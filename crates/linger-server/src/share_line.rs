//! The quiet line a room or DM gets when somebody shares their screen in its
//! voice (SPEC §4.20, #746): "Jules shared their screen", written by the
//! server as a message from them and marked `wire::Message::screen_share`.
//! An app that knows the field says "Jules is sharing their screen", with
//! Watch, while they still are. It never says what is shared (hard rule 2):
//! the server doesn't know, and nothing here could carry it.
//!
//! The same two rules as the line saying somebody joined voice
//! (`join_line.rs`) keep it from ever filling a room:
//!
//! - **It is written once a share has lasted** (`Config::share_line_after`,
//!   ten seconds). A misclick on Share, or stopping at once to pick another
//!   window, leaves nothing behind. "Lasted" means the same share
//!   throughout: sharing again, even at a new speed, is a new share with a
//!   wait of its own.
//! - **At most one per person per room every ten minutes**
//!   (`SCREEN_SHARE_LINE_EVERY_MS`), however often they share in between.
//!   Counted from the lines already stored, by the statement that writes the
//!   line, so a restart forgets nothing and two of somebody's computers
//!   sharing at once still write one.

use linger_core::gateway::ServerEvent;
use linger_core::limits::SCREEN_SHARE_LINE_EVERY_MS;
use linger_core::{MessageId, RoomId, UserId};
use sqlx::SqlitePool;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

/// What the line says, to an app that doesn't know the field and shows it as
/// an ordinary message from whoever shared.
pub const BODY: &str = "shared their screen";

/// `session_id` just started share socket `socket` in a room's voice: after
/// the wait, if that share is still going, write the line and tell the room.
///
/// Runs on its own task, so the share socket goes straight on to passing
/// frames. Nothing waits on it, and a failure is logged rather than sent
/// anywhere: the line is a courtesy, and nobody's screen depends on it.
pub fn after_share(
    state: AppState,
    session_id: String,
    user_id: UserId,
    room_id: RoomId,
    socket: u64,
) {
    tokio::spawn(async move {
        tokio::time::sleep(state.config.share_line_after).await;
        if !state
            .gateway
            .screens
            .holds_share(&session_id, room_id, socket)
        {
            return;
        }
        let written = match write(&state.db.write, user_id, room_id, now_ms()).await {
            Ok(written) => written,
            Err(error) => {
                tracing::warn!(error = ?error, "couldn't write a screen share line");
                return;
            }
        };
        let Some(id) = written else {
            return;
        };
        match repo::messages::expect(&state.db.read, &state.config, id).await {
            Ok(message) => state.gateway.publish(ServerEvent::MessageCreate(message)),
            Err(error) => tracing::warn!(error = ?error, "couldn't read a screen share line back"),
        }
    });
}

/// Write the line at `at`, unless this person already has one in this room
/// in the ten minutes before, or the room is archived. Answers the line's id
/// when one was written.
///
/// One statement, so the check and the write can't be split by another
/// computer's share: SQLite runs it whole, on the one writer.
///
/// # Errors
///
/// The database's.
pub async fn write(
    db: &SqlitePool,
    user_id: UserId,
    room_id: RoomId,
    at: i64,
) -> Result<Option<MessageId>, ApiError> {
    let id = MessageId::new();
    let written = sqlx::query(
        "INSERT INTO messages (id, room_id, author_id, body, created_at, screen_share)
         SELECT ?, ?, ?, ?, ?, 1
         WHERE NOT EXISTS (
                 SELECT 1 FROM messages
                  WHERE room_id = ? AND author_id = ? AND screen_share = 1 AND created_at > ?)
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND archived_at IS NULL)",
    )
    .bind(id.to_vec())
    .bind(room_id.to_vec())
    .bind(user_id.to_vec())
    .bind(BODY)
    .bind(at)
    .bind(room_id.to_vec())
    .bind(user_id.to_vec())
    .bind(at - SCREEN_SHARE_LINE_EVERY_MS)
    .bind(room_id.to_vec())
    .execute(db)
    .await?;
    Ok((written.rows_affected() == 1).then_some(id))
}
