//! A post's one-time key (PROTOCOL §4, #524).
//!
//! The app makes one up for each send and sends it again with every retry of
//! that send. A post is all or nothing, so a retry after a post that failed
//! finds nothing here and posts. A retry after a post that was saved, whose
//! answer was lost on the way back, finds its key here and is answered with
//! that message instead of posting it a second time.
//!
//! A key is remembered for [`NONCE_KEPT_MS`], not for the message's life:
//! nothing but a retry ever asks, and a retry only comes from an app still
//! showing the unsent message. Each post that carries a key clears out the
//! ones past that first, so the table holds about a week of posts.
//!
//! A poll is a post too (`routes::polls`): asking one takes a key the same
//! way, and its keys live here with every other message's.

use linger_core::limits::NONCE_KEPT_MS;
use linger_core::{MessageId, UserId};
use sqlx::SqliteConnection;

use crate::error::ApiError;

/// The message this person posted with this key, if they did within the
/// last [`NONCE_KEPT_MS`]. A key only ever means something together with
/// who sent it: two people may happen to use the same one.
pub async fn posted<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    author: UserId,
    nonce: &str,
    now: i64,
) -> Result<Option<MessageId>, ApiError> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT message_id FROM message_nonces
         WHERE author_id = ? AND nonce = ? AND created_at >= ?",
    )
    .bind(author.to_vec())
    .bind(nonce)
    .bind(now - NONCE_KEPT_MS)
    .fetch_optional(db)
    .await?;
    row.map(|(bytes,)| MessageId::from_slice(&bytes).map_err(anyhow::Error::from))
        .transpose()
        .map_err(ApiError::from)
}

/// Forget every key older than [`NONCE_KEPT_MS`]. One indexed range delete,
/// run inside the post that is about to add a key, which is what keeps the
/// table from growing for as long as the server runs.
pub async fn forget_old<'e>(db: impl sqlx::SqliteExecutor<'e>, now: i64) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM message_nonces WHERE created_at < ?")
        .bind(now - NONCE_KEPT_MS)
        .execute(db)
        .await?;
    Ok(())
}

/// What a post asks inside its own transaction: clear out the old keys,
/// then [`posted`]. The clearing out is a write, so the transaction holds the
/// one writer (`db.rs`) from its first statement, and a retry sent while the
/// first try was still being saved waited for it and finds it here.
pub async fn check_in(
    conn: &mut SqliteConnection,
    author: UserId,
    nonce: &str,
    now: i64,
) -> Result<Option<MessageId>, ApiError> {
    forget_old(&mut *conn, now).await?;
    posted(&mut *conn, author, nonce, now).await
}

/// Remember that this person's key posted this message. Written in the same
/// transaction as the message, so a key is never remembered for a post that
/// didn't happen, and a post never happens without its key.
pub async fn remember<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    author: UserId,
    nonce: &str,
    message_id: MessageId,
    now: i64,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO message_nonces (author_id, nonce, message_id, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(author.to_vec())
    .bind(nonce)
    .bind(message_id.to_vec())
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}
