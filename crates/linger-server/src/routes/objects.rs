//! The bytes. Neither of these paths is under `/api/v1`, and that is the point
//! (ARCHITECTURE §8): uploads and downloads never travel through the JSON API.
//!
//! - `PUT /upload/:upload_id/:part` — the local backend's listener. No session,
//!   no header, no database write: the URL was signed by this server when the
//!   slot was created and that signature is the whole authorisation. It is the
//!   same shape as an S3 presigned URL on purpose, so the client does one thing
//!   whichever backend a server runs (T-502).
//! - `GET /objects/*key` — serving a stored object back.
//!
//! **Why serving is not authenticated.** An object key contains a UUIDv7 with
//! 74 random bits, so the URL is the secret — the same arrangement every chat
//! app uses, and the only one that lets an `<img>` tag work at all.
//!
//! **That is also how a DM's files stay private** (SPEC §4.13, T-1303), and it
//! is worth being explicit about because it is not the mechanism used anywhere
//! else. There is no membership check here and there cannot be one: the browser
//! fetching an image does not carry a session. What keeps a DM's photo out of a
//! stranger's hands is that nothing ever hands them the URL — the message
//! routes, the media grid, search and the export all filter by membership, and
//! a key is not guessable. So a leak in any of those is a leak of the bytes as
//! well, which is why they are tested one surface at a time in
//! `tests/dm_leaks.rs` rather than trusted to a check here. What keeps
//! a hostile upload harmless is not a login check but where it is served from
//! and how: `/objects` answers only on the media host (`cdn.<domain>`, see
//! `super::media_origin_gate`), so nothing served here is ever same-origin with
//! the app, and anything that is not an ordinary image, video or audio file is
//! handed over as a download with sniffing turned off and a CSP that permits
//! nothing at all.
//!
//! **Why it answers `Range`.** A video player seeks by asking for the part of
//! the file it needs (`Range: bytes=…`) and expects `206 Partial Content` back.
//! Sending the whole file every time plays from the start and breaks the first
//! seek on GStreamer, the player under WebKitGTK on Linux (#222). One range per
//! request is served; anything else gets the whole file, which a server is
//! always allowed to do (RFC 9110 §14.2).
//!
//! On the S3 backend this route answers with a redirect and the *bucket* sends
//! the response, so the two headers that decide whether a file can render are
//! both stored on the object and signed into the presigned URL
//! ([`crate::storage::ServeAs`]). S3 has no `response-` override for
//! `X-Content-Type-Options` or `Content-Security-Policy`, so those two do not
//! make that trip; what stands in for them there is that the content type is
//! never the uploader's claim — it is one of the thirteen media types this
//! server sniffed for itself, or `application/octet-stream` with
//! `Content-Disposition: attachment`, which no browser renders whatever it
//! decides the bytes are. Active content (SVG, HTML, scripts) cannot be stored
//! in the first place (`linger_core::media`).

use std::io::SeekFrom;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::Router;
use linger_core::{AttachmentId, UploadId};
use serde::Deserialize;
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::error::ApiError;
use crate::state::AppState;
use crate::storage::local::PartError;
use crate::storage::{part_plan, ObjectBody, ServeAs};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/upload/{upload_id}/{part}", put(put_part))
        .route("/objects/{*key}", get(get_object))
}

#[derive(Deserialize)]
struct Signature {
    exp: i64,
    sig: String,
}

/// Accept one part of an upload.
async fn put_part(
    State(state): State<AppState>,
    Path((upload_id, part)): Path<(UploadId, u32)>,
    Query(signature): Query<Signature>,
    body: Body,
) -> Result<Response, ApiError> {
    let Some(local) = state.local.as_ref() else {
        return Err(ApiError::not_found("No such thing on this server."));
    };
    if !local.verify_part_url(upload_id, part, signature.exp, &signature.sig) {
        // Wrong signature, wrong part, or the link has aged out. The client's
        // move is the same in all three cases: ask for a fresh slot.
        return Err(ApiError::forbidden(
            "That upload link isn't valid any more.",
        ));
    }

    let record = crate::repo::attachments::record(&state.db.read, AttachmentId(upload_id.0))
        .await?
        .ok_or_else(|| ApiError::not_found("No such upload."))?;
    if record.state != "pending" {
        return Err(ApiError::conflict("That upload is already finished."));
    }

    let (count, part_size) = part_plan(record.size_bytes);
    if part == 0 || part > count {
        return Err(ApiError::validation("That upload has no such part."));
    }
    // The last part is whatever is left over; every other one is a full part.
    let max_bytes = if part == count {
        record.size_bytes - part_size * u64::from(count - 1)
    } else {
        part_size
    };

    match local.write_part(upload_id, part, max_bytes, body).await {
        Ok(etag) => {
            let mut headers = HeaderMap::new();
            if let Ok(value) = HeaderValue::from_str(&format!("\"{etag}\"")) {
                headers.insert(header::ETAG, value);
            }
            Ok((StatusCode::OK, headers).into_response())
        }
        Err(PartError::TooLarge) => Err(ApiError::file_too_large(
            "That part is bigger than the slot it was for.",
        )),
        Err(PartError::Aborted(why)) => {
            // Normal, and the reason multipart exists: resend this one part.
            tracing::debug!(%why, "upload part did not finish");
            Err(ApiError::validation("That part didn't finish arriving."))
        }
        Err(PartError::Io(err)) => {
            tracing::error!(error = %err, "writing upload part");
            Err(ApiError::internal())
        }
    }
}

/// Serve a stored object.
///
/// Two kinds of thing live in the store and both are served from here, because
/// both are somebody's bytes and both belong on the media host rather than on
/// the app's own name: uploads, and the export archives in [`crate::export`].
/// An export key never looks like an attachment key (`exports/<id>.zip`), so
/// the two lookups cannot collide.
async fn get_object(
    State(state): State<AppState>,
    Path(key): Path<String>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let row = sqlx::query(
        "SELECT filename, mime, poster_key FROM attachments
         WHERE state = 'complete' AND (object_key = ? OR poster_key = ?)",
    )
    .bind(&key)
    .bind(&key)
    .fetch_optional(&state.db.read)
    .await?;

    let Some(row) = row else {
        return get_export(&state, &key, &request).await;
    };

    let is_poster = row.get::<Option<String>, _>("poster_key").as_deref() == Some(key.as_str());
    let filename: String = row.get("filename");
    let serve = if is_poster {
        ServeAs::poster(&filename)
    } else {
        ServeAs::for_object(&row.get::<String, _>("mime"), &filename)
    };

    // Handed down as well as sent, because a store that answers with a redirect
    // has no response of its own to put them on: S3 signs these two into the
    // URL, and the bucket sends them back.
    let Some(object) = state
        .storage
        .read_object(&key, &serve)
        .await
        .map_err(ApiError::from)?
    else {
        return Err(ApiError::not_found("No such file."));
    };

    let (path, length) = match object {
        ObjectBody::Redirect(url) => {
            return Ok(axum::response::Redirect::temporary(&url).into_response())
        }
        ObjectBody::File(path, length) => (path, length),
    };

    let mut headers = served_as(&serve);
    // Objects are immutable: the key contains the id, and re-encoding happens
    // once, before the key is ever handed out.
    insert(
        &mut headers,
        header::CACHE_CONTROL,
        "public, max-age=31536000, immutable",
    );
    send_file(&path, length, headers, &request).await
}

/// Serve a finished export archive.
///
/// Unauthenticated for the same reason an upload is: the key holds a UUIDv7
/// with 74 random bits, so the URL is the secret. That matters more here than
/// it does for one photo — this is the whole server in a file — which is why
/// asking for somebody else's *job* is a 404 (see [`crate::export::job`]) and
/// why a new export deletes the previous archive rather than leaving old URLs
/// working forever.
async fn get_export(
    state: &AppState,
    key: &str,
    request: &HeaderMap,
) -> Result<Response, ApiError> {
    let row = sqlx::query(
        "SELECT filename, size_bytes FROM exports WHERE state = 'complete' AND object_key = ?",
    )
    .bind(key)
    .fetch_optional(&state.db.read)
    .await?
    .ok_or_else(|| ApiError::not_found("No such file."))?;

    let filename: String = row
        .get::<Option<String>, _>("filename")
        .unwrap_or_else(|| "linger-export.zip".to_string());
    let serve = ServeAs {
        content_type: "application/zip".to_string(),
        disposition: format!("attachment; filename=\"{filename}\""),
    };

    let Some(object) = state
        .storage
        .read_object(key, &serve)
        .await
        .map_err(ApiError::from)?
    else {
        return Err(ApiError::not_found("No such file."));
    };

    let (path, length) = match object {
        ObjectBody::Redirect(url) => {
            return Ok(axum::response::Redirect::temporary(&url).into_response())
        }
        ObjectBody::File(path, length) => (path, length),
    };

    let mut headers = served_as(&serve);
    // An archive is a snapshot and is replaced rather than revised, but the URL
    // stops working the moment its owner asks for another one — so it is not
    // the year-long immutable cache an upload gets.
    insert(&mut headers, header::CACHE_CONTROL, "private, no-store");
    send_file(&path, length, headers, request).await
}

/// The headers every stored file goes out with, whole or in part.
///
/// A partial answer carries all of them too: a `206` is the same file as far
/// as a browser is concerned, and a piece of a hostile upload is as hostile as
/// the rest of it.
fn served_as(serve: &ServeAs) -> HeaderMap {
    let mut headers = HeaderMap::new();
    insert(&mut headers, header::CONTENT_TYPE, &serve.content_type);
    insert(&mut headers, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    insert(
        &mut headers,
        header::CONTENT_DISPOSITION,
        &serve.disposition,
    );
    // Belt and braces on top of the type and the disposition: if a browser ever
    // did render one of these, it would render it with no scripts, no network
    // and no origin of its own to reach anything from.
    insert(
        &mut headers,
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; sandbox",
    );
    // The client is a webview on one origin and this is another host again, so
    // say plainly that loading these from elsewhere is allowed.
    insert(&mut headers, "cross-origin-resource-policy", "cross-origin");
    // Said on every answer, so a player knows it can seek before it tries.
    insert(&mut headers, header::ACCEPT_RANGES, "bytes");
    headers
}

/// Send a file off this machine's disk: the one byte range the request asked
/// for, or the whole file.
///
/// Only the bytes asked for are read. A seek near the end of a 500 MB video
/// costs what the player needs from there, not a pass over the whole file, and
/// nothing is ever held in memory beyond the stream's own buffer.
async fn send_file(
    path: &std::path::Path,
    length: u64,
    mut headers: HeaderMap,
    request: &HeaderMap,
) -> Result<Response, ApiError> {
    let (status, start, count) = match wanted(request, length) {
        Wanted::Whole => (StatusCode::OK, 0, length),
        Wanted::Part { start, end } => {
            insert(
                &mut headers,
                header::CONTENT_RANGE,
                &format!("bytes {start}-{end}/{length}"),
            );
            (StatusCode::PARTIAL_CONTENT, start, end - start + 1)
        }
        Wanted::Unsatisfiable => {
            // No body, so nothing that describes one. And never cached: a
            // cache that kept this would hand an empty answer to somebody
            // asking for the whole file.
            headers.remove(header::CONTENT_TYPE);
            headers.remove(header::CONTENT_DISPOSITION);
            insert(&mut headers, header::CACHE_CONTROL, "no-store");
            insert(
                &mut headers,
                header::CONTENT_RANGE,
                &format!("bytes */{length}"),
            );
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response());
        }
    };
    insert(&mut headers, header::CONTENT_LENGTH, &count.to_string());

    let unreadable = |err: std::io::Error| {
        tracing::error!(error = %err, "reading a stored file");
        ApiError::internal()
    };
    let mut file = tokio::fs::File::open(path).await.map_err(unreadable)?;
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(unreadable)?;
    }
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file.take(count)));
    Ok((status, headers, body).into_response())
}

/// What a request asks of a file `length` bytes long.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wanted {
    /// The whole file, with `200`: no `Range`, or one this route declines.
    Whole,
    /// Bytes `start..=end` with `206`. `end` is already inside the file.
    Part { start: u64, end: u64 },
    /// A range that begins at or past the end of the file: `416`.
    Unsatisfiable,
}

/// Read the request's `Range` (RFC 9110 §14.1.2) the way this route serves it.
///
/// Three forms are served: `bytes=a-b`, `bytes=a-` and `bytes=-n` (the last
/// `n` bytes). They are all a player sends when it seeks, and all a download
/// manager sends when it resumes. Several ranges at once would need a
/// `multipart/byteranges` body, which no player needs, so they get the whole
/// file, and so does anything malformed. That is always allowed, and always
/// safe: the client asked for some of these bytes and got all of them.
fn wanted(request: &HeaderMap, length: u64) -> Wanted {
    // `If-Range` makes the range conditional on a validator (an ETag or a
    // date) still matching. This route never sends one, so nothing a client
    // could put there can match, and RFC 9110 §13.1.5 says a range under a
    // validator that does not match is ignored.
    if request.contains_key(header::IF_RANGE) {
        return Wanted::Whole;
    }
    let mut ranges = request.get_all(header::RANGE).iter();
    let (Some(range), None) = (ranges.next(), ranges.next()) else {
        return Wanted::Whole;
    };
    match range.to_str() {
        Ok(range) => parse_range(range, length),
        Err(_) => Wanted::Whole,
    }
}

fn parse_range(range: &str, length: u64) -> Wanted {
    // An empty file has no byte to point at, and no `Content-Range` can
    // describe a piece of it. Its whole is nothing, which is a fine answer.
    if length == 0 {
        return Wanted::Whole;
    }
    let Some((unit, set)) = range.split_once('=') else {
        return Wanted::Whole;
    };
    if !unit.eq_ignore_ascii_case("bytes") || set.contains(',') {
        return Wanted::Whole;
    }
    let Some((first, last)) = set.trim().split_once('-') else {
        return Wanted::Whole;
    };
    let last_byte = length - 1;
    if first.is_empty() {
        // `bytes=-n`: the last n bytes, or the whole file if it is shorter.
        return match position(last) {
            Some(0) => Wanted::Unsatisfiable,
            Some(suffix) => Wanted::Part {
                start: length.saturating_sub(suffix),
                end: last_byte,
            },
            None => Wanted::Whole,
        };
    }
    // `bytes=a-b` and `bytes=a-`.
    let Some(start) = position(first) else {
        return Wanted::Whole;
    };
    let end = if last.is_empty() {
        None
    } else {
        match position(last) {
            Some(end) => Some(end),
            None => return Wanted::Whole,
        }
    };
    if end.is_some_and(|end| end < start) {
        // Backwards is not a range at all (RFC 9110 §14.1.1), so it is
        // ignored rather than refused.
        Wanted::Whole
    } else if start > last_byte {
        Wanted::Unsatisfiable
    } else {
        // One that runs past the end is cut to the end.
        Wanted::Part {
            start,
            end: end.map_or(last_byte, |end| end.min(last_byte)),
        }
    }
}

/// One end of a range: ASCII digits and nothing else. A number too big for a
/// `u64` is still a number, and past the end of any file there is.
fn position(digits: &str) -> Option<u64> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(digits.parse().unwrap_or(u64::MAX))
}

fn insert(headers: &mut HeaderMap, name: impl axum::http::header::IntoHeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_range, Wanted};

    /// The edges of the grammar. What each answer looks like over HTTP is
    /// proved in `tests/uploads.rs` and `tests/export.rs`.
    #[test]
    fn a_range_is_read_at_its_edges() {
        let part = |start, end| Wanted::Part { start, end };
        for (range, want) in [
            ("bytes=999-999", part(999, 999)),
            ("bytes=0-0", part(0, 0)),
            ("BYTES=0-0", part(0, 0)),
            ("bytes=990-5000", part(990, 999)),
            ("bytes=-5000", part(0, 999)),
            ("bytes=0-99999999999999999999999", part(0, 999)),
            ("bytes=99999999999999999999999-", Wanted::Unsatisfiable),
            ("bytes=-0", Wanted::Unsatisfiable),
            ("bytes=5-x", Wanted::Whole),
            ("bytes=1-2-3", Wanted::Whole),
            ("bytes=+1-2", Wanted::Whole),
            ("bytes=-", Wanted::Whole),
            ("bytes=", Wanted::Whole),
            ("0-5", Wanted::Whole),
        ] {
            assert_eq!(parse_range(range, 1000), want, "{range}");
        }
        assert_eq!(parse_range("bytes=0-", 0), Wanted::Whole, "an empty file");
    }
}
