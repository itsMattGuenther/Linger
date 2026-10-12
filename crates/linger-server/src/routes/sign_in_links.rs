//! Sign-in links (#581, PROTOCOL §5): the way back in for somebody who forgot
//! their password, without the host stopping the server to run
//! `reset-password`.
//!
//! The host makes one for a member. It works once, for a day, and lets
//! whoever holds it set that account's password. That is the whole risk, so
//! everything else leans the other way: only the host can make one, not a
//! co-host (`docs/decisions.md`, 2026-10-11), only the code's hash is
//! stored, a new link cancels the last, it can never be made for the host,
//! using it ends every other sign-in the account has, and the person's own
//! Settings says who made them one and when (`GET /me/sign-in-links`), so a
//! link they didn't ask for doesn't go unnoticed.
//!
//! The host's own way back in stays `reset-password` on the machine
//! (`crate::reset`): being able to run that is the proof of owning the server,
//! and nobody else can vouch for the host.

use axum::extract::{Path, State};
use axum::http::request::Parts;
use axum::routing::{get, post};
use axum::{Json, Router};
use linger_core::limits::{
    RATE_LOGIN_PER_IP, RATE_SIGN_IN_LINK_CREATE, SIGN_IN_LINK_CHARS, SIGN_IN_LINK_TTL_HOURS,
};
use linger_core::wire::{
    AuthResponse, SignInLink, SignInLinkMade, SignInLinkPreview, UseSignInLinkRequest,
};
use linger_core::UserId;
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::auth::{self, AuthedUser, HostUser, Standing};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::validate;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users/{id}/sign-in-link", post(make))
        .route("/me/sign-in-links", get(mine))
        .route("/auth/sign-in-link/{code}", get(preview))
        .route("/auth/sign-in-link", post(use_link))
}

/// The same lowercase base32 an invite uses, read aloud as easily, but longer.
fn new_code() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut bytes = [0u8; SIGN_IN_LINK_CHARS];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[(b % 32) as usize] as char)
        .collect()
}

fn code_hash(code: &str) -> String {
    hex::encode(Sha256::digest(code.trim().to_lowercase().as_bytes()))
}

/// `POST /users/:id/sign-in-link`: the host makes a link for a member. A new
/// one cancels any that still works. A co-host is refused as a member is
/// ([`HostUser`]): whoever holds a link can sign in as that person, so making
/// one stays with the person who runs the server.
async fn make(
    State(state): State<AppState>,
    maker: HostUser,
    Path(id): Path<UserId>,
) -> Result<Json<SignInLink>, ApiError> {
    // The host asking for themselves lands here too: only the host makes
    // links, and none is ever for the host.
    match auth::standing(&state.db.read, id).await? {
        None => return Err(ApiError::not_found("No such member.")),
        Some(Standing::Host) => {
            return Err(ApiError::forbidden(
                "Nobody can make a sign-in link for the host. A host who's locked out \
                 resets their password on the server itself.",
            ))
        }
        Some(_) => {}
    }
    if let Err(retry) = state.limiter.check(
        &format!("sign-in-link:{}", maker.id),
        RATE_SIGN_IN_LINK_CREATE,
    ) {
        return Err(ApiError::rate_limited(retry));
    }

    let now = now_ms();
    let code = new_code();
    let expires_at = now + SIGN_IN_LINK_TTL_HOURS * 3_600_000;
    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    sqlx::query(
        "UPDATE sign_in_links SET cancelled_at = ?
         WHERE user_id = ? AND used_at IS NULL AND cancelled_at IS NULL",
    )
    .bind(now)
    .bind(id.to_vec())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO sign_in_links (token_hash, user_id, made_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(code_hash(&code))
    .bind(id.to_vec())
    .bind(maker.id.to_vec())
    .bind(now)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await.map_err(ApiError::from)?;

    tracing::info!(made_by = %maker.id, user = %id, "sign-in link made");
    Ok(Json(SignInLink {
        code,
        user_id: id,
        expires_at,
    }))
}

/// `GET /me/sign-in-links`: the links made for you, newest first.
async fn mine(
    State(state): State<AppState>,
    auth: AuthedUser,
) -> Result<Json<Vec<SignInLinkMade>>, ApiError> {
    type Row = (Vec<u8>, i64, i64, Option<i64>, Option<i64>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT made_by, created_at, expires_at, used_at, cancelled_at FROM sign_in_links
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 5",
    )
    .bind(auth.id.to_vec())
    .fetch_all(&state.db.read)
    .await?;
    rows.into_iter()
        .map(|(made_by, made_at, expires_at, used_at, cancelled_at)| {
            Ok(SignInLinkMade {
                made_by: UserId::from_slice(&made_by).map_err(anyhow::Error::from)?,
                made_at,
                expires_at,
                used_at,
                cancelled_at,
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()
        .map(Json)
}

/// A link that still works, as what it is for.
pub struct OpenLink {
    pub user_id: UserId,
    pub username: String,
    pub made_by: String,
    pub expires_at: i64,
}

/// Why a link can't be used at `now`, or what it's for when it can.
pub enum LinkState {
    Open(OpenLink),
    Used,
    /// Run out, cancelled, made up, or for somebody no longer here: the same
    /// sentence for all of them.
    Dead,
}

/// What `code` can do at `now`. A link for somebody since removed, or since
/// made the host, is dead.
pub async fn link_state(db: &SqlitePool, code: &str, now: i64) -> Result<LinkState, ApiError> {
    // (user_id, expires_at, used_at, cancelled_at, username, is_host, deactivated_at, made_by)
    type Row = (
        Vec<u8>,
        i64,
        Option<i64>,
        Option<i64>,
        String,
        bool,
        Option<i64>,
        String,
    );
    let row: Option<Row> = sqlx::query_as(
        "SELECT l.user_id, l.expires_at, l.used_at, l.cancelled_at,
                u.username, u.is_host, u.deactivated_at, m.display_name
         FROM sign_in_links l
         JOIN users u ON u.id = l.user_id
         JOIN users m ON m.id = l.made_by
         WHERE l.token_hash = ?",
    )
    .bind(code_hash(code))
    .fetch_optional(db)
    .await?;
    Ok(match row {
        None => LinkState::Dead,
        Some((_, _, Some(_), ..)) => LinkState::Used,
        Some((user_id, expires_at, None, None, username, false, None, made_by))
            if expires_at > now =>
        {
            LinkState::Open(OpenLink {
                user_id: UserId::from_slice(&user_id).map_err(anyhow::Error::from)?,
                username,
                made_by,
                expires_at,
            })
        }
        Some(_) => LinkState::Dead,
    })
}

async fn server_name(db: &SqlitePool) -> Result<Option<String>, ApiError> {
    Ok(
        sqlx::query_scalar("SELECT value FROM server_config WHERE key = 'name'")
            .fetch_optional(db)
            .await?,
    )
}

/// `GET /auth/sign-in-link/:code`: unauthenticated, like an invite's preview,
/// so the app can say whose account this is before asking for a password.
async fn preview(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Json<SignInLinkPreview>, ApiError> {
    let LinkState::Open(link) = link_state(&state.db.read, &code, now_ms()).await? else {
        return Ok(Json(SignInLinkPreview {
            valid: false,
            server_name: None,
            username: None,
            made_by: None,
            expires_at: None,
        }));
    };
    Ok(Json(SignInLinkPreview {
        valid: true,
        server_name: server_name(&state.db.read).await?,
        username: Some(link.username),
        made_by: Some(link.made_by),
        expires_at: Some(link.expires_at),
    }))
}

fn link_refused(state: &LinkState) -> ApiError {
    ApiError::forbidden(match state {
        LinkState::Used => {
            "That sign-in link has been used. If that wasn't you, ask the host for a new one."
        }
        _ => "That sign-in link doesn't work any more. Ask the host for a new one.",
    })
}

/// `POST /auth/sign-in-link`: set a new password with a link, and sign in.
/// Every other sign-in the account had ends, as a password change ends them.
async fn use_link(
    State(state): State<AppState>,
    parts: Parts,
    Json(req): Json<UseSignInLinkRequest>,
) -> Result<Json<AuthResponse>, ApiError> {
    // The same allowance as signing in: a link is a way to sign in.
    let ip = auth::client_ip(&parts, &state.config.trusted_proxies);
    if let Err(retry) = state
        .limiter
        .check(&format!("login:{ip}"), RATE_LOGIN_PER_IP)
    {
        return Err(super::auth::sign_ins_paused(retry));
    }
    validate::password(&req.new_password)?;

    // The link before the password, as an invite goes before it at sign-up:
    // hashing is the slow half, and only somebody holding a good link gets
    // the server to do it.
    let user_id = match link_state(&state.db.read, &req.code, now_ms()).await? {
        LinkState::Open(link) => link.user_id,
        refused => return Err(link_refused(&refused)),
    };
    let password_hash = state.passwords.hash(req.new_password).await?;

    let now = now_ms();
    let mut tx = state.db.write.begin().await.map_err(ApiError::from)?;
    // Claimed and checked again in one step, after the hash (which may have
    // waited for a turn): two uses at once, or one racing a newer link or a
    // removal, leave exactly one winner or none.
    let claimed = sqlx::query(
        "UPDATE sign_in_links SET used_at = ?
         WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND cancelled_at IS NULL
           AND expires_at > ?",
    )
    .bind(now)
    .bind(code_hash(&req.code))
    .bind(user_id.to_vec())
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let changed = if claimed == 1 {
        sqlx::query(
            "UPDATE users SET password_hash = ?, last_seen_at = ?
             WHERE id = ? AND deactivated_at IS NULL AND is_host = 0",
        )
        .bind(&password_hash)
        .bind(now)
        .bind(user_id.to_vec())
        .execute(&mut *tx)
        .await?
        .rows_affected()
    } else {
        0
    };
    if changed != 1 {
        drop(tx);
        let now = now_ms();
        return Err(link_refused(
            &link_state(&state.db.read, &req.code, now).await?,
        ));
    }
    auth::end_sign_ins(&mut tx, user_id, now).await?;
    tx.commit().await.map_err(ApiError::from)?;

    // Written first, then enforced, as a password change does.
    state.gateway.close_sessions_for(user_id).await;
    tracing::info!(user = %user_id, "sign-in link used");
    super::auth::auth_response(&state, user_id).await.map(Json)
}

/// Cancel every link that still works for `user_id`: on removal, so a
/// removed member can't come back through one.
pub async fn cancel_for(
    conn: &mut sqlx::SqliteConnection,
    user_id: UserId,
    now: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE sign_in_links SET cancelled_at = ?
         WHERE user_id = ? AND used_at IS NULL AND cancelled_at IS NULL",
    )
    .bind(now)
    .bind(user_id.to_vec())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_long_lowercase_base32() {
        let code = new_code();
        assert_eq!(code.len(), SIGN_IN_LINK_CHARS);
        assert!(code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)));
        assert_ne!(new_code(), code);
    }

    #[test]
    fn a_code_is_found_however_it_was_pasted() {
        assert_eq!(code_hash(" ABCdef "), code_hash("abcdef"));
    }
}
