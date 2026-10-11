//! `GET /voice/ice` (SPEC §4.14, PROTOCOL §7, T-1403) over real HTTP.
//!
//! What is worth proving: that a server with no relay says so with an empty
//! list rather than an error, that a server with one hands out a password
//! coturn would accept — dated, for this member, recomputable from the
//! secret — that nobody gets one without signing in, and that nobody can ask
//! for them in a loop (#501).

mod common;

use linger_core::limits::RATE_VOICE_ICE;
use linger_core::wire::{ErrorCode, ErrorEnvelope, IceServers};
use linger_server::config::TurnConfig;
use linger_server::turn;

const SECRET: &str = "correct horse battery staple";

fn relay() -> TurnConfig {
    TurnConfig {
        secret: SECRET.into(),
        urls: vec![
            "stun:linger.example:3478".into(),
            "turn:linger.example:3478?transport=udp".into(),
        ],
        ttl_secs: 3600,
    }
}

async fn ask(server: &common::TestServer, token: &str) -> reqwest::Response {
    reqwest::Client::new()
        .get(server.url("/voice/ice"))
        .bearer_auth(token)
        .send()
        .await
        .expect("request")
}

#[tokio::test]
async fn no_relay_is_an_empty_list_not_an_error() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;

    let response = ask(&server, &host.access_token).await;
    assert_eq!(response.status(), 200);
    let ice: IceServers = response.json().await.expect("json");
    assert!(ice.servers.is_empty());
    assert_eq!(ice.ttl_secs, 0);
}

#[tokio::test]
async fn a_relay_hands_out_a_dated_password_for_this_member() {
    let server = common::spawn_tuned(|config| config.turn = Some(relay())).await;
    let host = common::bootstrap_host(&server).await;
    let before = turn::now_unix();

    let ice: IceServers = ask(&server, &host.access_token)
        .await
        .json()
        .await
        .expect("json");

    assert_eq!(ice.servers.len(), 1);
    let entry = &ice.servers[0];
    assert_eq!(entry.urls, relay().urls);

    // `<expiry>:<user id>`, with the expiry at least a TTL from now and
    // rounded up to the hour, so the name holds for the hour (#501).
    let username = entry.username.as_deref().expect("a username");
    let (expiry, who) = username.split_once(':').expect("expiry:user");
    let expiry: u64 = expiry.parse().expect("a unix time");
    assert!(expiry >= before + 3600 && expiry <= before + 3600 + turn::NAME_STEP_SECS + 5);
    assert_eq!(expiry % turn::NAME_STEP_SECS, 0);
    assert_eq!(who, host.user.id.to_string());
    // `ttl_secs` is the time left on it.
    assert!(ice.ttl_secs >= 3600 && ice.ttl_secs <= 3600 + turn::NAME_STEP_SECS);

    // The password is the HMAC coturn will recompute from the same secret.
    assert_eq!(
        entry.credential.as_deref().expect("a credential"),
        turn::password(SECRET, username)
    );
}

#[tokio::test]
async fn two_members_get_different_passwords() {
    let server = common::spawn_tuned(|config| config.turn = Some(relay())).await;
    let host = common::bootstrap_host(&server).await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;

    let a: IceServers = ask(&server, &host.access_token).await.json().await.unwrap();
    let b: IceServers = ask(&server, &dave.access_token).await.json().await.unwrap();
    assert_ne!(a.servers[0].username, b.servers[0].username);
    assert_ne!(a.servers[0].credential, b.servers[0].credential);
}

#[tokio::test]
async fn a_stranger_gets_nothing() {
    let server = common::spawn_tuned(|config| config.turn = Some(relay())).await;
    let _host = common::bootstrap_host(&server).await;

    let response = reqwest::Client::new()
        .get(server.url("/voice/ice"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), 401);
}

/// One member asking for relay passwords in a loop gets turned away (#501),
/// and somebody else on the server still gets theirs.
#[tokio::test]
async fn asking_for_the_relay_is_rate_limited() {
    let server = common::spawn_tuned(|config| config.turn = Some(relay())).await;
    let host = common::bootstrap_host(&server).await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;

    let (burst, _) = RATE_VOICE_ICE;
    for n in 0..burst {
        let response = ask(&server, &host.access_token).await;
        assert_eq!(response.status(), 200, "ask {n}");
    }
    let response = ask(&server, &host.access_token).await;
    assert_eq!(response.status(), 429);
    let envelope: ErrorEnvelope = response.json().await.expect("error envelope");
    assert_eq!(envelope.error.code, ErrorCode::RateLimited);
    assert!(envelope.error.retry_after_ms.is_some_and(|ms| ms > 0));

    assert_eq!(ask(&server, &dave.access_token).await.status(), 200);
}
