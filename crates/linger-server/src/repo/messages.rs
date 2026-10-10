//! Assembling `wire::Message`: page fetch, reaction grouping, attachments.

use std::collections::HashMap;

use linger_core::wire::{Message, PollClosed, ReactionGroup};
use linger_core::{MessageId, RoomId, UserId, REACTIONS};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::config::Config;
use crate::error::ApiError;

fn row_to_message(row: &SqliteRow) -> Result<Message, ApiError> {
    Ok(Message {
        id: MessageId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?,
        room_id: RoomId::from_slice(&row.get::<Vec<u8>, _>("room_id"))
            .map_err(anyhow::Error::from)?,
        author_id: UserId::from_slice(&row.get::<Vec<u8>, _>("author_id"))
            .map_err(anyhow::Error::from)?,
        body: row.get("body"),
        reply_to: row
            .get::<Option<Vec<u8>>, _>("reply_to")
            .map(|b| MessageId::from_slice(&b))
            .transpose()
            .map_err(anyhow::Error::from)?,
        attachments: Vec::new(),
        reactions: Vec::new(),
        pinned_at: row.get("pinned_at"),
        edited_at: row.get("edited_at"),
        deleted_at: row.get("deleted_at"),
        created_at: row.get("created_at"),
        // Only ever sent as `true`: every other message leaves it out.
        motd: row.get::<bool, _>("motd").then_some(true),
        voice_join: row.get::<bool, _>("voice_join").then_some(true),
        // `repo::polls::hydrate` fills the poll in, and the closed line's
        // question and result; the row only says which poll a line is about.
        poll: None,
        poll_closed: row
            .get::<Option<Vec<u8>>, _>("poll_closed")
            .map(|id| MessageId::from_slice(&id))
            .transpose()
            .map_err(anyhow::Error::from)?
            .map(|poll_id| PollClosed {
                poll_id,
                question: String::new(),
                winners: Vec::new(),
            }),
    })
}

/// Attach reaction groups to a batch of messages. Groups are emitted in the
/// canonical `REACTIONS` order; user_ids in first-reacted order (for hover).
async fn hydrate_reactions(db: &SqlitePool, messages: &mut [Message]) -> Result<(), ApiError> {
    if messages.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; messages.len()].join(",");
    let sql = format!(
        "SELECT message_id, key, user_id FROM reactions
         WHERE message_id IN ({placeholders}) ORDER BY created_at"
    );
    let mut query = sqlx::query(&sql);
    for m in messages.iter() {
        query = query.bind(m.id.to_vec());
    }
    let rows = query.fetch_all(db).await?;

    let mut grouped: HashMap<(MessageId, String), Vec<UserId>> = HashMap::new();
    for row in &rows {
        let mid = MessageId::from_slice(&row.get::<Vec<u8>, _>("message_id"))
            .map_err(anyhow::Error::from)?;
        let uid =
            UserId::from_slice(&row.get::<Vec<u8>, _>("user_id")).map_err(anyhow::Error::from)?;
        grouped.entry((mid, row.get("key"))).or_default().push(uid);
    }

    for m in messages.iter_mut() {
        m.reactions = REACTIONS
            .iter()
            .filter_map(|key| {
                grouped
                    .remove(&(m.id, (*key).to_string()))
                    .map(|user_ids| ReactionGroup {
                        key: (*key).to_string(),
                        count: user_ids.len() as u32,
                        user_ids,
                    })
            })
            .collect();
    }
    Ok(())
}

/// One fully assembled message.
pub async fn by_id(
    db: &SqlitePool,
    config: &Config,
    id: MessageId,
) -> Result<Option<Message>, ApiError> {
    let row = sqlx::query("SELECT * FROM messages WHERE id = ?")
        .bind(id.to_vec())
        .fetch_optional(db)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let mut messages = vec![row_to_message(&row)?];
    hydrate_reactions(db, &mut messages).await?;
    crate::repo::polls::hydrate(db, &mut messages).await?;
    crate::repo::attachments::hydrate(db, config, &mut messages).await?;
    Ok(messages.pop())
}

pub async fn expect(db: &SqlitePool, config: &Config, id: MessageId) -> Result<Message, ApiError> {
    by_id(db, config, id)
        .await?
        .ok_or_else(|| ApiError::not_found("No such message."))
}

/// A page of messages, newest-first (PROTOCOL §4). `before`/`after` are ids;
/// UUIDv7 blobs compare chronologically so this is a pure range scan.
pub async fn page(
    db: &SqlitePool,
    config: &Config,
    room_id: RoomId,
    before: Option<MessageId>,
    after: Option<MessageId>,
    limit: u32,
) -> Result<Vec<Message>, ApiError> {
    let mut sql = String::from("SELECT * FROM messages WHERE room_id = ?");
    if before.is_some() {
        sql.push_str(" AND id < ?");
    }
    if after.is_some() {
        sql.push_str(" AND id > ?");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");

    let mut query = sqlx::query(&sql).bind(room_id.to_vec());
    if let Some(b) = before {
        query = query.bind(b.to_vec());
    }
    if let Some(a) = after {
        query = query.bind(a.to_vec());
    }
    query = query.bind(i64::from(limit));

    let rows = query.fetch_all(db).await?;
    let mut messages = rows
        .iter()
        .map(row_to_message)
        .collect::<Result<Vec<_>, _>>()?;
    hydrate_reactions(db, &mut messages).await?;
    crate::repo::polls::hydrate(db, &mut messages).await?;
    crate::repo::attachments::hydrate(db, config, &mut messages).await?;
    Ok(messages)
}

/// A window of messages centred on one of them, for landing on a search hit
/// (SPEC §4.12, PROTOCOL §4).
///
/// Paging backwards cannot do this job. A hit six months back in a busy room is
/// thousands of messages behind the newest one, and walking there a page at a
/// time is dozens of round trips for history nobody asked to read. So the
/// window is fetched directly: the message itself, then as much either side of
/// it as `limit` allows.
///
/// Both halves are their own range scan on the same index the stream uses, and
/// the answer comes back newest-first like every other page from this endpoint,
/// so a client folds it in the way it folds any other.
///
/// The older half carries the target (`id <= around`) and gets the odd one when
/// `limit` is odd, because scrollback above a message is what gives it context
/// and the newer half is what a reader scrolls into next anyway.
pub async fn window(
    db: &SqlitePool,
    config: &Config,
    room_id: RoomId,
    around: MessageId,
    limit: u32,
) -> Result<Vec<Message>, ApiError> {
    let newer = limit / 2;
    let older = limit - newer;

    let sql = "SELECT * FROM (
                 SELECT * FROM messages WHERE room_id = ? AND id <= ? ORDER BY id DESC LIMIT ?
               )
               UNION ALL
               SELECT * FROM (
                 SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ?
               )
               ORDER BY id DESC";

    let rows = sqlx::query(sql)
        .bind(room_id.to_vec())
        .bind(around.to_vec())
        .bind(i64::from(older))
        .bind(room_id.to_vec())
        .bind(around.to_vec())
        .bind(i64::from(newer))
        .fetch_all(db)
        .await?;

    let mut messages = rows
        .iter()
        .map(row_to_message)
        .collect::<Result<Vec<_>, _>>()?;
    hydrate_reactions(db, &mut messages).await?;
    crate::repo::polls::hydrate(db, &mut messages).await?;
    crate::repo::attachments::hydrate(db, config, &mut messages).await?;
    Ok(messages)
}

/// A batch of messages in the order they were said, for anything that walks a
/// room forwards.
///
/// [`page`] is newest-first because the stream reads that way, and its `after`
/// still orders by `id DESC` — which is the newest messages after a point, not
/// the next ones. An archive reads the other way round, so it gets its own
/// query rather than a flag on that one.
pub async fn batch_ascending(
    db: &SqlitePool,
    config: &Config,
    room_id: RoomId,
    after: Option<MessageId>,
    limit: u32,
) -> Result<Vec<Message>, ApiError> {
    let mut sql = String::from("SELECT * FROM messages WHERE room_id = ?");
    if after.is_some() {
        sql.push_str(" AND id > ?");
    }
    sql.push_str(" ORDER BY id ASC LIMIT ?");

    let mut query = sqlx::query(&sql).bind(room_id.to_vec());
    if let Some(a) = after {
        query = query.bind(a.to_vec());
    }
    query = query.bind(i64::from(limit));

    let rows = query.fetch_all(db).await?;
    let mut messages = rows
        .iter()
        .map(row_to_message)
        .collect::<Result<Vec<_>, _>>()?;
    hydrate_reactions(db, &mut messages).await?;
    crate::repo::polls::hydrate(db, &mut messages).await?;
    crate::repo::attachments::hydrate(db, config, &mut messages).await?;
    Ok(messages)
}

/// One reaction key's current state on a message, for `reaction.update` fan-out.
pub async fn reaction_group(
    db: &SqlitePool,
    message_id: MessageId,
    key: &str,
) -> Result<ReactionGroup, ApiError> {
    let rows = sqlx::query(
        "SELECT user_id FROM reactions WHERE message_id = ? AND key = ? ORDER BY created_at",
    )
    .bind(message_id.to_vec())
    .bind(key)
    .fetch_all(db)
    .await?;
    let user_ids = rows
        .iter()
        .map(|r| UserId::from_slice(&r.get::<Vec<u8>, _>("user_id")).map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ReactionGroup {
        key: key.to_string(),
        count: user_ids.len() as u32,
        user_ids,
    })
}
