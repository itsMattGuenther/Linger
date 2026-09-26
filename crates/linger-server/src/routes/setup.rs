//! First-run setup endpoints (PROTOCOL §2.1). Once any user exists these
//! answer `NOT_FOUND` — the setup surface simply isn't there anymore.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use linger_core::wire::{AuthResponse, SetupPreview, SetupRequest};
use linger_core::UserId;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::{auth, validate};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup/{token}", get(preview))
        .route("/setup", post(complete))
}

async fn preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<SetupPreview>, ApiError> {
    if state.setup.peek().is_none() {
        return Err(ApiError::not_found("This server is already set up."));
    }
    Ok(Json(SetupPreview {
        valid: state.setup.matches(&token),
    }))
}

async fn complete(
    State(state): State<AppState>,
    Json(req): Json<SetupRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    if state.setup.peek().is_none() {
        return Err(ApiError::not_found("This server is already set up."));
    }
    validate::username(&req.username)?;
    validate::display_name(&req.display_name)?;
    validate::password(&req.password)?;
    let server_name = req.server_name.trim();
    if server_name.is_empty() || server_name.chars().count() > 48 {
        return Err(ApiError::validation("Server names are 1–48 characters."));
    }

    // Validate everything above *before* burning the one-shot token, so a typo
    // in the form doesn't brick first-run.
    if !state.setup.consume(&req.token) {
        return Err(ApiError::forbidden("That setup link isn't valid."));
    }

    let password_hash = auth::hash_password(req.password).await?;
    let host_id = UserId::new();
    let now = now_ms();

    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, is_host, created_at)
         VALUES (?, ?, ?, ?, 1, ?)",
    )
    .bind(host_id.to_vec())
    .bind(&req.username)
    .bind(req.display_name.trim())
    .bind(&password_hash)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    crate::repo::colors::assign_starting_color(&mut tx, host_id).await?;
    for (key, value) in [
        ("name", server_name.to_string()),
        ("created_at", now.to_string()),
    ] {
        sqlx::query("INSERT INTO server_config (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await.map_err(ApiError::from)?;

    tracing::info!(server = server_name, host = req.username, "server set up");
    super::auth::auth_response(&state, host_id).await.map(Json)
}
