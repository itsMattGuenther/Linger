//! Assembling `wire::Room`, for both kinds of room (SPEC §4.13).
//!
//! `last_message_id` is the newest non-tombstone message — deleting something
//! must not make a room look newly active — and never a message-of-the-day
//! line (#464), a line saying somebody joined voice (#473), or the line a
//! closing poll leaves (#474), which tell nobody to come and look.
//!
//! **Every query here that a member could reach is membership-aware**, and the
//! ones that are not say so in their name. `all` is the server's public rooms;
//! `dms_for` is one person's DMs; `visible_to` answers "may this person see this
//! room at all", which is the check every other surface asks before it answers.

use linger_core::wire::{Motd, Room, RoomKind};
use linger_core::{MessageId, RoomId, UserId};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::error::ApiError;

const ROOM_SELECT: &str = "
    SELECT r.id, r.slug, r.name, r.topic, r.kind, r.position, r.archived_at,
           r.motd, r.motd_set_by, r.motd_set_at,
           (SELECT MAX(m.id) FROM messages m
             WHERE m.room_id = r.id AND m.deleted_at IS NULL
               AND m.motd = 0 AND m.voice_join = 0
               AND m.poll_closed IS NULL) AS last_message_id
    FROM rooms r";

fn row_to_room(row: &SqliteRow) -> Result<Room, ApiError> {
    let kind = match row.get::<String, _>("kind").as_str() {
        "dm" => RoomKind::Dm,
        _ => RoomKind::Room,
    };
    Ok(Room {
        id: RoomId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?,
        slug: row.get("slug"),
        name: row.get("name"),
        topic: row.get("topic"),
        kind,
        // Filled in by the callers that return DMs. A room's is `None` and
        // stays `None` — its members are everybody (see `wire::Room`).
        member_ids: None,
        position: row.get::<i64, _>("position") as i32,
        archived_at: row.get("archived_at"),
        last_message_id: row
            .get::<Option<Vec<u8>>, _>("last_message_id")
            .map(|b| MessageId::from_slice(&b))
            .transpose()
            .map_err(anyhow::Error::from)?,
        motd: motd_of(row)?,
    })
}

/// The room's message of the day: all three columns, or none (0012_motd.sql).
fn motd_of(row: &SqliteRow) -> Result<Option<Motd>, ApiError> {
    let text: Option<String> = row.get("motd");
    let set_by: Option<Vec<u8>> = row.get("motd_set_by");
    let set_at: Option<i64> = row.get("motd_set_at");
    let (Some(text), Some(set_by), Some(set_at)) = (text, set_by, set_at) else {
        return Ok(None);
    };
    Ok(Some(Motd {
        text,
        set_by: UserId::from_slice(&set_by).map_err(anyhow::Error::from)?,
        set_at,
    }))
}

/// The server's public rooms. Never a DM — `GET /rooms` and the `ready` frame's
/// `rooms` both come through here, and neither has ever been able to carry a
/// private conversation because this query cannot produce one.
pub async fn all(db: &SqlitePool) -> Result<Vec<Room>, ApiError> {
    let rows = sqlx::query(&format!(
        "{ROOM_SELECT} WHERE r.kind = 'room' ORDER BY r.position, r.slug"
    ))
    .fetch_all(db)
    .await?;
    rows.iter().map(row_to_room).collect()
}

/// One room by id, whatever kind it is and whoever is asking.
///
/// **This one does not check membership**, so it is not the function a route
/// should reach for. Use [`visible_to`], which is this plus the check.
pub async fn by_id(db: &SqlitePool, id: RoomId) -> Result<Option<Room>, ApiError> {
    let row = sqlx::query(&format!("{ROOM_SELECT} WHERE r.id = ?"))
        .bind(id.to_vec())
        .fetch_optional(db)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let mut room = row_to_room(&row)?;
    if room.kind == RoomKind::Dm {
        room.member_ids = Some(members(db, id).await?);
    }
    Ok(Some(room))
}

pub async fn expect(db: &SqlitePool, id: RoomId) -> Result<Room, ApiError> {
    by_id(db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("No such room on this server."))
}

/// The room, if this person is allowed to see it at all.
///
/// **This is the function routes should call**, and the refusal is deliberately
/// `NOT_FOUND` rather than `FORBIDDEN`: telling somebody "you may not see this
/// DM" tells them the DM exists, who it is between if they guessed the id, and
/// that there is something to be curious about. There is nothing a non-member
/// can ask that distinguishes a DM they are not in from a room that was never
/// there (PROTOCOL §3.1).
pub async fn visible_to(db: &SqlitePool, id: RoomId, user_id: UserId) -> Result<Room, ApiError> {
    let room = expect(db, id).await?;
    if room.kind == RoomKind::Room {
        return Ok(room);
    }
    let is_member = room
        .member_ids
        .as_ref()
        .is_some_and(|ids| ids.contains(&user_id));
    if is_member {
        Ok(room)
    } else {
        Err(ApiError::not_found("No such room on this server."))
    }
}

/// The DMs one person is in, newest conversation first.
///
/// Ordered by the newest message rather than by when the DM was made: a DM is
/// found by who you were just talking to, and a list ordered by creation puts
/// the conversation you have not touched in months at the top forever.
pub async fn dms_for(db: &SqlitePool, user_id: UserId) -> Result<Vec<Room>, ApiError> {
    let rows = sqlx::query(&format!(
        "{ROOM_SELECT}
         JOIN room_members me ON me.room_id = r.id AND me.user_id = ?
         WHERE r.kind = 'dm'
         ORDER BY last_message_id DESC, r.id DESC"
    ))
    .bind(user_id.to_vec())
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut room = row_to_room(row)?;
        room.member_ids = Some(members(db, room.id).await?);
        out.push(room);
    }
    Ok(out)
}

/// Who is in a DM. Empty for a public room, which has no rows here — its
/// members are everybody (migration `0005_dms.sql`).
///
/// **Deactivated accounts are dropped.** Removal from the server is a soft
/// delete, so the membership row survives it on purpose: `restore` puts
/// somebody back into the DMs they were in without anything having had to
/// remember what they were (T-413). Until then they are not a member here, and
/// this is the single place that decides it.
pub async fn members(db: &SqlitePool, room_id: RoomId) -> Result<Vec<UserId>, ApiError> {
    let rows = sqlx::query(
        "SELECT rm.user_id FROM room_members rm
         JOIN users u ON u.id = rm.user_id AND u.deactivated_at IS NULL
         WHERE rm.room_id = ?
         ORDER BY rm.user_id",
    )
    .bind(room_id.to_vec())
    .fetch_all(db)
    .await?;
    rows.iter()
        .map(|row| {
            UserId::from_slice(&row.get::<Vec<u8>, _>("user_id"))
                .map_err(|e| ApiError::from(anyhow::Error::from(e)))
        })
        .collect()
}

/// A SQL condition restricting rows to the rooms one person may see
/// (SPEC §4.13). `alias` is the table alias of the `messages` row.
///
/// **This is the shape every listing query has to use**, rather than checking a
/// room after the rows come back. The difference matters: a check is a line
/// somebody can write the next query without, and it will be a query about
/// something else entirely — the media grid growing a filter, the export
/// growing a format. Folded into the `WHERE`, it cannot be left out without
/// changing what the query obviously does.
///
/// Contributes one `?`, bound to the viewer's id. Public rooms are in it for
/// everybody; a DM is in it for its members.
///
/// The viewer's own account is not checked for `deactivated_at` here, because a
/// deactivated account cannot authenticate and so cannot be the viewer — the
/// place that check *does* belong is [`members`], which answers who is in a DM
/// rather than what one person can see.
///
/// **Every alias inside is chosen so the text contains no `m.` of its own.**
/// `repo::media::link_groups` builds its inner query by replacing `m.` with
/// `m2.` across the whole filter string, and an alias like `rm` would be
/// rewritten to `rm2` and break the query. `visible_rooms_survives_realiasing`
/// is the test that keeps that true.
#[must_use]
pub fn visible_rooms(alias: &str) -> String {
    format!(
        "{alias}.room_id IN (
             SELECT r2.id FROM rooms r2
             WHERE r2.kind = 'room'
                OR r2.id IN (SELECT x.room_id FROM room_members x WHERE x.user_id = ?)
         )"
    )
}

/// Every DM on the server with its members, for the gateway's audience index
/// (`Gateway::load_rooms`). Only called at startup and after a membership
/// change, never per frame.
pub async fn all_dm_members(db: &SqlitePool) -> Result<Vec<(RoomId, Vec<UserId>)>, ApiError> {
    let rows = sqlx::query("SELECT id FROM rooms WHERE kind = 'dm'")
        .fetch_all(db)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let id = RoomId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?;
        out.push((id, members(db, id).await?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `repo::media::link_groups` re-aliases its filter string by replacing
    /// `m.` with `m2.`, so anything this function emits has to survive that
    /// with only the message alias rewritten. An alias ending in `m` would be
    /// mangled into a name that is never declared, and the query would fail at
    /// runtime rather than here.
    #[test]
    fn visible_rooms_survives_realiasing() {
        let clause = visible_rooms("m");
        let inner = clause.replace("m.", "m2.");
        assert!(inner.starts_with("m2.room_id"));
        assert_eq!(
            inner.matches("m2.").count(),
            1,
            "the re-alias touched something other than the message alias: {inner}"
        );
        // And the subquery is untouched, so it still refers to aliases it declares.
        assert!(inner.contains("SELECT x.room_id FROM room_members x WHERE x.user_id = ?"));
        assert!(inner.contains("FROM rooms r2"));
    }

    #[test]
    fn visible_rooms_takes_exactly_one_bind() {
        assert_eq!(visible_rooms("m").matches('?').count(), 1);
    }
}
