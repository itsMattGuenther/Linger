//! Assembling `wire::CustomEmoji` (#359): a `custom_emoji` row and the
//! attachment that is its picture.

use linger_core::wire::CustomEmoji;
use linger_core::EmojiId;
use linger_core::{AttachmentId, UserId};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::config::Config;
use crate::error::ApiError;

const EMOJI_SELECT: &str = "
    SELECT e.id, e.name, e.created_by, e.created_at, a.object_key, a.mime
    FROM custom_emoji e
    JOIN attachments a ON a.id = e.attachment_id";

fn row_to_emoji(row: &SqliteRow, config: &Config) -> Result<CustomEmoji, ApiError> {
    Ok(CustomEmoji {
        id: EmojiId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?,
        name: row.get("name"),
        url: config.object_url(&row.get::<String, _>("object_key")),
        // A GIF goes through the upload pipeline frame by frame, so it stays
        // animated; every other kind is still.
        animated: row.get::<String, _>("mime") == "image/gif",
        created_by: UserId::from_slice(&row.get::<Vec<u8>, _>("created_by"))
            .map_err(anyhow::Error::from)?,
        created_at: row.get("created_at"),
    })
}

/// Every emoji on the server, by name: what `GET /emoji`, `ready` and every
/// `emoji.update` carry.
pub async fn all(db: &SqlitePool, config: &Config) -> Result<Vec<CustomEmoji>, ApiError> {
    let rows = sqlx::query(&format!("{EMOJI_SELECT} ORDER BY e.name"))
        .fetch_all(db)
        .await?;
    rows.iter().map(|row| row_to_emoji(row, config)).collect()
}

/// One emoji, or `None` when there is no such one.
pub async fn by_id(
    db: &SqlitePool,
    config: &Config,
    id: EmojiId,
) -> Result<Option<CustomEmoji>, ApiError> {
    let row = sqlx::query(&format!("{EMOJI_SELECT} WHERE e.id = ?"))
        .bind(id.to_vec())
        .fetch_optional(db)
        .await?;
    row.map(|row| row_to_emoji(&row, config)).transpose()
}

/// How many emoji the server has.
pub async fn count(db: &SqlitePool) -> Result<usize, ApiError> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM custom_emoji")
        .fetch_one(db)
        .await?;
    Ok(usize::try_from(count).unwrap_or(usize::MAX))
}

/// Whether an attachment is an emoji's picture: one that never expires, can't
/// go on a message and can't be thrown away as an upload.
pub async fn is_picture(db: &SqlitePool, attachment: AttachmentId) -> Result<bool, ApiError> {
    let found: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM custom_emoji WHERE attachment_id = ?")
            .bind(attachment.to_vec())
            .fetch_optional(db)
            .await?;
    Ok(found.is_some())
}

/// Whether a name is taken, by an emoji other than `except`.
pub async fn name_taken(
    db: &SqlitePool,
    name: &str,
    except: Option<EmojiId>,
) -> Result<bool, ApiError> {
    let found: Option<(Vec<u8>,)> = sqlx::query_as("SELECT id FROM custom_emoji WHERE name = ?")
        .bind(name)
        .fetch_optional(db)
        .await?;
    Ok(match found {
        None => false,
        Some((id,)) => except.is_none_or(|except| except.to_vec() != id),
    })
}

/// The attachment an emoji's picture is, or `None` when there is no such
/// emoji.
pub async fn picture_of(db: &SqlitePool, id: EmojiId) -> Result<Option<AttachmentId>, ApiError> {
    let found: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT attachment_id FROM custom_emoji WHERE id = ?")
            .bind(id.to_vec())
            .fetch_optional(db)
            .await?;
    match found {
        None => Ok(None),
        Some((bytes,)) => Ok(Some(
            AttachmentId::from_slice(&bytes).map_err(anyhow::Error::from)?,
        )),
    }
}
