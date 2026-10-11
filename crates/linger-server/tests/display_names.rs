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

// ---------------------------------------------------------------------------
// Nobody takes a name that looks like someone else's (#574)
// ---------------------------------------------------------------------------

const LOOKS_TAKEN: &str =
    "Someone here already goes by a name that looks like that. Try something a little different.";

/// A look-alike refusal: its own code, so the app can say it on the name field.
async fn looks_taken(resp: reqwest::Response, name: &str) {
    assert_eq!(resp.status(), 409, "{name:?} should have been refused");
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "DISPLAY_NAME_TAKEN", "{name:?}");
    assert_eq!(body["error"]["message"], LOOKS_TAKEN, "{name:?}");
}

/// A single-use invite, as the host makes them by default.
async fn one_use_invite(server: &TestServer, host: &AuthResponse) -> Invite {
    client()
        .post(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// Somebody whose display name isn't their username: `jules`, "Jules R.".
async fn join_as(
    server: &TestServer,
    host: &AuthResponse,
    username: &str,
    name: &str,
) -> AuthResponse {
    let invite = one_use_invite(server, host).await;
    let resp = register(server, &invite.code, username, name).await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

#[tokio::test]
async fn a_name_that_looks_like_another_members_is_refused_and_a_different_one_taken() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await; // "Matt", @matt
    join_as(&server, &host, "jules", "Jules R.").await;
    join_as(&server, &host, "sam", "Sam G").await;
    let dave = join_member(&server, &host.access_token, "dave").await;

    for name in [
        "Matt",
        // Spaces at the ends are trimmed before anything is saved.
        "Matt ",
        "  Matt",
        // Only the capitals differ.
        "matt",
        "MATT",
        // Cyrillic М and а, which look like the Latin letters.
        "\u{041C}\u{0430}tt",
        // Full-width letters.
        "\u{FF2D}\u{FF41}\u{FF54}\u{FF54}",
        // rn for m.
        "rnatt",
        // A no-break space, or two spaces, where the space was.
        "Sam\u{00A0}G",
        "Sam  G",
        "sam g",
        // Somebody's username as your display name.
        "jules",
        "Jules",
    ] {
        let resp = patch_me(
            &server,
            &dave.access_token,
            &json!({ "display_name": name }),
        )
        .await;
        looks_taken(resp, name).await;
    }
    // Nothing refused was written.
    assert_eq!(me(&server, &dave.access_token).await.display_name, "dave");

    // A name that is a little different is anyone's.
    for name in ["Dave B", "Matty", "Matt's brother", "Jules R. 2", "Sammy"] {
        let resp = patch_me(
            &server,
            &dave.access_token,
            &json!({ "display_name": name }),
        )
        .await;
        assert_eq!(
            resp.status(),
            200,
            "{name:?}: {}",
            resp.text().await.unwrap()
        );
        assert_eq!(resp.json::<User>().await.unwrap().display_name, name);
    }
}

#[tokio::test]
async fn your_own_name_never_looks_taken_by_you() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    join_member(&server, &host.access_token, "dave").await;

    // Saved again as it is, changed only in its capitals, and back.
    for name in ["Matt", "MATT", "matt", "Matt"] {
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
        assert_eq!(resp.json::<User>().await.unwrap().display_name, name);
    }
}

#[tokio::test]
async fn a_name_saved_with_an_invisible_character_still_counts() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let eve = join_member(&server, &host.access_token, "eve").await;
    let dave = join_member(&server, &host.access_token, "dave").await;

    // As a server from before #296 would have stored it.
    sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
        .bind("Ev\u{200B}ie")
        .bind(eve.user.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();

    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": "Evie" }),
    )
    .await;
    looks_taken(resp, "Evie").await;
}

#[tokio::test]
async fn sign_up_with_a_look_alike_name_is_refused_before_the_account_or_the_invite_is_used() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let invite = one_use_invite(&server, &host).await;

    for name in ["\u{041C}\u{0430}tt", "matt", "Matt "] {
        let resp = register(&server, &invite.code, "callie", name).await;
        looks_taken(resp, name).await;
    }

    // The invite's one use is still there, and the username still free.
    let invites: Vec<Invite> = client()
        .get(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let held = invites.iter().find(|one| one.code == invite.code).unwrap();
    assert_eq!(held.uses, 0, "a refused name must not use up the invite");

    let resp = register(&server, &invite.code, "callie", "Callie").await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    let callie: AuthResponse = resp.json().await.unwrap();
    assert_eq!(callie.user.username, "callie");
}

#[tokio::test]
async fn without_a_good_invite_a_name_says_nothing_about_who_is_here() {
    let server = spawn_server().await;
    bootstrap_host(&server).await;

    let resp = register(&server, "not-a-real-code", "callie", "Matt").await;
    assert_eq!(resp.status(), 422);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["error"]["code"], "INVITE_INVALID");
}

#[tokio::test]
async fn a_removed_members_name_is_free_again() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let dave = join_as(&server, &host, "dave", "Dave B").await;
    let callie = join_member(&server, &host.access_token, "callie").await;

    let resp = patch_me(
        &server,
        &callie.access_token,
        &json!({ "display_name": "dave b" }),
    )
    .await;
    looks_taken(resp, "dave b").await;

    let removed = client()
        .post(server.url(&format!("/users/{}/remove", dave.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);

    // Nobody can see a removed member's name, so it doesn't keep it from anyone.
    let resp = patch_me(
        &server,
        &callie.access_token,
        &json!({ "display_name": "dave b" }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
}

#[tokio::test]
async fn two_people_asking_for_look_alike_names_at_once_cant_both_have_them() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let dave = join_member(&server, &host.access_token, "dave").await;
    let eve = join_member(&server, &host.access_token, "eve").await;

    let (latin, cyrillic) = (
        json!({ "display_name": "Robin" }),
        json!({ "display_name": "R\u{043E}bin" }),
    );
    let (first, second) = tokio::join!(
        patch_me(&server, &dave.access_token, &latin),
        patch_me(&server, &eve.access_token, &cyrillic),
    );
    let mut answers = [first.status().as_u16(), second.status().as_u16()];
    answers.sort_unstable();
    assert_eq!(answers, [200, 409], "exactly one of them gets the name");
}

#[tokio::test]
async fn look_alike_names_saved_before_the_rule_stay_as_they_are() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let dave = join_member(&server, &host.access_token, "dave").await;

    // Set before the rule: the host's name, in Cyrillic М and а.
    let old_name = "\u{041C}\u{0430}tt";
    sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
        .bind(old_name)
        .bind(dave.user.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();

    // It signs in, and sending it back unchanged isn't changing it.
    let dave = sign_in(&server, "dave").await;
    assert_eq!(dave.user.display_name, old_name);
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": old_name }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());

    // Changing it is held to the rule, like any other name.
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": "Matt" }),
    )
    .await;
    looks_taken(resp, "Matt").await;
    let resp = patch_me(
        &server,
        &dave.access_token,
        &json!({ "display_name": "Dave" }),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
}
