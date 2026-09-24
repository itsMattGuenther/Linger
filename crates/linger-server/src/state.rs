//! Shared application state. Cloned per-request by axum; everything inside is
//! a handle (pools, Arcs), so clones are cheap.

use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::auth::JwtKeys;
use crate::config::{Config, Storage};
use crate::db::Db;
use crate::gateway::Gateway;
use crate::ratelimit::RateLimiter;
use crate::setup::SetupState;
use crate::storage::{LocalStore, ObjectStore, S3Store};

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub config: Arc<Config>,
    pub jwt: Arc<JwtKeys>,
    pub limiter: Arc<RateLimiter>,
    pub gateway: Arc<Gateway>,
    pub setup: Arc<SetupState>,
    /// Where uploaded bytes live (ARCHITECTURE §8).
    pub storage: Arc<dyn ObjectStore>,
    /// The same store again, when it is the local one. Only the local backend
    /// runs an upload listener on this server — with S3 the client PUTs at S3 —
    /// so the listener route needs the concrete type, and its absence is how
    /// that route knows it has nothing to do.
    pub local: Option<Arc<LocalStore>>,
    /// How many export archives may build at once, across the whole server.
    /// The per-member limits bound what one person can ask for; this bounds
    /// what everybody asking at once costs the host's disk (`export.rs`).
    pub exports: Arc<Semaphore>,
}

impl AppState {
    /// Wire everything up: JWT keys from the data dir, setup armed iff the
    /// server has no users yet.
    pub async fn build(db: Db, config: Config) -> anyhow::Result<Self> {
        let jwt = JwtKeys::load_or_generate(&config.data_dir)?;
        let (user_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
            .fetch_one(&db.read)
            .await?;
        let config = Arc::new(config);
        // Only the local backend has a listener on this server, so only the
        // local backend is kept as a concrete handle as well as a trait object.
        let (storage, local): (Arc<dyn ObjectStore>, Option<Arc<LocalStore>>) = match config.storage
        {
            Storage::Local => {
                let local = Arc::new(LocalStore::open(config.clone())?);
                (local.clone(), Some(local))
            }
            Storage::S3 => (Arc::new(S3Store::open(&config)?), None),
        };
        // Who is in each DM, before anything can connect (SPEC §4.13). The `?`
        // is load-bearing: an empty audience index does not fail safe, it makes
        // every DM on the server look like a public room, so a server that
        // cannot read this must not come up at all.
        let gateway = Arc::new(Gateway::new());
        gateway
            .reload_dms(&db.read)
            .await
            .map_err(|_| anyhow::anyhow!("could not load DM membership from the database"))?;

        Ok(Self {
            db,
            config,
            jwt: Arc::new(jwt),
            limiter: Arc::new(RateLimiter::new()),
            gateway,
            setup: Arc::new(SetupState::new(user_count == 0)),
            storage,
            local,
            exports: Arc::new(Semaphore::new(crate::export::BUILDING_AT_ONCE)),
        })
    }
}
