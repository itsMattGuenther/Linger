//! Auth endpoints (PROTOCOL §2): register through an invite, login, rotating
//! refresh, logout, and the unauthenticated invite preview.

use axum::extract::{Path, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::{ACCESS_TOKEN_TTL_SECS, RATE_LOGIN_PER_IP};
use linger_core::wire::{
    AuthResponse, ErrorCode, InvitePreview, LoginRequest, RefreshRequest, RefreshResponse,
    RegisterRequest,
};
use linger_core::UserId;

use crate::auth::{self, RefreshOutcome};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::{repo, validate};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/refresh", post(refresh))
        .route("/auth/logout", post(logout))
        .route("/auth/invite/{code}", get(invite_preview))
}

/// Mint a full auth response: fresh access token + a new refresh family.
pub async fn auth_response(state: &AppState, user_id: UserId) -> Result<AuthResponse, ApiError> {
    let (access_token, _) = state.jwt.mint(user_id)?;
    let refresh_token = auth::issue_refresh_family(&state.db.write, user_id).await?;
    let user = repo::users::expect(&state.db.read, &state.config, user_id).await?;
    Ok(AuthResponse {
        access_token,
        refresh_token,
        expires_in: ACCESS_TOKEN_TTL_SECS,
        user,
    })
}

async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    validate::username(&req.username)?;
    validate::display_name(&req.display_name)?;
    validate::password(&req.password)?;

    let password_hash = auth::hash_password(req.password).await?;
    let user_id = UserId::new();
    let now = now_ms();
    let code = req.invite_code.trim().to_lowercase();

    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;

    // Atomic consume: the guarded UPDATE is the whole race-safety story, and
    // the surrounding transaction returns the use if the user insert fails.
    let consumed = sqlx::query(
        "UPDATE invites SET uses = uses + 1
         WHERE code = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND (max_uses IS NULL OR uses < max_uses)",
    )
    .bind(&code)
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if consumed == 0 {
        let expired: Option<(Option<i64>,)> =
            sqlx::query_as("SELECT expires_at FROM invites WHERE code = ? AND revoked_at IS NULL")
                .bind(&code)
                .fetch_optional(&mut *tx)
                .await?;
        return Err(match expired {
            Some((Some(at),)) if at <= now => ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: ErrorCode::InviteExpired,
                message: "That invite has expired.".into(),
                retry_after_ms: None,
            },
            _ => ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: ErrorCode::InviteInvalid,
                message: "That invite isn't valid.".into(),
                retry_after_ms: None,
            },
        });
    }

    let inserted = sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, is_host, created_at)
         VALUES (?, ?, ?, ?, 0, ?)",
    )
    .bind(user_id.to_vec())
    .bind(&req.username)
    .bind(req.display_name.trim())
    .bind(&password_hash)
    .bind(now)
    .execute(&mut *tx)
    .await;

    match inserted {
        Ok(_) => {
            // Somewhere to start on the palette other than everyone's gray.
            crate::repo::colors::assign_starting_color(&mut tx, user_id).await?;
            tx.commit().await.map_err(ApiError::from)?;
        }
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(ApiError::conflict("That username is taken."));
        }
        Err(e) => return Err(e.into()),
    }

    let response = auth_response(&state, user_id).await?;

    // Nothing else tells a connected client that this person exists: the roster
    // is built from the `users` list in `ready`, and their presence frames have
    // no card to land on. `user.update` is "here is this person, whether or not
    // you had them" (PROTOCOL §8) and the client's fold appends an unknown id,
    // so one announcement is the whole fix.
    state
        .gateway
        .publish(ServerEvent::UserUpdate(response.user.clone()));
    Ok(Json(response))
}

/// A stable argon2 hash to verify against when the username doesn't exist, so
/// unknown-user and wrong-password take comparable time.
fn dummy_hash() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| auth::hash_password_sync("dummy-timing-password").unwrap_or_default())
}

async fn login(
    State(state): State<AppState>,
    parts: Parts,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    let ip = auth::client_ip(&parts);
    if let Err(retry) = state
        .limiter
        .check(&format!("login:{ip}"), RATE_LOGIN_PER_IP)
    {
        return Err(ApiError::rate_limited(retry));
    }

    let row: Option<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT id, password_hash FROM users
         WHERE username = ? AND deactivated_at IS NULL",
    )
    .bind(req.username.trim().to_lowercase())
    .fetch_optional(&state.db.read)
    .await?;

    let (user_id, hash) = match row {
        Some((id, hash)) => (
            Some(UserId::from_slice(&id).map_err(anyhow::Error::from)?),
            hash,
        ),
        None => (None, dummy_hash().to_string()),
    };

    let verified = !hash.is_empty() && auth::verify_password(req.password, hash).await?;
    let Some(user_id) = user_id.filter(|_| verified) else {
        return Err(ApiError::unauthenticated_with(
            "That username and password don't match.",
        ));
    };

    sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(user_id.to_vec())
        .execute(&state.db.write)
        .await?;

    auth_response(&state, user_id).await.map(Json)
}

async fn refresh(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<RefreshResponse>, ApiError> {
    match auth::rotate_refresh(&state.db.write, &req.refresh_token).await? {
        RefreshOutcome::Rotated { user_id, new_token } => {
            let (access_token, _) = state.jwt.mint(user_id)?;
            Ok(Json(RefreshResponse {
                access_token,
                refresh_token: new_token,
                expires_in: ACCESS_TOKEN_TTL_SECS,
            }))
        }
        RefreshOutcome::Rejected => Err(ApiError::unauthenticated()),
    }
}

async fn logout(
    State(state): State<AppState>,
    Json(req): Json<RefreshRequest>,
) -> Result<StatusCode, ApiError> {
    auth::revoke_family(&state.db.write, &req.refresh_token).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn invite_preview(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Json<InvitePreview>, ApiError> {
    // (expires_at, max_uses, uses, revoked_at)
    type InvitePreviewRow = (Option<i64>, Option<u32>, u32, Option<i64>);
    let row: Option<InvitePreviewRow> =
        sqlx::query_as("SELECT expires_at, max_uses, uses, revoked_at FROM invites WHERE code = ?")
            .bind(code.trim().to_lowercase())
            .fetch_optional(&state.db.read)
            .await?;

    let now = now_ms();
    let (valid, expires_at) = match row {
        Some((expires_at, max_uses, uses, revoked_at)) => {
            let alive = revoked_at.is_none()
                && expires_at.is_none_or(|at| at > now)
                && max_uses.is_none_or(|max| uses < max);
            (alive, expires_at)
        }
        None => (false, None),
    };

    let server_name: Option<String> = if valid {
        sqlx::query_scalar("SELECT value FROM server_config WHERE key = 'name'")
            .fetch_optional(&state.db.read)
            .await?
    } else {
        None
    };

    Ok(Json(InvitePreview {
        valid,
        server_name,
        expires_at,
    }))
}
