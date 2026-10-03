//! Knock (SPEC §4.9, PROTOCOL §7, T-1101).
//!
//! One endpoint, and most of it is what it refuses to do. A knock is a nudge at
//! one person that does not ask for a reply: no body, no thread, no unread
//! state, nothing to dismiss. **Nothing is written down.** There is no knocks
//! table and there must never be one — a knock somebody can go back and read is
//! a message, and a message is the thing this feature exists to avoid making
//! anybody compose.
//!
//! So the whole of it is: check the person is really here, check the rate
//! limit, put one frame on that person's sessions. If they are not connected,
//! the knock lands nowhere and that is the correct behaviour — it is a tap on
//! the shoulder, not a voicemail.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::RATE_KNOCK_PER_TARGET;
use linger_core::wire::KnockRequest;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/knock", post(knock))
}

/// `POST /knock` — nudge one person.
async fn knock(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<KnockRequest>,
) -> Result<StatusCode, ApiError> {
    // Knocking on your own door is not an error worth a code of its own, but it
    // is not something to fan out either: it would arrive as a card from
    // yourself on your other machine.
    if req.target_user_id == auth.id {
        return Err(ApiError::validation("You can't knock on yourself."));
    }
    // A member of this server, and still one: `repo::users::expect` only ever
    // sees active accounts, so somebody who was removed is `NOT_FOUND` here
    // without this endpoint having to know what removal is.
    repo::users::expect(&state.db.read, req.target_user_id).await?;

    // Three an hour **per target** (SPEC §4.9), so the key names both ends:
    // knocking on five different people is five separate buckets and is fine.
    // The limit is about not being nagged, not about how busy the server is.
    let key = format!("knock:{}:{}", auth.id, req.target_user_id);
    if let Err(retry_after_ms) = state.limiter.check(&key, RATE_KNOCK_PER_TARGET) {
        return Err(ApiError::rate_limited(retry_after_ms));
    }

    // Somebody who blocked you never hears your knock, and you're never told:
    // the answer is the same 204 (PROTOCOL §5, "Report and block").
    if super::blocks::has_blocked(&state, req.target_user_id, auth.id).await? {
        return Ok(StatusCode::NO_CONTENT);
    }

    // Addressed, so it reaches that person's sessions and nobody else's — not
    // the room, not the server, not the sender's own other windows.
    state.gateway.publish_to(
        req.target_user_id,
        ServerEvent::Knock {
            from_user_id: auth.id,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}
