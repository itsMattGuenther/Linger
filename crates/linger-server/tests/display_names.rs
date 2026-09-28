//! What a display name may hold (#296, PROTOCOL §2), end to end over real HTTP
//! against a temp SQLite file: sign-up, first-host setup and `PATCH /me` each
//! refuse a name that hides, breaks the line, turns the text around or piles
//! marks on a letter, with a sentence that says which, and take real names in
//! any script. A name saved before the rules is left alone.

mod common;

use common::{bootstrap_host, join_member, sign_in, spawn_server, TestServer};
use linger_core::wire::{AuthResponse, Invite, User};
use serde_json::{json, Value};

/// A name the rules refuse, and the sentence each is refused with.
const REFUSED: &[(&str, &str)] = &[
    (
        "Matt\nB",
        "Names can't have tabs, line breaks or other control characters.",
    ),
    (
        "Matt\tB",
        "Names can't have tabs, line breaks or other control characters.",
    ),
    (
        "\u{202E}ttaM",
        "Names can't have characters that change the direction of text.",
    ),
    (
        "Matt\u{2066}B",
        "Names can't have characters that change the direction of text.",
    ),
    ("Ma\u{200B}tt", "Names can't have invisible characters."),
    ("Ma\u{200D}tt", "Names can't have invisible characters."),
    ("\u{FEFF}Matt", "Names can't have invisible characters."),
    (
        "M\u{0334}\u{0321}\u{031B}\u{0317}att",
        "Names can't have more than two accent marks on one letter.",
    ),
    (
        "\u{0E01}\u{0E49}\u{0E49}\u{0E49}\u{0E49}\u{0E49}",
        "Names can't stack that many marks on one letter.",
    ),
    ("\u{3164}", "That name has no letters anyone can see."),
    (
        "\u{2800}\u{2800}",
        "That name has no letters anyone can see.",
    ),
    ("   ", "That name has no letters anyone can see."),
    ("", "Display names are 1–32 characters."),
];

/// Real names that must go through, whatever the script.
const ALLOWED: &[&str] = &[
    "Justin B",
    "José",
    "李小龍",
    "محمد",
    "Ωmega",
    "Zoë 👨‍👩‍👧",
    // Persian, with the non-joiner written inside the word.
    "\u{0639}\u{0644}\u{06CC}\u{200C}\u{0631}\u{0636}\u{0627}",
];

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// A validation refusal's code and sentence.
async fn refused(resp: reqwest::Response, name: &str) -> String {
    assert_eq!(resp.status(), 422, "{name:?} should have been refused");
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "VALIDATION_FAILED", "{name:?}");
    body["error"]["message"].as_str().unwrap().to_string()
}

async fn open_invite(server: &TestServer, host: &AuthResponse) -> Invite {
    client()
        .post(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "max_uses": null }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn register(
    server: &TestServer,
    code: &str,
    username: &str,
    name: &str,
) -> reqwest::Response {
    client()
        .post(server.url("/auth/register"))
        .json(&json!({
            "invite_code": code,
            "username": username,
            "display_name": name,
            "password": "a perfectly fine password",
        }))
        .send()
        .await
        .unwrap()
}

async fn patch_me(server: &TestServer, token: &str, body: &Value) -> reqwest::Response {
    client()
        .patch(server.url("/me"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .unwrap()
}

async fn me(server: &TestServer, token: &str) -> User {
    client()
        .get(server.url("/me"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn sign_up_refuses_a_name_that_breaks_a_rule_and_takes_a_real_one() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let invite = open_invite(&server, &host).await;

    for (name, sentence) in REFUSED {
        let resp = register(&server, &invite.code, "callie", name).await;
        assert_eq!(refused(resp, name).await, *sentence, "{name:?}");
    }

    for (at, name) in ALLOWED.iter().enumerate() {
        let resp = register(&server, &invite.code, &format!("person_{at}"), name).await;
        assert_eq!(
            resp.status(),
            200,
            "{name:?}: {}",
            resp.text().await.unwrap()
        );
        let auth: AuthResponse = resp.json().await.unwrap();
        assert_eq!(auth.user.display_name, *name);
    }
}

#[tokio::test]
async fn first_host_setup_refuses_a_bad_name_without_spending_its_link() {
    let server = spawn_server().await;
    let token = server
        .state
        .setup
        .peek()
        .expect("a fresh server has a setup token");
    let setup = |name: &'static str| {
        client()
            .post(server.url("/setup"))
            .json(&json!({
                "token": token, "server_name": "the garage", "username": "matt",
                "display_name": name, "password": "correct horse battery",
            }))
            .send()
    };

    for (name, sentence) in REFUSED {
        let resp = setup(name).await.unwrap();
        assert_eq!(refused(resp, name).await, *sentence, "{name:?}");
        assert!(
            server.state.setup.peek().is_some(),
            "a refused name must not use up the setup link"
        );
    }

    let resp = setup("Matt 💾").await.unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    let auth: AuthResponse = resp.json().await.unwrap();
    assert!(auth.user.is_host);
    assert_eq!(auth.user.display_name, "Matt 💾");
}

#[tokio::test]
async fn changing_your_name_is_held_to_the_rules() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    for (name, sentence) in REFUSED {
        let resp = patch_me(
            &server,
            &host.access_token,
            &json!({ "display_name": name }),
        )
        .await;
        assert_eq!(refused(resp, name).await, *sentence, "{name:?}");
    }
    // Nothing refused was written.
    assert_eq!(me(&server, &host.access_token).await.display_name, "Matt");

    for name in ALLOWED {
        let resp = patch_me(
            &server,
            &host.access_token,
            &json!({ "display_name": name }),
        )
        .await;
        assert_eq!(
            resp.status(),
            200,
            "{name:?}: {}",
            resp.text().await.unwrap()
        );
        let user: User = resp.json().await.unwrap();
        assert_eq!(user.display_name, *name);
    }
}

#[tokio::test]
async fn a_name_saved_before_the_rules_still_loads_signs_in_and_stays() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let dave = join_member(&server, &host.access_token, "dave").await;

    // As an older server would have stored it: a right-to-left override and
    // a zero-width space in it, both refused today.
    let old_name = "Dave\u{202E}\u{200B} B";
    sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
        .bind(old_name)
        .bind(dave.user.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();

    // Signing in still works, and hands the name back as it is.
    let dave = sign_in(&server, "dave").await;
    assert_eq!(dave.user.display_name, old_name);
    assert_eq!(me(&server, &dave.access_token).await.display_name, old_name);
    let everyone: Vec<User> = client()
        .get(server.url("/users"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(everyone
        .iter()
        .any(|person| person.username == "dave" && person.display_name == old_name));

    // Saving a look or a status leaves the name alone.
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({
            "style": {
                "font_key": "departure-mono", "weight": 700, "italic": true,
                "fill": { "kind": "solid", "color": "teal" },
                "effect": "none", "msg_font_key": null
            }
        }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    let user: User = resp.json().await.unwrap();
    assert_eq!(user.display_name, old_name);
    assert_eq!(user.style.font_key, "departure-mono");

    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({
            "status": {
                "line": "fixing the fence",
                "reading": null, "listening": null, "working_on": null,
                "image_id": null, "image_url": null,
                "away_message": null, "away_since": null
            }
        }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    let user: User = resp.json().await.unwrap();
    assert_eq!(user.display_name, old_name);
    assert_eq!(
        user.status.and_then(|status| status.line).as_deref(),
        Some("fixing the fence")
    );

    // Sending the name back unchanged is not changing it.
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": old_name }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());

    // Changing it is: to another name that breaks a rule, no; to a fine one, yes.
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": "Dave\u{202E} C" }),
    )
    .await;
    assert_eq!(
        refused(resp, "Dave\u{202E} C").await,
        "Names can't have characters that change the direction of text."
    );
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": "Dave B" }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    assert_eq!(me(&server, &dave.access_token).await.display_name, "Dave B");
}
