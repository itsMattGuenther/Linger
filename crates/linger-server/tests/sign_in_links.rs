//! Sign-in links (#581, PROTOCOL §5): the host or a co-host makes a one-time
//! link for a member who forgot their password; it sets a new one and ends
//! every other sign-in. Never for the host.

mod common;

use linger_core::wire::{
    AuthResponse, ErrorEnvelope, SignInLink, SignInLinkMade, SignInLinkPreview,
};

async fn make_link(
    server: &common::TestServer,
    token: &str,
    user_id: impl std::fmt::Display,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url(&format!("/users/{user_id}/sign-in-link")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

async fn made(
    server: &common::TestServer,
    token: &str,
    user_id: impl std::fmt::Display,
) -> SignInLink {
    let resp = make_link(server, token, user_id).await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn preview(server: &common::TestServer, code: &str) -> SignInLinkPreview {
    reqwest::Client::new()
        .get(server.url(&format!("/auth/sign-in-link/{code}")))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn use_link(server: &common::TestServer, code: &str, password: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url("/auth/sign-in-link"))
        .json(&serde_json::json!({ "code": code, "new_password": password }))
        .send()
        .await
        .unwrap()
}

async fn login(server: &common::TestServer, username: &str, password: &str) -> reqwest::StatusCode {
    reqwest::Client::new()
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .unwrap()
        .status()
}

async fn message_of(resp: reqwest::Response) -> String {
    let envelope: ErrorEnvelope = resp.json().await.unwrap();
    envelope.error.message
}

#[tokio::test]
async fn a_link_sets_a_new_password_once_and_ends_every_other_sign_in() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;

    let link = made(&server, &host.access_token, sam.user.id).await;
    assert_eq!(link.user_id, sam.user.id);
    assert_eq!(link.code.len(), linger_core::limits::SIGN_IN_LINK_CHARS);

    let seen = preview(&server, &link.code).await;
    assert!(seen.valid);
    assert_eq!(seen.username.as_deref(), Some("sam"));
    assert_eq!(seen.made_by.as_deref(), Some("Matt"));
    assert_eq!(seen.server_name.as_deref(), Some("test server"));

    // Too short a password is refused before the link is spent.
    assert_eq!(use_link(&server, &link.code, "short").await.status(), 422);
    assert!(preview(&server, &link.code).await.valid);

    let resp = use_link(&server, &link.code, "a brand new password").await;
    assert_eq!(resp.status(), 200);
    let signed_in: AuthResponse = resp.json().await.unwrap();
    assert_eq!(signed_in.user.id, sam.user.id);

    // The new password works, the old one doesn't, and so does nothing from before.
    assert_eq!(login(&server, "sam", "a brand new password").await, 200);
    assert_eq!(
        login(&server, "sam", "a perfectly fine password").await,
        401
    );
    let old = reqwest::Client::new()
        .get(server.url("/me"))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(old.status(), 401, "an access token from before is refused");
    let old_refresh = reqwest::Client::new()
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": sam.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        old_refresh.status(),
        401,
        "so is a refresh token from before"
    );
    let fresh = reqwest::Client::new()
        .get(server.url("/me"))
        .bearer_auth(&signed_in.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(fresh.status(), 200, "the sign-in the link gave works");

    // Once.
    assert!(!preview(&server, &link.code).await.valid);
    let again = use_link(&server, &link.code, "somebody else's try").await;
    assert_eq!(again.status(), 403);
    assert!(message_of(again).await.contains("has been used"));
}

#[tokio::test]
async fn a_new_link_cancels_the_last() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;

    let first = made(&server, &host.access_token, sam.user.id).await;
    let second = made(&server, &host.access_token, sam.user.id).await;
    assert_ne!(first.code, second.code);
    assert!(!preview(&server, &first.code).await.valid);
    let resp = use_link(&server, &first.code, "a brand new password").await;
    assert_eq!(resp.status(), 403);
    assert!(message_of(resp).await.contains("doesn't work any more"));
    assert_eq!(
        use_link(&server, &second.code, "a brand new password")
            .await
            .status(),
        200
    );
}

#[tokio::test]
async fn never_for_the_host_never_for_yourself_and_never_by_a_member() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let cohost = common::join_member(&server, &host.access_token, "callie").await;
    let member = common::join_member(&server, &host.access_token, "dave").await;
    let resp = reqwest::Client::new()
        .put(server.url(&format!("/users/{}/cohost", cohost.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // A co-host can make one for a member.
    made(&server, &cohost.access_token, member.user.id).await;
    // Nobody can for the host, the host included.
    assert_eq!(
        make_link(&server, &cohost.access_token, host.user.id)
            .await
            .status(),
        403
    );
    assert_eq!(
        make_link(&server, &host.access_token, host.user.id)
            .await
            .status(),
        403
    );
    // Nor for themselves.
    assert_eq!(
        make_link(&server, &cohost.access_token, cohost.user.id)
            .await
            .status(),
        403
    );
    // A member can't make one at all.
    assert_eq!(
        make_link(&server, &member.access_token, cohost.user.id)
            .await
            .status(),
        403
    );
    // Nor for somebody who isn't here.
    assert_eq!(
        make_link(&server, &host.access_token, linger_core::UserId::new())
            .await
            .status(),
        404
    );
}

#[tokio::test]
async fn an_expired_link_is_refused() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;
    let link = made(&server, &host.access_token, sam.user.id).await;
    sqlx::query("UPDATE sign_in_links SET expires_at = 1")
        .execute(&server.state.db.write)
        .await
        .unwrap();
    assert!(!preview(&server, &link.code).await.valid);
    assert_eq!(
        use_link(&server, &link.code, "a brand new password")
            .await
            .status(),
        403
    );
    assert_eq!(
        login(&server, "sam", "a perfectly fine password").await,
        200
    );
}

#[tokio::test]
async fn removal_cancels_links_for_the_person_and_made_by_them() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let cohost = common::join_member(&server, &host.access_token, "callie").await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;
    reqwest::Client::new()
        .put(server.url(&format!("/users/{}/cohost", cohost.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();

    let for_sam = made(&server, &host.access_token, sam.user.id).await;
    let by_callie = made(&server, &cohost.access_token, dave.user.id).await;
    for id in [sam.user.id, cohost.user.id] {
        let resp = reqwest::Client::new()
            .post(server.url(&format!("/users/{id}/remove")))
            .bearer_auth(&host.access_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
    }
    assert!(!preview(&server, &for_sam.code).await.valid);
    assert!(!preview(&server, &by_callie.code).await.valid);
    assert_eq!(
        use_link(&server, &for_sam.code, "a brand new password")
            .await
            .status(),
        403
    );
}

#[tokio::test]
async fn your_settings_say_who_made_you_a_link() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;

    let list = |token: String| {
        let url = server.url("/me/sign-in-links");
        async move {
            let resp = reqwest::Client::new()
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200);
            let text = resp.text().await.unwrap();
            assert!(!text.contains("code"), "never the code: {text}");
            serde_json::from_str::<Vec<SignInLinkMade>>(&text).unwrap()
        }
    };
    assert!(list(sam.access_token.clone()).await.is_empty());

    let link = made(&server, &host.access_token, sam.user.id).await;
    let mine = list(sam.access_token.clone()).await;
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].made_by, host.user.id);
    assert_eq!(mine[0].used_at, None);
    assert_eq!(mine[0].expires_at, link.expires_at);

    let signed_in: AuthResponse = use_link(&server, &link.code, "a brand new password")
        .await
        .json()
        .await
        .unwrap();
    let mine = list(signed_in.access_token).await;
    assert!(mine[0].used_at.is_some());
    // Nobody else sees them.
    assert!(list(host.access_token).await.is_empty());
}

#[tokio::test]
async fn the_link_opens_a_page_in_a_browser() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;
    let link = made(&server, &host.access_token, sam.user.id).await;

    let page = |path: String| {
        let url = format!("{}{path}", server.base);
        async move {
            let resp = reqwest::get(url).await.unwrap();
            (resp.status(), resp.text().await.unwrap())
        }
    };
    let (status, html) = page(format!("/sign-in/{}", link.code)).await;
    assert_eq!(status, 200);
    assert!(
        html.contains("Get back into <bdi>test server</bdi>"),
        "{html}"
    );
    assert!(html.contains("Matt made this link so @sam"), "{html}");
    assert!(
        html.contains(&format!(">{}/sign-in/{}</code>", server.base, link.code)),
        "{html}"
    );
    // Opening the page doesn't use the link.
    assert!(preview(&server, &link.code).await.valid);

    use_link(&server, &link.code, "a brand new password").await;
    let (status, html) = page(format!("/sign-in/{}", link.code)).await;
    assert_eq!(status, 404);
    assert!(html.contains("This sign-in link has been used"), "{html}");
    assert!(!html.contains("@sam"), "{html}");

    let (status, html) = page("/sign-in/%3Cb%3E".into()).await;
    assert_eq!(status, 404);
    assert!(html.contains("doesn\u{2019}t work"), "{html}");
}
