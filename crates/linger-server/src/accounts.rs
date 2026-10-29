//! Deleting an account (#650, SPEC §4.19, PROTOCOL §5).
//!
//! Both app stores require that somebody who made an account in the app can
//! delete it there. Two ways in share this module: a person deleting their own
//! (`POST /me/delete`, password first), and the host deleting the account of
//! somebody they removed, who can't sign in to do it (`POST /users/:id/delete`).
//!
//! **The `users` row stays, emptied.** Messages, files, invites, emoji, polls
//! and reports point at it without `ON DELETE CASCADE`, and the links that do
//! cascade would take the reports about the person with them (migration
//! `0025_deleted_accounts.sql`). So everything about the person goes and the
//! row is left as a stand-in: no name, no password, no style, status or sound.
//! The username stays, which keeps it taken, because a mention is stored as
//! the text `@username` and a newcomer who took the name would inherit every
//! old mention of the person who left.
//!
//! **What they wrote is their choice** (Matt, 2026-10-17). By default it stays
//! and loses its name: the app draws it as "Deleted account", and nobody's
//! conversation is left with holes. With `everything`, their messages become
//! tombstones as a deleted message does, their files go with them, and their
//! reactions and their votes in open polls go too. A closed poll keeps how it
//! came out (SPEC §4.18), so a vote in one stays, nameless.

use std::collections::BTreeSet;
use std::time::Duration;

use linger_core::gateway::ServerEvent;
use linger_core::{MessageId, RoomId, UserId};

use crate::auth;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::repo::dms::Left;
use crate::state::AppState;

/// What changed for other people, gathered inside the transaction and told to
/// them once it has committed.
#[derive(Default)]
struct Erased {
    /// Their messages that became tombstones, with their rooms.
    messages: Vec<(MessageId, RoomId)>,
    /// Reaction groups that lost their reaction: message, room, emoji.
    reactions: BTreeSet<(MessageId, RoomId, String)>,
    /// Open polls that lost their vote.
    polls: Vec<MessageId>,
    /// Rooms whose message of the day was theirs.
    motd_rooms: Vec<RoomId>,
    /// The DMs they were in that changed: left, or deleted with nobody left.
    dms: Vec<(RoomId, Left)>,
}

/// How many frames of a large deletion go out before a pause. A person can
/// have written thousands of messages, and the gateway's bus holds 1024
/// frames: published all at once, every session would fall behind it and be
/// cut off (`gateway::mod`, "Lagged"). Paced, a deletion of 20,000 messages
/// takes twenty seconds to reach everybody, and nobody is cut off.
const FRAMES_PER_STEP: usize = 50;
const STEP: Duration = Duration::from_millis(50);

/// Delete `id`'s account. The caller has checked who may; this refuses only
/// the host, who must never be deleted (decision 4: the server would have
/// nobody in charge), and an account already deleted, which is `NOT_FOUND`.
///
/// # Errors
///
/// `NOT_FOUND` for no such account, a deleted one, or the host's. Otherwise
/// the database's. Telling the others happens after the commit and never
/// fails the call: the deletion has happened by then.
pub async fn delete(state: &AppState, id: UserId, everything: bool) -> Result<(), ApiError> {
    let now = now_ms();
    let mut tx = state.db.write.begin().await?;

    // On the one writer, inside the transaction, so a person deleting on two
    // devices at once, or while the host does, deletes once.
    let emptied = sqlx::query(
        "UPDATE users
            SET display_name = '', password_hash = '', is_cohost = 0, time_zone = NULL,
                last_seen_at = NULL, deactivated_at = COALESCE(deactivated_at, ?),
                deleted_at = ?
          WHERE id = ? AND is_host = 0 AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(now)
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if emptied == 0 {
        return Err(ApiError::not_found("No such person on this server."));
    }
    // Every sign-in, access tokens included (#496); then the rows themselves,
    // which name their devices.
    auth::end_sign_ins(&mut tx, id, now).await?;

    let mut erased = Erased::default();
    if everything {
        erased = erase_what_they_wrote(&mut tx, id, now).await?;
    }

    // What was theirs alone. Blocks *of* them stay: somebody who blocked them
    // chose not to see what they wrote, and that doesn't change because they
    // left. Reports stay, both ways, for the host: deleting an account must
    // not be a way to erase the reports about it.
    for statement in [
        "DELETE FROM user_style WHERE user_id = ?",
        "DELETE FROM user_status WHERE user_id = ?",
        "DELETE FROM user_status_fields WHERE user_id = ?",
        "DELETE FROM entrance_sounds WHERE user_id = ?",
        "DELETE FROM read_markers WHERE user_id = ?",
        "DELETE FROM notify_rules WHERE user_id = ?",
        "DELETE FROM notify_rules WHERE target_user_id = ?",
        "DELETE FROM blocks WHERE user_id = ?",
        "DELETE FROM refresh_tokens WHERE user_id = ?",
        "DELETE FROM sign_in_links WHERE user_id = ?",
        "DELETE FROM message_nonces WHERE author_id = ?",
    ] {
        sqlx::query(statement)
            .bind(id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    // Their invites stop working, as on removal. The rows stay: they say who
    // let whom in, and a code is nothing personal.
    sqlx::query("UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL")
        .bind(now)
        .bind(id.to_vec())
        .execute(&mut *tx)
        .await?;
    erased.dms = repo::dms::leave_all(&mut tx, id).await?;
    tx.commit().await?;

    // Written first, then enforced, as removal does: a socket closed before
    // the commit could identify again into an account that still worked.
    state.gateway.close_sessions_for(id).await;
    // Out of every DM's audience, the ones whose rows stay included: the row
    // of a deactivated account doesn't count (`repo::rooms::members`). Their
    // sessions are closed already and can't open again, so a reload that
    // fails leaves nothing reachable; the next one puts the map right.
    if let Err(err) = state.gateway.reload_dms(&state.db.read).await {
        tracing::warn!(error = ?err, "couldn't reload DM audiences after deleting an account");
    }
    state.gateway.publish(ServerEvent::UserRemove {
        user_id: id,
        deleted: Some(true),
    });

    // From here the account is gone whatever happens, so failures are logged,
    // not answered: an error would tell the person it didn't happen.
    if let Err(err) = crate::unsent::release_for(state, id).await {
        tracing::warn!(error = ?err, "could not release a deleted account's uploads");
    }
    if let Err(err) = crate::export::forget(state, id).await {
        tracing::warn!(error = ?err, "could not delete a deleted account's export");
    }
    let state = state.clone();
    tokio::spawn(async move { tell_the_others(&state, erased).await });
    Ok(())
}

/// The "also delete everything I wrote" half, on the deletion's transaction.
async fn erase_what_they_wrote(
    tx: &mut sqlx::SqliteConnection,
    id: UserId,
    now: i64,
) -> Result<Erased, ApiError> {
    // Everything they wrote except the quiet lines saying they joined voice,
    // left a DM or shared their screen, which are about them being there
    // rather than anything they said, and carry no words of theirs.
    const THEIRS: &str =
        "author_id = ? AND deleted_at IS NULL AND voice_join = 0 AND dm_left = 0 AND screen_share = 0";

    let rows: Vec<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as(&format!("SELECT id, room_id FROM messages WHERE {THEIRS}"))
            .bind(id.to_vec())
            .fetch_all(&mut *tx)
            .await?;
    let mut erased = Erased::default();
    for (message, room) in rows {
        erased.messages.push((
            MessageId::from_slice(&message).map_err(anyhow::Error::from)?,
            RoomId::from_slice(&room).map_err(anyhow::Error::from)?,
        ));
    }
    // As `routes::messages::delete` makes one, all at once: what hung off
    // them goes, then the words. The sweeper takes their files.
    for statement in [
        "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE {THEIRS})",
        "DELETE FROM message_links WHERE message_id IN (SELECT id FROM messages WHERE {THEIRS})",
    ] {
        sqlx::query(&statement.replace("{THEIRS}", THEIRS))
            .bind(id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(&format!(
        "UPDATE messages SET body = '', deleted_at = ?, pinned_at = NULL WHERE {THEIRS}"
    ))
    .bind(now)
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?;

    // Their reactions on everybody else's messages.
    let reacted: Vec<(Vec<u8>, Vec<u8>, String)> = sqlx::query_as(
        "SELECT r.message_id, m.room_id, r.key
           FROM reactions r JOIN messages m ON m.id = r.message_id
          WHERE r.user_id = ?",
    )
    .bind(id.to_vec())
    .fetch_all(&mut *tx)
    .await?;
    for (message, room, key) in reacted {
        erased.reactions.insert((
            MessageId::from_slice(&message).map_err(anyhow::Error::from)?,
            RoomId::from_slice(&room).map_err(anyhow::Error::from)?,
            key,
        ));
    }
    sqlx::query("DELETE FROM reactions WHERE user_id = ?")
        .bind(id.to_vec())
        .execute(&mut *tx)
        .await?;

    // Their votes in polls still open. A closed poll keeps how it came out.
    let open = "SELECT message_id FROM polls WHERE closed_at IS NULL";
    let polls: Vec<Vec<u8>> = sqlx::query_scalar(&format!(
        "SELECT DISTINCT message_id FROM poll_votes WHERE user_id = ? AND message_id IN ({open})"
    ))
    .bind(id.to_vec())
    .fetch_all(&mut *tx)
    .await?;
    for poll in polls {
        erased
            .polls
            .push(MessageId::from_slice(&poll).map_err(anyhow::Error::from)?);
    }
    sqlx::query(&format!(
        "DELETE FROM poll_votes WHERE user_id = ? AND message_id IN ({open})"
    ))
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?;

    // A message of the day they set is words of theirs too.
    let motd_rooms: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT id FROM rooms WHERE motd_set_by = ? AND motd IS NOT NULL")
            .bind(id.to_vec())
            .fetch_all(&mut *tx)
            .await?;
    for room in motd_rooms {
        erased
            .motd_rooms
            .push(RoomId::from_slice(&room).map_err(anyhow::Error::from)?);
    }
    sqlx::query(
        "UPDATE rooms SET motd = NULL, motd_set_by = NULL, motd_set_at = NULL WHERE motd_set_by = ?",
    )
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?;
    Ok(erased)
}

/// Tell everybody what the deletion changed for them, after it has committed.
///
/// The quick things first: the DMs they left and the rooms whose message of
/// the day went. Then the frames that can number thousands, paced so that no
/// session falls behind the bus ([`FRAMES_PER_STEP`]). A failure is logged and
/// the rest goes on; anybody who missed something has it at their next fresh
/// `ready` or the next time they load the room.
async fn tell_the_others(state: &AppState, erased: Erased) {
    let mut emptied = false;
    for (room_id, left) in &erased.dms {
        match left {
            Left::Stays { line } => {
                if let Err(err) = crate::routes::dms::tell_the_others(state, *room_id, *line).await
                {
                    tracing::warn!(error = ?err, "couldn't tell a DM a deleted account left it");
                }
            }
            Left::Emptied => emptied = true,
        }
    }
    for room_id in &erased.motd_rooms {
        match repo::rooms::expect(&state.db.read, *room_id).await {
            Ok(room) => state.gateway.publish(ServerEvent::RoomUpdate(room)),
            Err(err) => {
                tracing::warn!(error = ?err, "couldn't read back a room whose message of the day went")
            }
        }
    }

    let mut sent = 0;
    let mut pace = || {
        sent += 1;
        sent % FRAMES_PER_STEP == 0
    };
    for (id, room_id) in &erased.messages {
        state.gateway.publish(ServerEvent::MessageDelete {
            id: *id,
            room_id: *room_id,
        });
        if pace() {
            tokio::time::sleep(STEP).await;
        }
    }
    for (message_id, room_id, key) in &erased.reactions {
        match repo::messages::reaction_group(&state.db.read, *message_id, key).await {
            Ok(group) => state.gateway.publish_in(
                *room_id,
                ServerEvent::ReactionUpdate {
                    message_id: *message_id,
                    key: group.key,
                    count: group.count,
                    user_ids: group.user_ids,
                },
            ),
            Err(err) => {
                tracing::warn!(error = ?err, "couldn't read back a reaction a deleted account took")
            }
        }
        if pace() {
            tokio::time::sleep(STEP).await;
        }
    }
    for poll in &erased.polls {
        match repo::messages::expect(&state.db.read, &state.config, *poll).await {
            Ok(message) => state.gateway.publish(ServerEvent::MessageUpdate(message)),
            Err(err) => {
                tracing::warn!(error = ?err, "couldn't read back a poll a deleted account voted in")
            }
        }
        if pace() {
            tokio::time::sleep(STEP).await;
        }
    }

    // Their files, and an emptied DM's, needn't wait for the sweeper's next
    // pass, up to six hours off, to give the server its space back.
    if emptied || !erased.messages.is_empty() {
        if let Err(err) = crate::expiry::sweep(state).await {
            tracing::warn!(error = ?err, "couldn't sweep a deleted account's files");
        }
    }
}
