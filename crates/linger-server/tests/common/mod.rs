//! Shared integration-test harness (AGENTS.md): every test drives real HTTP
//! against the production router with a temp SQLite file. No mocks.
#![allow(dead_code)] // each test binary uses a different subset of helpers

use linger_core::limits::{DEFAULT_FILE_EXPIRY_DAYS, DEFAULT_POOL_BYTES};
use linger_core::wire::{AuthResponse, Invite};
use linger_server::config::{Config, S3Config, Storage};
use linger_server::{db, AppState};

pub struct TestServer {
    pub base: String,
    pub state: AppState,
    _dir: tempfile::TempDir,
}

impl TestServer {
    #[must_use]
    pub fn url(&self, path: &str) -> String {
        format!("{}/api/v1{path}", self.base)
    }

    /// The WS gateway URL.
    #[must_use]
    pub fn gateway_url(&self) -> String {
        format!("{}/api/v1/gateway", self.base.replace("http://", "ws://"))
    }
}

/// Boot a fully wired server on an ephemeral port, storing uploads on disk.
///
/// No domain, so it has one origin and hands out root-relative URLs — the same
/// shape as a server on a LAN address.
pub async fn spawn_server() -> TestServer {
    spawn_tuned(|_| {}).await
}

/// The same server with the storage knobs turned to something a test can
/// reach: a tiny pool, or an expiry measured in days that have already passed.
/// Both are environment variables on a real server (docs/decisions.md), and a
/// test must not set process environment other tests are also reading.
pub async fn spawn_tuned(tune: impl FnOnce(&mut Config)) -> TestServer {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut config = Config {
        data_dir: dir.path().to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        domain: None,
        media_domain: None,
        storage: Storage::Local,
        s3: None,
        pool_bytes: DEFAULT_POOL_BYTES,
        file_expiry_days: Some(DEFAULT_FILE_EXPIRY_DAYS),
        turn: None,
        voice_forwarding: None,
    };
    tune(&mut config);
    spawn_with(dir, config).await
}

/// The same server, but named — so uploads are served from their own host and
/// the origin split is switched on (T-503).
pub async fn spawn_named_server(domain: &str, media_domain: &str) -> TestServer {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        domain: Some(domain.to_string()),
        media_domain: Some(media_domain.to_string()),
        storage: Storage::Local,
        s3: None,
        pool_bytes: DEFAULT_POOL_BYTES,
        file_expiry_days: Some(DEFAULT_FILE_EXPIRY_DAYS),
        turn: None,
        voice_forwarding: None,
    };
    spawn_with(dir, config).await
}

/// The same server with `LINGER_STORAGE=s3`, or `None` when there is no bucket
/// to talk to.
///
/// The S3 tests need a real S3 API on the other end — CI runs MinIO in a
/// container, and `scripts/minio-test.sh` starts one locally. Without
/// `LINGER_TEST_S3_ENDPOINT` set they skip rather than fail, so an ordinary
/// `cargo test --workspace` on a laptop stays green. The variables are
/// deliberately not the `LINGER_S3_*` ones a real server reads: a test must
/// never be able to write into somebody's actual bucket by inheriting its
/// environment.
pub async fn spawn_s3_server() -> Option<TestServer> {
    let endpoint = std::env::var("LINGER_TEST_S3_ENDPOINT")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    let s3 = S3Config {
        bucket: std::env::var("LINGER_TEST_S3_BUCKET")
            .unwrap_or_else(|_| "linger-test".to_string()),
        region: std::env::var("LINGER_TEST_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string()),
        endpoint,
        path_style: true,
        access_key_id: std::env::var("LINGER_TEST_S3_ACCESS_KEY_ID")
            .expect("LINGER_TEST_S3_ACCESS_KEY_ID"),
        secret_access_key: std::env::var("LINGER_TEST_S3_SECRET_ACCESS_KEY")
            .expect("LINGER_TEST_S3_SECRET_ACCESS_KEY"),
    };
    ensure_bucket(&s3).await;

    let dir = tempfile::tempdir().expect("tempdir");
    let config = Config {
        data_dir: dir.path().to_path_buf(),
        bind: "127.0.0.1:0".parse().unwrap(),
        domain: None,
        media_domain: None,
        storage: Storage::S3,
        s3: Some(s3),
        pool_bytes: DEFAULT_POOL_BYTES,
        file_expiry_days: Some(DEFAULT_FILE_EXPIRY_DAYS),
        turn: None,
        voice_forwarding: None,
    };
    Some(spawn_with(dir, config).await)
}

/// Create the test bucket if this is the first run against a fresh MinIO.
///
/// Every test shares it: object keys are UUIDv7s and part keys hang off the
/// upload id, so two tests running at once cannot collide.
async fn ensure_bucket(s3: &S3Config) {
    use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};

    let bucket = Bucket::new(
        s3.endpoint.parse().expect("endpoint is a URL"),
        UrlStyle::Path,
        s3.bucket.clone(),
        s3.region.clone(),
    )
    .expect("bucket");
    let credentials = Credentials::new(s3.access_key_id.clone(), s3.secret_access_key.clone());
    let url = bucket
        .create_bucket(&credentials)
        .sign(std::time::Duration::from_secs(60));
    let resp = reqwest::Client::new()
        .put(url)
        .send()
        .await
        .expect("create bucket");
    // 409 is "it already exists", which is the ordinary case.
    assert!(
        resp.status().is_success() || resp.status() == 409,
        "could not create the test bucket: {}",
        resp.text().await.unwrap_or_default()
    );
}

async fn spawn_with(dir: tempfile::TempDir, config: Config) -> TestServer {
    let database = db::init(&config.db_path()).await.expect("db init");
    let state = AppState::build(database, config).await.expect("state");
    let app = linger_server::app(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    TestServer {
        base: format!("http://{addr}"),
        state,
        _dir: dir,
    }
}

/// Complete first-run setup: creates the host account and names the server.
pub async fn bootstrap_host(server: &TestServer) -> AuthResponse {
    let token = server
        .state
        .setup
        .peek()
        .expect("fresh server has a setup token");
    let resp = reqwest::Client::new()
        .post(server.url("/setup"))
        .json(&serde_json::json!({
            "token": token,
            "server_name": "test server",
            "username": "matt",
            "display_name": "Matt",
            "password": "correct horse battery",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "setup failed: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// Invite + register a member, via the real endpoints.
pub async fn join_member(server: &TestServer, host_access: &str, username: &str) -> AuthResponse {
    let client = reqwest::Client::new();
    let invite: Invite = client
        .post(server.url("/invites"))
        .bearer_auth(host_access)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let resp = client
        .post(server.url("/auth/register"))
        .json(&serde_json::json!({
            "invite_code": invite.code,
            "username": username,
            "display_name": username,
            "password": "a perfectly fine password",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "register failed: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// Sign in again as somebody who already has an account.
///
/// Needed by anything that removes a member and restores them: removal revokes
/// every sign-in they had, so the way back in is the front door with their
/// password (T-413).
pub async fn sign_in(server: &TestServer, username: &str) -> AuthResponse {
    let resp = reqwest::Client::new()
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({
            "username": username,
            "password": "a perfectly fine password",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "sign-in failed: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// Host + one room, the most common fixture.
pub async fn server_with_room(slug: &str) -> (TestServer, AuthResponse, linger_core::wire::Room) {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": slug, "name": format!("#{slug}") }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (server, host, room)
}
