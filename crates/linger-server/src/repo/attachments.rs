//! Assembling `wire::Attachment`, and the arithmetic behind the storage pool.

use std::collections::HashMap;

use linger_core::wire::{Attachment, Message};
use linger_core::{AttachmentId, MessageId, UserId};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::config::Config;
use crate::error::ApiError;

/// An attachment row as the server needs it internally — the wire type has no
/// object keys or state on it, because neither is any of the client's business.
pub struct Record {
    pub id: AttachmentId,
    pub message_id: Option<MessageId>,
    pub uploader_id: UserId,
    pub object_key: String,
    pub poster_key: Option<String>,
    /// What an image is drawn from where it is shown small (#382): its display
    /// copy, or its own `object_key`. `None` for an image from before copies,
    /// until `display.rs` has made its, and for anything that isn't an image.
    pub display_key: Option<String>,
    pub filename: String,
    pub mime: String,
    pub size_bytes: u64,
    pub state: String,
}

#[allow(clippy::cast_sign_loss)]
fn row_to_record(row: &SqliteRow) -> Result<Record, ApiError> {
    Ok(Record {
        id: AttachmentId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?,
        message_id: row
            .get::<Option<Vec<u8>>, _>("message_id")
            .map(|b| MessageId::from_slice(&b))
            .transpose()
            .map_err(anyhow::Error::from)?,
        uploader_id: UserId::from_slice(&row.get::<Vec<u8>, _>("uploader_id"))
            .map_err(anyhow::Error::from)?,
        object_key: row.get("object_key"),
        poster_key: row.get("poster_key"),
        display_key: row.get("display_key"),
        filename: row.get("filename"),
        mime: row.get("mime"),
        size_bytes: row.get::<i64, _>("size_bytes").max(0) as u64,
        state: row.get("state"),
    })
}

#[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
pub(crate) fn row_to_attachment(row: &SqliteRow, config: &Config) -> Result<Attachment, ApiError> {
    let record = row_to_record(row)?;
    Ok(Attachment {
        id: record.id,
        filename: record.filename,
        mime: record.mime,
        size_bytes: record.size_bytes,
        url: config.object_url(&record.object_key),
        width: row.get::<Option<i64>, _>("width").map(|v| v.max(0) as u32),
        height: row.get::<Option<i64>, _>("height").map(|v| v.max(0) as u32),
        duration_ms: row
            .get::<Option<i64>, _>("duration_ms")
            .map(|v| v.max(0) as u64),
        blurhash: row.get("blurhash"),
        poster_url: record.poster_key.map(|key| config.object_url(&key)),
        display_url: record.display_key.map(|key| config.object_url(&key)),
        starred_at: row.get("starred_at"),
        uploader_id: record.uploader_id,
        created_at: row.get("created_at"),
    })
}

/// The internal record for one attachment, whatever state it is in.
pub async fn record(db: &SqlitePool, id: AttachmentId) -> Result<Option<Record>, ApiError> {
    let row = sqlx::query("SELECT * FROM attachments WHERE id = ?")
        .bind(id.to_vec())
        .fetch_optional(db)
        .await?;
    row.as_ref().map(row_to_record).transpose()
}

/// One finished attachment, as the client sees it.
pub async fn by_id(
    db: &SqlitePool,
    config: &Config,
    id: AttachmentId,
) -> Result<Option<Attachment>, ApiError> {
    let row = sqlx::query("SELECT * FROM attachments WHERE id = ? AND state = 'complete'")
        .bind(id.to_vec())
        .fetch_optional(db)
        .await?;
    row.as_ref()
        .map(|row| row_to_attachment(row, config))
        .transpose()
}

/// Hang each message's finished attachments off it, oldest first.
pub async fn hydrate(
    db: &SqlitePool,
    config: &Config,
    messages: &mut [Message],
) -> Result<(), ApiError> {
    if messages.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; messages.len()].join(",");
    let sql = format!(
        "SELECT * FROM attachments
         WHERE state = 'complete' AND message_id IN ({placeholders})
         ORDER BY id"
    );
    let mut query = sqlx::query(&sql);
    for message in messages.iter() {
        query = query.bind(message.id.to_vec());
    }
    let rows = query.fetch_all(db).await?;

    let mut grouped: HashMap<MessageId, Vec<Attachment>> = HashMap::new();
    for row in &rows {
        let message_id = row_to_record(row)?
            .message_id
            .ok_or_else(|| anyhow::anyhow!("attachment matched a message id but has none"))?;
        grouped
            .entry(message_id)
            .or_default()
            .push(row_to_attachment(row, config)?);
    }
    for message in messages.iter_mut() {
        message.attachments = grouped.remove(&message.id).unwrap_or_default();
    }
    Ok(())
}

/// Bytes already spoken for: everything stored, plus everything mid-upload.
///
/// In-flight uploads count. Otherwise a full server would hand out slots for
/// another fifty files and only notice when the last byte of each arrived.
#[allow(clippy::cast_sign_loss)]
pub async fn pool_used(db: &SqlitePool) -> Result<u64, ApiError> {
    let (used,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE state IN ('pending','complete')",
    )
    .fetch_one(db)
    .await?;
    Ok(used.max(0) as u64)
}
