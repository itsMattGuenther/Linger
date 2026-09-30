//! Authentication (ARCHITECTURE §7, PROTOCOL §2).
//!
//! - Passwords: argon2id `m=19456, t=2, p=1` — hashing runs on the blocking pool.
//! - Access tokens: EdDSA JWTs, 15 min. The Ed25519 key is generated at first
//!   boot into the data dir; losing it only invalidates outstanding access
//!   tokens (15 min of pain), unlike the update-signing key.
//! - Refresh tokens: opaque 256-bit, stored as sha256, rotating. Every login
//!   starts a *family*; rotation keeps the family; presenting an
//!   already-rotated token revokes the entire family (stolen-token detector).

use std::net::SocketAddr;
use std::path::Path;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::connect_info::ConnectInfo;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};
use linger_core::limits::{ACCESS_TOKEN_TTL_SECS, REFRESH_TOKEN_TTL_DAYS};
use linger_core::UserId;
use rand::RngCore;
use ring::signature::KeyPair;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

fn argon2() -> Argon2<'static> {
    // The ARCHITECTURE §7 floor. Params::new is infallible for these values.
    let params = Params::new(19_456, 2, 1, None).expect("static argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

/// Synchronous hash — only for callers already off the reactor (or one-time
/// initialization like the login timing dummy). Handlers use [`hash_password`].
pub fn hash_password_sync(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))
}

/// Hash a password on the blocking pool (argon2id is deliberately expensive).
pub async fn hash_password(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || hash_password_sync(&password)).await?
}

/// Constant-work verification on the blocking pool.
pub async fn verify_password(password: String, hash: String) -> anyhow::Result<bool> {
    tokio::task::spawn_blocking(move || {
        let parsed = PasswordHash::new(&hash).map_err(|e| anyhow::anyhow!("bad hash: {e}"))?;
        Ok(argon2()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await?
}

// ---------------------------------------------------------------------------
// Access tokens (EdDSA JWT)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    iat: u64,
    exp: u64,
}

pub struct JwtKeys {
    encoding: EncodingKey,
    decoding: DecodingKey,
}

impl JwtKeys {
    /// Load the Ed25519 keypair from the data dir, generating it on first boot.
    pub fn load_or_generate(data_dir: &Path) -> anyhow::Result<Self> {
        let path = data_dir.join("jwt_ed25519.pk8");
        let pkcs8: Vec<u8> = if path.exists() {
            std::fs::read(&path)?
        } else {
            let doc =
                ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                    .map_err(|_| anyhow::anyhow!("keypair generation failed"))?;
            std::fs::create_dir_all(data_dir)?;
            std::fs::write(&path, doc.as_ref())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }
            doc.as_ref().to_vec()
        };
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(&pkcs8)
            .map_err(|_| anyhow::anyhow!("invalid jwt key file {}", path.display()))?;
        Ok(Self {
            encoding: EncodingKey::from_ed_der(&pkcs8),
            decoding: DecodingKey::from_ed_der(pair.public_key().as_ref()),
        })
    }

    /// Mint an access token. Returns `(jwt, expires_in_seconds)`.
    pub fn mint(&self, user_id: UserId) -> anyhow::Result<(String, u64)> {
        #[allow(clippy::cast_sign_loss)]
        let now = (now_ms() / 1000) as u64;
        let claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + ACCESS_TOKEN_TTL_SECS,
        };
        let jwt = jsonwebtoken::encode(
            &Header::new(jsonwebtoken::Algorithm::EdDSA),
            &claims,
            &self.encoding,
        )?;
        Ok((jwt, ACCESS_TOKEN_TTL_SECS))
    }

    /// Verify a token and return its subject. Any failure is `Unauthenticated`
    /// — the client can't act on the distinction and attackers shouldn't get it.
    pub fn verify(&self, token: &str) -> Result<UserId, ApiError> {
        let validation = Validation::new(jsonwebtoken::Algorithm::EdDSA);
        let data = jsonwebtoken::decode::<Claims>(token, &self.decoding, &validation)
            .map_err(|_| ApiError::unauthenticated())?;
        data.claims
            .sub
            .parse()
            .map_err(|_| ApiError::unauthenticated())
    }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

fn new_opaque_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

const REFRESH_TTL_MS: i64 = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/// Start a new token family (login/register/setup). Returns the opaque token.
pub async fn issue_refresh_family(db: &SqlitePool, user_id: UserId) -> anyhow::Result<String> {
    let token = new_opaque_token();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::now_v7().as_bytes().to_vec())
    .bind(user_id.to_vec())
    .bind(Uuid::now_v7().as_bytes().to_vec())
    .bind(token_hash(&token))
    .bind(now + REFRESH_TTL_MS)
    .bind(now)
    .execute(db)
    .await?;
    Ok(token)
}

pub enum RefreshOutcome {
    /// Rotation succeeded: old token dead, here's the new one.
    Rotated { user_id: UserId, new_token: String },
    /// Unknown, expired, or reused token. Reuse additionally revoked the family
    /// before this was returned; the caller responds identically either way.
    Rejected,
}

/// Rotate a refresh token (PROTOCOL §2). Runs in one transaction on the writer.
pub async fn rotate_refresh(db: &SqlitePool, token: &str) -> anyhow::Result<RefreshOutcome> {
    // (id, user_id, family_id, expires_at, revoked_at)
    type RefreshRow = (Vec<u8>, Vec<u8>, Vec<u8>, i64, Option<i64>);

    let hash = token_hash(token);
    let now = now_ms();
    let mut tx = db.begin().await?;

    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT id, user_id, family_id, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((id, user_bytes, family, expires_at, revoked_at)) = row else {
        return Ok(RefreshOutcome::Rejected);
    };

    if revoked_at.is_some() {
        // Reuse of a rotated token: someone is replaying. Kill the family.
        sqlx::query(
            "UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
        )
        .bind(now)
        .bind(&family)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        tracing::warn!("refresh token reuse detected; family revoked");
        return Ok(RefreshOutcome::Rejected);
    }

    if expires_at <= now {
        return Ok(RefreshOutcome::Rejected);
    }

    let user_id = UserId::from_slice(&user_bytes)?;

    // Removal revokes every family this user owns, so a removed member's token
    // is normally already dead by the branch above. This is the belt: rotation
    // is the door that would otherwise keep handing out fresh 15-minute access
    // tokens for the whole 30-day refresh window (T-413).
    let live: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM users WHERE id = ? AND deactivated_at IS NULL")
            .bind(&user_bytes)
            .fetch_optional(&mut *tx)
            .await?;
    if live.is_none() {
        return Ok(RefreshOutcome::Rejected);
    }

    let new_token = new_opaque_token();

    sqlx::query("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?")
        .bind(now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::now_v7().as_bytes().to_vec())
    .bind(user_id.to_vec())
    .bind(&family)
    .bind(token_hash(&new_token))
    .bind(now + REFRESH_TTL_MS)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(RefreshOutcome::Rotated { user_id, new_token })
}

/// Logout: revoke the presented token's whole family. Idempotent; unknown
/// tokens are silently fine (logout must never fail).
pub async fn revoke_family(db: &SqlitePool, token: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = ?
         WHERE revoked_at IS NULL
           AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)",
    )
    .bind(now_ms())
    .bind(token_hash(token))
    .execute(db)
    .await?;
    Ok(())
}

/// Password change / deactivation: revoke everything the user holds.
pub async fn revoke_all_for_user(db: &SqlitePool, user_id: UserId) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(now_ms())
    .bind(user_id.to_vec())
    .execute(db)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/// Any authenticated member. `Authorization: Bearer <jwt>` only.
///
/// **Removed members are refused here, not just at the next refresh** (T-413).
/// That costs one primary-key read on the read pool per authenticated request,
/// which is the same read `HostUser` already pays for `is_host`. The other
/// answer — let the access token lapse on its own — buys that read back at the
/// price of up to fifteen minutes in which somebody the host just removed can
/// still post, and those fifteen minutes are the exact thing the host was
/// trying to stop. One read by primary key is not the expensive half of any
/// request, however many people the server has.
#[derive(Debug, Clone, Copy)]
pub struct AuthedUser {
    pub id: UserId,
}

impl FromRequestParts<AppState> for AuthedUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthenticated)?;
        let id = state.jwt.verify(token)?;
        let live: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM users WHERE id = ? AND deactivated_at IS NULL")
                .bind(id.to_vec())
                .fetch_optional(&state.db.read)
                .await?;
        if live.is_none() {
            return Err(ApiError::unauthenticated());
        }
        Ok(Self { id })
    }
}

/// The host. It is "the host", never "admin" (SPEC §1 vocabulary).
#[derive(Debug, Clone, Copy)]
pub struct HostUser {
    pub id: UserId,
}

impl FromRequestParts<AppState> for HostUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let user = AuthedUser::from_request_parts(parts, state).await?;
        let (is_host,): (bool,) =
            sqlx::query_as("SELECT is_host FROM users WHERE id = ? AND deactivated_at IS NULL")
                .bind(user.id.to_vec())
                .fetch_optional(&state.db.read)
                .await?
                .ok_or_else(ApiError::unauthenticated)?;
        if !is_host {
            return Err(ApiError::forbidden("Only the host can do that."));
        }
        Ok(Self { id: user.id })
    }
}

/// Best client-IP guess for per-IP limits: first `X-Forwarded-For` entry when a
/// reverse proxy set one, else the socket peer.
#[must_use]
pub fn client_ip(parts: &Parts) -> String {
    if let Some(xff) = parts
        .headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return xff.to_string();
    }
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(|| "unknown".to_string(), |c| c.0.ip().to_string())
}
