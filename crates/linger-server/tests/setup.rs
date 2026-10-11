//! First-run setup (PROTOCOL §2.1): one token, one shot.

mod common;

use linger_core::wire::{AuthResponse, ServerInfo};

#[tokio::test]
async fn fresh_server_completes_setup_exactly_once() {
    let server = common::spawn_server().await;
    let token = server
        .state
        .setup
        .peek()
        .expect("fresh server must arm a setup token");
    let client = reqwest::Client::new();

    // Preview: right token is valid, wrong token isn't.
    let ok: serde_json::Value = client
        .get(server.url(&format!("/setup/{token}")))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ok["valid"], true);
    let bad: serde_json::Value = client
        .get(server.url("/setup/not-the-token"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bad["valid"], false);

    // A bad form must NOT burn the token.
    let short_pw = client
        .post(server.url("/setup"))
        .json(&serde_json::json!({
            "token": token, "server_name": "home", "username": "matt",
            "display_name": "Matt", "password": "short",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(short_pw.status(), 422);
    assert!(
        server.state.setup.peek().is_some(),
        "validation failure must not consume the token"
    );

    // Complete for real: host account + server name.
    let auth: AuthResponse = client
        .post(server.url("/setup"))
        .json(&serde_json::json!({
            "token": token, "server_name": "the garage", "username": "matt",
            "display_name": "Matt", "password": "correct horse battery",
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(auth.user.is_host);
    assert_eq!(auth.user.username, "matt");

    // Token is dead: preview 404s, a second completion 404s.
    let again = client
        .post(server.url("/setup"))
        .json(&serde_json::json!({
            "token": token, "server_name": "x", "username": "mallory",
            "display_name": "M", "password": "a long enough password",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 404);
    let preview = client
        .get(server.url(&format!("/setup/{token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(preview.status(), 404);

    // The server knows its name.
    let info: ServerInfo = client
        .get(server.url("/server"))
        .bearer_auth(&auth.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info.name, "the garage");
    assert_eq!(info.member_count, 1);
}

/// Hashing can be refused while the server is busy with other people's
/// passwords (#495). The setup link is the host's only way in, so a refusal
/// must leave it working; and a wrong token must not get as far as hashing.
#[tokio::test]
async fn a_busy_server_does_not_burn_the_setup_link() {
    let server = common::spawn_server().await;
    let token = server
        .state
        .setup
        .peek()
        .expect("a fresh server has a token");
    let setup = |token: String| {
        reqwest::Client::new()
            .post(server.url("/setup"))
            .json(&serde_json::json!({
                "token": token, "server_name": "the garage", "username": "matt",
                "display_name": "Matt", "password": "correct horse battery",
            }))
            .send()
    };

    let wrong = setup("not-the-token".into()).await.unwrap();
    assert_eq!(wrong.status(), 403);
    assert_eq!(server.state.passwords.started(), 0, "a wrong token hashed");

    // Somebody else's hashing has every turn, for longer than setup waits.
    let turns = u32::try_from(linger_server::auth::PASSWORD_WORK_AT_ONCE).unwrap();
    let taken = server
        .state
        .passwords
        .turns
        .clone()
        .acquire_many_owned(turns)
        .await
        .unwrap();
    let busy = setup(token.clone()).await.unwrap();
    assert_eq!(busy.status(), 429);
    assert_eq!(server.state.setup.peek().as_deref(), Some(token.as_str()));

    drop(taken);
    let done = setup(token).await.unwrap();
    assert_eq!(done.status(), 200);
    assert!(server.state.setup.peek().is_none());
}
