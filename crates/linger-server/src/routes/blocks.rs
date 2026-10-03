//! Block (SPEC §4.15, PROTOCOL §5 "Report and block", T-1605): one person's
//! private list of people whose messages they'd rather not see.
//!
//! Nobody else can read the list, and the person blocked is never told:
//! nothing they can call answers any differently. The server's one part in it
//! is the knock (`routes/knock.rs`); the clients fold a blocked person's
//! messages into a grey line, and keep them out of chimes, DMs' light, Media and
//! Search.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::UserId;

use crate::auth::AuthedUser;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/me/blocks", get(list_blocks))
        .route("/me/blocks/{id}", put(block).delete(unblock))
}

/// `GET /me/blocks` — who you've blocked, in the order you did it.
async fn list_blocks(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<Vec<UserId>>, ApiError> {
    let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at, blocked_id",
    )
    .bind(auth.id.to_vec())
    .fetch_all(&state.db.read)
    .await?;
    let ids = rows
        .into_iter()
        .map(|(id,)| UserId::from_slice(&id).map_err(|e| ApiError::from(anyhow::Error::from(e))))
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(ids))
}

/// `PUT /me/blocks/:id` — block somebody. Blocking them again changes nothing.
async fn block(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<UserId>,
) -> Result<StatusCode, ApiError> {
    if id == auth.id {
        return Err(ApiError::validation("You can't block yourself."));
    }
    // A member of this server, and still one: somebody removed is not found,
    // as everywhere else.
    repo::users::expect(&state.db.read, id).await?;
    sqlx::query("INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)")
        .bind(auth.id.to_vec())
        .bind(id.to_vec())
        .bind(now_ms())
        .execute(&state.db.write)
        .await?;
    // Every one of your sessions, so a block made on a phone holds on the
    // computer at once. Nobody else's.
    state.gateway.publish_to(
        auth.id,
        ServerEvent::BlockUpdate {
            user_id: id,
            blocked: true,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /me/blocks/:id` — unblock somebody. Whether or not they were
/// blocked, or are still a member, they aren't now.
async fn unblock(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<UserId>,
) -> Result<StatusCode, ApiError> {
    sqlx::query("DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?")
        .bind(auth.id.to_vec())
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;
    state.gateway.publish_to(
        auth.id,
        ServerEvent::BlockUpdate {
            user_id: id,
            blocked: false,
        },
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Has `user_id` blocked `other`? The knock asks before it fans out.
pub async fn has_blocked(
    state: &AppState,
    user_id: UserId,
    other: UserId,
) -> Result<bool, ApiError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?")
            .bind(user_id.to_vec())
            .bind(other.to_vec())
            .fetch_optional(&state.db.read)
            .await?;
    Ok(row.is_some())
}
