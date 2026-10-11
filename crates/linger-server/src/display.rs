//! Display copies for images uploaded before the server made them (#382).
//!
//! An image finished from now on gets its display copy at upload
//! (`media::process`). One from before has no `display_key`, and the app draws
//! its original until this has made its copy. It runs once when the server
//! starts, newest images first, so the conversations people are reading are
//! the first to get lighter, and stops when none are left.
//!
//! Copies are made here rather than on the first request for one, because on
//! S3 that request goes to the bucket and never reaches this server. Each
//! original is read back as an export reads it, from the server's own disk or
//! from the bucket.
//!
//! An image that can't be read as a picture is drawn from its original, as it
//! always was, and isn't tried again. A store that can't be reached ends the
//! run: the next start tries again.

use std::time::Duration;

use linger_core::AttachmentId;

use crate::error::ApiError;
use crate::media::{display_copy_of, image_job, MAX_IMAGE_BYTES};
use crate::state::AppState;
use crate::storage::{display_key, ObjectBody, ServeAs};

/// Images per batch. Each is a decode and an encode, a second or so of one
/// core for a phone photo, and each batch holds the single writer only for
/// its updates.
const BATCH: i64 = 16;

/// The breath between batches, so people uploading and typing come first.
const PAUSE: Duration = Duration::from_millis(500);

/// Make the copies in the background, once, when the server starts.
pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        match catch_up(&state).await {
            Ok(0) => {}
            Ok(made) => tracing::info!(images = made, "made display copies for earlier images"),
            Err(err) => {
                tracing::warn!(error = ?err, "display copies stopped; the next start goes on")
            }
        }
    })
}

/// Give every finished image a display key, until none is left without one.
/// How many it settled. Public so an integration test can drive it.
pub async fn catch_up(state: &AppState) -> Result<u64, ApiError> {
    let mut settled = 0;
    loop {
        let rows: Vec<(Vec<u8>, String, String, String)> = sqlx::query_as(
            "SELECT id, object_key, mime, filename FROM attachments
              WHERE state = 'complete' AND display_key IS NULL AND mime LIKE 'image/%'
              ORDER BY created_at DESC
              LIMIT ?",
        )
        .bind(BATCH)
        .fetch_all(&state.db.read)
        .await?;
        if rows.is_empty() {
            return Ok(settled);
        }
        for (id, object_key, mime, filename) in rows {
            let id = AttachmentId::from_slice(&id).map_err(anyhow::Error::from)?;
            let key = copy(state, id, &object_key, &mime, &filename).await?;
            let recorded = sqlx::query(
                "UPDATE attachments SET display_key = ? WHERE id = ? AND display_key IS NULL",
            )
            .bind(&key)
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
            // Swept, or thrown away, while its copy was being made.
            if recorded.rows_affected() == 0 && key != object_key {
                let _ = state.storage.delete_object(&key).await;
            }
            settled += 1;
        }
        tokio::time::sleep(PAUSE).await;
    }
}

/// The key an image should be drawn from: a new copy, or its own when it is
/// already small, a GIF, or unreadable.
async fn copy(
    state: &AppState,
    id: AttachmentId,
    object_key: &str,
    mime: &str,
    filename: &str,
) -> Result<String, ApiError> {
    let serve = ServeAs::for_object(mime, filename);
    let bytes = match state.storage.read_object(object_key, &serve).await? {
        None => return Ok(object_key.to_string()),
        Some(ObjectBody::File(path, _)) => {
            tokio::fs::read(&path).await.map_err(anyhow::Error::from)?
        }
        Some(ObjectBody::Redirect(url)) => reqwest::get(&url)
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(anyhow::Error::from)?
            .bytes()
            .await
            .map_err(anyhow::Error::from)?
            .to_vec(),
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Ok(object_key.to_string());
    }
    let owned_mime = mime.to_string();
    let made = image_job(move || display_copy_of(&bytes, &owned_mime)).await?;
    match made {
        Ok(Some(copy)) => {
            let key = display_key(id, mime);
            state.storage.put_bytes(&key, &copy, &serve).await?;
            Ok(key)
        }
        Ok(None) | Err(_) => Ok(object_key.to_string()),
    }
}
