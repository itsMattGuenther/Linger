//! Polls (SPEC §4.18, PROTOCOL §4, #474): a question the host or a co-host
//! asks a room, answered with a click. Asking, voting and closing are
//! `routes::polls`; this is what both they and the sweeper share: closing a
//! poll, and closing the ones whose time is up.
//!
//! **Every poll closes.** Whoever asked can close it sooner; otherwise the
//! sweeper closes it when `closes_at` comes, whether or not anybody is
//! online. Closing writes a line at the bottom of the room saying how it came
//! out, because after a fortnight the poll itself is a long way up.

use std::time::Duration;

use linger_core::gateway::ServerEvent;
use linger_core::{MessageId, UserId};
use sqlx::Row;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

/// How often the sweeper looks for polls whose time is up. A poll closes
/// within this of its time, which nobody waiting a day or a week will see.
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// Close a poll: `by` is who asked, or `None` when its time ran out. Writes
/// the closed line in the same transaction, then tells the room both: the
/// poll as it ended, then the line. Answers `false` when it was already
/// closed, or is gone, and changes nothing.
///
/// # Errors
///
/// The database's.
pub async fn close(
    state: &AppState,
    poll_id: MessageId,
    by: Option<UserId>,
) -> Result<bool, ApiError> {
    let at = now_ms();
    let mut tx = state.db.write.begin().await?;
    let closed = sqlx::query(
        "UPDATE polls SET closed_at = ?, closed_by = ?
          WHERE message_id = ? AND closed_at IS NULL
            AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND deleted_at IS NULL)",
    )
    .bind(at)
    .bind(by.map(|user| user.to_vec()))
    .bind(poll_id.to_vec())
    .bind(poll_id.to_vec())
    .execute(&mut *tx)
    .await?;
    if closed.rows_affected() == 0 {
        return Ok(false);
    }
    let poll = sqlx::query("SELECT m.room_id, m.author_id, p.question FROM polls p JOIN messages m ON m.id = p.message_id WHERE p.message_id = ?")
        .bind(poll_id.to_vec())
        .fetch_one(&mut *tx)
        .await?;
    let question: String = poll.get("question");
    let winners = repo::polls::winners(&mut tx, poll_id).await?;
    let line = MessageId::new();
    sqlx::query(
        "INSERT INTO messages (id, room_id, author_id, body, created_at, poll_closed)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(line.to_vec())
    .bind(poll.get::<Vec<u8>, _>("room_id"))
    .bind(poll.get::<Vec<u8>, _>("author_id"))
    .bind(closed_words(&question, &winners))
    .bind(at)
    .bind(poll_id.to_vec())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let poll = repo::messages::expect(&state.db.read, &state.config, poll_id).await?;
    state.gateway.publish(ServerEvent::MessageUpdate(poll));
    let line = repo::messages::expect(&state.db.read, &state.config, line).await?;
    state.gateway.publish(ServerEvent::MessageCreate(line));
    Ok(true)
}

/// What the closed line says, to an app that doesn't know the field and shows
/// it as an ordinary message: "Poll closed: “Which faction?” Horde won."
#[must_use]
pub fn closed_words(question: &str, winners: &[String]) -> String {
    let result = match winners {
        [] => "Nobody voted.".to_string(),
        [one] => format!("{one} won."),
        [first, second] => format!("{first} and {second} tied."),
        [rest @ .., last] => format!("{} and {last} tied.", rest.join(", ")),
    };
    format!("Poll closed: “{question}” {result}")
}

/// Close every open poll whose time is up. Answers how many it closed.
///
/// # Errors
///
/// The database's.
pub async fn close_due(state: &AppState) -> Result<usize, ApiError> {
    let due: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT p.message_id FROM polls p JOIN messages m ON m.id = p.message_id
          WHERE p.closed_at IS NULL AND p.closes_at <= ? AND m.deleted_at IS NULL
          ORDER BY p.closes_at",
    )
    .bind(now_ms())
    .fetch_all(&state.db.read)
    .await?;
    let mut closed = 0;
    for id in due {
        let id = MessageId::from_slice(&id).map_err(anyhow::Error::from)?;
        if close(state, id, None).await? {
            closed += 1;
        }
    }
    Ok(closed)
}

/// The sweeper: a pass at startup, for polls whose time ran out while the
/// server was down, then one every `SWEEP_INTERVAL`.
pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            if let Err(error) = close_due(&state).await {
                tracing::warn!(error = ?error, "closing polls whose time is up failed");
            }
        }
    })
}
