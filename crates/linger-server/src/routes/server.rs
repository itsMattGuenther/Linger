//! The server itself (PROTOCOL §3): its name, accent, and headline numbers.

use std::collections::HashMap;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use linger_core::wire::{ColorKey, ServerInfo, UpdateServerRequest};

use crate::auth::{AuthedUser, HostOrCohost};
use crate::error::ApiError;
use crate::state::AppState;
use crate::{repo, validate};

pub fn router() -> Router<AppState> {
    Router::new().route("/server", get(info).patch(update))
}

async fn read_config(state: &AppState) -> Result<HashMap<String, String>, ApiError> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, value FROM server_config")
        .fetch_all(&state.db.read)
        .await?;
    Ok(rows.into_iter().collect())
}

async fn build_info(state: &AppState) -> Result<ServerInfo, ApiError> {
    let config = read_config(state).await?;
    let (member_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM users WHERE deactivated_at IS NULL")
            .fetch_one(&state.db.read)
            .await?;
    Ok(ServerInfo {
        name: config.get("name").cloned().unwrap_or_default(),
        accent_key: config.get("accent_key").cloned().map(ColorKey),
        icon_key: config.get("icon_key").cloned(),
        member_count: u32::try_from(member_count).unwrap_or(0),
        created_at: config
            .get("created_at")
            .and_then(|v| v.parse().ok())
            .unwrap_or_default(),
        // The status bar's third figure (SPEC §5.6). Everybody sees it, not
        // just the host: whether there is room for a 400 MB video is a question
        // anybody about to share one has. The two knobs behind it are the
        // host's and they are environment variables (docs/decisions.md), so
        // there is nothing here to edit — only a figure to read.
        storage_used_bytes: repo::attachments::pool_used(&state.db.read).await?,
        storage_limit_bytes: state.config.pool_bytes,
        file_expiry_days: state.config.file_expiry_days,
        voice: Some(state.gateway.forwards_voice()),
    })
}

async fn info(
    State(state): State<AppState>,
    _auth: AuthedUser,
) -> Result<Json<ServerInfo>, ApiError> {
    build_info(&state).await.map(Json)
}

async fn update(
    State(state): State<AppState>,
    _host: HostOrCohost,
    Json(req): Json<UpdateServerRequest>,
) -> Result<Json<ServerInfo>, ApiError> {
    let name = req.name.as_deref().map(validate::server_name).transpose()?;
    if let Some(accent) = &req.accent_key {
        if !accent.is_valid() {
            return Err(ApiError::validation(
                "The accent comes from the named palette.",
            ));
        }
    }

    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    let pairs = [
        ("name", name),
        ("accent_key", req.accent_key.map(|c| c.0)),
        ("icon_key", req.icon_key),
    ];
    for (key, value) in pairs {
        if let Some(value) = value {
            sqlx::query(
                "INSERT INTO server_config (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(value)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await.map_err(ApiError::from)?;

    build_info(&state).await.map(Json)
}
