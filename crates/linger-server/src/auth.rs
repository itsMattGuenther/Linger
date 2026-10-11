//! Authentication (ARCHITECTURE §7, PROTOCOL §2).
//!
//! - Passwords: argon2id `m=19456, t=2, p=1` — hashing runs on the blocking pool,
//!   [`PASSWORD_WORK_AT_ONCE`] at a time across the whole server ([`PasswordWork`]).
//! - Access tokens: EdDSA JWTs, 15 min. The Ed25519 key is generated at first
//!   boot into the data dir; losing it only invalidates outstanding access
//!   tokens (15 min of pain), unlike the update-signing key.
//! - Refresh tokens: opaque 256-bit, stored as sha256, rotating. Every login
//!   starts a *family*; rotation keeps the family; presenting an
//!   already-rotated token revokes the entire family (stolen-token detector).

use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use axum::extract::connect_info::ConnectInfo;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation};
use linger_core::limits::{ACCESS_TOKEN_TTL_SECS, REFRESH_TOKEN_TTL_DAYS};
use linger_core::wire::ErrorCode;
use linger_core::UserId;
use rand::RngCore;
use ring::signature::KeyPair;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;
use uuid::Uuid;

use crate::config::TrustedProxies;
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
/// initialization like the login timing dummy). Handlers use
/// [`PasswordWork::hash`], which takes a turn first.
pub fn hash_password_sync(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("argon2 hash: {e}"))
}

/// Constant-work verification. Same rule as [`hash_password_sync`]: handlers
/// go through [`PasswordWork::verify`].
fn verify_password_sync(password: &str, hash: &str) -> anyhow::Result<bool> {
    let parsed = PasswordHash::new(hash).map_err(|e| anyhow::anyhow!("bad hash: {e}"))?;
    Ok(argon2()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/// How many argon2id hashes and checks run at the same time, across the
/// whole server (#495).
///
/// Each one holds about 19 MB (`m=19456`) and one core (`p=1`) for as long as
/// it runs, and they run on tokio's blocking pool, which would start hundreds
/// of threads for hundreds of requests. Four caps what passwords can cost the
/// host at about 76 MB, whatever arrives. It is also about the core count of
/// the small machines Linger runs on, where more at once would finish no
/// sooner and only hold more memory; on a bigger machine four still get
/// through dozens of sign-ins a second, more than a server of friends sends.
pub const PASSWORD_WORK_AT_ONCE: usize = 4;

/// How long a sign-in or sign-up waits for a turn before it is refused with
/// `RATE_LIMITED`. Waiting rather than refusing straight away means a real
/// person who signs in at the same moment as a few others only waits a
/// moment. A flood is turned away instead of piling up. Well inside the
/// client's 30-second request timeout, so the person sees the refusal's
/// words rather than a dropped connection.
pub const PASSWORD_WORK_WAIT: Duration = Duration::from_secs(5);

/// The turns password work takes (#495). Every argon2id hash and check a
/// request makes goes through here: sign-in, sign-up, first-run setup and
/// changing a password. A stranger hammering sign-in can make the server
/// queue, never make it hold more than [`PASSWORD_WORK_AT_ONCE`] hashes'
/// worth of memory.
pub struct PasswordWork {
    /// One permit per hash or check running. Public so a test can take them
    /// all, the way tests take `AppState::exports`.
    pub turns: Arc<Semaphore>,
    wait: Duration,
    waiting: AtomicUsize,
    started: AtomicU64,
}

impl PasswordWork {
    #[must_use]
    pub fn new(at_once: usize, wait: Duration) -> Self {
        Self {
            turns: Arc::new(Semaphore::new(at_once)),
            wait,
            waiting: AtomicUsize::new(0),
            started: AtomicU64::new(0),
        }
    }

    /// Hash a new password, once a turn is free.
    pub async fn hash(&self, password: String) -> Result<String, ApiError> {
        Ok(self.run(move || hash_password_sync(&password)).await??)
    }

    /// Check a password against its stored hash, once a turn is free.
    pub async fn verify(&self, password: String, hash: String) -> Result<bool, ApiError> {
        Ok(self
            .run(move || verify_password_sync(&password, &hash))
            .await??)
    }

    /// How many hashes and checks have been given a turn since the server
    /// started. Tests count with it: a request that should cost nothing
    /// must leave it where it was.
    #[must_use]
    pub fn started(&self) -> u64 {
        self.started.load(Ordering::SeqCst)
    }

    /// How many requests are waiting for a turn right now.
    #[must_use]
    pub fn waiting(&self) -> usize {
        self.waiting.load(Ordering::SeqCst)
    }

    /// Run `work` on the blocking pool once a turn is free, or refuse after
    /// [`PASSWORD_WORK_WAIT`].
    ///
    /// The turn moves into the blocking task and is given back when the work
    /// is done, not when the request is. A request whose client hangs up is
    /// dropped mid-await, but its hash runs to the end on its thread anyway;
    /// if the turn went back with the request, opening and closing
    /// connections would walk straight past the cap.
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, ApiError> {
        let turn = {
            let _waiting = Waiting::start(&self.waiting);
            tokio::time::timeout(self.wait, self.turns.clone().acquire_owned()).await
        };
        let turn = match turn {
            Ok(Ok(turn)) => turn,
            // The semaphore is never closed.
            Ok(Err(closed)) => return Err(anyhow::Error::from(closed).into()),
            Err(_) => return Err(busy(self.wait)),
        };
        self.started.fetch_add(1, Ordering::SeqCst);
        tokio::task::spawn_blocking(move || {
            let _turn = turn;
            work()
        })
        .await
        .map_err(|joined| anyhow::Error::from(joined).into())
    }
}

/// Counts a request as waiting for as long as it is, including when it is
/// dropped while it waits.
struct Waiting<'a>(&'a AtomicUsize);

impl<'a> Waiting<'a> {
    fn start(count: &'a AtomicUsize) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// No turn came free in time. Honest about why, unlike the per-address limits'
/// "Slow down a little.": this person may have done nothing but arrive at a
/// busy moment.
fn busy(wait: Duration) -> ApiError {
    ApiError {
        status: StatusCode::TOO_MANY_REQUESTS,
        code: ErrorCode::RateLimited,
        message: "The server is busy. Try again in a moment.".into(),
        retry_after_ms: Some(u64::try_from(wait.as_millis()).unwrap_or(u64::MAX)),
    }
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

/// The address the per-address limits (sign-in, sign-up) are kept against.
///
/// The connection's own peer, unless that peer is a proxy we can believe
/// (`LINGER_TRUSTED_PROXIES`, by default one on this machine or on a private
/// network, which is how the shipped Caddy container reaches the server over
/// Docker's network). Only then is `X-Forwarded-For` read, and only its
/// **last** entry, the one the nearest proxy wrote. Every entry before it is
/// whatever the client sent. This used to take the first, so each request
/// could claim a new address and walk past the limits, from anywhere (#495).
///
/// Caddy replaces the header for a client it doesn't trust, so behind it the
/// last entry is the person's own address. A proxy that appends instead
/// (nginx's `$proxy_add_x_forwarded_for`) puts the address it saw last, which
/// is still the right one. A header with nothing usable at the end counts as
/// the proxy itself: everybody behind it then shares one allowance, which is
/// the safe way to be wrong.
///
/// The same is true of a proxy the server doesn't trust, which is why the
/// first header from one is logged, once per process: a host behind a proxy
/// on an unusual address sees why everybody shares an allowance, and what to
/// set.
#[must_use]
pub fn client_ip(parts: &Parts, trusted: &TrustedProxies) -> String {
    let Some(peer) = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_canonical())
    else {
        return "unknown".to_string();
    };
    if !trusted.trusts(peer) {
        if parts.headers.contains_key("x-forwarded-for") {
            UNTRUSTED_FORWARD.call_once(|| {
                tracing::warn!(
                    "A request from {peer} said who it was passing on for (X-Forwarded-For), \
                     but {peer} isn't a proxy this server trusts, so it counts as {peer} for \
                     the limits on signing in and signing up. If a proxy of yours connects \
                     from there, add it to LINGER_TRUSTED_PROXIES (docs/host-guide.md); \
                     until then everybody behind it shares one allowance. If not, it was \
                     somebody claiming to be somebody else, and it changed nothing. Said \
                     once per start."
                );
            });
        }
        return peer.to_string();
    }
    last_forwarded(&parts.headers).unwrap_or(peer).to_string()
}

/// [`client_ip`] has said once that an untrusted peer sent `X-Forwarded-For`.
static UNTRUSTED_FORWARD: std::sync::Once = std::sync::Once::new();

/// The last `X-Forwarded-For` entry, if it is an address. Several header
/// lines read as one list, in order.
fn last_forwarded(headers: &HeaderMap) -> Option<IpAddr> {
    let line = headers.get_all("x-forwarded-for").iter().next_back()?;
    let entry = line.to_str().ok()?.rsplit(',').next()?.trim();
    entry.parse::<IpAddr>().ok().map(|ip| ip.to_canonical())
}

#[cfg(test)]
mod tests {
    use std::sync::{Condvar, Mutex};

    use super::*;

    /// A request as the router hands it over: from `peer`, with these
    /// `X-Forwarded-For` lines.
    fn request_from(peer: &str, forwarded: &[&str]) -> Parts {
        let mut request = axum::http::Request::builder();
        for line in forwarded {
            request = request.header("x-forwarded-for", *line);
        }
        let (mut parts, ()) = request.body(()).unwrap().into_parts();
        parts
            .extensions
            .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        parts
    }

    #[test]
    fn a_public_peer_is_its_own_address_whatever_it_claims() {
        // Somebody reaching the server directly writes whatever they like.
        let parts = request_from("203.0.113.7:51000", &["198.51.100.1"]);
        assert_eq!(client_ip(&parts, &TrustedProxies::default()), "203.0.113.7");
        let parts = request_from("[2001:db8::7]:51000", &["198.51.100.1"]);
        assert_eq!(client_ip(&parts, &TrustedProxies::default()), "2001:db8::7");
    }

    #[test]
    fn behind_a_proxy_the_last_entry_counts_not_the_first() {
        // The client wrote the first entry; the proxy appended the last.
        let parts = request_from("172.18.0.3:40000", &["10.9.8.7, 203.0.113.7"]);
        assert_eq!(client_ip(&parts, &TrustedProxies::default()), "203.0.113.7");
        // The same thing split over two header lines.
        let parts = request_from("172.18.0.3:40000", &["10.9.8.7", "203.0.113.7"]);
        assert_eq!(client_ip(&parts, &TrustedProxies::default()), "203.0.113.7");
        // Caddy's own: one entry, the person's address.
        let parts = request_from("172.18.0.3:40000", &["203.0.113.7"]);
        assert_eq!(client_ip(&parts, &TrustedProxies::default()), "203.0.113.7");
    }

    #[test]
    fn loopback_and_private_peers_are_proxies_and_others_are_not() {
        for proxy in [
            "127.0.0.1:1",
            "10.0.0.2:1",
            "172.16.0.2:1",
            "192.168.1.2:1",
            "[::1]:1",
            "[fd00::2]:1",
            "[::ffff:172.18.0.3]:1",
        ] {
            let parts = request_from(proxy, &["203.0.113.7"]);
            assert_eq!(
                client_ip(&parts, &TrustedProxies::default()),
                "203.0.113.7",
                "{proxy} is a proxy"
            );
        }
        for stranger in ["100.64.0.2:1", "169.254.1.2:1", "[fe80::2]:1", "8.8.8.8:1"] {
            let parts = request_from(stranger, &["203.0.113.7"]);
            assert_ne!(
                client_ip(&parts, &TrustedProxies::default()),
                "203.0.113.7",
                "{stranger} is not"
            );
        }
    }

    #[test]
    fn a_proxy_with_nothing_usable_in_the_header_is_its_own_address() {
        for line in ["", "not an address", "203.0.113.7, ", "203.0.113.7:443"] {
            let parts = request_from("172.18.0.3:40000", &[line]);
            assert_eq!(
                client_ip(&parts, &TrustedProxies::default()),
                "172.18.0.3",
                "{line:?}"
            );
        }
        let parts = request_from("[::ffff:172.18.0.3]:40000", &[]);
        assert_eq!(client_ip(&parts, &TrustedProxies::default()), "172.18.0.3");
    }

    #[test]
    fn a_proxy_the_host_names_is_believed_and_a_stranger_still_is_not() {
        // Caddy on a VPS, reaching this machine over Tailscale: not a private
        // address, so only believed once the host names it.
        let tailscale: TrustedProxies = "private,100.64.0.0/10".parse().unwrap();
        let parts = request_from("100.101.102.103:40000", &["10.9.8.7, 203.0.113.7"]);
        assert_eq!(
            client_ip(&parts, &TrustedProxies::default()),
            "100.101.102.103"
        );
        assert_eq!(client_ip(&parts, &tailscale), "203.0.113.7");

        // Naming one proxy makes nobody else one.
        let parts = request_from("198.51.100.4:51000", &["203.0.113.7"]);
        assert_eq!(client_ip(&parts, &tailscale), "198.51.100.4");
        let parts = request_from("[2001:db8::4]:51000", &["203.0.113.7"]);
        assert_eq!(client_ip(&parts, &tailscale), "2001:db8::4");
    }

    /// Work that stays running until the test lets it finish, and says when
    /// it starts and how many ran at once.
    #[derive(Default)]
    struct Held {
        open: Mutex<bool>,
        opened: Condvar,
        running: AtomicUsize,
        most: AtomicUsize,
    }

    impl Held {
        fn work(self: &Arc<Self>) -> impl FnOnce() + Send + 'static {
            let held = self.clone();
            move || {
                let now = held.running.fetch_add(1, Ordering::SeqCst) + 1;
                held.most.fetch_max(now, Ordering::SeqCst);
                let mut open = held.open.lock().unwrap();
                while !*open {
                    open = held.opened.wait(open).unwrap();
                }
                held.running.fetch_sub(1, Ordering::SeqCst);
            }
        }

        fn release(&self) {
            *self
                .open
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = true;
            self.opened.notify_all();
        }
    }

    /// Lets held work finish when a test ends, however it ends. A failed
    /// assertion has to fail the test, not leave threads blocked that the
    /// runtime then waits on forever as it shuts down.
    struct ReleaseOnDrop(Arc<Held>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    /// Polls until `ready`, which must come true on its own. Waits for the
    /// thing itself, never a fixed time (docs/testing-strategy.md); the bound
    /// only turns a hang into a failure.
    async fn until(what: &str, ready: impl Fn() -> bool) {
        for _ in 0..2_000 {
            if ready() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("never happened: {what}");
    }

    #[tokio::test]
    async fn no_more_than_the_turns_run_at_once_and_the_rest_wait() {
        let work = Arc::new(PasswordWork::new(2, Duration::from_secs(600)));
        let held = Arc::new(Held::default());
        let _release = ReleaseOnDrop(held.clone());
        let mut tasks = Vec::new();
        for _ in 0..6 {
            let (work, job) = (work.clone(), held.work());
            tasks.push(tokio::spawn(async move { work.run(job).await }));
        }

        // Everybody has arrived, and everybody given a turn has got as far
        // as running: a turn is taken a moment before its thread starts.
        until("six requests at the door, the turns' work running", || {
            let started = work.started();
            started + work.waiting() as u64 == 6
                && held.running.load(Ordering::SeqCst) as u64 == started
        })
        .await;
        assert_eq!(work.started(), 2);
        assert_eq!(work.waiting(), 4);
        assert_eq!(held.running.load(Ordering::SeqCst), 2);

        held.release();
        for task in tasks {
            assert!(task.await.unwrap().is_ok(), "a waiting request was refused");
        }
        assert_eq!(work.started(), 6);
        assert_eq!(held.most.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_request_that_cannot_get_a_turn_in_time_is_told_the_server_is_busy() {
        let work = PasswordWork::new(1, Duration::from_millis(50));
        let _taken = work.turns.clone().acquire_owned().await.unwrap();

        let refused = work.run(|| ()).await.unwrap_err();
        assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(refused.code, ErrorCode::RateLimited);
        assert_eq!(refused.retry_after_ms, Some(50));
        assert_eq!(work.started(), 0, "it hashed without a turn");
        assert_eq!(work.waiting(), 0);
    }

    #[tokio::test]
    async fn a_turn_is_held_until_the_work_ends_even_when_the_request_is_gone() {
        let work = Arc::new(PasswordWork::new(1, Duration::from_secs(600)));
        let held = Arc::new(Held::default());
        let _release = ReleaseOnDrop(held.clone());
        let request = {
            let (work, job) = (work.clone(), held.work());
            tokio::spawn(async move { work.run(job).await })
        };
        until("the work to start", || {
            held.running.load(Ordering::SeqCst) == 1
        })
        .await;

        // The client hangs up: the request is dropped, the hash is not.
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(
            work.turns.available_permits(),
            0,
            "the turn left with the request"
        );

        held.release();
        until("the turn to come back", || {
            work.turns.available_permits() == 1
        })
        .await;
    }

    #[tokio::test]
    async fn hashes_and_checks_agree() {
        let work = PasswordWork::new(1, Duration::from_secs(600));
        let hash = work.hash("correct horse battery".into()).await.unwrap();
        assert!(work
            .verify("correct horse battery".into(), hash.clone())
            .await
            .unwrap());
        assert!(!work
            .verify("wrong horse battery".into(), hash)
            .await
            .unwrap());
        assert_eq!(work.started(), 3);
    }
}
