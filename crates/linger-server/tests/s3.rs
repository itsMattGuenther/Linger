//! The S3 backend, end to end against a real S3 API (T-502).
//!
//! These drive the same public endpoints as `uploads.rs` — nothing here reaches
//! into the store directly — with `LINGER_STORAGE=s3` underneath, so what is
//! being proven is that the seam holds: the client PUTs at the bucket, the
//! server reads the parts back out of it, and a download is a redirect to the
//! bucket rather than bytes through this process.
//!
//! **They skip when there is no bucket.** CI runs MinIO in a service container;
//! locally, `scripts/minio-test.sh` starts one and runs these. Without
//! `LINGER_TEST_S3_ENDPOINT` set, `cargo test --workspace` skips them and stays
//! green — printing a line saying so, because a test that silently does nothing
//! is worse than one that fails.

mod common;

use common::{bootstrap_host, spawn_s3_server, TestServer};
use linger_core::wire::{Attachment, CompletedPart, UploadSlot};
use reqwest::StatusCode;

/// Start a server on the test bucket, or say why not and stop.
///
/// The `$name` is printed so a skipped run is visible in `cargo test` output.
macro_rules! s3_server {
    ($name:literal) => {
        match spawn_s3_server().await {
            Some(server) => server,
            None => {
                println!("skipping {}: LINGER_TEST_S3_ENDPOINT is not set", $name);
                return;
            }
        }
    };
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn slot(
    server: &TestServer,
    token: &str,
    filename: &str,
    size_bytes: u64,
    mime: &str,
) -> UploadSlot {
    let resp = client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "filename": filename,
            "size_bytes": size_bytes,
            "mime": mime,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "slot refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// PUT one part straight at the bucket. The URL is absolute and presigned, and
/// carries no credentials of ours — which is the whole point of the design.
async fn put_part(url: &str, bytes: Vec<u8>) -> (StatusCode, Option<String>) {
    assert!(
        url.starts_with("http"),
        "an S3 slot hands out absolute URLs, got {url}"
    );
    let resp = client().put(url).body(bytes).send().await.unwrap();
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    (resp.status(), etag)
}

async fn finish(
    server: &TestServer,
    token: &str,
    slot: &UploadSlot,
    parts: Option<Vec<CompletedPart>>,
) -> reqwest::Response {
    client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "parts": parts }))
        .send()
        .await
        .unwrap()
}

async fn upload(
    server: &TestServer,
    token: &str,
    filename: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> Attachment {
    let slot = slot(server, token, filename, bytes.len() as u64, mime).await;
    let (status, _) = put_part(&slot.url, bytes).await;
    assert_eq!(status, 200);
    let resp = finish(server, token, &slot, None).await;
    assert_eq!(
        resp.status(),
        200,
        "complete refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// Ask the server for an object and follow it wherever it points.
///
/// With S3 that is a redirect to a presigned URL, and the headers under test
/// are the ones the *bucket* sends after the redirect — they were signed into
/// the URL, so this is the only way to see them.
async fn fetch_object(server: &TestServer, url: &str) -> reqwest::Response {
    let url = format!("{}{url}", server.base);
    // Redirects are followed by hand, because the redirect itself is the thing
    // being asserted: the app server must not be sending bytes.
    let hop = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(&url)
        .send()
        .await
        .unwrap();
    assert_eq!(
        hop.status(),
        StatusCode::TEMPORARY_REDIRECT,
        "an S3 server sends the client to the bucket instead of proxying"
    );
    let target = hop
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .expect("a redirect has somewhere to go")
        .to_string();
    client().get(target).send().await.unwrap()
}

fn header(resp: &reqwest::Response, name: reqwest::header::HeaderName) -> String {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// Ask the bucket directly whether a key is there.
///
/// Signed with the test credentials rather than anything the server handed
/// out, so "the parts were swept" is checked against S3 itself and not against
/// the server's own opinion of what it deleted.
async fn bucket_has(key: &str) -> bool {
    use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

    let bucket = Bucket::new(
        std::env::var("LINGER_TEST_S3_ENDPOINT")
            .unwrap()
            .parse()
            .unwrap(),
        UrlStyle::Path,
        std::env::var("LINGER_TEST_S3_BUCKET").unwrap_or_else(|_| "linger-test".to_string()),
        std::env::var("LINGER_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
    )
    .unwrap();
    let credentials = Credentials::new(
        std::env::var("LINGER_TEST_S3_ACCESS_KEY_ID").unwrap(),
        std::env::var("LINGER_TEST_S3_SECRET_ACCESS_KEY").unwrap(),
    );
    let url = bucket
        .head_object(Some(&credentials), key)
        .sign(std::time::Duration::from_secs(60));
    client()
        .head(url)
        .send()
        .await
        .unwrap()
        .status()
        .is_success()
}

/// GET a key straight out of the bucket, with nothing signed into the URL
/// beyond the signature itself.
///
/// This is what a CDN in front of the bucket sees, and what anybody who ever
/// reached the object by some other route would get: only the headers stored
/// *on* the object (T-503).
async fn bucket_get(key: &str) -> reqwest::Response {
    use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

    let bucket = Bucket::new(
        std::env::var("LINGER_TEST_S3_ENDPOINT")
            .unwrap()
            .parse()
            .unwrap(),
        UrlStyle::Path,
        std::env::var("LINGER_TEST_S3_BUCKET").unwrap_or_else(|_| "linger-test".to_string()),
        std::env::var("LINGER_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
    )
    .unwrap();
    let credentials = Credentials::new(
        std::env::var("LINGER_TEST_S3_ACCESS_KEY_ID").unwrap(),
        std::env::var("LINGER_TEST_S3_SECRET_ACCESS_KEY").unwrap(),
    );
    let url = bucket
        .get_object(Some(&credentials), key)
        .sign(std::time::Duration::from_secs(60));
    client().get(url).send().await.unwrap()
}

/// The object key inside a served URL (`/objects/ab/cd/…`).
fn key_of(url: &str) -> String {
    url.rsplit_once("/objects/")
        .expect("a served URL is under /objects/")
        .1
        .to_string()
}

async fn error_code(resp: reqwest::Response) -> String {
    let body: serde_json::Value = resp.json().await.unwrap();
    body["error"]["code"].as_str().unwrap().to_string()
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(width, height);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x % 256) as u8, (y % 256) as u8);
        *pixel = image::Rgba([r, g, 200, 255]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn filler(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| {
            #[allow(clippy::cast_possible_truncation)]
            let byte = (i * 31 % 251) as u8;
            byte
        })
        .collect()
}

const PART: usize = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_image_goes_into_the_bucket_and_is_served_from_it() {
    let server = s3_server!("an_image_goes_into_the_bucket_and_is_served_from_it");
    let host = bootstrap_host(&server).await;

    let attachment = upload(
        &server,
        &host.access_token,
        "photo.png",
        "image/png",
        png(48, 32),
    )
    .await;
    assert_eq!(attachment.mime, "image/png");
    assert_eq!(attachment.width, Some(48));
    assert!(attachment.blurhash.is_some());

    let resp = fetch_object(&server, &attachment.url).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(header(&resp, reqwest::header::CONTENT_TYPE), "image/png");
    assert!(
        header(&resp, reqwest::header::CONTENT_DISPOSITION).starts_with("inline;"),
        "an image is shown, not downloaded"
    );
    let bytes = resp.bytes().await.unwrap();
    assert_eq!(bytes.len() as u64, attachment.size_bytes);
    assert_eq!(
        &bytes[1..4],
        b"PNG",
        "the stored object is the re-encoded PNG"
    );
}

#[tokio::test]
async fn anything_not_an_image_still_comes_back_as_a_download() {
    let server = s3_server!("anything_not_an_image_still_comes_back_as_a_download");
    let host = bootstrap_host(&server).await;

    // The download-forcing headers are the whole defence against a hostile
    // upload (ARCHITECTURE §7), and with S3 this server does not send them —
    // it signs them into the URL and the bucket does. So check the bucket.
    let attachment = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        b"nothing dangerous in here".to_vec(),
    )
    .await;

    let resp = fetch_object(&server, &attachment.url).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        header(&resp, reqwest::header::CONTENT_TYPE),
        "application/octet-stream"
    );
    assert!(header(&resp, reqwest::header::CONTENT_DISPOSITION).starts_with("attachment;"));
}

#[tokio::test]
async fn an_object_carries_its_own_headers_in_the_bucket() {
    let server = s3_server!("an_object_carries_its_own_headers_in_the_bucket");
    let host = bootstrap_host(&server).await;

    // The presigned URL this server hands out signs the content type and the
    // disposition into the request. These assertions are about the object
    // itself: reached with none of that, it still describes itself correctly,
    // so a bucket behind a CDN — or one somebody made public — cannot be
    // talked into serving a stored file as a page.
    let notes = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        b"plain enough".to_vec(),
    )
    .await;
    let resp = bucket_get(&key_of(&notes.url)).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        header(&resp, reqwest::header::CONTENT_TYPE),
        "application/octet-stream"
    );
    assert!(
        header(&resp, reqwest::header::CONTENT_DISPOSITION).starts_with("attachment;"),
        "a stored file that is not media downloads however it is reached"
    );

    let image = upload(
        &server,
        &host.access_token,
        "photo.png",
        "image/png",
        png(16, 16),
    )
    .await;
    let resp = bucket_get(&key_of(&image.url)).await;
    assert_eq!(header(&resp, reqwest::header::CONTENT_TYPE), "image/png");
    assert!(header(&resp, reqwest::header::CONTENT_DISPOSITION).starts_with("inline;"));
}

#[tokio::test]
async fn a_killed_upload_resumes_against_the_bucket() {
    let server = s3_server!("a_killed_upload_resumes_against_the_bucket");
    let host = bootstrap_host(&server).await;

    // Three parts, and the middle one never goes — the ordinary shape of a
    // connection dying halfway through a big file.
    let body = filler(PART * 2 + 4096);
    let slot = slot(
        &server,
        &host.access_token,
        "trip.bin",
        body.len() as u64,
        "application/octet-stream",
    )
    .await;
    let parts = slot.parts.clone().expect("a 16 MB upload is cut up");
    assert_eq!(parts.len(), 3);

    let mut etags = Vec::new();
    for part in &parts {
        if part.number == 2 {
            continue;
        }
        let start = (part.number as usize - 1) * PART;
        let end = (start + PART).min(body.len());
        let (status, etag) = put_part(&part.url, body[start..end].to_vec()).await;
        assert_eq!(status, 200);
        etags.push(CompletedPart {
            number: part.number,
            etag: etag.expect("the bucket answers a PUT with an etag"),
        });
    }

    let resp = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(resp.status(), 422);
    assert_eq!(error_code(resp).await, "VALIDATION_FAILED");

    // The slot is still alive: send what is missing and ask again.
    let (status, etag) = put_part(&parts[1].url, body[PART..PART * 2].to_vec()).await;
    assert_eq!(status, 200);
    etags.push(CompletedPart {
        number: 2,
        etag: etag.unwrap(),
    });
    etags.sort_by_key(|p| p.number);

    let resp = finish(&server, &host.access_token, &slot, Some(etags)).await;
    assert_eq!(
        resp.status(),
        200,
        "resumed complete refused: {}",
        resp.text().await.unwrap()
    );
    let attachment: Attachment = resp.json().await.unwrap();
    assert_eq!(attachment.size_bytes, body.len() as u64);

    let fetched = fetch_object(&server, &attachment.url).await;
    assert_eq!(fetched.status(), 200);
    assert_eq!(
        fetched.bytes().await.unwrap().as_ref(),
        body.as_slice(),
        "every part landed in the right order"
    );
}

#[tokio::test]
async fn a_part_that_does_not_match_its_etag_is_caught() {
    let server = s3_server!("a_part_that_does_not_match_its_etag_is_caught");
    let host = bootstrap_host(&server).await;

    let bytes = png(8, 8);
    let slot = slot(
        &server,
        &host.access_token,
        "photo.png",
        bytes.len() as u64,
        "image/png",
    )
    .await;
    let (status, _) = put_part(&slot.url, bytes).await;
    assert_eq!(status, 200);

    let resp = finish(
        &server,
        &host.access_token,
        &slot,
        Some(vec![CompletedPart {
            number: 1,
            etag: "\"00000000000000000000000000000000\"".to_string(),
        }]),
    )
    .await;
    assert_eq!(resp.status(), 422);
    assert_eq!(error_code(resp).await, "VALIDATION_FAILED");
}

#[tokio::test]
async fn a_file_that_lies_about_its_type_is_refused_and_its_parts_are_swept() {
    let server = s3_server!("a_file_that_lies_about_its_type_is_refused_and_its_parts_are_swept");
    let host = bootstrap_host(&server).await;

    // A zip wearing a PNG's name. Refused at complete, and refused finally:
    // the parts go with it, which on this backend means objects in the bucket.
    let bytes = b"PK\x03\x04 this is a zip, whatever the request said".to_vec();
    let slot = slot(
        &server,
        &host.access_token,
        "photo.png",
        bytes.len() as u64,
        "image/png",
    )
    .await;
    let (status, _) = put_part(&slot.url, bytes).await;
    assert_eq!(status, 200);

    let resp = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(resp.status(), 415);
    assert_eq!(error_code(resp).await, "UNSUPPORTED_MEDIA");

    // The part is gone from the bucket, not merely forgotten by the server.
    assert!(
        !bucket_has(&format!("uploads/{}/00001", slot.upload_id)).await,
        "a discarded upload leaves nothing behind"
    );

    // And the slot is spent.
    let resp = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(resp.status(), 409);
}

#[tokio::test]
async fn cancelling_an_upload_takes_the_object_out_of_the_bucket() {
    let server = s3_server!("cancelling_an_upload_takes_the_object_out_of_the_bucket");
    let host = bootstrap_host(&server).await;

    let attachment = upload(
        &server,
        &host.access_token,
        "photo.png",
        "image/png",
        png(16, 16),
    )
    .await;
    let url = attachment.url.clone();
    let key = key_of(&url);
    assert_eq!(fetch_object(&server, &url).await.status(), 200);
    assert!(bucket_has(&key).await);

    let resp = client()
        .delete(server.url(&format!("/uploads/{}", attachment.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // The row is gone, so the server no longer knows the key at all — and
    // neither does the bucket.
    let resp = client()
        .get(format!("{}{url}", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    assert!(!bucket_has(&key).await, "the bytes went with the upload");
}

#[tokio::test]
async fn the_upload_listener_is_not_there_when_storage_is_the_bucket() {
    let server = s3_server!("the_upload_listener_is_not_there_when_storage_is_the_bucket");
    let host = bootstrap_host(&server).await;

    // The local backend's `PUT /upload/...` path exists only because a
    // filesystem has no second machine to PUT at. On S3 it must answer nothing,
    // or it is an unauthenticated write endpoint nobody is watching.
    let slot = slot(&server, &host.access_token, "photo.png", 64, "image/png").await;
    let resp = client()
        .put(format!(
            "{}/upload/{}/1?exp=99999999999999&sig=00",
            server.base, slot.upload_id
        ))
        .body(vec![0u8; 64])
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

/// An export on the S3 backend has to pull every file back out of the bucket to
/// put it in the archive — the local backend has the bytes on its own disk and
/// this one does not (T-801). That download is the only part of the export that
/// differs between backends, so it is the part that gets a test against a real
/// bucket.
#[tokio::test]
async fn an_export_pulls_the_files_back_out_of_the_bucket() {
    use std::io::Read;

    let server = s3_server!("an_export_pulls_the_files_back_out_of_the_bucket");
    let host = bootstrap_host(&server).await;

    let room: linger_core::wire::Room = client()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "general", "name": "general" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let attachment = upload(
        &server,
        &host.access_token,
        "from the bucket.png",
        "image/png",
        png(8, 8),
    )
    .await;
    let posted = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "body": "a file that lives in S3",
            "attachment_ids": [attachment.id],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(posted.status(), 200);

    let started: linger_core::wire::ExportStarted = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let mut job = None;
    for _ in 0..200 {
        let asked: linger_core::wire::ExportJob = client()
            .get(server.url(&format!("/export/{}", started.job_id)))
            .bearer_auth(&host.access_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        match asked.state {
            linger_core::wire::ExportState::Complete => {
                job = Some(asked);
                break;
            }
            linger_core::wire::ExportState::Failed => panic!("the export failed"),
            _ => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
    let job = job.expect("the export never finished");
    let url = job.url.expect("a finished export has a url");

    // The archive itself is an object in the bucket, so asking for it is a
    // redirect like any other object.
    let archive = fetch_object(&server, &url).await;
    assert_eq!(archive.status(), 200);

    let bytes = archive.bytes().await.unwrap().to_vec();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("it opens");
    let mut image = Vec::new();
    let mut found = false;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        if file.name().ends_with("media/from the bucket.png") {
            file.read_to_end(&mut image).unwrap();
            found = true;
        }
    }
    assert!(found, "the file never came back out of the bucket");
    assert_eq!(&image[1..4], b"PNG", "and the bytes are the real file");

    // A week after it finished, the sweeper takes it out of the bucket too
    // (#504): on S3 an archive nobody downloads is billed every month.
    let key = linger_server::export::object_key(started.job_id);
    assert!(
        bucket_has(&key).await,
        "the archive was never in the bucket"
    );
    sqlx::query("UPDATE exports SET finished_at = finished_at - ?")
        .bind(linger_server::export::KEPT_FOR_MS + 60_000)
        .execute(&server.state.db.write)
        .await
        .unwrap();
    let swept = linger_server::expiry::sweep(&server.state).await.unwrap();
    assert_eq!(swept.archives, 1);
    assert!(
        !bucket_has(&key).await,
        "an old archive is still in the bucket"
    );
}

/// A large image's display copy (#382) lives in the bucket next to it, is
/// served from it as the image's own type, and goes when the upload goes.
#[tokio::test]
async fn a_large_images_display_copy_is_in_the_bucket_and_goes_with_it() {
    let server = s3_server!("a_large_images_display_copy_is_in_the_bucket_and_goes_with_it");
    let host = bootstrap_host(&server).await;

    let attachment = upload(
        &server,
        &host.access_token,
        "wide.png",
        "image/png",
        png(1500, 900),
    )
    .await;
    let display = attachment
        .display_url
        .clone()
        .expect("a large image has a display copy");
    assert_ne!(display, attachment.url);
    assert!(bucket_has(&key_of(&display)).await);

    let resp = fetch_object(&server, &display).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(header(&resp, reqwest::header::CONTENT_TYPE), "image/png");
    assert!(header(&resp, reqwest::header::CONTENT_DISPOSITION).starts_with("inline;"));
    let copy = image::load_from_memory(&resp.bytes().await.unwrap()).unwrap();
    assert_eq!((copy.width(), copy.height()), (960, 576));

    let resp = client()
        .delete(server.url(&format!("/uploads/{}", attachment.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
    assert!(
        !bucket_has(&key_of(&display)).await,
        "the copy went with the upload"
    );
}

/// An image from before copies gets its copy when the server starts, read back
/// out of the bucket (#382). Forgetting the copy is the one thing done to the
/// store directly here: it is how an image from an older server looks.
#[tokio::test]
async fn an_earlier_image_gets_its_display_copy_from_the_bucket() {
    let server = s3_server!("an_earlier_image_gets_its_display_copy_from_the_bucket");
    let host = bootstrap_host(&server).await;

    let attachment = upload(
        &server,
        &host.access_token,
        "wide.png",
        "image/png",
        png(1500, 900),
    )
    .await;
    let display = attachment.display_url.clone().unwrap();
    server
        .state
        .storage
        .delete_object(&key_of(&display))
        .await
        .unwrap();
    sqlx::query("UPDATE attachments SET display_key = NULL")
        .execute(&server.state.db.write)
        .await
        .unwrap();
    assert!(!bucket_has(&key_of(&display)).await);

    assert_eq!(
        linger_server::display::catch_up(&server.state)
            .await
            .unwrap(),
        1
    );
    assert!(
        bucket_has(&key_of(&display)).await,
        "the copy was made again from the bucket's original"
    );
    let copy =
        image::load_from_memory(&fetch_object(&server, &display).await.bytes().await.unwrap())
            .unwrap();
    assert_eq!((copy.width(), copy.height()), (960, 576));
}
