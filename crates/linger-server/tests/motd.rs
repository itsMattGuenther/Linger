//! A room's message of the day (#464, PROTOCOL §3) over real HTTP and real
//! WebSockets, against a temporary SQLite file.
//!
//! The host or a co-host sets it with `PATCH /rooms/:id { motd }`, which also
//! writes a line in the room saying so. The line never makes the room look new
//! and can't be edited; clearing it writes nothing.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::limits::MAX_MOTD_CHARS;
use linger_core::wire::{Message, Room};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const MEETING: &str = "We will be meeting on Friday, Oct 9 @ 8PM CDT to discuss faction choice. If available, please plan to attend.";

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn set_motd(
    server: &common::TestServer,
    token: &str,
    room: &Room,
    motd: &str,
) -> reqwest::Response {
    client()
        .patch(server.url(&format!("/rooms/{}", room.id)))
        .bearer_auth(token)
        .json(&json!({ "motd": motd }))
        .send()
        .await
        .unwrap()
}

async fn rooms(server: &common::TestServer, token: &str) -> Vec<Room> {
    client()
        .get(server.url("/rooms"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// The room's messages, newest first, as the raw JSON a client receives.
async fn messages(server: &common::TestServer, token: &str, room: &Room) -> Vec<Value> {
    client()
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn say(server: &common::TestServer, token: &str, room: &Room, body: &str) -> Message {
    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
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

async fn wait_for(ws: &mut Ws, op: &str) -> Value {
    loop {
        let frame = recv_json(ws).await;
        if frame["op"] == op {
            return frame;
        }
    }
}

async fn connect_ready(server: &common::TestServer, token: &str) -> (Ws, Value) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    assert_eq!(recv_json(&mut ws).await["op"], "hello");
    ws.send(WsMessage::Text(
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } })
            .to_string()
            .into(),
    ))
    .await
    .expect("ws send");
    let ready = wait_for(&mut ws, "ready").await;
    (ws, ready)
}

#[tokio::test]
async fn the_host_sets_it_and_a_line_says_so() {
    let (server, host, room) = common::server_with_room("general").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let before = say(
        &server,
        &member.access_token,
        &room,
        "anyone around friday?",
    )
    .await;
    let (mut ws, _) = connect_ready(&server, &member.access_token).await;

    let resp = set_motd(
        &server,
        &host.access_token,
        &room,
        &format!("  {MEETING}  "),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    let set: Room = resp.json().await.unwrap();
    let motd = set.motd.expect("the room has a message of the day");
    assert_eq!(motd.text, MEETING, "trimmed");
    assert_eq!(motd.set_by, host.user.id);

    // Everybody sees it, in the list of rooms and as it happens.
    let listed = rooms(&server, &member.access_token).await;
    assert_eq!(
        listed[0].motd.as_ref().map(|m| m.text.as_str()),
        Some(MEETING)
    );
    let update = wait_for(&mut ws, "room.update").await;
    assert_eq!(update["d"]["motd"]["text"], MEETING);
    let created = wait_for(&mut ws, "message.create").await;
    assert_eq!(created["d"]["motd"], true);
    assert_eq!(created["d"]["body"], MEETING);

    // The line is in the room's history, from whoever set it, at the moment
    // it was set.
    let history = messages(&server, &member.access_token, &room).await;
    assert_eq!(history[0]["motd"], true);
    assert_eq!(history[0]["author_id"], json!(host.user.id));
    assert_eq!(history[0]["created_at"], json!(motd.set_at));
    // Every other message leaves the field out, as it always has.
    assert!(history[1].get("motd").is_none(), "{}", history[1]);

    // And it doesn't make the room look new to anybody: the room's newest
    // message is still the one before it.
    assert_eq!(listed[0].last_message_id, Some(before.id));
}

#[tokio::test]
async fn a_cohost_sets_it_and_a_member_cannot() {
    let (server, host, room) = common::server_with_room("general").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let cohost = common::join_member(&server, &host.access_token, "dave").await;
    let made = client()
        .put(server.url(&format!("/users/{}/cohost", cohost.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(made.status(), 200, "{}", made.text().await.unwrap());

    let refused = set_motd(&server, &member.access_token, &room, MEETING).await;
    assert_eq!(refused.status(), 403);
    assert!(rooms(&server, &host.access_token).await[0].motd.is_none());
    assert!(messages(&server, &host.access_token, &room)
        .await
        .is_empty());

    let set = set_motd(&server, &cohost.access_token, &room, MEETING).await;
    assert_eq!(set.status(), 200, "{}", set.text().await.unwrap());
    let room_now: Room = set.json().await.unwrap();
    assert_eq!(room_now.motd.map(|m| m.set_by), Some(cohost.user.id));
}

#[tokio::test]
async fn it_has_a_length_limit() {
    let (server, host, room) = common::server_with_room("general").await;

    let long = "x".repeat(MAX_MOTD_CHARS + 1);
    let refused = set_motd(&server, &host.access_token, &room, &long).await;
    assert_eq!(refused.status(), 422);
    assert!(messages(&server, &host.access_token, &room)
        .await
        .is_empty());

    // Letters, not bytes: three hundred accented ones are fine.
    let full = "é".repeat(MAX_MOTD_CHARS);
    let set = set_motd(&server, &host.access_token, &room, &full).await;
    assert_eq!(set.status(), 200, "{}", set.text().await.unwrap());
}

/// It's drawn over the room, beside who set it, so it can't turn itself or
/// them around (#488): the characters that turn text around are taken out,
/// from the strip and from its line in the room alike.
#[tokio::test]
async fn it_loses_the_characters_that_turn_text_around() {
    let (server, host, room) = common::server_with_room("general").await;
    let set = set_motd(
        &server,
        &host.access_token,
        &room,
        "raid at \u{202E}8 tonight\u{202C}",
    )
    .await;
    assert_eq!(set.status(), 200, "{}", set.text().await.unwrap());
    let now = rooms(&server, &host.access_token)
        .await
        .into_iter()
        .find(|r| r.id == room.id)
        .unwrap();
    assert_eq!(now.motd.unwrap().text, "raid at 8 tonight");
    let lines = messages(&server, &host.access_token, &room).await;
    assert_eq!(lines[0]["body"], "raid at 8 tonight");
}

#[tokio::test]
async fn the_same_words_again_change_nothing_and_empty_clears_it() {
    let (server, host, room) = common::server_with_room("general").await;

    let first: Room = set_motd(&server, &host.access_token, &room, MEETING)
        .await
        .json()
        .await
        .unwrap();
    let again: Room = set_motd(&server, &host.access_token, &room, MEETING)
        .await
        .json()
        .await
        .unwrap();
    // No second line, and the same moment, so nobody's folded strip opens.
    assert_eq!(first.motd, again.motd);
    assert_eq!(messages(&server, &host.access_token, &room).await.len(), 1);

    let cleared = set_motd(&server, &host.access_token, &room, "   ").await;
    assert_eq!(cleared.status(), 200, "{}", cleared.text().await.unwrap());
    let cleared: Value = cleared.json().await.unwrap();
    // No message of the day is no field at all, as on a room that never had one.
    assert!(cleared.get("motd").is_none(), "{cleared}");
    // Clearing it writes nothing in the room.
    assert_eq!(messages(&server, &host.access_token, &room).await.len(), 1);

    // A topic change leaves it alone.
    set_motd(&server, &host.access_token, &room, MEETING).await;
    let renamed: Room = client()
        .patch(server.url(&format!("/rooms/{}", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "topic": "raid talk" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(renamed.motd.map(|m| m.text), Some(MEETING.to_string()));
}

#[tokio::test]
async fn its_line_cannot_be_edited_but_can_be_deleted() {
    let (server, host, room) = common::server_with_room("general").await;
    set_motd(&server, &host.access_token, &room, MEETING).await;
    let line = messages(&server, &host.access_token, &room).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let edit = client()
        .patch(server.url(&format!("/messages/{line}")))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "We will be meeting on Saturday" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 422);
    assert_eq!(
        messages(&server, &host.access_token, &room).await[0]["body"],
        MEETING
    );

    let delete = client()
        .delete(server.url(&format!("/messages/{line}")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(delete.status(), 204);
}

#[tokio::test]
async fn a_dm_and_an_archived_room_have_none() {
    let (server, host, room) = common::server_with_room("general").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;

    let dm: Room = client()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_ids": [member.user.id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        set_motd(&server, &host.access_token, &dm, MEETING)
            .await
            .status(),
        404
    );

    let archived = client()
        .post(server.url(&format!("/rooms/{}/archive", room.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(archived.status(), 200);
    assert_eq!(
        set_motd(&server, &host.access_token, &room, MEETING)
            .await
            .status(),
        422
    );
}

#[tokio::test]
async fn ready_carries_it() {
    let (server, host, room) = common::server_with_room("general").await;
    set_motd(&server, &host.access_token, &room, MEETING).await;

    let (_ws, ready) = connect_ready(&server, &host.access_token).await;
    let rooms = ready["d"]["rooms"].as_array().expect("ready lists rooms");
    assert_eq!(rooms[0]["motd"]["text"], MEETING);
    // The line alone is no reason for the room to look new.
    assert_eq!(rooms[0]["last_message_id"], Value::Null);
}
