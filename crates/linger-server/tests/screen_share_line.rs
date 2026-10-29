//! The quiet line a room gets when somebody shares their screen in its voice
//! (SPEC §4.20, PROTOCOL §4, #746), and the two rules that keep it from
//! flooding a room, as the line for joining voice has (#473): it is written
//! only once a share has lasted, and at most once per person per room every
//! ten minutes.
//!
//! Real sockets against a real server, as `screen.rs`. The wait is shortened
//! from ten seconds to `WAIT`, and the join line's lengthened out of the way;
//! the ten minutes are tested by moving a stored line back in time, which is
//! what the server counts from.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{Message, Room, SearchHit};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long a share lasts before the line is written, in these tests.
const WAIT: Duration = Duration::from_millis(400);
/// Comfortably past `WAIT`: the line, if there is going to be one, is out.
const PAST_WAIT: Duration = Duration::from_millis(1_200);
/// Long enough for a frame the server was going to send to have arrived.
const SETTLE: Duration = Duration::from_millis(250);

async fn server() -> (common::TestServer, linger_core::wire::AuthResponse, Room) {
    common::voice_server_tuned("garage", |config| {
        config.share_line_after = WAIT;
        // Joining voice writes its own line; not in these tests.
        config.voice_line_after = Duration::from_secs(3_600);
    })
    .await
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

/// Every frame that arrives in the next `span`, and no longer, for "not
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

/// A gateway connection and its session id.
async fn gateway(server: &common::TestServer, token: &str) -> (Ws, String) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    assert_eq!(recv_json(&mut ws).await["op"], "hello");
    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } }),
    )
    .await;
    loop {
        let frame = recv_json(&mut ws).await;
        if frame["op"] == "ready" {
            return (ws, frame["d"]["session_id"].as_str().unwrap().to_string());
        }
    }
}

async fn join_voice(ws: &mut Ws, room: &str) {
    send_json(
        ws,
        json!({ "op": "voice.join", "d": { "room_id": room, "forwarding": true } }),
    )
    .await;
}

/// A share, started: its socket, once the server has taken it.
async fn share(server: &common::TestServer, token: &str, session: &str) -> Ws {
    let url = format!("{}/api/v1/screen", server.base.replace("http://", "ws://"));
    let (mut ws, _) = connect_async(url).await.expect("screen ws");
    let hello =
        json!({"op": "share", "token": token, "session_id": session, "fps": 30, "encode": ["vp8"]});
    ws.send(WsMessage::Text(hello.to_string().into()))
        .await
        .expect("hello");
    assert_eq!(recv_json(&mut ws).await["op"], "want");
    ws
}

/// Stop a share, and give the server a moment to take it off the board.
async fn stop(mut share: Ws) {
    share.close(None).await.expect("close");
    tokio::time::sleep(Duration::from_millis(50)).await;
}

/// The share lines among a batch of frames.
fn share_lines(frames: &[Value]) -> Vec<Message> {
    frames
        .iter()
        .filter(|frame| frame["op"] == "message.create")
        .map(|frame| serde_json::from_value::<Message>(frame["d"].clone()).expect("a message"))
        .filter(|message| message.screen_share == Some(true))
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
async fn sharing_and_keeping_on_puts_a_quiet_line_in_the_room_and_nothing_more() {
    let (server, host, room) = server().await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();
    let (mut watcher, _) = gateway(&server, &host.access_token).await;
    let (mut sharer, session) = gateway(&server, &callie.access_token).await;
    join_voice(&mut sharer, &room_id).await;
    drain(&mut watcher, SETTLE).await;

    let _share = share(&server, &callie.access_token, &session).await;
    // Not yet: a share is only news once it has lasted.
    assert!(share_lines(&frames_for(&mut watcher, WAIT / 2).await).is_empty());

    let lines = share_lines(&drain(&mut watcher, PAST_WAIT).await);
    assert_eq!(lines.len(), 1, "one line once the share has lasted");
    let line = &lines[0];
    assert_eq!(line.author_id, callie.user.id);
    assert_eq!(line.room_id, room.id);
    // Who, and never what: the server doesn't know what's shared.
    assert_eq!(line.body, "shared their screen");
    assert_eq!(line.voice_join, None);

    // It stays in the history, for whoever comes in later.
    let held = history(&server, &host.access_token, &room_id).await;
    assert!(held
        .iter()
        .any(|message| message.id == line.id && message.screen_share == Some(true)));

    // It never makes the room look new.
    let listed = rooms(&server, &host.access_token).await;
    let garage = listed.iter().find(|r| r.id == room.id).unwrap();
    assert_eq!(garage.last_message_id, None);

    // Nobody typed it, so nobody can edit it or react to it.
    let client = reqwest::Client::new();
    let edit = client
        .patch(server.url(&format!("/messages/{}", line.id)))
        .bearer_auth(&callie.access_token)
        .json(&json!({ "body": "rewritten" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 422, "VALIDATION_FAILED");
    let react = client
        .put(server.url(&format!("/messages/{}/reactions/👍", line.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(react.status(), 422, "VALIDATION_FAILED");

    // And search passes over it: "screen" finds nothing.
    let hits: Vec<SearchHit> = client
        .get(server.url("/search?q=screen"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(hits.is_empty(), "search found a share line: {hits:?}");
}

#[tokio::test]
async fn a_share_that_stops_inside_the_wait_leaves_nothing() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let (mut watcher, _) = gateway(&server, &host.access_token).await;
    let (mut sharer, session) = gateway(&server, &host.access_token).await;
    join_voice(&mut sharer, &room_id).await;
    drain(&mut watcher, SETTLE).await;

    // A misclick on Share.
    let first = share(&server, &host.access_token, &session).await;
    tokio::time::sleep(WAIT / 4).await;
    stop(first).await;

    assert!(share_lines(&drain(&mut watcher, PAST_WAIT).await).is_empty());
    assert!(history(&server, &host.access_token, &room_id)
        .await
        .is_empty());
}

#[tokio::test]
async fn stopping_to_pick_another_window_and_sharing_again_writes_one_line() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let (mut watcher, _) = gateway(&server, &host.access_token).await;
    let (mut sharer, session) = gateway(&server, &host.access_token).await;
    join_voice(&mut sharer, &room_id).await;
    drain(&mut watcher, SETTLE).await;

    // Stopping and starting fast: no share lasts the wait.
    for _ in 0..4 {
        let quick = share(&server, &host.access_token, &session).await;
        tokio::time::sleep(WAIT / 8).await;
        stop(quick).await;
    }
    assert!(share_lines(&drain(&mut watcher, PAST_WAIT).await).is_empty());

    // Then keeping on: one line.
    let kept = share(&server, &host.access_token, &session).await;
    assert_eq!(share_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);

    // Picking another window, each share lasting the wait: nothing more,
    // since they already have a line here in the last ten minutes.
    stop(kept).await;
    for _ in 0..2 {
        let again = share(&server, &host.access_token, &session).await;
        tokio::time::sleep(PAST_WAIT).await;
        stop(again).await;
    }
    assert!(share_lines(&drain(&mut watcher, SETTLE).await).is_empty());
    let lines: Vec<Message> = history(&server, &host.access_token, &room_id)
        .await
        .into_iter()
        .filter(|message| message.screen_share == Some(true))
        .collect();
    assert_eq!(lines.len(), 1);
}

#[tokio::test]
async fn after_ten_minutes_a_new_share_is_news_again() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let (mut watcher, _) = gateway(&server, &host.access_token).await;
    let (mut sharer, session) = gateway(&server, &host.access_token).await;
    join_voice(&mut sharer, &room_id).await;
    drain(&mut watcher, SETTLE).await;

    let first = share(&server, &host.access_token, &session).await;
    assert_eq!(share_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);
    stop(first).await;

    // Nine minutes on, it's too soon: move the line back and share again.
    move_lines_back(&server, Duration::from_secs(9 * 60)).await;
    let second = share(&server, &host.access_token, &session).await;
    assert!(share_lines(&drain(&mut watcher, PAST_WAIT).await).is_empty());
    stop(second).await;

    // Eleven minutes on, it isn't.
    move_lines_back(&server, Duration::from_secs(2 * 60)).await;
    let _third = share(&server, &host.access_token, &session).await;
    assert_eq!(share_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);
}

/// Make every share line older by `by`, as if that much time had passed.
async fn move_lines_back(server: &common::TestServer, by: Duration) {
    sqlx::query("UPDATE messages SET created_at = created_at - ? WHERE screen_share = 1")
        .bind(i64::try_from(by.as_millis()).unwrap())
        .execute(&server.state.db.write)
        .await
        .unwrap();
}

#[tokio::test]
async fn two_computers_sharing_together_write_one_line() {
    let (server, host, room) = server().await;
    let room_id = room.id.to_string();
    let (mut watcher, _) = gateway(&server, &host.access_token).await;
    let (mut laptop, laptop_session) = gateway(&server, &host.access_token).await;
    let (mut desktop, desktop_session) = gateway(&server, &host.access_token).await;
    join_voice(&mut laptop, &room_id).await;
    join_voice(&mut desktop, &room_id).await;
    drain(&mut watcher, SETTLE).await;

    let _one = share(&server, &host.access_token, &laptop_session).await;
    let _two = share(&server, &host.access_token, &desktop_session).await;
    assert_eq!(share_lines(&drain(&mut watcher, PAST_WAIT).await).len(), 1);
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
    let (mut sharer, session) = gateway(&server, &host.access_token).await;
    let (mut in_it, _) = gateway(&server, &callie.access_token).await;
    let (mut outside, _) = gateway(&server, &dex.access_token).await;
    join_voice(&mut sharer, &dm.id.to_string()).await;
    drain(&mut in_it, SETTLE).await;
    drain(&mut outside, SETTLE).await;

    let _share = share(&server, &host.access_token, &session).await;
    let lines = share_lines(&drain(&mut in_it, PAST_WAIT).await);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].room_id, dm.id);
    assert!(
        share_lines(&drain(&mut outside, SETTLE).await).is_empty(),
        "somebody outside the DM was told about its share"
    );
}
