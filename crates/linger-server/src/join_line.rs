//! The quiet line a room or DM gets when somebody joins its voice (SPEC §4.14,
//! #473): "Jules joined voice", written by the server as a message from them
//! and marked `wire::Message::voice_join`.
//!
//! Two rules keep it from ever filling a room, and both live here:
//!
//! - **It is written once somebody has stayed** (`Config::voice_line_after`,
//!   ten seconds). A misclick on Join, or a join that ends at once, leaves
//!   nothing behind. "Stayed" means the same seat throughout: leaving and
//!   joining again inside the wait is a new seat with a wait of its own.
//! - **At most one per person per room every ten minutes**
//!   (`VOICE_JOIN_LINE_EVERY_MS`), however often they join in between.
//!   That is counted from the lines already stored, not from memory, so a
//!   restart forgets nothing, and it is checked by the same statement that
//!   writes the line, so two of somebody's devices joining at once still
//!   write one.

use linger_core::gateway::ServerEvent;
use linger_core::limits::VOICE_JOIN_LINE_EVERY_MS;
use linger_core::{MessageId, RoomId, UserId};
use sqlx::SqlitePool;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

/// What the line says, to an app that doesn't know the field and shows it as
/// an ordinary message from whoever joined.
pub const BODY: &str = "joined voice";

/// Somebody just took seat `number` in a room's voice: after the wait, if
/// they still hold it, write the line and tell the room.
///
/// Runs on its own task, so the socket that asked goes straight back to
/// reading frames. Nothing waits on it, and a failure is logged rather than
/// sent anywhere: the line is a courtesy, and nobody's voice depends on it.
pub fn after_join(
    state: AppState,
    session_id: String,
    user_id: UserId,
    room_id: RoomId,
    number: u64,
) {
    tokio::spawn(async move {
        tokio::time::sleep(state.config.voice_line_after).await;
        if !state.gateway.holds_seat(&session_id, room_id, number) {
            return;
        }
        let written = match write(&state.db.write, user_id, room_id, now_ms()).await {
            Ok(written) => written,
            Err(error) => {
                tracing::warn!(error = ?error, "couldn't write a voice join line");
                return;
            }
        };
        let Some(id) = written else {
            return;
        };
        match repo::messages::expect(&state.db.read, &state.config, id).await {
            Ok(message) => state.gateway.publish(ServerEvent::MessageCreate(message)),
            Err(error) => tracing::warn!(error = ?error, "couldn't read a voice join line back"),
        }
    });
}

/// Write the line at `at`, unless this person already has one in this room
/// in the ten minutes before, or the room is archived. Answers the line's id
/// when one was written.
///
/// One statement, so the check and the write can't be split by another
/// device's join: SQLite runs it whole, on the one writer.
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
        "INSERT INTO messages (id, room_id, author_id, body, created_at, voice_join)
         SELECT ?, ?, ?, ?, ?, 1
         WHERE NOT EXISTS (
                 SELECT 1 FROM messages
                  WHERE room_id = ? AND author_id = ? AND voice_join = 1 AND created_at > ?)
           AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND archived_at IS NULL)",
    )
    .bind(id.to_vec())
    .bind(room_id.to_vec())
    .bind(user_id.to_vec())
    .bind(BODY)
    .bind(at)
    .bind(room_id.to_vec())
    .bind(user_id.to_vec())
    .bind(at - VOICE_JOIN_LINE_EVERY_MS)
    .bind(room_id.to_vec())
    .execute(db)
    .await?;
    Ok((written.rows_affected() == 1).then_some(id))
}
