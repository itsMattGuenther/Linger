//! The upload pipeline's paperwork (PROTOCOL §6, ARCHITECTURE §8).
//!
//! Three calls and no bytes. The client asks for a slot, PUTs the file straight
//! at the URL it gets back (see [`crate::routes::objects`]), and then says it is
//! finished. Only at that last step does the server look at what actually
//! arrived — and everything the client claimed on the way in gets checked again
//! against the bytes on disk, because a declared size and a declared type are
//! both just strings somebody sent.
//!
//! Completing can fail in two different ways, and they are not the same thing.
//! If parts are missing the upload is still alive: send them and ask again.
//! So it is when the server is too busy with other pictures to start on this
//! one (#487): ask again later. If what arrived is not an acceptable file, the
//! slot is finished — resending the same bytes into the same declaration
//! cannot make them acceptable.
//!
//! The upload and the attachment it will become share one id. There is nothing
//! to remember about an upload that the attachment row does not already hold,
//! and the part layout is a pure function of the size (`storage::part_plan`), so
//! a resumed upload works out the identical plan without asking.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use linger_core::limits::{MAX_FILE_BYTES, RATE_UPLOAD_SLOTS};
use linger_core::media;
use linger_core::wire::{
    Attachment, CompleteUploadRequest, CreateUploadRequest, ErrorCode, UploadSlot,
};
use linger_core::{AttachmentId, UploadId};

use crate::auth::AuthedUser;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::storage::{display_key, object_key, part_plan, poster_key, ServeAs};
use crate::{repo, validate};

/// Parts of an upload that never completed are swept once they are this old.
/// Long enough to outlive any resumable upload (the signed URLs last a day),
/// short enough that an abandoned 400 MB video does not sit on the disk.
const STALE_UPLOAD_MS: i64 = 48 * 60 * 60 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/uploads", post(create))
        .route("/uploads/{id}/complete", post(complete))
        .route("/uploads/{id}", axum::routing::delete(cancel))
}

/// `POST /uploads` — reserve a slot and hand back where to PUT the bytes.
///
/// Everything refusable is refused here, before a single byte moves: too big
/// for one file, too big for what is left of the pool, or a type this server
/// does not store. Sending 400 MB and *then* being told no is the rude version.
async fn create(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<CreateUploadRequest>,
) -> Result<Json<UploadSlot>, ApiError> {
    if let Err(retry) = state
        .limiter
        .check(&format!("upload:{}", auth.id), RATE_UPLOAD_SLOTS)
    {
        return Err(ApiError::rate_limited(retry));
    }

    let filename = validate::filename(&req.filename)?;
    if req.size_bytes == 0 {
        return Err(ApiError::validation("That file is empty."));
    }
    if req.size_bytes > MAX_FILE_BYTES {
        return Err(ApiError::file_too_large(format!(
            "Files are up to {} MB.",
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }
    if !media::is_allowed_mime(&req.mime) {
        return Err(ApiError::unsupported_media(
            "This server doesn't take that kind of file.",
        ));
    }
    let mime = media::canonical_mime(&req.mime).to_string();

    sweep_stale_uploads(&state).await?;

    let used = repo::attachments::pool_used(&state.db.read).await?;
    if used.saturating_add(req.size_bytes) > state.config.pool_bytes {
        return Err(ApiError::quota_exceeded(
            "This server's storage is full. The host can free some up or raise the limit.",
        ));
    }

    let attachment_id = AttachmentId::new();
    let upload_id = UploadId(attachment_id.0);
    #[allow(clippy::cast_possible_wrap)]
    sqlx::query(
        "INSERT INTO attachments
           (id, uploader_id, object_key, filename, mime, size_bytes, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    )
    .bind(attachment_id.to_vec())
    .bind(auth.id.to_vec())
    .bind(object_key(attachment_id))
    .bind(&filename)
    .bind(&mime)
    .bind(req.size_bytes as i64)
    .bind(now_ms())
    .execute(&state.db.write)
    .await?;

    let slot = state
        .storage
        .slot(upload_id, attachment_id, req.size_bytes)
        .map_err(ApiError::from)?;
    Ok(Json(slot))
}

/// `POST /uploads/:id/complete` — assemble, verify, clean, store.
async fn complete(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(upload_id): Path<UploadId>,
    body: Option<Json<CompleteUploadRequest>>,
) -> Result<Json<Attachment>, ApiError> {
    let attachment_id = AttachmentId(upload_id.0);
    let record = repo::attachments::record(&state.db.read, attachment_id)
        .await?
        .ok_or_else(|| ApiError::not_found("No such upload."))?;
    if record.uploader_id != auth.id {
        return Err(ApiError::forbidden("That upload isn't yours."));
    }
    if record.state == "complete" {
        // Completing twice is the client retrying after a dropped response.
        return repo::attachments::by_id(&state.db.read, &state.config, attachment_id)
            .await?
            .map(Json)
            .ok_or_else(ApiError::internal);
    }
    if record.state != "pending" {
        return Err(ApiError::conflict("That upload already failed."));
    }

    let upload_id = UploadId(record.id.0);
    let req = body.map(|Json(body)| body);
    let (expected_parts, _) = part_plan(record.size_bytes);

    // Assembly is the one failure that leaves the slot alive. "Some of it never
    // arrived" is the ordinary shape of a dropped connection, and the fix is to
    // send the missing parts and ask again — which is the whole point of
    // cutting the file up. Nothing is thrown away here.
    let staged = state
        .storage
        .assemble(
            upload_id,
            req.as_ref().and_then(|r| r.parts.as_deref()),
            expected_parts,
        )
        .await
        .map_err(|err| {
            tracing::info!(error = %err, "upload could not be assembled");
            ApiError::validation(
                "Some of that file never arrived. Send the missing parts and try again.",
            )
        })?;

    // Past that point a refusal is about the bytes themselves, and re-sending
    // them cannot help: the slot is spent, and the parts go with it. All but
    // one: the server being busy with other pictures.
    match finish(&state, &record, &staged).await {
        Ok(attachment) => Ok(Json(attachment)),
        // Busy with other pictures says nothing about these bytes: the slot
        // stays, and completing again once there is room can still work.
        Err(err) if err.code == ErrorCode::RateLimited => Err(err),
        Err(err) => {
            let _ = state.storage.discard(upload_id).await;
            sqlx::query("UPDATE attachments SET state = 'failed' WHERE id = ?")
                .bind(attachment_id.to_vec())
                .execute(&state.db.write)
                .await?;
            Err(err)
        }
    }
}

async fn finish(
    state: &AppState,
    record: &repo::attachments::Record,
    staged: &crate::storage::Staged,
) -> Result<Attachment, ApiError> {
    // The declared size was a claim. This is the file.
    if staged.size_bytes > MAX_FILE_BYTES {
        return Err(ApiError::file_too_large(format!(
            "Files are up to {} MB.",
            MAX_FILE_BYTES / (1024 * 1024)
        )));
    }
    if staged.size_bytes != record.size_bytes {
        return Err(ApiError::validation(
            "That file isn't the size it was going to be.",
        ));
    }

    let processed = crate::media::process(&staged.path, &record.mime, &record.filename).await?;

    let poster = match &processed.poster {
        Some(bytes) => {
            let key = poster_key(record.id);
            state
                .storage
                .put_bytes(&key, bytes, &ServeAs::poster(&processed.filename))
                .await
                .map_err(ApiError::from)?;
            Some(key)
        }
        None => None,
    };
    // An image is drawn small from its display copy, or from itself when it
    // is already small or a GIF (#382). Nothing else has one.
    let display = if media::kind_of(&processed.mime) == "image" {
        match &processed.display {
            Some(bytes) => {
                let key = display_key(record.id, &processed.mime);
                state
                    .storage
                    .put_bytes(
                        &key,
                        bytes,
                        &ServeAs::for_object(&processed.mime, &processed.filename),
                    )
                    .await
                    .map_err(ApiError::from)?;
                Some(key)
            }
            None => Some(record.object_key.clone()),
        }
    } else {
        None
    };
    // How this file is allowed to be served is decided once, here, from what
    // the server made of the bytes — never from what the uploader declared —
    // and stored with the object so it is the same answer wherever it is read
    // back from (ARCHITECTURE §7).
    state
        .storage
        .put_object(
            &record.object_key,
            &staged.path,
            &ServeAs::for_object(&processed.mime, &processed.filename),
        )
        .await
        .map_err(ApiError::from)?;
    let _ = state.storage.discard(UploadId(record.id.0)).await;

    #[allow(clippy::cast_possible_wrap)]
    sqlx::query(
        "UPDATE attachments SET
           filename = ?, mime = ?, size_bytes = ?, width = ?, height = ?,
           duration_ms = ?, blurhash = ?, poster_key = ?, display_key = ?,
           state = 'complete'
         WHERE id = ?",
    )
    .bind(&processed.filename)
    .bind(&processed.mime)
    .bind(processed.size_bytes as i64)
    .bind(processed.width.map(i64::from))
    .bind(processed.height.map(i64::from))
    .bind(processed.duration_ms.map(|d| d as i64))
    .bind(processed.blurhash.as_deref())
    .bind(poster.as_deref())
    .bind(display.as_deref())
    .bind(record.id.to_vec())
    .execute(&state.db.write)
    .await?;

    repo::attachments::by_id(&state.db.read, &state.config, record.id)
        .await?
        .ok_or_else(ApiError::internal)
}

/// `DELETE /uploads/:id` — give up on an upload, or throw away a finished one
/// that was never posted. A file already on a message is a message's problem.
async fn cancel(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(upload_id): Path<UploadId>,
) -> Result<StatusCode, ApiError> {
    let attachment_id = AttachmentId(upload_id.0);
    let record = repo::attachments::record(&state.db.read, attachment_id)
        .await?
        .ok_or_else(|| ApiError::not_found("No such upload."))?;
    if record.uploader_id != auth.id {
        return Err(ApiError::forbidden("That upload isn't yours."));
    }
    if record.message_id.is_some() {
        return Err(ApiError::conflict(
            "That file is on a message. Delete the message instead.",
        ));
    }
    if repo::emoji::is_picture(&state.db.read, attachment_id).await? {
        return Err(ApiError::conflict(
            "That picture is one of the server's emoji. Remove the emoji instead.",
        ));
    }

    let _ = state.storage.discard(upload_id).await;
    let _ = state.storage.delete_object(&record.object_key).await;
    if let Some(key) = &record.poster_key {
        let _ = state.storage.delete_object(key).await;
    }
    if let Some(key) = record
        .display_key
        .as_ref()
        .filter(|key| **key != record.object_key)
    {
        let _ = state.storage.delete_object(key).await;
    }
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(attachment_id.to_vec())
        .execute(&state.db.write)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Drop uploads nobody ever finished, and the part files behind them.
///
/// Done here, on the way in, rather than from a background task: slot creation
/// is the only moment the answer matters, since pending uploads count against
/// the pool. It is rate-limited to twenty an hour per person, so it is nowhere
/// near a hot path.
async fn sweep_stale_uploads(state: &AppState) -> Result<(), ApiError> {
    let cutoff = now_ms() - STALE_UPLOAD_MS;
    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT id FROM attachments WHERE state != 'complete' AND created_at < ?")
            .bind(cutoff)
            .fetch_all(&state.db.read)
            .await?;

    for (id,) in rows {
        let Ok(id) = AttachmentId::from_slice(&id) else {
            continue;
        };
        let _ = state.storage.discard(UploadId(id.0)).await;
        sqlx::query("DELETE FROM attachments WHERE id = ?")
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
    }
    Ok(())
}
