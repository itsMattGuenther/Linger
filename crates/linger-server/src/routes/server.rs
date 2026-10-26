//! The server itself (PROTOCOL §3): its name, accent, and headline numbers.

use std::collections::HashMap;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use linger_core::wire::{
    BackupBucketHealth, ColorKey, ServerHealth, ServerInfo, UpdateServerRequest,
};
use linger_core::UserId;

use crate::auth::{AuthedUser, HostOrCohost, Standing};
use crate::config::FileExpiry;
use crate::db::now_ms;
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

async fn build_info(state: &AppState, viewer: UserId) -> Result<ServerInfo, ApiError> {
    let config = read_config(state).await?;
    let (member_count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM users WHERE deactivated_at IS NULL")
            .fetch_one(&state.db.read)
            .await?;
    let used = repo::attachments::pool_used(&state.db.read).await?;
    let health = health(state, viewer, used).await?;
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
        storage_used_bytes: used,
        storage_limit_bytes: state.config.pool_bytes,
        file_expiry_days: state.config.file_expiry.days(),
        file_expiry_when_full: Some(state.config.file_expiry == FileExpiry::WhenFull),
        voice: Some(state.gateway.forwards_voice()),
        screens: Some(state.gateway.passes_screens()),
        health,
    })
}

/// What only the host hears about the machine (#582). Not a co-host: the
/// machine is whoever runs it (SPEC §4.16), and a co-host can't fix a full
/// disk or a failing backup from inside the app any more than the host can.
async fn health(
    state: &AppState,
    viewer: UserId,
    used: u64,
) -> Result<Option<ServerHealth>, ApiError> {
    if crate::auth::standing(&state.db.read, viewer).await? != Some(Standing::Host) {
        return Ok(None);
    }
    let disk = crate::disk::room(state.config.data_dir.clone()).await;
    let backups = state.config.backups;
    Ok(Some(ServerHealth {
        backups,
        last_backup_at: state.backups.last(),
        backup_overdue: backups && state.backups.overdue(now_ms()),
        disk_nearly_full: disk.is_some_and(crate::disk::Room::nearly_full),
        file_space_nearly_full: nearly_used_up(state, used).await?,
        bucket: state.backups.bucket_name().map(|name| BackupBucketHealth {
            name: name.to_string(),
            last_sent_at: state.backups.sent(),
            overdue: state.backups.bucket_overdue(now_ms()),
        }),
    }))
}

/// Uploads at 90% or more of the pool (#582). Under `when-full` that's where
/// the oldest files start going (#583), which is the setting working, not a
/// problem: the host only needs to hear when there's nothing left it can
/// take, every file starred, pinned or waiting for its message.
async fn nearly_used_up(state: &AppState, used: u64) -> Result<bool, ApiError> {
    let (start, _) = crate::expiry::when_full_marks(state.config.pool_bytes);
    if used < start {
        return Ok(false);
    }
    if state.config.file_expiry != FileExpiry::WhenFull {
        return Ok(true);
    }
    Ok(!crate::expiry::anything_to_take(state).await?)
}

async fn info(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<ServerInfo>, ApiError> {
    build_info(&state, auth.id).await.map(Json)
}

async fn update(
    State(state): State<AppState>,
    host: HostOrCohost,
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

    build_info(&state, host.id).await.map(Json)
}
