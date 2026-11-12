//! A phone asking for notifications, changing what it hears, and stopping
//! (SPEC §4.15, PROTOCOL §5 "Phone notifications", #830).
//!
//! What a phone hands over is the least that lets the server reach it
//! without knowing where it is: an address sealed by the relay, which the
//! server can't open, and the public half of a key to encrypt to. It belongs
//! to one sign-in, named by that sign-in's refresh token, and goes when the
//! sign-in does. What the server sends it is `crate::push`.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use linger_core::limits::{MAX_PUSH_ROOMS, MAX_PUSH_SEALED_CHARS, RATE_PUSH_DEVICE};
use linger_core::wire::{
    PushDevice, PushSettings, RegisterPushDeviceRequest, UpdatePushDeviceRequest,
};
use linger_core::PushDeviceId;

use crate::auth::AuthedUser;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/push/devices", post(register)).route(
        "/push/devices/{id}",
        axum::routing::get(get_device).patch(update).delete(remove),
    )
}

/// The host turned notifications off (`LINGER_PUSH=off`): the server takes
/// nothing a phone offers, and says why.
fn switched_on(state: &AppState) -> Result<(), ApiError> {
    if state.push.is_some() {
        Ok(())
    } else {
        Err(ApiError::conflict(
            "This server doesn't send phone notifications: its host turned them off.",
        ))
    }
}

fn limited(state: &AppState, auth: AuthedUser) -> Result<(), ApiError> {
    state
        .limiter
        .check(&format!("push:{}", auth.id), RATE_PUSH_DEVICE)
        .map_err(ApiError::rate_limited)
}

/// `POST /push/devices`: this sign-in's phone wants notifications. Asking
/// again replaces what it asked before and keeps its id.
async fn register(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<RegisterPushDeviceRequest>,
) -> Result<Json<PushDevice>, ApiError> {
    switched_on(&state)?;
    limited(&state, auth)?;
    let sealed_token = sealed(&req.sealed_token)?;
    let public_key = decode(&req.public_key)
        .filter(|key| crate::push::crypto::check_public_key(key).is_ok())
        .ok_or_else(|| ApiError::validation("That isn't a P-256 public key."))?;
    let auth_secret: [u8; 16] = decode(&req.auth_secret)
        .and_then(|secret| secret.try_into().ok())
        .ok_or_else(|| ApiError::validation("The auth secret is 16 bytes."))?;
    check_settings(&state, &req.settings).await?;

    let now = now_ms();
    let family = repo::push::live_family(&state.db.read, auth.id, &req.refresh_token, now)
        .await?
        .ok_or_else(|| {
            ApiError::validation(
                "That refresh token isn't one of your sign-ins that's still going.",
            )
        })?;
    let keys = repo::push::Keys {
        sealed_token,
        public_key: &public_key,
        auth_secret: &auth_secret,
    };
    let mut tx = state.db.write.begin().await?;
    let id = repo::push::register(&mut tx, auth.id, &family, &keys, &req.settings, now).await?;
    tx.commit().await?;
    found(&state, auth, id).await.map(Json)
}

/// `GET /push/devices/{id}`: what one of your phones hears.
async fn get_device(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<PushDeviceId>,
) -> Result<Json<PushDevice>, ApiError> {
    found(&state, auth, id).await.map(Json)
}

/// `PATCH /push/devices/{id}`: new switches, a new sealed address, or both.
async fn update(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<PushDeviceId>,
    Json(req): Json<UpdatePushDeviceRequest>,
) -> Result<Json<PushDevice>, ApiError> {
    switched_on(&state)?;
    limited(&state, auth)?;
    let sealed_token = req.sealed_token.as_deref().map(sealed).transpose()?;
    if let Some(settings) = &req.settings {
        check_settings(&state, settings).await?;
    }
    let mut tx = state.db.write.begin().await?;
    let changed = repo::push::update(
        &mut tx,
        auth.id,
        id,
        sealed_token,
        req.settings.as_ref(),
        now_ms(),
    )
    .await?;
    tx.commit().await?;
    if !changed {
        return Err(gone());
    }
    found(&state, auth, id).await.map(Json)
}

/// `DELETE /push/devices/{id}`: "Nothing" on that phone. The server forgets
/// its address and keys. Already gone is the same answer.
async fn remove(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<PushDeviceId>,
) -> Result<StatusCode, ApiError> {
    limited(&state, auth)?;
    repo::push::delete(&state.db.write, auth.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn found(
    state: &AppState,
    auth: AuthedUser,
    id: PushDeviceId,
) -> Result<PushDevice, ApiError> {
    repo::push::get(&state.db.read, auth.id, id)
        .await?
        .ok_or_else(gone)
}

/// One answer for a phone that isn't yours and one that's gone, as a DM you
/// aren't in answers like one that isn't there. A phone told this registers
/// again: its sign-in ended, or the relay said its address had.
fn gone() -> ApiError {
    ApiError::not_found("That phone isn't registered for notifications here.")
}

/// base64url, with or without its padding, as a phone's web push library
/// hands it over.
fn decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(text.trim().trim_end_matches('='))
        .ok()
}

/// A sealed address is the relay's business, so the server only checks it
/// is the shape one could be: printable, no spaces, not huge.
fn sealed(text: &str) -> Result<&str, ApiError> {
    let ok = !text.is_empty()
        && text.chars().count() <= MAX_PUSH_SEALED_CHARS
        && text.bytes().all(|byte| byte.is_ascii_graphic());
    if ok {
        Ok(text)
    } else {
        Err(ApiError::validation(
            "That isn't a sealed push address from the relay.",
        ))
    }
}

/// Each room chosen once, at most [`MAX_PUSH_ROOMS`], and every one a room
/// on this server: a DM is `dms`, and has no room setting of its own.
async fn check_settings(state: &AppState, settings: &PushSettings) -> Result<(), ApiError> {
    if settings.rooms.len() > MAX_PUSH_ROOMS {
        return Err(ApiError::validation(format!(
            "A phone can choose at most {MAX_PUSH_ROOMS} rooms."
        )));
    }
    let mut seen = std::collections::HashSet::new();
    for room in &settings.rooms {
        if !seen.insert(room.room_id) {
            return Err(ApiError::validation("That room is in the list twice."));
        }
        let is_room: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM rooms WHERE id = ? AND kind = 'room'")
                .bind(room.room_id.to_vec())
                .fetch_optional(&state.db.read)
                .await?;
        if is_room.is_none() {
            return Err(ApiError::validation("That room isn't on this server."));
        }
    }
    Ok(())
}
