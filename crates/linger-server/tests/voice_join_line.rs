//! The quiet line a room gets when somebody joins its voice (SPEC §4.14,
//! PROTOCOL §4, #473), and the two rules that keep it from flooding a room:
//! it is written only once somebody has stayed, and at most once per person
//! per room every ten minutes.
//!
//! Real sockets against a real server, as `voice.rs`. The wait is shortened
//! from ten seconds to `WAIT` so the tests don't sit idle; the ten minutes
//! are tested by moving a stored line back in time, which is what the server
//! counts from.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{Message, Room, SearchHit};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long somebody stays before the line is written, in these tests.
const WAIT: Duration = Duration::from_millis(400);
/// Comfortably past `WAIT`: the line, if there is going to be one, is out.
const PAST_WAIT: Duration = Duration::from_millis(1_200);
/// Long enough for a frame the server was going to send to have arrived.
const SETTLE: Duration = Duration::from_millis(250);

async fn server() -> (common::TestServer, linger_core::wire::AuthResponse, Room) {
    common::voice_server_tuned("garage", |config| config.voice_line_after = WAIT).await
}

async fn recv_json(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5s")
            .expect("socket still open")
            .expect("clean frame");
        if let WsMessage::Text(text) = msg {
            return serde_json::from_str(text.as_str()).expect("valid frame json");
        }
    }
}

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(WsMessage::Text(value.to_string().into()))
        .await
        .expect("ws send");
}

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

/// Every frame that arrives in the next `span`, and no longer: unlike
/// `drain`, a frame arriving late doesn't stretch the window. For "not
/// yet", which a window stretched past `WAIT` would get wrong.
async fn frames_for(ws: &mut Ws, span: Duration) -> Vec<Value> {
    let until = tokio::time::Instant::now() + span;
    let mut frames = Vec::new();
    while let Ok(Some(Ok(frame))) = tokio::time::timeout_at(until, ws.next()).await {
        if let WsMessage::Text(text) = frame {
            frames.push(serde_json::from_str(text.as_str()).expect("valid frame json"));
        }
    }
    frames
}

async fn connect(server: &common::TestServer, token: &str) -> Ws {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    assert_eq!(recv_json(&mut ws).await["op"], "hello");
    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } }),
    )
    .await;
    while recv_json(&mut ws).await["op"] != "ready" {}
    ws
}

async fn join_voice(ws: &mut Ws, room: &str) {
    send_json(
        ws,
        json!({ "op": "voice.join", "d": { "room_id": room, "forwarding": true } }),
    )
    .await;
}

async fn leave_voice(ws: &mut Ws) {
    send_json(ws, json!({ "op": "voice.leave", "d": null })).await;
}

/// The join lines among a batch of frames.
fn join_lines(frames: &[Value]) -> Vec<Message> {
    frames
        .iter()
        .filter(|frame| frame["op"] == "message.create")
        .map(|frame| serde_json::from_value::<Message>(frame["d"].clone()).expect("a message"))
        .filter(|message| message.voice_join == Some(true))
        .collect()
}

async fn history(server: &common::TestServer, token: &str, room: &str) -> Vec<Message> {
    reqwest::Client::new()
        .get(server.url(&format!("/rooms/{room}/messages?limit=100")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn rooms(server: &common::TestServer, token: &str) -> Vec<Room> {
    reqwest::Client::new()
        .get(server.url("/rooms"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn staying_in_voice_puts_a_quiet_line_in_the_room_and_nothing_more() {
    let (server, host, room) = server().await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();
    let mut watcher = connect(&server, &host.access_token).await;
    let mut joiner = connect(&server, &callie.access_token).await;
    drain(&mut watcher, SETTLE).await;

    join_voice(&mut joiner, &room_id).await;
    // Not yet: a join is only news once somebody has stayed.
    assert!(join_lines(&frames_for(&mut watcher, WAIT / 2).await).is_empty());

    let lines = join_lines(&drain(&mut watcher, PAST_WAIT).await);
    assert_eq!(lines.len(), 1, "one line once they've stayed");
    let line = &lines[0];
    assert_eq!(line.author_id, callie.user.id);
    assert_eq!(line.room_id, room.id);
    assert_eq!(line.body, "joined voice");
    assert_eq!(line.motd, None);

    // It stays in the history, for whoever comes in later.
    let held = history(&server, &host.access_token, &room_id).await;
    assert!(held
        .iter()
        .any(|message| message.id == line.id && message.voice_join == Some(true)));

    // It never makes the room look new: the room's newest message is still
    // what it was, which here is nothing at all.
    let listed = rooms(&server, &host.access_token).await;
    let garage = listed.iter().find(|r| r.id == room.id).unwrap();
    assert_eq!(garage.last_message_id, None);

    // Nobody typed it, so nobody can edit it.
    let edit = reqwest::Client::new()
        .patch(server.url(&format!("/messages/{}", line.id)))
        .bearer_auth(&callie.access_token)
        .json(&json!({ "body": "rewritten" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 422, "VALIDATION_FAILED");

    // And search passes over it: "voice" finds nothing.
    let hits: Vec<SearchHit> = reqwest::Client::new()
        .get(server.url("/search?q=voice"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(hits.is_empty(), "search found a join line: {hits:?}");
}

#[tokio::test]
async fn a_join_that_ends_inside_the_wait_leaves_nothing() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let mut watcher = connect(&server, &host.access_token).await;
    let mut joiner = connect(&server, &host.access_token).await;
    drain(&mut watcher, SETTLE).await;

    // A misclick on Join.
    join_voice(&mut joiner, &room_id).await;
    tokio::time::sleep(WAIT / 4).await;
    leave_voice(&mut joiner).await;

    assert!(join_lines(&drain(&mut watcher, PAST_WAIT).await).is_empty());
    assert!(history(&server, &host.access_token, &room_id)
        .await
        .is_empty());
}

#[tokio::test]
async fn joining_and_leaving_over_and_over_writes_one_line() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let mut watcher = connect(&server, &host.access_token).await;
    let mut joiner = connect(&server, &host.access_token).await;
    drain(&mut watcher, SETTLE).await;

    // Flapping fast: no seat lasts the wait, so none of these is news.
    for _ in 0..8 {
        join_voice(&mut joiner, &room_id).await;
        tokio::time::sleep(WAIT / 8).await;
        leave_voice(&mut joiner).await;
        tokio::time::sleep(WAIT / 8).await;
    }
    assert!(join_lines(&drain(&mut watcher, PAST_WAIT).await).is_empty());

    // Then staying: one line.
    join_voice(&mut joiner, &room_id).await;
    assert_eq!(join_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);

    // Flapping slowly, each seat lasting the wait: still nothing more, since
    // they already have a line here in the last ten minutes.
    for _ in 0..3 {
        leave_voice(&mut joiner).await;
        join_voice(&mut joiner, &room_id).await;
        tokio::time::sleep(PAST_WAIT).await;
    }
    assert!(join_lines(&drain(&mut watcher, SETTLE).await).is_empty());
    let lines: Vec<Message> = history(&server, &host.access_token, &room_id)
        .await
        .into_iter()
        .filter(|message| message.voice_join == Some(true))
        .collect();
    assert_eq!(lines.len(), 1);
}

#[tokio::test]
async fn after_ten_minutes_a_new_join_is_news_again() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let mut watcher = connect(&server, &host.access_token).await;
    let mut joiner = connect(&server, &host.access_token).await;
    drain(&mut watcher, SETTLE).await;

    join_voice(&mut joiner, &room_id).await;
    assert_eq!(join_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);

    // Nine minutes on, it's too soon: move the line back and join again.
    move_lines_back(&server, Duration::from_secs(9 * 60)).await;
    leave_voice(&mut joiner).await;
    join_voice(&mut joiner, &room_id).await;
    assert!(join_lines(&drain(&mut watcher, PAST_WAIT).await).is_empty());

    // Eleven minutes on, it isn't.
    move_lines_back(&server, Duration::from_secs(2 * 60)).await;
    leave_voice(&mut joiner).await;
    join_voice(&mut joiner, &room_id).await;
    assert_eq!(join_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);
}

/// Make every join line older by `by`, as if that much time had passed.
async fn move_lines_back(server: &common::TestServer, by: Duration) {
    sqlx::query("UPDATE messages SET created_at = created_at - ? WHERE voice_join = 1")
        .bind(i64::try_from(by.as_millis()).unwrap())
        .execute(&server.state.db.write)
        .await
        .unwrap();
}

#[tokio::test]
async fn two_devices_joining_together_write_one_line() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let mut watcher = connect(&server, &host.access_token).await;
    let mut laptop = connect(&server, &host.access_token).await;
    let mut desktop = connect(&server, &host.access_token).await;
    drain(&mut watcher, SETTLE).await;

    join_voice(&mut laptop, &room_id).await;
    join_voice(&mut desktop, &room_id).await;
    assert_eq!(join_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);
}

#[tokio::test]
async fn moving_voice_to_another_room_is_joining_that_room() {
    let (server, host, room) = server().await;
    let other: Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut watcher = connect(&server, &host.access_token).await;
    let mut joiner = connect(&server, &host.access_token).await;
    drain(&mut watcher, SETTLE).await;

    join_voice(&mut joiner, &room.id.to_string()).await;
    let first = join_lines(&drain(&mut watcher, PAST_WAIT).await);
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].room_id, room.id);

    join_voice(&mut joiner, &other.id.to_string()).await;
    let second = join_lines(&drain(&mut watcher, PAST_WAIT).await);
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].room_id, other.id);
}

#[tokio::test]
async fn a_dms_line_reaches_its_people_and_nobody_else() {
    let (server, host, _room) = server().await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;
    let dm: Room = reqwest::Client::new()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_ids": [callie.user.id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mut joiner = connect(&server, &host.access_token).await;
    let mut in_it = connect(&server, &callie.access_token).await;
    let mut outside = connect(&server, &dex.access_token).await;
    drain(&mut in_it, SETTLE).await;
    drain(&mut outside, SETTLE).await;

    join_voice(&mut joiner, &dm.id.to_string()).await;
    let lines = join_lines(&drain(&mut in_it, PAST_WAIT).await);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].room_id, dm.id);
    assert!(
        join_lines(&drain(&mut outside, SETTLE).await).is_empty(),
        "somebody outside the DM was told about its voice"
    );
}
