//! Rooms (PROTOCOL §3). Creation, reshaping and the message of the day are
//! for the host or a co-host; being in them is everyone's business (and the
//! gateway's).

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::wire::{CreateRoomRequest, Room, RoomKind, UpdateRoomRequest};
use linger_core::{MessageId, RoomId};

use crate::auth::{AuthedUser, HostOrCohost};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::{repo, validate};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rooms", get(list).post(create))
        .route("/rooms/{id}", axum::routing::patch(update))
        .route("/rooms/{id}/archive", post(archive))
}

async fn list(
    State(state): State<AppState>,
    _auth: AuthedUser,
) -> Result<Json<Vec<Room>>, ApiError> {
    repo::rooms::all(&state.db.read).await.map(Json)
}

async fn create(
    State(state): State<AppState>,
    _host: HostOrCohost,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<Room>, ApiError> {
    validate::room_slug(&req.slug)?;
    let name = req.name.trim();
    if name.is_empty() || name.chars().count() > 48 {
        return Err(ApiError::validation("Room names are 1–48 characters."));
    }

    let id = RoomId::new();
    let position: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(position), -1) + 1 FROM rooms")
        .fetch_one(&state.db.read)
        .await?;

    let inserted = sqlx::query(
        "INSERT INTO rooms (id, slug, name, topic, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id.to_vec())
    .bind(&req.slug)
    .bind(name)
    .bind(&req.topic)
    .bind(position)
    .bind(now_ms())
    .execute(&state.db.write)
    .await;

    match inserted {
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(ApiError::conflict("A room with that slug already exists."));
        }
        Err(e) => return Err(e.into()),
    }

    let room = repo::rooms::expect(&state.db.read, id).await?;
    state.gateway.publish(ServerEvent::RoomCreate(room.clone()));
    Ok(Json(room))
}

/// A DM is not a room the host administers (SPEC §4.13).
///
/// `POST /rooms`, `PATCH /rooms/:id` and the archive are host-only, and being
/// the host is not membership in anybody's conversation. Renaming a DM,
/// re-ordering it or archiving it are all things a host could otherwise do to a
/// conversation they are not in — small acts, but each one is the host reaching
/// inside a private space, which is the thing this feature exists to make
/// impossible. `NOT_FOUND` rather than `FORBIDDEN`, for the usual reason: the
/// refusal must not confirm the DM is there.
fn only_a_room(room: &Room) -> Result<(), ApiError> {
    if room.kind == RoomKind::Room {
        Ok(())
    } else {
        Err(ApiError::not_found("No such room on this server."))
    }
}

async fn update(
    State(state): State<AppState>,
    host: HostOrCohost,
    Path(id): Path<RoomId>,
    Json(req): Json<UpdateRoomRequest>,
) -> Result<Json<Room>, ApiError> {
    let before = repo::rooms::expect(&state.db.read, id).await?;
    only_a_room(&before)?;
    if let Some(name) = &req.name {
        let trimmed = name.trim();
        if trimmed.is_empty() || trimmed.chars().count() > 48 {
            return Err(ApiError::validation("Room names are 1–48 characters."));
        }
    }
    let motd = match req.motd.as_deref().map(validate::motd).transpose()? {
        // The same words again, or clearing nothing, changes nothing: no second
        // line in the room, and nobody's folded strip opens again (#464).
        Some(text) if before.motd.as_ref().map_or("", |motd| motd.text.as_str()) == text => None,
        other => other,
    };
    if motd.as_deref().is_some_and(|text| !text.is_empty()) && before.archived_at.is_some() {
        return Err(ApiError::validation("That room is archived."));
    }

    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    // Setting a message of the day writes a line in the room saying so, in the
    // same transaction, so nobody sees one without the other. Clearing it
    // writes nothing: an empty strip is news to nobody.
    let mut line: Option<MessageId> = None;
    match motd.as_deref() {
        None => {}
        Some("") => {
            sqlx::query(
                "UPDATE rooms SET motd = NULL, motd_set_by = NULL, motd_set_at = NULL WHERE id = ?",
            )
            .bind(id.to_vec())
            .execute(&mut *tx)
            .await?;
        }
        Some(text) => {
            let at = now_ms();
            sqlx::query("UPDATE rooms SET motd = ?, motd_set_by = ?, motd_set_at = ? WHERE id = ?")
                .bind(text)
                .bind(host.id.to_vec())
                .bind(at)
                .bind(id.to_vec())
                .execute(&mut *tx)
                .await?;
            let message_id = MessageId::new();
            sqlx::query(
                "INSERT INTO messages (id, room_id, author_id, body, created_at, motd)
                 VALUES (?, ?, ?, ?, ?, 1)",
            )
            .bind(message_id.to_vec())
            .bind(id.to_vec())
            .bind(host.id.to_vec())
            .bind(text)
            .bind(at)
            .execute(&mut *tx)
            .await?;
            line = Some(message_id);
        }
    }
    if let Some(name) = &req.name {
        sqlx::query("UPDATE rooms SET name = ? WHERE id = ?")
            .bind(name.trim())
            .bind(id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    if let Some(topic) = &req.topic {
        sqlx::query("UPDATE rooms SET topic = ? WHERE id = ?")
            .bind(topic)
            .bind(id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    if let Some(position) = req.position {
        sqlx::query("UPDATE rooms SET position = ? WHERE id = ?")
            .bind(i64::from(position))
            .bind(id.to_vec())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await.map_err(ApiError::from)?;

    let room = repo::rooms::expect(&state.db.read, id).await?;
    state.gateway.publish(ServerEvent::RoomUpdate(room.clone()));
    if let Some(message_id) = line {
        // Its links go in the collection like any message's (SPEC §4.4).
        repo::links::replace_for_message(
            &state.db.write,
            message_id,
            &crate::links::extract(motd.as_deref().unwrap_or_default()),
        )
        .await?;
        let message = repo::messages::expect(&state.db.read, &state.config, message_id).await?;
        state.gateway.publish(ServerEvent::MessageCreate(message));
    }
    Ok(Json(room))
}

async fn archive(
    State(state): State<AppState>,
    _host: HostOrCohost,
    Path(id): Path<RoomId>,
) -> Result<Json<Room>, ApiError> {
    only_a_room(&repo::rooms::expect(&state.db.read, id).await?)?;
    sqlx::query("UPDATE rooms SET archived_at = ? WHERE id = ? AND archived_at IS NULL")
        .bind(now_ms())
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;
    let room = repo::rooms::expect(&state.db.read, id).await?;
    state.gateway.publish(ServerEvent::RoomUpdate(room.clone()));
    Ok(Json(room))
}
