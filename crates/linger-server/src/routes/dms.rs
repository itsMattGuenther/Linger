//! DMs (SPEC §4.13, PROTOCOL §3.1, T-1301).
//!
//! Two endpoints, and almost all of the file is the check on the way in.
//!
//! A DM is a room, so there is no `GET /dms/:id/messages` and no DM anything
//! else: once it exists it is addressed by `room_id` like any room, and the
//! membership check lives in `repo::rooms::visible_to`, which every room-scoped
//! route already goes through.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::{MAX_DM_MEMBERS, MIN_DM_MEMBERS};
use linger_core::wire::{CreateDmRequest, Room};

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/dms", get(list).post(create))
}

/// The DMs this person is in. Never anybody else's — there is no argument that
/// could ask for somebody else's, which is the point of it taking none.
async fn list(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<Vec<Room>>, ApiError> {
    repo::rooms::dms_for(&state.db.read, auth.id)
        .await
        .map(Json)
}

/// Create-or-find a DM with these people.
///
/// The caller is always a member and never names themselves (PROTOCOL §3.1),
/// so the member list is `user_ids` plus the caller. Everything that can be
/// wrong with that list is refused here, with a sentence, because this is where
/// somebody is standing when it goes wrong.
async fn create(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<CreateDmRequest>,
) -> Result<Json<Room>, ApiError> {
    let mut members = vec![auth.id];
    for id in req.user_ids {
        if id == auth.id {
            return Err(ApiError::validation(
                "You are already in it — name the other people, not yourself.",
            ));
        }
        if members.contains(&id) {
            return Err(ApiError::validation("Somebody is named twice."));
        }
        members.push(id);
    }

    if members.len() < MIN_DM_MEMBERS {
        return Err(ApiError::validation(
            "A direct message needs somebody to send it to.",
        ));
    }
    if members.len() > MAX_DM_MEMBERS {
        return Err(ApiError::validation(
            "A direct message holds up to eight people. More than that is a room.",
        ));
    }

    // Every id has to be somebody who is really here. `expect` refuses a
    // deactivated account too, so a DM cannot be opened with somebody who has
    // been removed from the server.
    for id in &members {
        repo::users::expect(&state.db.read, *id).await?;
    }

    let (room, created) =
        repo::dms::create_or_find(&state.db.read, &state.db.write, &members).await?;

    if created {
        // Order matters, and this is the one place in the server where it is
        // load-bearing: the frame announcing a DM is itself a frame about that
        // DM, so its audience has to be known before the frame goes out or the
        // announcement is the leak.
        state.gateway.note_dm(room.id, members.clone());
        state.gateway.publish(ServerEvent::RoomCreate(room.clone()));
    }

    Ok(Json(room))
}
