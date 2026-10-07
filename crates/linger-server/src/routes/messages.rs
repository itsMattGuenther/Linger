//! Messages, reactions, and read markers (PROTOCOL §4).
//!
//! Deletes are tombstones — the row stays so reply chains survive. And per the
//! AGENTS.md hard rule: nothing here computes or returns an unread count, and
//! nothing ever will.
//!
//! Files are uploaded first and attached second (PROTOCOL §6): by the time an
//! `attachment_id` reaches this module the bytes are already stored, checked
//! and re-encoded, and all that is left is to say which message they belong to.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::{MAX_ATTACHMENTS_PER_MESSAGE, RATE_MESSAGE_SEND};
use linger_core::wire::{
    CreateMessageRequest, EditMessageRequest, Message, UpdateReadMarkerRequest,
};
use linger_core::{MessageId, RoomId, UserId};
use serde::Deserialize;

use crate::auth::{self, AuthedUser, Standing};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::{repo, validate};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rooms/{id}/messages", get(page).post(create))
        .route("/rooms/{id}/read", put(put_read_marker))
        .route("/read", get(read_map))
        .route("/messages/{id}", axum::routing::patch(edit).delete(delete))
        .route("/messages/{id}/pin", post(pin).delete(unpin))
        .route(
            "/messages/{id}/reactions/{key}",
            put(add_reaction).delete(remove_reaction),
        )
}

#[derive(Deserialize)]
struct PageQuery {
    before: Option<MessageId>,
    after: Option<MessageId>,
    /// Centre the page on this message instead of paging from an edge
    /// (PROTOCOL §4). This is how a search hit is opened.
    around: Option<MessageId>,
    limit: Option<u32>,
}

async fn page(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(room_id): Path<RoomId>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Vec<Message>>, ApiError> {
    // A DM this person is not in answers exactly like a room that does not
    // exist (PROTOCOL §3.1) — 404, not 403, because "you may not read this"
    // confirms there is something to read.
    repo::rooms::visible_to(&state.db.read, room_id, auth.id).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);

    let Some(around) = query.around else {
        return repo::messages::page(
            &state.db.read,
            &state.config,
            room_id,
            query.before,
            query.after,
            limit,
        )
        .await
        .map(Json);
    };

    // Asking for a window *and* an edge is two different pages, and guessing
    // which one was meant is how a client ends up with history it did not ask
    // for and cannot tell is wrong.
    if query.before.is_some() || query.after.is_some() {
        return Err(ApiError::validation(
            "Ask for a window around a message or a page before one, not both.",
        ));
    }
    // A message that is not in this room means the caller is holding a stale
    // id — after a delete, or from another room. "Nothing here" and "not that
    // room" send a reader looking in different places.
    let target = repo::messages::expect(&state.db.read, &state.config, around).await?;
    if target.room_id != room_id {
        return Err(ApiError::not_found("That message isn't in this room."));
    }

    repo::messages::window(&state.db.read, &state.config, room_id, around, limit)
        .await
        .map(Json)
}

async fn create(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(room_id): Path<RoomId>,
    Json(req): Json<CreateMessageRequest>,
) -> Result<Json<Message>, ApiError> {
    if let Err(retry) = state
        .limiter
        .check(&format!("msg:{}", auth.id), RATE_MESSAGE_SEND)
    {
        return Err(ApiError::rate_limited(retry));
    }

    let room = repo::rooms::visible_to(&state.db.read, room_id, auth.id).await?;
    if room.archived_at.is_some() {
        return Err(ApiError::validation("That room is archived."));
    }
    let attachment_ids = req.attachment_ids.clone().unwrap_or_default();
    check_attachments(&state, auth.id, &attachment_ids).await?;
    let body = if attachment_ids.is_empty() {
        validate::message_body(&req.body)?
    } else {
        validate::caption(&req.body)?
    };
    if let Some(reply_to) = req.reply_to {
        let parent = repo::messages::expect(&state.db.read, &state.config, reply_to).await?;
        if parent.room_id != room_id {
            return Err(ApiError::validation("Replies stay in their room."));
        }
    }

    let id = MessageId::new();
    sqlx::query(
        "INSERT INTO messages (id, room_id, author_id, body, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id.to_vec())
    .bind(room_id.to_vec())
    .bind(auth.id.to_vec())
    .bind(&body)
    .bind(req.reply_to.map(|r| r.to_vec()))
    .bind(now_ms())
    .execute(&state.db.write)
    .await?;

    // What the message links to, recorded as it is posted so the media grid's
    // links are a table read rather than a scan of every body ever written
    // (SPEC §4.4). The cards themselves are filled in later, on demand, by
    // `POST /links/preview` — nothing here touches the network.
    repo::links::replace_for_message(&state.db.write, id, &crate::links::extract(&body)).await?;

    // Attaching is the last step of the upload pipeline (ARCHITECTURE §8): the
    // file has been stored and checked for a while by now, and this is the
    // moment it becomes part of the conversation.
    for attachment_id in &attachment_ids {
        sqlx::query("UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL")
            .bind(id.to_vec())
            .bind(attachment_id.to_vec())
            .execute(&state.db.write)
            .await?;
    }

    // Saying something is catching up: your own message never makes a room
    // look new on any of your devices (#454). Moved here rather than left to
    // the sending device, whose debounced write is lost when a phone is put
    // away straight after sending.
    advance_read_marker(&state, auth.id, room_id, id).await?;

    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    state
        .gateway
        .publish(ServerEvent::MessageCreate(message.clone()));
    Ok(Json(message))
}

/// A message may only carry uploads that finished, that this person uploaded,
/// and that are not already hanging off another message.
///
/// The uploader check is the one that matters: without it, an attachment id is
/// a bearer token for somebody else's file, and posting it would republish
/// their upload under your name.
async fn check_attachments(
    state: &AppState,
    author: UserId,
    ids: &[linger_core::AttachmentId],
) -> Result<(), ApiError> {
    if ids.is_empty() {
        return Ok(());
    }
    if ids.len() > MAX_ATTACHMENTS_PER_MESSAGE {
        return Err(ApiError::validation(format!(
            "One message carries at most {MAX_ATTACHMENTS_PER_MESSAGE} files."
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(*id) {
            return Err(ApiError::validation("That file is on the message twice."));
        }
        let record = repo::attachments::record(&state.db.read, *id)
            .await?
            .ok_or_else(|| ApiError::not_found("No such upload."))?;
        if record.uploader_id != author {
            return Err(ApiError::forbidden("That upload isn't yours."));
        }
        if record.state != "complete" {
            return Err(ApiError::validation("That upload hasn't finished."));
        }
        if record.message_id.is_some() {
            return Err(ApiError::conflict("That file is already on a message."));
        }
        // On a message, it would go when the message is deleted (#359).
        if repo::emoji::is_picture(&state.db.read, *id).await? {
            return Err(ApiError::conflict(
                "That picture is one of the server's emoji.",
            ));
        }
    }
    Ok(())
}

/// A message this person is allowed to touch at all.
///
/// Every route below takes a message id straight from the caller, and a message
/// id is a bare UUID with nothing in it that says which room it belongs to — so
/// without this, a DM's message could be edited, deleted, pinned, reacted to or
/// used as a read marker by anybody who came by the id (SPEC §4.13). The room
/// check is the same one the room routes make, and it answers the same way: a
/// message in a DM you are not in is `NOT_FOUND`, exactly like a message that
/// was never there.
async fn reachable(state: &AppState, id: MessageId, user_id: UserId) -> Result<Message, ApiError> {
    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    repo::rooms::visible_to(&state.db.read, message.room_id, user_id).await?;
    Ok(message)
}

async fn edit(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<MessageId>,
    Json(req): Json<EditMessageRequest>,
) -> Result<Json<Message>, ApiError> {
    let message = reachable(&state, id, auth.id).await?;
    if message.deleted_at.is_some() {
        return Err(ApiError::not_found("That message is gone."));
    }
    if message.author_id != auth.id {
        return Err(ApiError::forbidden("Only the author can edit a message."));
    }
    let body = if message.attachments.is_empty() {
        validate::message_body(&req.body)?
    } else {
        validate::caption(&req.body)?
    };

    sqlx::query("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?")
        .bind(&body)
        .bind(now_ms())
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;

    // An edit that takes a link out takes its card out of the collection too.
    // The archive follows what the message says now, not what it once said.
    repo::links::replace_for_message(&state.db.write, id, &crate::links::extract(&body)).await?;

    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    state
        .gateway
        .publish(ServerEvent::MessageUpdate(message.clone()));
    Ok(Json(message))
}

/// The author deletes their own message; the host or a co-host deletes
/// anybody's, except that a co-host can't delete the host's (#424).
async fn delete(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<MessageId>,
) -> Result<StatusCode, ApiError> {
    let message = reachable(&state, id, auth.id).await?;
    if message.deleted_at.is_some() {
        return Ok(StatusCode::NO_CONTENT); // idempotent
    }
    if message.author_id != auth.id {
        let standing = auth::standing(&state.db.read, auth.id)
            .await?
            .unwrap_or(Standing::Member);
        if !standing.hosts() {
            return Err(ApiError::forbidden(
                "Only the author, the host or a co-host can delete a message.",
            ));
        }
        auth::refuse_on_the_host(
            &state.db.read,
            standing,
            message.author_id,
            "A co-host can't delete the host's messages.",
        )
        .await?;
    }

    // Tombstone, not removal: body empties, the row (and reply chains) survive.
    sqlx::query("UPDATE messages SET body = '', deleted_at = ?, pinned_at = NULL WHERE id = ?")
        .bind(now_ms())
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;

    state.gateway.publish(ServerEvent::MessageDelete {
        id,
        room_id: message.room_id,
    });
    Ok(StatusCode::NO_CONTENT)
}

async fn set_pin(
    state: &AppState,
    id: MessageId,
    user_id: UserId,
    pinned: bool,
) -> Result<Json<Message>, ApiError> {
    let message = reachable(state, id, user_id).await?;
    if message.deleted_at.is_some() {
        return Err(ApiError::not_found("That message is gone."));
    }
    sqlx::query("UPDATE messages SET pinned_at = ? WHERE id = ?")
        .bind(pinned.then(now_ms))
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;
    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    state
        .gateway
        .publish(ServerEvent::MessageUpdate(message.clone()));
    Ok(Json(message))
}

async fn pin(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<MessageId>,
) -> Result<Json<Message>, ApiError> {
    set_pin(&state, id, auth.id, true).await
}

async fn unpin(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<MessageId>,
) -> Result<Json<Message>, ApiError> {
    set_pin(&state, id, auth.id, false).await
}

async fn add_reaction(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path((id, key)): Path<(MessageId, String)>,
) -> Result<StatusCode, ApiError> {
    if !linger_core::is_valid_reaction_key(&key) {
        return Err(ApiError::validation(
            "Reactions come from the fixed set of 12.",
        ));
    }
    let message = reachable(&state, id, auth.id).await?;
    if message.deleted_at.is_some() {
        return Err(ApiError::not_found("That message is gone."));
    }

    sqlx::query(
        "INSERT OR IGNORE INTO reactions (message_id, user_id, key, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(id.to_vec())
    .bind(auth.id.to_vec())
    .bind(&key)
    .bind(now_ms())
    .execute(&state.db.write)
    .await?;

    publish_reaction(&state, id, message.room_id, &key).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn remove_reaction(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path((id, key)): Path<(MessageId, String)>,
) -> Result<StatusCode, ApiError> {
    if !linger_core::is_valid_reaction_key(&key) {
        return Err(ApiError::validation(
            "Reactions come from the fixed set of 12.",
        ));
    }
    // Taking a reaction back needs the same check putting one on does: without
    // it, a non-member with an id could still make the server fan out a
    // `reaction.update` for a DM's message.
    let message = reachable(&state, id, auth.id).await?;
    sqlx::query("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND key = ?")
        .bind(id.to_vec())
        .bind(auth.id.to_vec())
        .bind(&key)
        .execute(&state.db.write)
        .await?;

    publish_reaction(&state, id, message.room_id, &key).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `reaction.update` is the one frame that belongs to a room without naming
/// one — it names a message. So the room is resolved here and travels with the
/// frame rather than in it (`Gateway::publish_in`): a client that gets the
/// frame is holding the message already, and a `room_id` on the wire would be a
/// field that exists only to be got wrong.
async fn publish_reaction(
    state: &AppState,
    id: MessageId,
    room_id: RoomId,
    key: &str,
) -> Result<(), ApiError> {
    let group = repo::messages::reaction_group(&state.db.read, id, key).await?;
    state.gateway.publish_in(
        room_id,
        ServerEvent::ReactionUpdate {
            message_id: id,
            key: group.key,
            count: group.count,
            user_ids: group.user_ids,
        },
    );
    Ok(())
}

async fn put_read_marker(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(room_id): Path<RoomId>,
    Json(req): Json<UpdateReadMarkerRequest>,
) -> Result<StatusCode, ApiError> {
    let message = reachable(&state, req.last_read_id, auth.id).await?;
    if message.room_id != room_id {
        return Err(ApiError::validation("That message isn't in that room."));
    }
    advance_read_marker(&state, auth.id, room_id, req.last_read_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Move a read marker to `message_id`, or leave it where it is if it is
/// already there or later (PROTOCOL §4).
///
/// Forward only, because one person has several devices: a phone that comes
/// back with an older position must not pull back what the desktop has
/// already read (#454). Message ids are UUIDv7, and SQLite compares blobs
/// byte by byte, so `>` on the column is "posted later".
async fn advance_read_marker(
    state: &AppState,
    user_id: UserId,
    room_id: RoomId,
    message_id: MessageId,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO read_markers (user_id, room_id, last_read_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, room_id) DO UPDATE SET
           last_read_id = excluded.last_read_id, updated_at = excluded.updated_at
         WHERE excluded.last_read_id > read_markers.last_read_id",
    )
    .bind(user_id.to_vec())
    .bind(room_id.to_vec())
    .bind(message_id.to_vec())
    .bind(now_ms())
    .execute(&state.db.write)
    .await?;
    Ok(())
}

async fn read_map(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<linger_core::wire::ReadMap>, ApiError> {
    let rows: Vec<(Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT room_id, last_read_id FROM read_markers WHERE user_id = ?")
            .bind(auth.id.to_vec())
            .fetch_all(&state.db.read)
            .await?;
    let map = rows
        .into_iter()
        .map(|(room, msg)| {
            Ok((
                RoomId::from_slice(&room).map_err(anyhow::Error::from)?,
                MessageId::from_slice(&msg).map_err(anyhow::Error::from)?,
            ))
        })
        .collect::<Result<linger_core::wire::ReadMap, ApiError>>()?;
    Ok(Json(map))
}
