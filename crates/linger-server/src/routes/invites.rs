//! Invites (PROTOCOL §7). Any member can invite a friend — that's what a server
//! is for — rate-limited to 10/day. Codes are 12 chars of CSPRNG base32.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use linger_core::limits::{INVITE_CODE_CHARS, RATE_INVITE_CREATE};
use linger_core::wire::{CreateInviteRequest, Invite};
use linger_core::UserId;
use rand::RngCore;

use crate::auth::{self, AuthedUser, Standing};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/invites", get(list).post(create))
        .route("/invites/{code}", axum::routing::delete(revoke))
}

/// Lowercase RFC-4648 base32 alphabet; friendly to read aloud over the phone.
fn new_code() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; INVITE_CODE_CHARS];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[(b % 32) as usize] as char)
        .collect()
}

/// (code, created_by, expires_at, max_uses, uses, revoked_at, created_at)
type InviteRow = (
    String,
    Vec<u8>,
    Option<i64>,
    Option<u32>,
    u32,
    Option<i64>,
    i64,
);

fn row_to_invite(row: InviteRow) -> Result<Invite, ApiError> {
    let (code, created_by, expires_at, max_uses, uses, revoked_at, created_at) = row;
    Ok(Invite {
        code,
        created_by: UserId::from_slice(&created_by).map_err(anyhow::Error::from)?,
        expires_at,
        max_uses,
        uses,
        revoked_at,
        created_at,
    })
}

async fn list(
    State(state): State<AppState>,
    _auth: AuthedUser,
) -> Result<Json<Vec<Invite>>, ApiError> {
    let rows: Vec<InviteRow> = sqlx::query_as(
        "SELECT code, created_by, expires_at, max_uses, uses, revoked_at, created_at
         FROM invites ORDER BY created_at DESC",
    )
    .fetch_all(&state.db.read)
    .await?;
    rows.into_iter()
        .map(row_to_invite)
        .collect::<Result<Vec<_>, _>>()
        .map(Json)
}

async fn create(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<CreateInviteRequest>,
) -> Result<Json<Invite>, ApiError> {
    if let Err(retry) = state
        .limiter
        .check(&format!("invite:{}", auth.id), RATE_INVITE_CREATE)
    {
        return Err(ApiError::rate_limited(retry));
    }
    if req.max_uses == Some(Some(0)) {
        return Err(ApiError::validation("An invite needs at least one use."));
    }

    let now = now_ms();
    let code = new_code();
    let expires_at = req.expires_in_hours.map(|h| now + i64::from(h) * 3_600_000);
    // Single-use by default (ARCHITECTURE §7): an unlimited invite is opt-in,
    // asked for with `"max_uses": null` (#246).
    let max_uses = req.max_uses.unwrap_or(Some(1));

    sqlx::query(
        "INSERT INTO invites (code, created_by, expires_at, max_uses, uses, created_at)
         VALUES (?, ?, ?, ?, 0, ?)",
    )
    .bind(&code)
    .bind(auth.id.to_vec())
    .bind(expires_at)
    .bind(max_uses)
    .bind(now)
    .execute(&state.db.write)
    .await?;

    Ok(Json(Invite {
        code,
        created_by: auth.id,
        expires_at,
        max_uses,
        uses: 0,
        revoked_at: None,
        created_at: now,
    }))
}

async fn revoke(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(code): Path<String>,
) -> Result<StatusCode, ApiError> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT created_by FROM invites WHERE code = ?")
        .bind(&code)
        .fetch_optional(&state.db.read)
        .await?;
    let Some((created_by,)) = row else {
        return Err(ApiError::not_found("No such invite."));
    };

    // The inviter revokes their own; the host or a co-host revokes anybody's,
    // except that a co-host can't revoke the host's (#424).
    let created_by = UserId::from_slice(&created_by).map_err(anyhow::Error::from)?;
    if created_by != auth.id {
        let standing = auth::standing(&state.db.read, auth.id)
            .await?
            .unwrap_or(Standing::Member);
        if !standing.hosts() {
            return Err(ApiError::forbidden(
                "Only the inviter, the host or a co-host can revoke an invite.",
            ));
        }
        auth::refuse_on_the_host(
            &state.db.read,
            standing,
            created_by,
            "A co-host can't revoke the host's invites.",
        )
        .await?;
    }

    sqlx::query("UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL")
        .bind(now_ms())
        .bind(&code)
        .execute(&state.db.write)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
