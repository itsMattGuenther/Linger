//! A status's short fields with labels people choose (#270, SPEC §4.6,
//! PROTOCOL §5), end to end over real HTTP against a temp SQLite file.
//!
//! Most of this is about the apps that came before. They know three fixed
//! fields, `listening`, `reading` and `working_on`, and they must keep
//! working: every status still carries those three, filled from the fields
//! with those exact labels, and a save from one of them (no `fields` in it)
//! changes those three and keeps everything else. The migration turns the
//! old columns into fields, so nobody's status changes on update.

mod common;

use common::{bootstrap_host, data_config, join_member, spawn_in, spawn_server, TestServer};
use linger_core::wire::{AuthResponse, StatusField, User, UserStatus};
use linger_core::UserId;
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn field(label: &str, value: &str) -> StatusField {
    StatusField {
        label: label.into(),
        value: value.into(),
    }
}

/// A whole status the way this app sends one: its fields, and the three old
/// keys filled from them for a server that predates fields.
fn with_fields(line: &str, fields: &[(&str, &str)]) -> Value {
    let find = |label: &str| {
        fields
            .iter()
            .find(|(held, _)| *held == label)
            .map(|(_, value)| *value)
    };
    json!({
        "status": {
            "line": line,
            "reading": find("Reading"),
            "listening": find("Listening to"),
            "working_on": find("Working on"),
            "fields": fields.iter().map(|(label, value)| json!({ "label": label, "value": value })).collect::<Vec<_>>(),
            "image_id": null, "image_url": null,
            "away_message": null, "away_since": null
        }
    })
}

/// A whole status the way an app from before #270 sends one: the three fixed
/// keys, and no `fields` at all.
fn the_old_way(
    line: &str,
    listening: Option<&str>,
    reading: Option<&str>,
    working_on: Option<&str>,
    away: Option<&str>,
) -> Value {
    json!({
        "status": {
            "line": line,
            "reading": reading, "listening": listening, "working_on": working_on,
            "image_id": null, "image_url": null,
            "away_message": away, "away_since": null
        }
    })
}

async fn patch(server: &TestServer, token: &str, body: &Value) -> reqwest::Response {
    client()
        .patch(server.url("/me"))
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .unwrap()
}

/// `PATCH /me`, expecting it to be taken.
async fn save(server: &TestServer, token: &str, body: Value) -> User {
    let resp = patch(server, token, &body).await;
    assert_eq!(
        resp.status(),
        200,
        "status refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// `PATCH /me`, expecting a refusal in words: the message is returned.
async fn refused(server: &TestServer, token: &str, body: Value) -> String {
    let resp = patch(server, token, &body).await;
    assert_eq!(resp.status(), 422, "expected a refusal for {body}");
    let answer: Value = resp.json().await.unwrap();
    assert_eq!(answer["error"]["code"], "VALIDATION_FAILED");
    answer["error"]["message"].as_str().unwrap().to_string()
}

async fn get<T: serde::de::DeserializeOwned>(server: &TestServer, token: &str, path: &str) -> T {
    client()
        .get(server.url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// What a friend's app reads for this person: `GET /users/:id`.
async fn seen(server: &TestServer, token: &str, id: UserId) -> UserStatus {
    let user: User = get(server, token, &format!("/users/{id}")).await;
    user.status.expect("a status")
}

/// The same status as raw JSON, so the wire shape itself is checked rather
/// than what serde makes of it.
async fn seen_raw(server: &TestServer, token: &str, id: UserId) -> Value {
    let user: Value = get(server, token, &format!("/users/{id}")).await;
    user["status"].clone()
}

fn fields_of(status: &UserStatus) -> Vec<StatusField> {
    status
        .fields
        .clone()
        .expect("a server that knows fields sends them")
}

// ---------------------------------------------------------------------------
// Saving and reading fields
// ---------------------------------------------------------------------------

/// Fields save, come back in their order, trimmed, to you and to everybody.
#[tokio::test]
async fn fields_save_and_come_back() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let jo = join_member(&server, &host.access_token, "jo").await;

    let saved = save(
        &server,
        &host.access_token,
        with_fields(
            "fixing the porch light",
            &[
                ("Playing", "  Outer Wilds "),
                (" GitHub", "github.com/bendthebracket"),
                ("Reading", "Piranesi"),
            ],
        ),
    )
    .await;
    let want = vec![
        field("Playing", "Outer Wilds"),
        field("GitHub", "github.com/bendthebracket"),
        field("Reading", "Piranesi"),
    ];
    assert_eq!(fields_of(saved.status.as_ref().unwrap()), want);

    let me: User = get(&server, &host.access_token, "/me").await;
    assert_eq!(fields_of(me.status.as_ref().unwrap()), want);
    assert_eq!(
        fields_of(&seen(&server, &jo.access_token, host.user.id).await),
        want
    );
    let everyone: Vec<User> = get(&server, &jo.access_token, "/users").await;
    let host_there = everyone.iter().find(|u| u.id == host.user.id).unwrap();
    assert_eq!(fields_of(host_there.status.as_ref().unwrap()), want);

    // An empty list clears them all, and an empty list is what comes back:
    // a server that knows fields always sends the list.
    save(&server, &host.access_token, with_fields("still here", &[])).await;
    let raw = seen_raw(&server, &jo.access_token, host.user.id).await;
    assert_eq!(raw["fields"], json!([]));
    assert_eq!(raw["line"], "still here");
    assert_eq!(raw["reading"], Value::Null);
}

/// Somebody who has never saved a status has none, as before.
#[tokio::test]
async fn nobody_gets_fields_they_never_saved() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let jo = join_member(&server, &host.access_token, "jo").await;
    let user: User = get(
        &server,
        &host.access_token,
        &format!("/users/{}", jo.user.id),
    )
    .await;
    assert_eq!(user.status, None);
}

/// Every label and value is checked by the server (never the app alone):
/// lengths in characters, no control characters, no label twice, no blanks.
/// A refused save changes nothing.
#[tokio::test]
async fn labels_and_values_are_capped_and_checked() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let token = &host.access_token;
    save(
        &server,
        token,
        with_fields("kept", &[("Playing", "Outer Wilds")]),
    )
    .await;

    let long_label = "x".repeat(25);
    let long_value = "y".repeat(81);
    let cases: Vec<(Vec<(&str, &str)>, &str)> = vec![
        (vec![(long_label.as_str(), "ok")], "capped at 24"),
        (vec![("Reading", long_value.as_str())], "capped at 80"),
        (vec![("Read\ting", "ok")], "control characters"),
        (vec![("Reading", "one\ntwo")], "control characters"),
        (vec![("Reading", "bell \u{7}")], "control characters"),
        (vec![("Reading", "tab\u{9}")], "control characters"),
        (vec![("  ", "ok")], "needs a label"),
        (vec![("Reading", "   ")], "needs something written"),
        (vec![("Reading", "a"), ("reading", "b")], "Two fields"),
    ];
    for (fields, words) in cases {
        let message = refused(&server, token, with_fields("changed", &fields)).await;
        assert!(message.contains(words), "{message:?} should say {words:?}");
    }
    let still = seen(&server, token, host.user.id).await;
    assert_eq!(still.line.as_deref(), Some("kept"));
    assert_eq!(fields_of(&still), vec![field("Playing", "Outer Wilds")]);

    // Right at the limits is fine, counted in characters rather than bytes.
    let label = "é".repeat(24);
    let value = "ü".repeat(80);
    let saved = save(&server, token, with_fields("full", &[(&label, &value)])).await;
    assert_eq!(
        fields_of(saved.status.as_ref().unwrap()),
        vec![field(&label, &value)]
    );

    // The three old keys are held to the same rules, since they become fields.
    let message = refused(
        &server,
        token,
        the_old_way("x", None, Some("one\ntwo"), None, None),
    )
    .await;
    assert!(message.contains("control characters"), "{message:?}");
    refused(
        &server,
        token,
        the_old_way("x", None, Some(&"z".repeat(81)), None, None),
    )
    .await;
}

/// A status can't turn itself, or the words beside it on a card, around
/// (#488): the characters that change the direction of text are taken out of
/// every part of it, the line, the fields and the away message, and the
/// rest is saved as written.
#[tokio::test]
async fn a_status_loses_the_characters_that_turn_text_around() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let jo = join_member(&server, &host.access_token, "jo").await;
    let mut body = with_fields(
        "fixing the \u{202E}thgil hcrop",
        &[
            ("Play\u{2067}ing", "Outer Wilds\u{2069}"),
            ("Reading", "\u{202B}שלום"),
        ],
    );
    body["status"]["away_message"] = json!("\u{200F}back after work");
    save(&server, &host.access_token, body).await;

    let status = seen(&server, &jo.access_token, host.user.id).await;
    assert_eq!(status.line.as_deref(), Some("fixing the thgil hcrop"));
    assert_eq!(
        fields_of(&status),
        vec![field("Playing", "Outer Wilds"), field("Reading", "שלום")]
    );
    assert_eq!(status.reading.as_deref(), Some("שלום"));
    assert_eq!(status.away_message.as_deref(), Some("back after work"));

    // An app from before fields sends the three old keys: the same.
    save(
        &server,
        &host.access_token,
        the_old_way("x", Some("\u{202D}Low"), None, None, None),
    )
    .await;
    let status = seen(&server, &jo.access_token, host.user.id).await;
    assert_eq!(status.listening.as_deref(), Some("Low"));
}

/// A status is a small card, not a bio: a fourth field is refused.
#[tokio::test]
async fn a_fourth_field_is_refused() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let message = refused(
        &server,
        &host.access_token,
        with_fields(
            "too much",
            &[("A", "1"), ("B", "2"), ("C", "3"), ("D", "4")],
        ),
    )
    .await;
    assert!(message.contains("three fields at most"), "{message:?}");
    let saved = save(
        &server,
        &host.access_token,
        with_fields("enough", &[("A", "1"), ("B", "2"), ("C", "3")]),
    )
    .await;
    assert_eq!(fields_of(saved.status.as_ref().unwrap()).len(), 3);
}

// ---------------------------------------------------------------------------
// Older apps
// ---------------------------------------------------------------------------

/// The three old keys are filled from the fields whose labels are exactly
/// "Listening to", "Reading" and "Working on"; any other field is left out.
/// When `fields` is sent, the old keys beside it are ignored.
#[tokio::test]
async fn the_classic_three_are_still_filled_for_older_apps() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let jo = join_member(&server, &host.access_token, "jo").await;

    let mut body = with_fields(
        "on the couch",
        &[
            ("Working on", "a porch light"),
            ("Playing", "Outer Wilds"),
            ("Listening to", "Khruangbin"),
        ],
    );
    // What the old keys say beside a list doesn't matter; the list does.
    body["status"]["reading"] = json!("not a field");
    body["status"]["working_on"] = json!("something else");
    save(&server, &host.access_token, body).await;

    let raw = seen_raw(&server, &jo.access_token, host.user.id).await;
    assert_eq!(raw["listening"], "Khruangbin");
    assert_eq!(raw["reading"], Value::Null);
    assert_eq!(raw["working_on"], "a porch light");
    assert_eq!(raw["line"], "on the couch");
}

/// Exactly means exactly: a lower-case "reading" is somebody's own label, and
/// an older app doesn't see it.
#[tokio::test]
async fn a_lower_case_label_is_not_a_classic_one() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    save(
        &server,
        &host.access_token,
        with_fields(
            "x",
            &[("reading", "lower case"), ("working on", "also mine")],
        ),
    )
    .await;
    let raw = seen_raw(&server, &host.access_token, host.user.id).await;
    assert_eq!(raw["reading"], Value::Null);
    assert_eq!(raw["working_on"], Value::Null);
    assert_eq!(raw["fields"].as_array().map(Vec::len), Some(2));
}

/// The case that matters: a friend on an older app saves their status (goes
/// away, changes their line) and the fields it doesn't know about survive.
/// Its three keys change the fields with those labels, in place; an empty one
/// clears that field; a new one is added at the end.
#[tokio::test]
async fn an_older_apps_save_keeps_custom_fields() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let token = &host.access_token;
    save(
        &server,
        token,
        with_fields(
            "fixing the porch light",
            &[
                ("Playing", "Outer Wilds"),
                ("Reading", "Piranesi"),
                ("GitHub", "github.com/bendthebracket"),
            ],
        ),
    )
    .await;

    // Going away from an older app: it sends back what it read, plus the
    // away message.
    let away = save(
        &server,
        token,
        the_old_way(
            "fixing the porch light",
            None,
            Some("Piranesi"),
            None,
            Some("walking the dog"),
        ),
    )
    .await;
    let status = away.status.unwrap();
    assert_eq!(status.away_message.as_deref(), Some("walking the dog"));
    assert_eq!(
        fields_of(&status),
        vec![
            field("Playing", "Outer Wilds"),
            field("Reading", "Piranesi"),
            field("GitHub", "github.com/bendthebracket"),
        ]
    );

    // A new book replaces the old one where it stands.
    let changed = save(
        &server,
        token,
        the_old_way("back", None, Some("Dune"), None, None),
    )
    .await;
    assert_eq!(
        fields_of(changed.status.as_ref().unwrap()),
        vec![
            field("Playing", "Outer Wilds"),
            field("Reading", "Dune"),
            field("GitHub", "github.com/bendthebracket"),
        ]
    );

    // With the box emptied, that field goes, and only it.
    let cleared = save(&server, token, the_old_way("back", None, None, None, None)).await;
    assert_eq!(
        fields_of(cleared.status.as_ref().unwrap()),
        vec![
            field("Playing", "Outer Wilds"),
            field("GitHub", "github.com/bendthebracket"),
        ]
    );

    // A value for a field that isn't there is added at the end.
    let added = save(
        &server,
        token,
        the_old_way("back", Some("Khruangbin"), None, None, None),
    )
    .await;
    let status = added.status.unwrap();
    assert_eq!(
        fields_of(&status),
        vec![
            field("Playing", "Outer Wilds"),
            field("GitHub", "github.com/bendthebracket"),
            field("Listening to", "Khruangbin"),
        ]
    );
    assert_eq!(status.listening.as_deref(), Some("Khruangbin"));

    // `fields: null` is the same as leaving it out.
    let mut body = the_old_way("back", Some("Khruangbin"), None, None, None);
    body["status"]["fields"] = Value::Null;
    let same = save(&server, token, body).await;
    assert_eq!(fields_of(same.status.as_ref().unwrap()).len(), 3);

    // Full: an older app can't add a fourth, and says why. Nothing changes.
    let message = refused(
        &server,
        token,
        the_old_way("full", Some("Khruangbin"), Some("Piranesi"), None, None),
    )
    .await;
    assert!(message.contains("three fields"), "{message:?}");
    let still = seen(&server, token, host.user.id).await;
    assert_eq!(still.line.as_deref(), Some("back"));
    assert_eq!(fields_of(&still).len(), 3);
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

const PASSWORD: &str = "correct horse battery";

/// Somebody on a server from before #270, written straight into its tables.
async fn person_the_old_way(
    db: &sqlx::SqlitePool,
    username: &str,
    is_host: bool,
    status: Option<[Option<&str>; 5]>,
) -> UserId {
    let id = UserId::new();
    let hash = linger_server::auth::hash_password_sync(PASSWORD).unwrap();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, is_host, created_at)
         VALUES (?, ?, ?, ?, ?, 0)",
    )
    .bind(id.to_vec())
    .bind(username)
    .bind(username)
    .bind(hash)
    .bind(i64::from(is_host))
    .execute(db)
    .await
    .unwrap();
    if let Some([line, listening, reading, working_on, away]) = status {
        sqlx::query(
            "INSERT INTO user_status
               (user_id, line, reading, listening, working_on, away_message, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0)",
        )
        .bind(id.to_vec())
        .bind(line)
        .bind(reading)
        .bind(listening)
        .bind(working_on)
        .bind(away)
        .execute(db)
        .await
        .unwrap();
    }
    id
}

async fn sign_in(server: &TestServer, username: &str) -> AuthResponse {
    let resp = client()
        .post(server.url("/auth/login"))
        .json(&json!({ "username": username, "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "sign in: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// A server updated from before #270: its database is built by the
/// migrations it shipped with, statuses are saved the old way, and then the
/// new server starts over it and runs 0007 for real. Every status reads back
/// exactly as it did, and the old three are fields with those labels, in the
/// order the card showed them.
#[tokio::test]
async fn the_migration_carries_existing_statuses_over_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = data_config(&dir).db_path();
    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = before
        .migrations
        .iter()
        .filter(|migration| migration.version <= 6)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    assert_eq!(before.migrations.len(), 6, "0001 to 0006, as shipped");
    before.run(&old).await.unwrap();

    let host = person_the_old_way(&old, "matt", true, None).await;
    let all_three = person_the_old_way(
        &old,
        "callie",
        false,
        Some([
            Some("on the couch"),
            Some("Khruangbin"),
            Some("Piranesi"),
            Some("a porch light"),
            None,
        ]),
    )
    .await;
    let one = person_the_old_way(
        &old,
        "jules",
        false,
        Some([Some("speakers set up"), None, None, Some("a mixtape"), None]),
    )
    .await;
    let blanks = person_the_old_way(
        &old,
        "sam",
        false,
        Some([None, Some(""), Some("   "), None, Some("back after work")]),
    )
    .await;
    old.close().await;

    // The update: the new server over the old database.
    let server = spawn_in(dir, |_| {}).await;
    let token = sign_in(&server, "matt").await.access_token;

    let callie = seen(&server, &token, all_three).await;
    assert_eq!(callie.line.as_deref(), Some("on the couch"));
    assert_eq!(callie.listening.as_deref(), Some("Khruangbin"));
    assert_eq!(callie.reading.as_deref(), Some("Piranesi"));
    assert_eq!(callie.working_on.as_deref(), Some("a porch light"));
    assert_eq!(
        fields_of(&callie),
        vec![
            field("Listening to", "Khruangbin"),
            field("Reading", "Piranesi"),
            field("Working on", "a porch light"),
        ]
    );

    let jules = seen(&server, &token, one).await;
    assert_eq!(jules.working_on.as_deref(), Some("a mixtape"));
    assert_eq!(jules.reading, None);
    assert_eq!(fields_of(&jules), vec![field("Working on", "a mixtape")]);

    let sam = seen(&server, &token, blanks).await;
    assert_eq!(sam.away_message.as_deref(), Some("back after work"));
    assert_eq!(fields_of(&sam), vec![], "an empty column makes no field");

    let me: User = get(&server, &token, "/me").await;
    assert_eq!(me.id, host);
    assert_eq!(me.status, None);

    // And the carried-over fields are ordinary fields from here on: an older
    // app's save still finds them by label.
    let callie_token = sign_in(&server, "callie").await.access_token;
    let saved = save(
        &server,
        &callie_token,
        the_old_way(
            "on the couch",
            Some("Khruangbin"),
            Some("Dune"),
            Some("a porch light"),
            None,
        ),
    )
    .await;
    assert_eq!(
        fields_of(saved.status.as_ref().unwrap()),
        vec![
            field("Listening to", "Khruangbin"),
            field("Reading", "Dune"),
            field("Working on", "a porch light"),
        ]
    );
}
