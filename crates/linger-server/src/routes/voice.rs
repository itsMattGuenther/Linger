//! The voice relay's front door (SPEC §4.14, PROTOCOL §7, T-1403).
//!
//! One endpoint, and it stores nothing: a member asks what to put in their
//! peer connections, and gets the host's relay addresses with a password that
//! was computed for them on the spot and dies on its own (`crate::turn`). No
//! relay configured is an empty answer, not an error — voice between machines
//! on one network is a real thing a server can offer, and the client joins
//! anyway.
//!
//! Audio never comes here. The server's whole part in voice is introducing
//! two clients to each other over the gateway; this is the one extra thing
//! it says at the introduction, which is where to meet when neither can reach
//! the other's door.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use linger_core::wire::IceServers;
use linger_core::{RoomId, UserId};

use crate::auth::{AuthedUser, HostOrCohost};
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;
use crate::turn;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/voice/ice", get(ice))
        .route("/rooms/{id}/voice/{user_id}", delete(take_out))
}

/// `DELETE /rooms/{id}/voice/{user_id}` — the host or a co-host takes
/// somebody out of a room's voice (#423, #424): somebody who walked away with
/// their microphone on, say. Not a ban; they can join again. Only in a room
/// they can see, so a DM's call stays as private as the DM, never themselves,
/// who have Leave, and for a co-host never the host.
async fn take_out(
    State(state): State<AppState>,
    host: HostOrCohost,
    Path((room_id, user_id)): Path<(RoomId, UserId)>,
) -> Result<StatusCode, ApiError> {
    if user_id == host.id {
        return Err(ApiError::validation(
            "To leave voice yourself, press Leave.",
        ));
    }
    host.not_on_the_host(
        &state.db.read,
        user_id,
        "A co-host can't take the host out of voice.",
    )
    .await?;
    repo::rooms::visible_to(&state.db.read, room_id, host.id).await?;
    if !state.gateway.voice_take_out(room_id, user_id) {
        return Err(ApiError::not_found("They aren't in voice there."));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /voice/ice` — the relay, for the member asking, for the next while.
async fn ice(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<IceServers>, ApiError> {
    let answer = match &state.config.turn {
        Some(turn) => turn::ice_servers(turn, auth.id, turn::now_unix()),
        None => IceServers {
            servers: Vec::new(),
            ttl_secs: 0,
        },
    };
    Ok(Json(answer))
}
