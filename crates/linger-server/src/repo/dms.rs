//! Making, finding and leaving DMs (SPEC §4.13, PROTOCOL §3.1, T-1301, #565).
//!
//! One function makes them, and the thing it has to get right is that asking
//! twice for a DM with the same people gives you the same DM. Otherwise a group
//! of three ends up with four conversations, none of which has all of what was
//! said. The other takes somebody out of a group, which is the one change a
//! DM's people ever take (#565).
//!
//! **The uniqueness is the database's, not this module's.** `member_key` is a
//! `UNIQUE` column (migration `0005_dms.sql`), so two people asking for the same
//! DM in the same instant produce one row and one conflict rather than two
//! rooms. A "check, then insert" in Rust cannot promise that, and a race that
//! rare is one nobody would ever reproduce from a bug report.

use linger_core::wire::{Room, RoomKind};
use linger_core::{MessageId, RoomId, UserId};
use sqlx::SqlitePool;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;

/// The canonical name for a set of people.
///
/// Sorted, hex, comma-joined. Sorting is the whole trick: a DM with Callie and
/// Dave has to be the same row as a DM with Dave and Callie, and the only way
/// to make two sets compare equal in a `UNIQUE` index is to write them down the
/// same way every time.
fn member_key(members: &[UserId]) -> String {
    let mut hexes: Vec<String> = members.iter().map(|id| hex::encode(id.to_vec())).collect();
    hexes.sort();
    hexes.join(",")
}

/// A DM's slug and name.
///
/// Both are generated and neither is for reading. `rooms.slug` is `NOT NULL
/// UNIQUE` and a good deal of the server addresses rooms by it, so a DM needs
/// one; but a DM is named by who is in it (SPEC §4.13), and a name computed
/// from its members would be wrong for everybody in it — Callie's DM with Dave
/// is "Dave" to Callie and "Callie" to Dave. So the client draws `member_ids`
/// and ignores both of these.
///
/// The `dm-` prefix is reserved: `validate::room_slug` refuses it, so a host
/// cannot make a public room whose slug collides with one of these.
fn generated_slug(id: RoomId) -> String {
    format!("dm-{}", hex::encode(id.to_vec()))
}

/// Find the DM for exactly this set of people, or make it.
///
/// `members` must already be validated: two to eight of them, all real, no
/// duplicates, and including the caller. This function does not re-check,
/// because the route is where a refusal has a sentence to go with it.
pub async fn create_or_find(
    read: &SqlitePool,
    write: &SqlitePool,
    members: &[UserId],
) -> Result<(Room, bool), ApiError> {
    let key = member_key(members);

    if let Some(existing) = by_key(read, &key).await? {
        return Ok((existing, false));
    }

    let id = RoomId::new();
    let now = now_ms();
    let mut tx = write.begin().await.map_err(ApiError::from)?;

    // `position` is what orders the room list, and a DM is not in it. Zero
    // rather than "after the last room": a DM that quietly moved every room's
    // position when it was made would be a private conversation with a visible
    // side effect.
    let inserted = sqlx::query(
        "INSERT INTO rooms (id, slug, name, topic, kind, member_key, position, created_at)
         VALUES (?, ?, ?, NULL, 'dm', ?, 0, ?)",
    )
    .bind(id.to_vec())
    .bind(generated_slug(id))
    .bind(generated_slug(id))
    .bind(&key)
    .bind(now)
    .execute(&mut *tx)
    .await;

    match inserted {
        Ok(_) => {}
        // Somebody else asked for the same DM between the lookup above and
        // here. Their row is the one that exists, so use it — this is the race
        // the UNIQUE index is there to lose gracefully.
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            tx.rollback().await.map_err(ApiError::from)?;
            let existing = by_key(read, &key)
                .await?
                .ok_or_else(|| ApiError::from(anyhow::anyhow!("dm vanished after conflict")))?;
            return Ok((existing, false));
        }
        Err(e) => return Err(e.into()),
    }

    for member in members {
        sqlx::query("INSERT INTO room_members (room_id, user_id, created_at) VALUES (?, ?, ?)")
            .bind(id.to_vec())
            .bind(member.to_vec())
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await.map_err(ApiError::from)?;

    Ok((repo::rooms::expect(read, id).await?, true))
}

/// What the line says to an app that doesn't know `Message::left` (#565),
/// which shows it as whoever left saying so.
pub const LEFT_BODY: &str = "left";

/// What leaving a group DM came to (#565).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Left {
    /// The others are still in it, and this is the line telling them.
    Stays { line: MessageId },
    /// That was the last person who could read it, so it's deleted: every
    /// message the way a deleted message is. Its files are the sweeper's.
    Emptied,
}

/// Take somebody out of a group DM (SPEC §4.13, PROTOCOL §3.1, #565).
///
/// **One transaction, so nothing is half done.** Their membership goes, which
/// is the whole of losing access: every surface asks `room_members` whose a
/// DM is (`repo::rooms::visible_to`, `visible_rooms`, `dms_for`). The DM's
/// `member_key` is cleared, so create-or-find never matches it again and
/// nobody asking for the same people is put back into a conversation they
/// left; the cleared key is also what marks it as a group from now on,
/// whatever its size. Their read position and notification rules for it go,
/// since nothing may name it to them any more. And the people still in it get
/// a line saying so, the way somebody joining voice does (#473).
///
/// When nobody who could read it is left, it is deleted instead of keeping
/// bytes nobody can reach: the messages become tombstones, as `DELETE
/// /messages/:id` makes them, their reactions and link cards go, and so do
/// the memberships of anybody removed from the server, who would otherwise
/// be put back into an empty shell by a restore (T-413).
///
/// # Errors
///
/// `NOT_FOUND` when this isn't a DM they're in, as for any room they can't
/// see; `VALIDATION_FAILED` for a one-to-one DM, which is their friend's row
/// in the list and can't be left. Otherwise the database's.
pub async fn leave(write: &SqlitePool, room_id: RoomId, user_id: UserId) -> Result<Left, ApiError> {
    let mut tx = write.begin().await?;

    // Asked inside the transaction, on the one writer, so two of somebody's
    // devices leaving at once can't both get past it.
    let found: Option<(Option<String>, i64)> = sqlx::query_as(
        "SELECT r.member_key,
                (SELECT COUNT(*) FROM room_members a WHERE a.room_id = r.id)
           FROM rooms r
           JOIN room_members me ON me.room_id = r.id AND me.user_id = ?
          WHERE r.id = ? AND r.kind = 'dm'",
    )
    .bind(user_id.to_vec())
    .bind(room_id.to_vec())
    .fetch_optional(&mut *tx)
    .await?;
    let Some((key, made_for)) = found else {
        return Err(ApiError::not_found("No such room on this server."));
    };
    // A key still in place means nobody has left yet, so its rows are the
    // people it was made for: two of them is a one-to-one DM. Removal from
    // the server keeps rows (T-413), so a removed friend still counts here.
    if key.is_some() && made_for <= 2 {
        return Err(ApiError::validation(
            "A DM with one person can't be left. It's their row in your list.",
        ));
    }

    for statement in [
        "DELETE FROM room_members WHERE room_id = ? AND user_id = ?",
        "DELETE FROM read_markers WHERE room_id = ? AND user_id = ?",
        "DELETE FROM notify_rules WHERE room_id = ? AND user_id = ?",
    ] {
        sqlx::query(statement)
            .bind(room_id.to_vec())
            .bind(user_id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE rooms SET member_key = NULL WHERE id = ?")
        .bind(room_id.to_vec())
        .execute(&mut *tx)
        .await?;

    // Who can still read it: `repo::rooms::members`' rule, asked of this
    // transaction rather than of a reader that can't see it yet.
    let staying: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM room_members rm
           JOIN users u ON u.id = rm.user_id AND u.deactivated_at IS NULL
          WHERE rm.room_id = ?",
    )
    .bind(room_id.to_vec())
    .fetch_one(&mut *tx)
    .await?;

    let left = if staying > 0 {
        let line = MessageId::new();
        sqlx::query(
            "INSERT INTO messages (id, room_id, author_id, body, created_at, dm_left)
             VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(line.to_vec())
        .bind(room_id.to_vec())
        .bind(user_id.to_vec())
        .bind(LEFT_BODY)
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
        Left::Stays { line }
    } else {
        empty(&mut tx, room_id).await?;
        Left::Emptied
    };

    tx.commit().await?;
    Ok(left)
}

/// Delete a DM nobody can read any more (`leave`): its messages become
/// tombstones, as a deleted message is (`routes::messages::delete`), and what
/// hung off them goes. The sweeper takes their files, which is what it does
/// for any deleted message's (`expiry`, rule 2).
///
/// The room's own row stays, as `kind = 'dm'` with nobody in it. That is what
/// keeps it private: the gateway treats a room it has no DM entry for as
/// public (`Gateway::can_see_room`), so a DM must never stop being one.
async fn empty(tx: &mut sqlx::SqliteConnection, room_id: RoomId) -> Result<(), ApiError> {
    for statement in [
        "DELETE FROM room_members WHERE room_id = ?",
        "DELETE FROM read_markers WHERE room_id = ?",
        "DELETE FROM notify_rules WHERE room_id = ?",
        "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE room_id = ?)",
        "DELETE FROM message_links WHERE message_id IN (SELECT id FROM messages WHERE room_id = ?)",
    ] {
        sqlx::query(statement)
            .bind(room_id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "UPDATE messages SET body = '', deleted_at = ?, pinned_at = NULL
          WHERE room_id = ? AND deleted_at IS NULL",
    )
    .bind(now_ms())
    .bind(room_id.to_vec())
    .execute(&mut *tx)
    .await?;
    Ok(())
}

async fn by_key(db: &SqlitePool, key: &str) -> Result<Option<Room>, ApiError> {
    let row: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT id FROM rooms WHERE member_key = ? AND kind = 'dm'")
            .bind(key)
            .fetch_optional(db)
            .await?;
    let Some(bytes) = row else { return Ok(None) };
    let id = RoomId::from_slice(&bytes).map_err(anyhow::Error::from)?;
    let room = repo::rooms::expect(db, id).await?;
    debug_assert_eq!(room.kind, RoomKind::Dm);
    Ok(Some(room))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_key_does_not_depend_on_the_order_asked_for() {
        let a = UserId::new();
        let b = UserId::new();
        let c = UserId::new();
        assert_eq!(member_key(&[a, b, c]), member_key(&[c, a, b]));
        assert_eq!(member_key(&[a, b]), member_key(&[b, a]));
    }

    #[test]
    fn different_sets_get_different_keys() {
        let a = UserId::new();
        let b = UserId::new();
        let c = UserId::new();
        assert_ne!(member_key(&[a, b]), member_key(&[a, c]));
        assert_ne!(member_key(&[a, b]), member_key(&[a, b, c]));
    }
}
