//! Deleting an account (#650, SPEC §4.19, PROTOCOL §5).
//!
//! Both app stores require it, and what they ask is that the account goes
//! with the personal data that came with it. So most of what is here checks
//! the database straight after a delete: nothing about the person is left
//! but the emptied row that keeps their name taken, and what they wrote only
//! when they chose to leave it.
//!
//! Real HTTP and real WebSockets against the production router, with a temp
//! SQLite file.

mod common;

use std::time::Duration;

use common::{bootstrap_host, join_member, sign_in, spawn_server, TestServer};
use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{
    Attachment, AuthResponse, ErrorCode, ErrorEnvelope, Message, Room, UploadSlot, User,
};
use linger_core::UserId;
use serde_json::{json, Value};
use sqlx::Row;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const PASSWORD: &str = "a perfectly fine password";

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn make_room(server: &TestServer, token: &str, slug: &str) -> Room {
    let resp = client()
        .post(server.url("/rooms"))
        .bearer_auth(token)
        .json(&json!({ "slug": slug, "name": format!("#{slug}") }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn say(server: &TestServer, token: &str, room_id: &str, body: &str) -> Message {
    say_with(server, token, room_id, body, &[]).await
}

async fn say_with(
    server: &TestServer,
    token: &str,
    room_id: &str,
    body: &str,
    files: &[&Attachment],
) -> Message {
    let ids: Vec<String> = files.iter().map(|f| f.id.to_string()).collect();
    let resp = client()
        .post(server.url(&format!("/rooms/{room_id}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body, "attachment_ids": ids }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn upload(server: &TestServer, token: &str, filename: &str, bytes: Vec<u8>) -> Attachment {
    let slot: UploadSlot = client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&json!({ "filename": filename, "size_bytes": bytes.len(), "mime": "text/plain" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let put = client()
        .put(format!("{}{}", server.base, slot.url))
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let done = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&json!({ "parts": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(done.status(), 200, "{}", done.text().await.unwrap());
    done.json().await.unwrap()
}

async fn history(server: &TestServer, token: &str, room_id: &str) -> Vec<Message> {
    let resp = client()
        .get(server.url(&format!("/rooms/{room_id}/messages")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn react(server: &TestServer, token: &str, message: &Message, key: &str) {
    let resp = client()
        .put(server.url(&format!("/messages/{}/reactions/{key}", message.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204, "{}", resp.text().await.unwrap());
}

async fn ask_poll(server: &TestServer, token: &str, room: &Room, question: &str) -> Message {
    let resp = client()
        .post(server.url(&format!("/rooms/{}/polls", room.id)))
        .bearer_auth(token)
        .json(&json!({
            "question": question, "choices": ["Horde", "Alliance"],
            "multi": false, "closes_in_days": 7
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn vote(server: &TestServer, token: &str, poll: &Message, choice: u32) {
    let resp = client()
        .put(server.url(&format!("/messages/{}/vote", poll.id)))
        .bearer_auth(token)
        .json(&json!({ "choices": [choice] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
}

async fn close_poll(server: &TestServer, token: &str, poll: &Message) {
    let resp = client()
        .post(server.url(&format!("/messages/{}/close", poll.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.text().await.unwrap());
}

async fn delete_me(
    server: &TestServer,
    token: &str,
    password: &str,
    everything: bool,
) -> reqwest::Response {
    client()
        .post(server.url("/me/delete"))
        .bearer_auth(token)
        .json(&json!({ "password": password, "everything": everything }))
        .send()
        .await
        .unwrap()
}

async fn host_deletes(
    server: &TestServer,
    token: &str,
    who: UserId,
    everything: bool,
) -> reqwest::Response {
    client()
        .post(server.url(&format!("/users/{who}/delete")))
        .bearer_auth(token)
        .json(&json!({ "everything": everything }))
        .send()
        .await
        .unwrap()
}

async fn post_empty(server: &TestServer, token: &str, path: &str) -> reqwest::Response {
    client()
        .post(server.url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

async fn users(server: &TestServer, token: &str, path: &str) -> Vec<User> {
    let resp = client()
        .get(server.url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn code_of(resp: reqwest::Response) -> ErrorCode {
    let body: ErrorEnvelope = resp.json().await.unwrap();
    body.error.code
}

/// Rows in `table` where `column` is this person.
async fn rows(server: &TestServer, table: &str, column: &str, who: UserId) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?"))
        .bind(who.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap()
}

async fn connect_ready(server: &TestServer, token: &str) -> (Ws, Value) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["op"], "hello");
    ws.send(WsMessage::Text(
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = recv_json(&mut ws).await;
        if frame["op"] == "ready" {
            return (ws, frame["d"].clone());
        }
    }
}

async fn recv_json(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("gateway frame within 5s")
            .expect("socket still open")
            .expect("clean frame");
        if let WsMessage::Text(text) = msg {
            return serde_json::from_str(text.as_str()).expect("valid frame json");
        }
    }
}

/// Every frame inside `window`.
async fn drain(ws: &mut Ws, window: Duration) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        match tokio::time::timeout(window, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                frames.push(serde_json::from_str(text.as_str()).expect("valid frame json"));
            }
            Ok(Some(Ok(_))) => {}
            _ => return frames,
        }
    }
}

/// A member with a bit of everything set up: style, status and its fields,
/// an entrance sound, notification rules both ways, a read position, a block
/// both ways, an invite, a sign-in link the host made, and a report both ways.
struct Lived {
    server: TestServer,
    host: AuthResponse,
    sam: AuthResponse,
    callie: AuthResponse,
    room: Room,
    sams: Message,
}

async fn lived_in() -> Lived {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let room = make_room(&server, &host.access_token, "porch").await;
    let token = sam.access_token.as_str();

    let resp = client()
        .patch(server.url("/me"))
        .bearer_auth(token)
        .json(&json!({
            "style": {
                "font_key": "departure-mono", "weight": 700, "italic": false,
                "fill": { "kind": "gradient", "from": "teal", "to": "violet" },
                "effect": "shimmer", "msg_font_key": "newsreader"
            },
            "status": {
                "line": "out on the porch", "reading": null, "listening": null,
                "working_on": null,
                "fields": [{ "label": "Playing", "value": "WoW" }],
                "image_id": null, "image_url": null,
                "away_message": null, "away_since": null
            },
            "entrance_sound": "woodblock",
            "time_zone": "America/Toronto"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());

    let sams = say(
        &server,
        token,
        &room.id.to_string(),
        "the secret is under the mat",
    )
    .await;
    let hosts = say(&server, &host.access_token, &room.id.to_string(), "hey sam").await;

    for (who, about) in [(&sam, &callie), (&callie, &sam)] {
        let resp = client()
            .put(server.url("/me/notify-rules"))
            .bearer_auth(&who.access_token)
            .json(&json!({ "target_user_id": about.user.id, "room_id": null }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
        let resp = client()
            .put(server.url(&format!("/me/blocks/{}", about.user.id)))
            .bearer_auth(&who.access_token)
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success(), "{}", resp.text().await.unwrap());
    }
    let resp = client()
        .put(server.url(&format!("/rooms/{}/read", room.id)))
        .bearer_auth(token)
        .json(&json!({ "last_read_id": hosts.id }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.text().await.unwrap());

    let resp = client()
        .post(server.url("/invites"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    let resp = post_empty(
        &server,
        &host.access_token,
        &format!("/users/{}/sign-in-link", sam.user.id),
    )
    .await;
    assert!(resp.status().is_success(), "{}", resp.text().await.unwrap());

    let callies = say(&server, &callie.access_token, &room.id.to_string(), "rude").await;
    for (who, message) in [(&sam, &callies), (&callie, &sams)] {
        let resp = client()
            .post(server.url("/reports"))
            .bearer_auth(&who.access_token)
            .json(&json!({ "message_id": message.id.to_string(), "note": "not ok" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 201, "{}", resp.text().await.unwrap());
    }

    Lived {
        server,
        host,
        sam,
        callie,
        room,
        sams,
    }
}

// ---------------------------------------------------------------------------

/// The password is asked for, so a borrowed, unlocked phone can't do it.
#[tokio::test]
async fn deleting_your_account_takes_your_password() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;

    let resp = delete_me(&server, &sam.access_token, "not my password", false).await;
    assert_eq!(resp.status(), 403);
    assert_eq!(code_of(resp).await, ErrorCode::Forbidden);

    // Nothing happened: the account still signs in and is still listed.
    sign_in(&server, "sam").await;
    let listed = users(&server, &host.access_token, "/users").await;
    assert!(listed.iter().any(|u| u.id == sam.user.id));
}

/// The host can't: the server would have nobody in charge (decision 4).
#[tokio::test]
async fn the_host_cant_delete_their_own_account() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    let resp = delete_me(&server, &host.access_token, "correct horse battery", false).await;
    assert_eq!(resp.status(), 403);
    let body: ErrorEnvelope = resp.json().await.unwrap();
    assert!(
        body.error.message.contains("host"),
        "{}",
        body.error.message
    );
    sign_in_as_host(&server).await;
}

async fn sign_in_as_host(server: &TestServer) {
    let resp = client()
        .post(server.url("/auth/login"))
        .json(&json!({ "username": "matt", "password": "correct horse battery" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "the host still signs in");
}

/// The heart of it: after a delete, nothing about the person is left but the
/// emptied row keeping their name taken. What they wrote stays, nameless,
/// because they didn't tick the box.
#[tokio::test]
async fn a_deleted_account_leaves_nothing_about_them_behind() {
    let Lived {
        server,
        host,
        sam,
        callie,
        room,
        sams,
        ..
    } = lived_in().await;
    let me = sam.user.id;

    let resp = delete_me(&server, &sam.access_token, PASSWORD, false).await;
    assert_eq!(resp.status(), 204, "{}", resp.text().await.unwrap());

    // The row: emptied, marked, and its name still there.
    let row = sqlx::query(
        "SELECT username, display_name, password_hash, time_zone, last_seen_at,
                deactivated_at, deleted_at FROM users WHERE id = ?",
    )
    .bind(me.to_vec())
    .fetch_one(&server.state.db.read)
    .await
    .unwrap();
    let username: String = row.get("username");
    let display_name: String = row.get("display_name");
    let hash: String = row.get("password_hash");
    let tz: Option<String> = row.get("time_zone");
    let seen: Option<i64> = row.get("last_seen_at");
    let deactivated: Option<i64> = row.get("deactivated_at");
    let deleted: Option<i64> = row.get("deleted_at");
    assert_eq!(username, "sam", "the name stays taken");
    assert_eq!(display_name, "");
    assert_eq!(hash, "");
    assert_eq!(tz, None);
    assert_eq!(seen, None);
    assert!(deactivated.is_some() && deleted.is_some());

    // Everything that was theirs alone.
    for (table, column) in [
        ("user_style", "user_id"),
        ("user_status", "user_id"),
        ("user_status_fields", "user_id"),
        ("entrance_sounds", "user_id"),
        ("read_markers", "user_id"),
        ("notify_rules", "user_id"),
        ("notify_rules", "target_user_id"),
        ("blocks", "user_id"),
        ("refresh_tokens", "user_id"),
        ("sign_in_links", "user_id"),
        ("message_nonces", "author_id"),
        ("exports", "user_id"),
    ] {
        assert_eq!(
            rows(&server, table, column, me).await,
            0,
            "{table}.{column} still names them"
        );
    }
    // Their invites stop working.
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invites WHERE created_by = ? AND revoked_at IS NULL",
    )
    .bind(me.to_vec())
    .fetch_one(&server.state.db.read)
    .await
    .unwrap();
    assert_eq!(live, 0);

    // What stays, on purpose: Callie's block of them (her choice not to see
    // what they wrote), and the reports both ways, for the host.
    assert_eq!(rows(&server, "blocks", "blocked_id", me).await, 1);
    assert_eq!(rows(&server, "reports", "reporter_id", me).await, 1);
    assert_eq!(rows(&server, "reports", "user_id", me).await, 1);

    // What they wrote stays, under their id.
    let said = history(&server, &host.access_token, &room.id.to_string()).await;
    let kept = said.iter().find(|m| m.id == sams.id).expect("still there");
    assert_eq!(kept.body, "the secret is under the mat");
    assert!(kept.deleted_at.is_none());

    // Gone from every list, the host's Removed one included: nobody can
    // restore a deleted account.
    assert!(!users(&server, &host.access_token, "/users")
        .await
        .iter()
        .any(|u| u.id == me));
    assert!(!users(&server, &host.access_token, "/users/removed")
        .await
        .iter()
        .any(|u| u.id == me));
    let resp = client()
        .get(server.url(&format!("/users/{me}")))
        .bearer_auth(&callie.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let resp = post_empty(&server, &host.access_token, &format!("/users/{me}/restore")).await;
    assert_eq!(resp.status(), 404);

    // They can't get back in, by password or by an old token.
    let resp = client()
        .post(server.url("/auth/login"))
        .json(&json!({ "username": "sam", "password": PASSWORD }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let resp = client()
        .get(server.url("/me"))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    let resp = client()
        .post(server.url("/auth/refresh"))
        .json(&json!({ "refresh_token": sam.refresh_token }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);

    // And nobody new can take the name and inherit their mentions.
    let invite: Value = client()
        .post(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let resp = client()
        .post(server.url("/auth/register"))
        .json(&json!({
            "invite_code": invite["code"], "username": "sam",
            "display_name": "Not Sam", "password": PASSWORD,
        }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_client_error(),
        "the name is free again: {}",
        resp.status()
    );
}

/// With the box ticked, what they wrote goes too: their messages become
/// tombstones, their files go, and their reactions and votes in open polls
/// come off. A closed poll keeps how it came out.
#[tokio::test]
async fn everything_takes_what_they_wrote_with_them() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let room = make_room(&server, &host.access_token, "porch").await;
    let at = room.id.to_string();

    let file = upload(
        &server,
        &sam.access_token,
        "plans.txt",
        b"meet at nine".to_vec(),
    )
    .await;
    let with_file = say_with(
        &server,
        &sam.access_token,
        &at,
        "the plan, attached",
        &[&file],
    )
    .await;
    let words = say(&server, &sam.access_token, &at, "zanzibar is lovely").await;
    let hosts = say(&server, &host.access_token, &at, "hey sam").await;
    react(&server, &sam.access_token, &hosts, "❤️").await;
    react(&server, &host.access_token, &words, "😂").await;
    let open = ask_poll(&server, &host.access_token, &room, "Which faction?").await;
    let closed = ask_poll(&server, &host.access_token, &room, "Which server?").await;
    vote(&server, &sam.access_token, &open, 0).await;
    vote(&server, &sam.access_token, &closed, 1).await;
    close_poll(&server, &host.access_token, &closed).await;
    // Their own words in a message of the day: host powers, so a co-host's.
    let resp = client()
        .put(server.url(&format!("/users/{}/cohost", sam.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let resp = client()
        .patch(server.url(&format!("/rooms/{}", room.id)))
        .bearer_auth(&sam.access_token)
        .json(&json!({ "motd": "raid at nine" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());

    let (mut watching, _) = connect_ready(&server, &host.access_token).await;
    let resp = delete_me(&server, &sam.access_token, PASSWORD, true).await;
    assert_eq!(resp.status(), 204, "{}", resp.text().await.unwrap());

    let said = history(&server, &host.access_token, &at).await;
    for mine in [&with_file, &words] {
        let gone = said
            .iter()
            .find(|m| m.id == mine.id)
            .expect("a tombstone stays");
        assert!(gone.deleted_at.is_some(), "{} is still there", mine.body);
        assert_eq!(gone.body, "");
        assert!(gone.attachments.is_empty());
        assert!(
            gone.reactions.is_empty(),
            "the reactions on it went with it"
        );
    }
    let hosts_now = said.iter().find(|m| m.id == hosts.id).unwrap();
    assert!(
        hosts_now.reactions.is_empty(),
        "their reaction came off the host's message"
    );
    assert_eq!(hosts_now.body, "hey sam", "nobody else's words are touched");

    let votes = |poll: &Message| {
        let poll = said
            .iter()
            .find(|m| m.id == poll.id)
            .unwrap()
            .poll
            .clone()
            .unwrap();
        poll.choices
            .iter()
            .flat_map(|c| c.voter_ids.clone())
            .collect::<Vec<_>>()
    };
    assert!(votes(&open).is_empty(), "their vote came off the open poll");
    assert_eq!(
        votes(&closed),
        vec![sam.user.id],
        "a closed poll keeps how it came out"
    );

    let rooms: Vec<Room> = client()
        .get(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let room_now = rooms.iter().find(|r| r.id == room.id).unwrap();
    assert!(room_now.motd.is_none(), "their message of the day went");

    // Search can't find their words any more.
    let found: Vec<Value> = client()
        .get(server.url("/search?q=zanzibar"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(found.is_empty(), "{found:?}");

    // Everybody watching is told, without a restart.
    let frames = drain(&mut watching, Duration::from_millis(800)).await;
    let ops: Vec<&str> = frames.iter().filter_map(|f| f["op"].as_str()).collect();
    assert!(
        frames.iter().any(|f| f["op"] == "user.remove"
            && f["d"]["user_id"] == json!(sam.user.id)
            && f["d"]["deleted"] == json!(true)),
        "{ops:?}"
    );
    for mine in [&with_file, &words] {
        assert!(
            frames
                .iter()
                .any(|f| f["op"] == "message.delete" && f["d"]["id"] == json!(mine.id)),
            "{ops:?}"
        );
    }
    assert!(
        frames.iter().any(|f| f["op"] == "reaction.update"
            && f["d"]["message_id"] == json!(hosts.id)
            && f["d"]["count"] == json!(0)),
        "{ops:?}"
    );
    assert!(
        frames
            .iter()
            .any(|f| f["op"] == "message.update" && f["d"]["id"] == json!(open.id)),
        "{ops:?}"
    );
    assert!(
        frames
            .iter()
            .any(|f| f["op"] == "room.update" && f["d"]["id"] == json!(room.id)),
        "{ops:?}"
    );

    // Their file goes from the store too, when the sweep that follows has run.
    let attachment = said
        .iter()
        .find(|m| m.id == with_file.id)
        .unwrap()
        .attachments
        .clone();
    assert!(attachment.is_empty());
    let mut left: i64 = 1;
    for _ in 0..50 {
        left = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = ?")
            .bind(file.id.to_vec())
            .fetch_one(&server.state.db.read)
            .await
            .unwrap();
        if left == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(left, 0, "their file is still stored");
}

/// The app learns who is deleted, at `ready` and as it happens, so it can say
/// "Deleted account" rather than "someone"; and their live sessions end.
#[tokio::test]
async fn everybody_hears_and_their_own_sessions_end() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let dex = join_member(&server, &host.access_token, "dex").await;

    let (mut theirs, _) = connect_ready(&server, &sam.access_token).await;
    let (mut watching, ready) = connect_ready(&server, &host.access_token).await;
    assert_eq!(ready["deleted_users"], json!([]));

    // A removal is not a deletion: no `deleted` on the frame.
    let resp = post_empty(
        &server,
        &host.access_token,
        &format!("/users/{}/remove", dex.user.id),
    )
    .await;
    assert_eq!(resp.status(), 204);
    let frames = drain(&mut watching, Duration::from_millis(300)).await;
    let removed = frames
        .iter()
        .find(|f| f["op"] == "user.remove")
        .expect("user.remove");
    assert!(removed["d"].get("deleted").is_none(), "{removed}");

    let resp = delete_me(&server, &sam.access_token, PASSWORD, false).await;
    assert_eq!(resp.status(), 204);

    let frames = drain(&mut watching, Duration::from_millis(300)).await;
    assert!(frames.iter().any(|f| f["op"] == "user.remove"
        && f["d"]["user_id"] == json!(sam.user.id)
        && f["d"]["deleted"] == json!(true)));
    // Their own socket is hung up on.
    let ended = drain(&mut theirs, Duration::from_millis(500)).await;
    assert!(
        ended.iter().any(|f| f["op"] == "invalid_session"),
        "{ended:?}"
    );

    let (_, ready) = connect_ready(&server, &host.access_token).await;
    assert_eq!(ready["deleted_users"], json!([sam.user.id]));
    let listed = ready["users"].as_array().unwrap();
    assert!(!listed.iter().any(|u| u["id"] == json!(sam.user.id)));
}

/// A group DM gets the line saying they left; a one-to-one DM stays as the
/// friend's conversation; one nobody can read any more is deleted.
#[tokio::test]
async fn their_dms() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let dex = join_member(&server, &host.access_token, "dex").await;

    let dm = |who: Vec<UserId>, token: String| {
        let server = &server;
        async move {
            let resp = client()
                .post(server.url("/dms"))
                .bearer_auth(token)
                .json(&json!({ "user_ids": who }))
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
            resp.json::<Room>().await.unwrap()
        }
    };
    let group = dm(vec![callie.user.id, host.user.id], sam.access_token.clone()).await;
    let pair = dm(vec![callie.user.id], sam.access_token.clone()).await;
    let lonely = dm(vec![dex.user.id], sam.access_token.clone()).await;
    say(
        &server,
        &sam.access_token,
        &group.id.to_string(),
        "group hello",
    )
    .await;
    say(&server, &sam.access_token, &pair.id.to_string(), "just us").await;
    say(&server, &sam.access_token, &lonely.id.to_string(), "hi dex").await;

    // Dex is removed, then Sam deletes: nobody left can read Sam and Dex's DM.
    let resp = post_empty(
        &server,
        &host.access_token,
        &format!("/users/{}/remove", dex.user.id),
    )
    .await;
    assert_eq!(resp.status(), 204);
    let (mut callies, _) = connect_ready(&server, &callie.access_token).await;
    let resp = delete_me(&server, &sam.access_token, PASSWORD, false).await;
    assert_eq!(resp.status(), 204);

    let in_group: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM room_members WHERE room_id = ? AND user_id = ?")
            .bind(group.id.to_vec())
            .bind(sam.user.id.to_vec())
            .fetch_one(&server.state.db.read)
            .await
            .unwrap();
    assert_eq!(in_group, 0, "out of the group");
    let said = history(&server, &callie.access_token, &group.id.to_string()).await;
    assert!(said
        .iter()
        .any(|m| m.left == Some(true) && m.author_id == sam.user.id));
    assert!(
        said.iter().any(|m| m.body == "group hello"),
        "what they said stays"
    );
    let frames = drain(&mut callies, Duration::from_millis(500)).await;
    assert!(
        frames
            .iter()
            .any(|f| f["op"] == "message.create" && f["d"]["left"] == json!(true)),
        "{frames:?}"
    );

    // The one-to-one is still Callie's, with what Sam said in it.
    let said = history(&server, &callie.access_token, &pair.id.to_string()).await;
    assert!(said.iter().any(|m| m.body == "just us"));

    // Sam and Dex's: deleted, the way a DM everybody left is.
    let kept: Vec<(Option<i64>,)> =
        sqlx::query_as("SELECT deleted_at FROM messages WHERE room_id = ?")
            .bind(lonely.id.to_vec())
            .fetch_all(&server.state.db.read)
            .await
            .unwrap();
    assert!(!kept.is_empty() && kept.iter().all(|(at,)| at.is_some()));
    let members: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM room_members WHERE room_id = ?")
        .bind(lonely.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(members, 0);
}

/// The host deletes the account of somebody they removed, who can't sign in
/// to do it. The host only, and only somebody removed.
#[tokio::test]
async fn the_host_deletes_a_removed_persons_account() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let room = make_room(&server, &host.access_token, "porch").await;
    let said = say(&server, &sam.access_token, &room.id.to_string(), "bye all").await;

    let resp = client()
        .put(server.url(&format!("/users/{}/cohost", callie.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Still a member: they delete their own.
    let resp = host_deletes(&server, &host.access_token, sam.user.id, false).await;
    assert_eq!(resp.status(), 422);
    assert_eq!(code_of(resp).await, ErrorCode::ValidationFailed);

    let resp = post_empty(
        &server,
        &host.access_token,
        &format!("/users/{}/remove", sam.user.id),
    )
    .await;
    assert_eq!(resp.status(), 204);

    // A co-host can't; a member can't.
    let resp = host_deletes(&server, &callie.access_token, sam.user.id, false).await;
    assert_eq!(resp.status(), 403);

    let resp = host_deletes(&server, &host.access_token, sam.user.id, true).await;
    assert_eq!(resp.status(), 204, "{}", resp.text().await.unwrap());

    assert!(!users(&server, &host.access_token, "/users/removed")
        .await
        .iter()
        .any(|u| u.id == sam.user.id));
    let deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM users WHERE id = ?")
        .bind(sam.user.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert!(deleted.is_some());
    // The box was ticked on their behalf.
    let history = history(&server, &host.access_token, &room.id.to_string()).await;
    assert!(history
        .iter()
        .find(|m| m.id == said.id)
        .unwrap()
        .deleted_at
        .is_some());

    // Once is all: again is not found, as is a restore.
    let resp = host_deletes(&server, &host.access_token, sam.user.id, false).await;
    assert_eq!(resp.status(), 404);
    let resp = post_empty(
        &server,
        &host.access_token,
        &format!("/users/{}/restore", sam.user.id),
    )
    .await;
    assert_eq!(resp.status(), 404);
    // Nor the host, by this door either.
    let resp = host_deletes(&server, &host.access_token, host.user.id, false).await;
    assert_eq!(resp.status(), 422);
}
