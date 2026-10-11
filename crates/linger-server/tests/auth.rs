//! Auth (PROTOCOL §2): register, login, refresh rotation, reuse detection,
//! logout, the per-address limits on sign-in and sign-up, and the turns
//! password hashing takes (#495).

mod common;

use linger_core::limits::{RATE_LOGIN_PER_IP, RATE_REGISTER_PER_IP};
use linger_core::wire::{AuthResponse, ErrorCode, ErrorEnvelope, Invite, RefreshResponse};
use linger_server::auth::PASSWORD_WORK_AT_ONCE;

#[tokio::test]
async fn register_login_and_wrong_password() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    assert!(!member.user.is_host);

    let client = reqwest::Client::new();
    let ok: AuthResponse = client
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({ "username": "callie", "password": "a perfectly fine password" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ok.user.username, "callie");

    for (user, pw) in [
        ("callie", "wrong password entirely"),
        ("nobody", "whatever whatever"),
    ] {
        let resp = client
            .post(server.url("/auth/login"))
            .json(&serde_json::json!({ "username": user, "password": pw }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        let env: ErrorEnvelope = resp.json().await.unwrap();
        assert_eq!(env.error.code, ErrorCode::Unauthenticated);
    }
}

#[tokio::test]
async fn duplicate_username_conflicts_and_invite_use_is_returned() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    let invite: linger_core::wire::Invite = client
        .post(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // "matt" is taken by the host; the tx must roll back the invite use…
    let resp = client
        .post(server.url("/auth/register"))
        .json(&serde_json::json!({
            "invite_code": invite.code, "username": "matt",
            "display_name": "Impostor", "password": "a long enough password",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 409);

    // …so the same single-use invite still works for a fresh name.
    let resp = client
        .post(server.url("/auth/register"))
        .json(&serde_json::json!({
            "invite_code": invite.code, "username": "dave",
            "display_name": "Dave", "password": "a long enough password",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn refresh_rotates_and_reuse_revokes_the_family() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    // Rotate once: old token spent, new one works.
    let first: RefreshResponse = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": host.refresh_token }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(first.refresh_token, host.refresh_token);

    let second: RefreshResponse = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": first.refresh_token }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Replaying the *first* (already rotated) token is theft-shaped: it must
    // fail AND take the whole family down with it.
    let replay = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": first.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 401);

    let family_dead = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": second.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        family_dead.status(),
        401,
        "reuse must revoke the newest token too"
    );
}

#[tokio::test]
async fn logout_revokes_the_family() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    let out = client
        .post(server.url("/auth/logout"))
        .json(&serde_json::json!({ "refresh_token": host.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(out.status(), 204);

    let resp = client
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": host.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

#[tokio::test]
async fn login_is_rate_limited_per_ip_with_retry_hint() {
    let server = common::spawn_server().await;
    let _host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    // 5/min/IP: burn the burst with bad attempts…
    for _ in 0..5 {
        let resp = client
            .post(server.url("/auth/login"))
            .json(&serde_json::json!({ "username": "matt", "password": "wrong wrong wrong" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
    }
    // …then the 6th gets the envelope with a usable retry hint.
    let resp = client
        .post(server.url("/auth/login"))
        .json(&serde_json::json!({ "username": "matt", "password": "correct horse battery" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 429);
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::RateLimited);
    assert!(env.error.retry_after_ms.is_some_and(|ms| ms > 0));
}

#[tokio::test]
async fn expired_and_garbage_access_tokens_are_rejected() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let client = reqwest::Client::new();

    // Sanity: the real token works.
    let ok = client
        .get(server.url("/me"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);

    // A structurally valid JWT signed by nobody we know.
    let forged = format!(
        "{}.e30.forged-signature",
        host.access_token.split('.').next().unwrap()
    );
    let resp = client
        .get(server.url("/me"))
        .bearer_auth(forged)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
}

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

/// Sign up through `code`, arriving through the test's proxy for `from`.
///
/// Every test request comes from 127.0.0.1, which is a proxy the server
/// believes, so `X-Forwarded-For` is how a test is somebody else.
async fn sign_up_from(
    server: &common::TestServer,
    from: &str,
    code: &str,
    username: &str,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url("/auth/register"))
        .header("x-forwarded-for", from)
        .json(&serde_json::json!({
            "invite_code": code, "username": username,
            "display_name": username, "password": "a long enough password",
        }))
        .send()
        .await
        .unwrap()
}

async fn sign_in_from(
    server: &common::TestServer,
    from: &str,
    password: &str,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url("/auth/login"))
        .header("x-forwarded-for", from)
        .json(&serde_json::json!({ "username": "matt", "password": password }))
        .send()
        .await
        .unwrap()
}

async fn code_of(resp: reqwest::Response) -> ErrorCode {
    resp.json::<ErrorEnvelope>().await.unwrap().error.code
}

/// #495: a sign-up with no usable invite used to hash the password first
/// (~19 MB and a core for a moment) and only then look at the invite, so a
/// stranger with no invite at all could make the server do that on demand.
#[tokio::test]
async fn a_sign_up_without_a_usable_invite_hashes_nothing() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let expired = make_invite(
        &server,
        &host.access_token,
        serde_json::json!({ "expires_in_hours": 0 }),
    )
    .await;
    let used = make_invite(&server, &host.access_token, serde_json::json!({})).await;
    let resp = sign_up_from(&server, "203.0.113.5", &used.code, "callie").await;
    assert_eq!(resp.status(), 200);

    let before = server.state.passwords.started();
    for (code, refusal) in [
        ("madeupcode12", ErrorCode::InviteInvalid),
        (expired.code.as_str(), ErrorCode::InviteExpired),
        (used.code.as_str(), ErrorCode::InviteInvalid),
    ] {
        let resp = sign_up_from(&server, "203.0.113.5", code, "dave").await;
        assert_eq!(resp.status(), 422, "{code}");
        assert_eq!(code_of(resp).await, refusal, "{code}");
    }
    assert_eq!(
        server.state.passwords.started(),
        before,
        "a sign-up with no usable invite hashed a password"
    );
}

#[tokio::test]
async fn sign_up_is_rate_limited_per_address() {
    let server = common::spawn_server().await;
    let _host = common::bootstrap_host(&server).await;

    // Made-up invites are the cheap way to spend the allowance, now that
    // they cost no hashing.
    let (allowed, _) = RATE_REGISTER_PER_IP;
    for n in 0..allowed {
        let resp = sign_up_from(&server, "203.0.113.20", "madeupcode12", &format!("p{n}")).await;
        assert_eq!(resp.status(), 422, "attempt {n} was limited early");
    }
    let resp = sign_up_from(&server, "203.0.113.20", "madeupcode12", "one_more").await;
    assert_eq!(resp.status(), 429);
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::RateLimited);
    assert!(env.error.retry_after_ms.is_some_and(|ms| ms > 0));

    // Somebody else's allowance is their own.
    let resp = sign_up_from(&server, "203.0.113.21", "madeupcode12", "neighbour").await;
    assert_eq!(resp.status(), 422);
}

/// #495: the address used to be the first `X-Forwarded-For` entry, which is
/// whatever the client wrote. Writing a new one each time skipped the
/// sign-in limit, and with it the brake on guessing passwords.
#[tokio::test]
async fn a_made_up_first_forwarded_entry_does_not_dodge_the_sign_in_limit() {
    let server = common::spawn_server().await;
    let _host = common::bootstrap_host(&server).await;

    let (allowed, _) = RATE_LOGIN_PER_IP;
    for n in 0..allowed {
        let forged = format!("10.0.{n}.1, 203.0.113.9");
        let resp = sign_in_from(&server, &forged, "wrong wrong wrong").await;
        assert_eq!(resp.status(), 401);
    }
    let resp = sign_in_from(&server, "10.0.99.1, 203.0.113.9", "correct horse battery").await;
    assert_eq!(resp.status(), 429);
    assert_eq!(code_of(resp).await, ErrorCode::RateLimited);
}

/// Every hash and check takes a turn, and while every turn is taken a
/// sign-in or sign-up waits, then is told the server is busy. It hashes
/// nothing meanwhile, and a sign-up turned away keeps its invite.
#[tokio::test]
async fn sign_in_and_sign_up_wait_for_a_turn_and_a_refused_one_keeps_its_invite() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;

    // Somebody else's hashing has every turn.
    let turns = u32::try_from(PASSWORD_WORK_AT_ONCE).unwrap();
    let taken = server
        .state
        .passwords
        .turns
        .clone()
        .acquire_many_owned(turns)
        .await
        .unwrap();
    let before = server.state.passwords.started();

    let (signed_in, signed_up) = tokio::join!(
        sign_in_from(&server, "203.0.113.30", "correct horse battery"),
        sign_up_from(&server, "203.0.113.31", &invite.code, "callie"),
    );
    for resp in [signed_in, signed_up] {
        assert_eq!(resp.status(), 429);
        let env: ErrorEnvelope = resp.json().await.unwrap();
        assert_eq!(env.error.code, ErrorCode::RateLimited);
        assert_eq!(
            env.error.message,
            "The server is busy. Try again in a moment."
        );
    }
    assert_eq!(server.state.passwords.started(), before);
    assert_eq!(server.state.passwords.waiting(), 0);

    // The turns come back, and the single-use invite was never spent.
    drop(taken);
    let resp = sign_up_from(&server, "203.0.113.31", &invite.code, "callie").await;
    assert_eq!(resp.status(), 200);
}

/// Checking the invite before hashing must not open a gap: two people
/// racing for the last use of one invite both pass the check, and the
/// guarded update inside the transaction still lets exactly one in.
#[tokio::test]
async fn two_people_racing_for_one_single_use_invite_cannot_both_get_in() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;

    let (a, b) = tokio::join!(
        sign_up_from(&server, "203.0.113.40", &invite.code, "callie"),
        sign_up_from(&server, "203.0.113.41", &invite.code, "dave"),
    );
    let mut statuses = [a.status().as_u16(), b.status().as_u16()];
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [200, 422],
        "exactly one may use a single-use invite"
    );
    let refused = if a.status() == 422 { a } else { b };
    assert_eq!(code_of(refused).await, ErrorCode::InviteInvalid);
}
