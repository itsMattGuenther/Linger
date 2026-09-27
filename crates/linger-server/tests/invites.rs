//! Invites (PROTOCOL §7): expiry, exhaustion, revocation, preview.

mod common;

use linger_core::wire::{ErrorCode, ErrorEnvelope, Invite, InvitePreview};

async fn make_invite(server: &common::TestServer, token: &str, body: serde_json::Value) -> Invite {
    reqwest::Client::new()
        .post(server.url("/invites"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn register_with(
    server: &common::TestServer,
    code: &str,
    username: &str,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url("/auth/register"))
        .json(&serde_json::json!({
            "invite_code": code, "username": username,
            "display_name": username, "password": "a long enough password",
        }))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn single_use_default_exhausts_after_one_join() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;
    assert_eq!(
        invite.max_uses,
        Some(1),
        "invites are single-use by default"
    );

    assert_eq!(
        register_with(&server, &invite.code, "callie")
            .await
            .status(),
        200
    );

    let resp = register_with(&server, &invite.code, "dave").await;
    assert_eq!(resp.status(), 422);
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::InviteInvalid);
}

#[tokio::test]
async fn multi_use_invite_counts_down() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(
        &server,
        &host.access_token,
        serde_json::json!({ "max_uses": 2 }),
    )
    .await;

    assert_eq!(
        register_with(&server, &invite.code, "callie")
            .await
            .status(),
        200
    );
    assert_eq!(
        register_with(&server, &invite.code, "dave").await.status(),
        200
    );
    assert_eq!(
        register_with(&server, &invite.code, "jen").await.status(),
        422
    );
}

#[tokio::test]
async fn null_max_uses_is_no_limit() {
    // "Anyone" in both clients sends `"max_uses": null` (#246). It used to be
    // read as "not sent" and stored as one use.
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(
        &server,
        &host.access_token,
        serde_json::json!({ "max_uses": null, "expires_in_hours": null }),
    )
    .await;
    assert_eq!(invite.max_uses, None, "null asks for no limit");
    assert_eq!(invite.expires_at, None);

    for name in ["callie", "dave", "jen"] {
        assert_eq!(
            register_with(&server, &invite.code, name).await.status(),
            200
        );
    }

    let preview: InvitePreview = reqwest::get(server.url(&format!("/auth/invite/{}", invite.code)))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(preview.valid, "still works after three people joined");

    let listed: Vec<Invite> = reqwest::Client::new()
        .get(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let stored = listed.iter().find(|i| i.code == invite.code).unwrap();
    assert_eq!((stored.max_uses, stored.uses), (None, 3));
}

#[tokio::test]
async fn zero_uses_is_refused() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let resp = reqwest::Client::new()
        .post(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "max_uses": 0 }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::ValidationFailed);
}

#[tokio::test]
async fn expired_invite_says_expired() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    // 0 hours ⇒ expires_at = now: already dead by the time it's used.
    let invite = make_invite(
        &server,
        &host.access_token,
        serde_json::json!({ "expires_in_hours": 0 }),
    )
    .await;

    let resp = register_with(&server, &invite.code, "callie").await;
    assert_eq!(resp.status(), 422);
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::InviteExpired);

    let preview: InvitePreview = reqwest::get(server.url(&format!("/auth/invite/{}", invite.code)))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!preview.valid);
}

#[tokio::test]
async fn revocation_kills_an_invite_and_permissions_hold() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let client = reqwest::Client::new();

    // Member-created invite: a third member can't revoke it, the host can.
    let invite = make_invite(&server, &member.access_token, serde_json::json!({})).await;
    let other = common::join_member(&server, &host.access_token, "dave").await;

    let denied = client
        .delete(server.url(&format!("/invites/{}", invite.code)))
        .bearer_auth(&other.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);

    let revoked = client
        .delete(server.url(&format!("/invites/{}", invite.code)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 204);

    assert_eq!(
        register_with(&server, &invite.code, "jen").await.status(),
        422
    );
}

#[tokio::test]
async fn preview_shows_server_name_for_valid_invites_only() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;

    let preview: InvitePreview = reqwest::get(server.url(&format!("/auth/invite/{}", invite.code)))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(preview.valid);
    assert_eq!(preview.server_name.as_deref(), Some("test server"));

    let missing: InvitePreview = reqwest::get(server.url("/auth/invite/nope00000000"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(!missing.valid);
    assert!(missing.server_name.is_none());
}
