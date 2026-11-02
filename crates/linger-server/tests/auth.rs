//! Auth (PROTOCOL §2): register, login, refresh rotation, reuse detection,
//! logout, the per-address limits on sign-in and sign-up, and the turns
//! password hashing takes (#495).

mod common;

use linger_core::limits::{DEFAULT_SIGNUPS_PER_HOUR, RATE_LOGIN_PER_IP, RATE_SHARE_SIGN_IN};
use linger_core::wire::{
    AuthResponse, ErrorCode, ErrorEnvelope, Invite, RefreshResponse, ShareSignInResponse,
};
use linger_server::auth::SERVER_BUSY;

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
    for n in 0..DEFAULT_SIGNUPS_PER_HOUR {
        let resp = sign_up_from(&server, "203.0.113.20", "madeupcode12", &format!("p{n}")).await;
        assert_eq!(resp.status(), 422, "attempt {n} was limited early");
    }
    let resp = sign_up_from(&server, "203.0.113.20", "madeupcode12", "one_more").await;
    assert_eq!(resp.status(), 429);
    // Sixty an hour comes back at one a minute: the wait, in HTTP's header
    // and in the body, and in the words the person reads (#538). A minute
    // less however long the sixty took, so not exactly a minute.
    let header = resp.headers()["retry-after"].to_str().unwrap().to_string();
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::RateLimited);
    let wait = env.error.retry_after_ms.unwrap();
    assert!((30_000..=60_000).contains(&wait), "{wait}");
    assert_eq!(header, wait.div_ceil(1_000).to_string());
    assert_eq!(
        env.error.message,
        "Lots of people have joined from your network in the last hour, so this server is \
         pausing new sign-ups from it. Try again in about a minute. If your group is joining \
         together, the host can raise this limit."
    );

    // Somebody else's allowance is their own.
    let resp = sign_up_from(&server, "203.0.113.21", "madeupcode12", "neighbour").await;
    assert_eq!(resp.status(), 422);
}

/// #538: a community that sends one invite to a crowd can have more than
/// sixty people arrive from one address (a school, a phone network). The host
/// raises `LINGER_SIGNUPS_PER_HOUR`, or turns it off, and the 61st gets in.
#[tokio::test]
async fn a_host_who_raises_the_sign_up_limit_lets_the_sixty_first_through() {
    for (setting, last) in [(Some(200), 200), (None, 250)] {
        let server = common::spawn_tuned(|config| config.signups_per_hour = setting).await;
        let _host = common::bootstrap_host(&server).await;
        for n in 0..last {
            let resp =
                sign_up_from(&server, "203.0.113.22", "madeupcode12", &format!("p{n}")).await;
            assert_eq!(resp.status(), 422, "{setting:?}: attempt {n} was limited");
        }
        let resp = sign_up_from(&server, "203.0.113.22", "madeupcode12", "one_more").await;
        let limited = setting.is_some();
        assert_eq!(resp.status() == 429, limited, "{setting:?}");
    }
}

/// A host who lowers the limit gets a longer wait between sign-ups, and the
/// person told to wait is told how long in minutes.
#[tokio::test]
async fn a_lower_sign_up_limit_says_the_wait_in_minutes() {
    let server = common::spawn_tuned(|config| config.signups_per_hour = Some(6)).await;
    let _host = common::bootstrap_host(&server).await;
    for n in 0..6 {
        let resp = sign_up_from(&server, "203.0.113.23", "madeupcode12", &format!("p{n}")).await;
        assert_eq!(resp.status(), 422, "attempt {n} was limited early");
    }
    let resp = sign_up_from(&server, "203.0.113.23", "madeupcode12", "one_more").await;
    assert_eq!(resp.status(), 429);
    let header: u64 = resp.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((570..=600).contains(&header), "{header}");
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert!(
        env.error.message.contains("Try again in about 10 minutes."),
        "{}",
        env.error.message
    );
}

/// `LINGER_PASSWORD_CHECKS_AT_ONCE` sets how many turns there are.
#[tokio::test]
async fn a_host_can_give_password_checks_more_turns() {
    let server = common::spawn_tuned(|config| config.password_checks_at_once = 7).await;
    assert_eq!(server.state.passwords.turns.available_permits(), 7);
    let server = common::spawn_server().await;
    assert_eq!(server.state.passwords.turns.available_permits(), 4);
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
    // One try comes back every 12 seconds, and the person is told when (#538).
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::RateLimited);
    let wait = env.error.retry_after_ms.unwrap();
    assert!((1..=12_000).contains(&wait), "{wait}");
    assert_eq!(
        env.error.message,
        format!(
            "Too many sign-in tries from your network in the last minute. Try again in {} \
             seconds.",
            wait.div_ceil(1_000)
        )
    );
}

/// `LINGER_TRUSTED_PROXIES` reaches the limits: told to trust only a range
/// the test's own connections aren't in, the server stops believing their
/// `X-Forwarded-For`, and every attempt counts against 127.0.0.1.
#[tokio::test]
async fn a_server_told_whom_to_trust_believes_nobody_else() {
    let server = common::spawn_tuned(|config| {
        config.trusted_proxies = "203.0.113.0/24".parse().unwrap();
    })
    .await;
    let _host = common::bootstrap_host(&server).await;

    let (allowed, _) = RATE_LOGIN_PER_IP;
    for n in 0..allowed {
        let resp = sign_in_from(&server, &format!("198.51.100.{n}"), "wrong wrong wrong").await;
        assert_eq!(resp.status(), 401);
    }
    let resp = sign_in_from(&server, "198.51.100.99", "correct horse battery").await;
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
    let turns = u32::try_from(server.state.config.password_checks_at_once).unwrap();
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
        assert_eq!(env.error.message, SERVER_BUSY);
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

// --- the share window's own sign-in (#820) -----------------------------------

/// `POST /auth/refresh`'s status, and its answer when it worked.
async fn refreshed(server: &common::TestServer, token: &str) -> (u16, Option<RefreshResponse>) {
    let resp = reqwest::Client::new()
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": token }))
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    (
        status,
        if status == 200 {
            Some(resp.json().await.unwrap())
        } else {
            None
        },
    )
}

async fn share_sign_in(server: &common::TestServer, token: &str) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url("/auth/share-sign-in"))
        .json(&serde_json::json!({ "refresh_token": token }))
        .send()
        .await
        .unwrap()
}

/// The share window gets a sign-in of its own: a new family, so the app's
/// token isn't spent asking, and each renews without touching the other. A
/// replay of the window's spent token takes down the window's family alone.
#[tokio::test]
async fn a_share_sign_in_is_a_family_of_its_own() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;

    let resp = share_sign_in(&server, &host.refresh_token).await;
    assert_eq!(resp.status(), 200);
    let share: ShareSignInResponse = resp.json().await.unwrap();
    assert_ne!(share.refresh_token, host.refresh_token);

    // Its access tokens are the person's.
    let (status, window) = refreshed(&server, &share.refresh_token).await;
    assert_eq!(status, 200);
    let window = window.unwrap();
    let me = reqwest::Client::new()
        .get(server.url("/me"))
        .bearer_auth(&window.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(me.status(), 200);

    // The app's token wasn't spent asking, and still renews.
    let (status, app) = refreshed(&server, &host.refresh_token).await;
    assert_eq!(status, 200, "asking spent the app's token");
    let app = app.unwrap();

    // Replaying the window's spent token kills the window's family only.
    assert_eq!(refreshed(&server, &share.refresh_token).await.0, 401);
    assert_eq!(
        refreshed(&server, &window.refresh_token).await.0,
        401,
        "the window's family lives on"
    );
    assert_eq!(
        refreshed(&server, &app.refresh_token).await.0,
        200,
        "the app's family went with the window's"
    );
}

/// Asking with a token already spent is a replay, as at `POST /auth/refresh`:
/// no sign-in, and its family is revoked. An unknown token gets nothing.
#[tokio::test]
async fn a_spent_token_gets_no_share_sign_in_and_loses_its_family() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let (_, next) = refreshed(&server, &host.refresh_token).await;
    let next = next.unwrap();

    let resp = share_sign_in(&server, &host.refresh_token).await;
    assert_eq!(resp.status(), 401);
    let body: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(body.error.code, ErrorCode::Unauthenticated);
    assert_eq!(
        refreshed(&server, &next.refresh_token).await.0,
        401,
        "a replay must revoke the family"
    );

    assert_eq!(share_sign_in(&server, "not-a-token").await.status(), 401);
}

/// What ends every sign-in ends the share window's too: a password change.
#[tokio::test]
async fn a_password_change_ends_the_share_sign_in() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let share: ShareSignInResponse = share_sign_in(&server, &host.refresh_token)
        .await
        .json()
        .await
        .unwrap();

    let changed = reqwest::Client::new()
        .patch(server.url("/me/password"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({
            "current_password": "correct horse battery", "new_password": "a brand new passphrase"
        }))
        .send()
        .await
        .unwrap();
    assert!(changed.status().is_success(), "{}", changed.status());
    assert_eq!(refreshed(&server, &share.refresh_token).await.0, 401);
}

/// A handful an hour per person, then `RATE_LIMITED` with when to try again;
/// the one refused isn't left behind as a working sign-in.
#[tokio::test]
async fn share_sign_ins_are_limited_per_person() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    for _ in 0..RATE_SHARE_SIGN_IN.0 {
        assert_eq!(
            share_sign_in(&server, &host.refresh_token).await.status(),
            200
        );
    }
    let refused = share_sign_in(&server, &host.refresh_token).await;
    assert_eq!(refused.status(), 429);
    let body: ErrorEnvelope = refused.json().await.unwrap();
    assert_eq!(body.error.code, ErrorCode::RateLimited);
    assert!(body.error.retry_after_ms.is_some_and(|ms| ms > 0));
    // Still the app's to use.
    assert_eq!(refreshed(&server, &host.refresh_token).await.0, 200);
}
