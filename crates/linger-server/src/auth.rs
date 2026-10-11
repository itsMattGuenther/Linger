//! Authentication (ARCHITECTURE §7, PROTOCOL §2).
//!
//! - Passwords: argon2id `m=19456, t=2, p=1` — hashing runs on the blocking pool.
//! - Access tokens: EdDSA JWTs, 15 min. The Ed25519 key is generated at first
//!   boot into the data dir; losing it only invalidates outstanding access
//!   tokens (15 min of pain), unlike the update-signing key.
//! - Refresh tokens: opaque 256-bit, stored as sha256, rotating. Every login
//!   starts a *family*; rotation keeps the family; presenting an
//!   already-rotated token revokes the entire family (stolen-token detector).
//! - Ending every sign-in an account has (#496): [`end_sign_ins`] revokes the
//!   refresh families and moves the account's `token_generation` on, which
//!   every access token minted before it carries less of ([`still_signed_in`]).

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
use sqlx::{SqliteConnection, SqlitePool};
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
    /// The account's `token_generation` when this was minted (#496). Tokens
    /// minted before the claim existed leave it out, and count as 0, which
    /// is where every account started.
    #[serde(rename = "gen", default)]
    generation: i64,
}

/// What a valid access token says: whose it is, and which generation of their
/// sign-ins it belongs to (#496).
///
/// A signature that checks out is only half of it. [`still_signed_in`] asks
/// the other half, whether those sign-ins have been ended since, and every
/// door that takes a token asks it: the bearer extractor, and the gateway's
/// identify and resume.
#[derive(Debug, Clone, Copy)]
pub struct Bearer {
    pub user_id: UserId,
    generation: i64,
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
    ///
    /// `generation` is the account's `token_generation` as it is now
    /// ([`token_generation`]): the token stops working once that moves on.
    pub fn mint(&self, user_id: UserId, generation: i64) -> anyhow::Result<(String, u64)> {
        #[allow(clippy::cast_sign_loss)]
        let now = (now_ms() / 1000) as u64;
        let claims = Claims {
            sub: user_id.to_string(),
            iat: now,
            exp: now + ACCESS_TOKEN_TTL_SECS,
            generation,
        };
        let jwt = jsonwebtoken::encode(
            &Header::new(jsonwebtoken::Algorithm::EdDSA),
            &claims,
            &self.encoding,
        )?;
        Ok((jwt, ACCESS_TOKEN_TTL_SECS))
    }

    /// Verify a token's signature and expiry, and say what it carries. Any
    /// failure is `Unauthenticated` — the client can't act on the distinction
    /// and attackers shouldn't get it.
    ///
    /// Not enough on its own to let anybody in: see [`Bearer`].
    pub fn verify(&self, token: &str) -> Result<Bearer, ApiError> {
        let validation = Validation::new(jsonwebtoken::Algorithm::EdDSA);
        let data = jsonwebtoken::decode::<Claims>(token, &self.decoding, &validation)
            .map_err(|_| ApiError::unauthenticated())?;
        let user_id = data
            .claims
            .sub
            .parse()
            .map_err(|_| ApiError::unauthenticated())?;
        Ok(Bearer {
            user_id,
            generation: data.claims.generation,
        })
    }
}

/// The account's `token_generation` now, for minting a token that belongs to
/// it. Read after whatever ended the last generation has committed, so a token
/// minted straight after a password change is a good one.
pub async fn token_generation(db: &SqlitePool, user_id: UserId) -> Result<i64, ApiError> {
    let generation: i64 = sqlx::query_scalar("SELECT token_generation FROM users WHERE id = ?")
        .bind(user_id.to_vec())
        .fetch_one(db)
        .await?;
    Ok(generation)
}

/// Whether a verified token's sign-in is still going: the account isn't
/// removed (T-413), and nothing has ended every sign-in it has since the token
/// was minted (#496). One primary-key read.
///
/// A count rather than a time is what makes this exact. Token times are in
/// whole seconds, so a time could not tell a token minted just before a
/// password change from the fresh one minted just after it, in the same second.
pub async fn still_signed_in(db: &SqlitePool, bearer: Bearer) -> Result<bool, ApiError> {
    let now: Option<i64> = sqlx::query_scalar(
        "SELECT token_generation FROM users WHERE id = ? AND deactivated_at IS NULL",
    )
    .bind(bearer.user_id.to_vec())
    .fetch_optional(db)
    .await?;
    Ok(now.is_some_and(|now| bearer.generation >= now))
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
    /// Rotation succeeded: old token dead, here's the new one, and the
    /// account's `token_generation` to mint its access token with.
    Rotated {
        user_id: UserId,
        generation: i64,
        new_token: String,
    },
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
    //
    // Read in the same transaction as the rotation, so a password change can't
    // land between them and leave this minting a token for the generation it
    // just ended (#496).
    let generation: Option<i64> = sqlx::query_scalar(
        "SELECT token_generation FROM users WHERE id = ? AND deactivated_at IS NULL",
    )
    .bind(&user_bytes)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(generation) = generation else {
        return Ok(RefreshOutcome::Rejected);
    };

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

    Ok(RefreshOutcome::Rotated {
        user_id,
        generation,
        new_token,
    })
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

/// End every sign-in this account has (#496): revoke every refresh family, and
/// move the account's `token_generation` on so that every access token already
/// handed out is refused from now on ([`still_signed_in`]).
///
/// On the caller's transaction, so it lands with whatever made it necessary: a
/// new password, or removal. Open gateway sessions are the caller's to close
/// ([`crate::gateway::Gateway::close_sessions_for`]), after the commit. A
/// session closed first could identify again with a token that still worked.
pub async fn end_sign_ins(
    conn: &mut SqliteConnection,
    user_id: UserId,
    now: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(user_id.to_vec())
    .execute(&mut *conn)
    .await?;
    sqlx::query("UPDATE users SET token_generation = token_generation + 1 WHERE id = ?")
        .bind(user_id.to_vec())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// [`end_sign_ins`] on its own, for the command line's password reset (T-414).
///
/// That runs in a process of its own, with no gateway to tell. The host guide
/// has the server stopped while it does, which has closed every session
/// already; one left running keeps a socket that is already open until it next
/// has to show a token.
pub async fn revoke_all_for_user(db: &SqlitePool, user_id: UserId) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;
    end_sign_ins(&mut tx, user_id, now_ms()).await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/// Any authenticated member. `Authorization: Bearer <jwt>` only.
///
/// **Removed members are refused here, not just at the next refresh** (T-413),
/// and so is a token from before a password change (#496): [`still_signed_in`].
/// That costs one primary-key read on the read pool per authenticated request,
/// which is the same read the host extractors already pay for [`standing`]. The other
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
        let bearer = state.jwt.verify(token)?;
        if !still_signed_in(&state.db.read, bearer).await? {
            return Err(ApiError::unauthenticated());
        }
        Ok(Self { id: bearer.user_id })
    }
}

/// What somebody is to the server: the host, a co-host the host named, or
/// neither (#424). It is "the host" and "a co-host", never "admin" or
/// "moderator" (SPEC §1 vocabulary).
///
/// Two values that do anything and nothing in between, on purpose: a co-host
/// is one switch with a fixed meaning, not the first rung of a role ladder
/// (SPEC §2 anti-goals, `docs/decisions.md`). Do not add a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    Host,
    Cohost,
    Member,
}

impl Standing {
    /// The host's powers in the app: the host, or a co-host.
    #[must_use]
    pub const fn hosts(self) -> bool {
        matches!(self, Self::Host | Self::Cohost)
    }
}

/// Where somebody stands, or `None` for an account that is removed or was
/// never here. One primary-key read, like the bearer extractor's.
///
/// The host is never also a co-host (`routes/users.rs` refuses it), but if a
/// row said both, the host wins: nothing a co-host can't do is lost that way.
pub async fn standing(db: &SqlitePool, id: UserId) -> Result<Option<Standing>, ApiError> {
    let row: Option<(bool, bool)> = sqlx::query_as(
        "SELECT is_host, is_cohost FROM users WHERE id = ? AND deactivated_at IS NULL",
    )
    .bind(id.to_vec())
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(is_host, is_cohost)| match (is_host, is_cohost) {
        (true, _) => Standing::Host,
        (false, true) => Standing::Cohost,
        (false, false) => Standing::Member,
    }))
}

/// The host and nobody else. Only one thing needs it: making and clearing
/// co-hosts (#424). Everything else the host does, a co-host does too, and
/// takes [`HostOrCohost`].
#[derive(Debug, Clone, Copy)]
pub struct HostUser {
    pub id: UserId,
}

impl FromRequestParts<AppState> for HostUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let user = AuthedUser::from_request_parts(parts, state).await?;
        match standing(&state.db.read, user.id).await? {
            Some(Standing::Host) => Ok(Self { id: user.id }),
            Some(_) => Err(ApiError::forbidden("Only the host can do that.")),
            None => Err(ApiError::unauthenticated()),
        }
    }
}

/// The host, or a co-host the host named (#424): whoever has the host's
/// powers in the app. Every host endpoint takes this, except the one that
/// makes co-hosts.
///
/// A co-host can do all of it but one more thing besides: act on the host.
/// An endpoint that acts on a person asks [`HostOrCohost::not_on_the_host`]
/// before it does, so a co-host can't remove the host, take them out of
/// voice, delete their messages or revoke their invites. Those two
/// exceptions are the whole difference, and there will be no third.
#[derive(Debug, Clone, Copy)]
pub struct HostOrCohost {
    pub id: UserId,
    pub standing: Standing,
}

impl HostOrCohost {
    /// Refuse a co-host acting on the host, in the words given. The host
    /// themselves, and anybody acting on somebody else, pass.
    pub async fn not_on_the_host(
        &self,
        db: &SqlitePool,
        target: UserId,
        refusal: &str,
    ) -> Result<(), ApiError> {
        refuse_on_the_host(db, self.standing, target, refusal).await
    }
}

/// [`HostOrCohost::not_on_the_host`] for an endpoint where the person acting
/// may be neither, like deleting a message: an author deletes their own, and
/// only the host's powers reach anybody else's.
pub async fn refuse_on_the_host(
    db: &SqlitePool,
    acting: Standing,
    target: UserId,
    refusal: &str,
) -> Result<(), ApiError> {
    if acting == Standing::Cohost && standing(db, target).await? == Some(Standing::Host) {
        return Err(ApiError::forbidden(refusal));
    }
    Ok(())
}

impl FromRequestParts<AppState> for HostOrCohost {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let user = AuthedUser::from_request_parts(parts, state).await?;
        match standing(&state.db.read, user.id).await? {
            Some(standing) if standing.hosts() => Ok(Self {
                id: user.id,
                standing,
            }),
            Some(_) => Err(ApiError::forbidden(
                "Only the host or a co-host can do that.",
            )),
            None => Err(ApiError::unauthenticated()),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Tokens minted before #496 carry no generation. They have to keep
    /// working until something ends the account's sign-ins, or the update
    /// itself would sign everybody out.
    #[test]
    fn a_token_from_before_generations_counts_as_the_first() {
        #[derive(Serialize)]
        struct Before {
            sub: String,
            iat: u64,
            exp: u64,
        }
        let dir = tempfile::tempdir().unwrap();
        let keys = JwtKeys::load_or_generate(dir.path()).unwrap();
        let user = UserId::new();
        #[allow(clippy::cast_sign_loss)]
        let now = (now_ms() / 1000) as u64;
        let before = jsonwebtoken::encode(
            &Header::new(jsonwebtoken::Algorithm::EdDSA),
            &Before {
                sub: user.to_string(),
                iat: now,
                exp: now + ACCESS_TOKEN_TTL_SECS,
            },
            &keys.encoding,
        )
        .unwrap();
        let bearer = keys.verify(&before).unwrap();
        assert_eq!(bearer.user_id, user);
        assert_eq!(bearer.generation, 0);

        let (minted, _) = keys.mint(user, 3).unwrap();
        assert_eq!(keys.verify(&minted).unwrap().generation, 3);
    }
}
