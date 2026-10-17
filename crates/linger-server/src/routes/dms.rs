//! DMs (SPEC §4.13, PROTOCOL §3.1, T-1301).
//!
//! Three endpoints: the list, create-or-find, and leaving a group (#565).
//! Most of the file is the check on the way in.
//!
//! A DM is a room, so there is no `GET /dms/:id/messages` and no DM anything
//! else: once it exists it is addressed by `room_id` like any room, and the
//! membership check lives in `repo::rooms::visible_to`, which every room-scoped
//! route already goes through.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::{MAX_DM_MEMBERS, MIN_DM_MEMBERS};
use linger_core::wire::{CreateDmRequest, Room};
use linger_core::RoomId;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/dms", get(list).post(create))
        .route("/dms/{id}/leave", post(leave))
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

/// Leave a group DM (SPEC §4.13, PROTOCOL §3.1, #565).
///
/// The database does the leaving in one go (`repo::dms::leave`); this tells
/// everybody, and **the order is the privacy**. The leaver comes out of the
/// DM's audience first, so nothing published about it from then on can reach
/// them: not the line, not the new member list. Then any seat of theirs in the
/// DM's voice ends. Then their own sessions are told it's gone, by address,
/// since they're no longer anybody the room's frames go to. Then the people
/// still in it get the DM as it is now and the line.
async fn leave(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(room_id): Path<RoomId>,
) -> Result<StatusCode, ApiError> {
    let left = repo::dms::leave(&state.db.write, room_id, auth.id).await?;

    state.gateway.left_dm(room_id, auth.id);
    // Every seat they had in its voice (a laptop and a desktop are two): each
    // is told why it ended, and the people still in it see them go (#423).
    state.gateway.voice_take_out(room_id, auth.id);
    state
        .gateway
        .publish_to(auth.id, ServerEvent::DmRemove { room_id });

    match left {
        // They're out whatever happens next, so a failure to read the DM back
        // is logged rather than answered: an error here would tell them the
        // leave didn't happen. The others catch up at their next `ready`.
        repo::dms::Left::Stays { line } => {
            if let Err(error) = tell_the_others(&state, room_id, line).await {
                tracing::warn!(error = ?error, "couldn't tell a DM somebody left it");
            }
        }
        // Nobody can read it now, so its files needn't wait for the sweeper's
        // next pass, up to six hours off, to give the server its space back.
        repo::dms::Left::Emptied => {
            let state = state.clone();
            tokio::spawn(async move {
                if let Err(error) = crate::expiry::sweep(&state).await {
                    tracing::warn!(error = ?error, "couldn't sweep a deleted DM's files");
                }
            });
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

/// The people still in a DM somebody left: the DM as it is now, with its new
/// `member_ids`, then the line saying so.
pub(crate) async fn tell_the_others(
    state: &AppState,
    room_id: RoomId,
    line: linger_core::MessageId,
) -> Result<(), ApiError> {
    let room = repo::rooms::expect(&state.db.read, room_id).await?;
    let line = repo::messages::expect(&state.db.read, &state.config, line).await?;
    state.gateway.publish(ServerEvent::RoomUpdate(room));
    state.gateway.publish(ServerEvent::MessageCreate(line));
    Ok(())
}
