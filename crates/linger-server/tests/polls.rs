//! Polls (SPEC §4.18, PROTOCOL §4, #474): asking one, voting, closing it by
//! hand and on its own, and the line a room gets when it closes. Real HTTP
//! and real sockets against a temp SQLite file, as every endpoint's test is.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{AuthResponse, Message, Room, SearchHit};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SETTLE: Duration = Duration::from_millis(250);

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn faction() -> Value {
    json!({
        "question": "Which faction are we rolling on WoW Forever?",
        "choices": ["Horde", "Alliance", "Don't care"],
        "multi": false,
        "closes_in_days": 7,
    })
}

async fn ask(
    server: &common::TestServer,
    token: &str,
    room: &Room,
    poll: &Value,
) -> reqwest::Response {
    client()
        .post(server.url(&format!("/rooms/{}/polls", room.id)))
        .bearer_auth(token)
        .json(poll)
        .send()
        .await
        .unwrap()
}

async fn asked(server: &common::TestServer, token: &str, room: &Room) -> Message {
    let resp = ask(server, token, room, &faction()).await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn vote(
    server: &common::TestServer,
    token: &str,
    poll: &Message,
    choices: &[u32],
) -> reqwest::Response {
    client()
        .put(server.url(&format!("/messages/{}/vote", poll.id)))
        .bearer_auth(token)
        .json(&json!({ "choices": choices }))
        .send()
        .await
        .unwrap()
}

async fn close(server: &common::TestServer, token: &str, poll: &Message) -> reqwest::Response {
    client()
        .post(server.url(&format!("/messages/{}/close", poll.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

async fn history(server: &common::TestServer, token: &str, room: &Room) -> Vec<Message> {
    client()
        .get(server.url(&format!("/rooms/{}/messages?limit=100", room.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn room_now(server: &common::TestServer, token: &str, room: &Room) -> Room {
    let rooms: Vec<Room> = client()
        .get(server.url("/rooms"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    rooms.into_iter().find(|r| r.id == room.id).unwrap()
}

/// Names on each choice, by user id, in order.
fn voters(poll: &Message) -> Vec<Vec<String>> {
    poll.poll
        .as_ref()
        .expect("a poll")
        .choices
        .iter()
        .map(|choice| choice.voter_ids.iter().map(ToString::to_string).collect())
        .collect()
}

async fn make_cohost(server: &common::TestServer, host: &AuthResponse, who: &AuthResponse) {
    let resp = client()
        .put(server.url(&format!("/users/{}/cohost", who.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.text().await.unwrap());
}

#[tokio::test]
async fn the_host_or_a_co_host_asks_and_nobody_else_can() {
    let (server, host, room) = common::server_with_room("wow").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;

    let poll = asked(&server, &host.access_token, &room).await;
    let held = poll.poll.as_ref().expect("the message carries its poll");
    assert_eq!(
        held.question,
        "Which faction are we rolling on WoW Forever?"
    );
    assert_eq!(
        held.choices
            .iter()
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>(),
        ["Horde", "Alliance", "Don't care"]
    );
    assert!(!held.multi);
    assert!(held.closed_at.is_none());
    let week = held.closes_at - poll.created_at;
    assert_eq!(week, 7 * 24 * 60 * 60 * 1000);
    // An app that doesn't know polls reads it as words.
    assert!(poll.body.contains("Which faction") && poll.body.contains("- Horde"));

    // A member is refused, as with every `/` command.
    assert_eq!(
        ask(&server, &callie.access_token, &room, &faction())
            .await
            .status(),
        403
    );
    // A co-host may.
    make_cohost(&server, &host, &dex).await;
    assert_eq!(
        ask(&server, &dex.access_token, &room, &faction())
            .await
            .status(),
        200
    );

    // A poll makes the room look new, like any message.
    assert!(room_now(&server, &host.access_token, &room)
        .await
        .last_message_id
        .is_some());
}

#[tokio::test]
async fn a_poll_has_a_question_and_two_to_ten_different_choices() {
    let (server, host, room) = common::server_with_room("wow").await;
    let bad = [
        json!({ "question": "  ", "choices": ["a", "b"], "multi": false, "closes_in_days": 7 }),
        json!({ "question": "Q", "choices": ["a"], "multi": false, "closes_in_days": 7 }),
        json!({ "question": "Q", "choices": (0..11).map(|n| n.to_string()).collect::<Vec<_>>(), "multi": false, "closes_in_days": 7 }),
        json!({ "question": "Q", "choices": ["a", " "], "multi": false, "closes_in_days": 7 }),
        json!({ "question": "Q", "choices": ["Horde", "horde"], "multi": false, "closes_in_days": 7 }),
        json!({ "question": "Q", "choices": ["a", "x".repeat(81)], "multi": false, "closes_in_days": 7 }),
        json!({ "question": "x".repeat(301), "choices": ["a", "b"], "multi": false, "closes_in_days": 7 }),
        json!({ "question": "Q", "choices": ["a", "b"], "multi": false, "closes_in_days": 2 }),
    ];
    for poll in &bad {
        assert_eq!(
            ask(&server, &host.access_token, &room, poll).await.status(),
            422,
            "{poll}"
        );
    }
}

#[tokio::test]
async fn a_dm_has_no_polls() {
    let (server, host, _room) = common::server_with_room("wow").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dm: Room = client()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_ids": [callie.user.id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        ask(&server, &host.access_token, &dm, &faction())
            .await
            .status(),
        404
    );
}

#[tokio::test]
async fn everybody_votes_whoever_asked_too_and_can_change_or_take_it_back() {
    let (server, host, room) = common::server_with_room("wow").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let poll = asked(&server, &host.access_token, &room).await;
    let (h, c) = (host.user.id.to_string(), callie.user.id.to_string());

    // Whoever asked votes like anybody.
    let after: Message = vote(&server, &host.access_token, &poll, &[0])
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(voters(&after), [vec![h.clone()], vec![], vec![]]);
    vote(&server, &callie.access_token, &poll, &[1]).await;
    // Changing a vote moves it.
    let after: Message = vote(&server, &callie.access_token, &poll, &[0])
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(voters(&after), [vec![h.clone(), c.clone()], vec![], vec![]]);
    // An empty vote takes it back.
    let after: Message = vote(&server, &callie.access_token, &poll, &[])
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(voters(&after), [vec![h], vec![], vec![]]);

    // Pick-one takes one; no such choice is no vote.
    assert_eq!(
        vote(&server, &callie.access_token, &poll, &[0, 1])
            .await
            .status(),
        422
    );
    assert_eq!(
        vote(&server, &callie.access_token, &poll, &[3])
            .await
            .status(),
        422
    );
    assert_eq!(
        vote(&server, &callie.access_token, &poll, &[1, 1])
            .await
            .status(),
        422
    );

    // Voting never makes the room look new: its newest message is the poll.
    assert_eq!(
        room_now(&server, &host.access_token, &room)
            .await
            .last_message_id,
        Some(poll.id)
    );
}

#[tokio::test]
async fn pick_any_takes_several() {
    let (server, host, room) = common::server_with_room("raid").await;
    let nights = json!({
        "question": "Which nights work for raiding?",
        "choices": ["Tuesday", "Wednesday", "Thursday"],
        "multi": true,
        "closes_in_days": 3,
    });
    let poll: Message = ask(&server, &host.access_token, &room, &nights)
        .await
        .json()
        .await
        .unwrap();
    let after: Message = vote(&server, &host.access_token, &poll, &[2, 0])
        .await
        .json()
        .await
        .unwrap();
    let h = host.user.id.to_string();
    assert_eq!(voters(&after), [vec![h.clone()], vec![], vec![h]]);
}

#[tokio::test]
async fn only_whoever_asked_closes_it_and_the_room_gets_a_quiet_line() {
    let (server, host, room) = common::server_with_room("wow").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;
    make_cohost(&server, &host, &dex).await;
    let poll = asked(&server, &dex.access_token, &room).await;
    vote(&server, &callie.access_token, &poll, &[0]).await;
    vote(&server, &dex.access_token, &poll, &[0]).await;
    vote(&server, &host.access_token, &poll, &[1]).await;
    let newest_before = room_now(&server, &host.access_token, &room)
        .await
        .last_message_id;

    // Not a member, not the host, only whoever asked (Matt, 2026-10-10).
    assert_eq!(
        close(&server, &callie.access_token, &poll).await.status(),
        403
    );
    assert_eq!(
        close(&server, &host.access_token, &poll).await.status(),
        403
    );
    let closed: Message = close(&server, &dex.access_token, &poll)
        .await
        .json()
        .await
        .unwrap();
    let ended = closed.poll.as_ref().unwrap();
    assert!(ended.closed_at.is_some());
    assert_eq!(ended.closed_by, Some(dex.user.id));

    // A line at the bottom of the room says how it came out.
    let held = history(&server, &host.access_token, &room).await;
    let line = held
        .iter()
        .find(|m| m.poll_closed.is_some())
        .expect("a closed line");
    let said = line.poll_closed.as_ref().unwrap();
    assert_eq!(said.poll_id, poll.id);
    assert_eq!(
        said.question,
        "Which faction are we rolling on WoW Forever?"
    );
    assert_eq!(said.winners, ["Horde"]);
    assert_eq!(
        line.body,
        "Poll closed: “Which faction are we rolling on WoW Forever?” Horde won."
    );
    // It never makes the room look new, and can't be edited.
    assert_eq!(
        room_now(&server, &host.access_token, &room)
            .await
            .last_message_id,
        newest_before
    );
    let edit = client()
        .patch(server.url(&format!("/messages/{}", line.id)))
        .bearer_auth(&dex.access_token)
        .json(&json!({ "body": "rewritten" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 422);

    // Closed is closed: no more votes, and no second close or line.
    assert_eq!(
        vote(&server, &callie.access_token, &poll, &[1])
            .await
            .status(),
        422
    );
    assert_eq!(close(&server, &dex.access_token, &poll).await.status(), 422);
    let lines = history(&server, &host.access_token, &room)
        .await
        .into_iter()
        .filter(|m| m.poll_closed.is_some())
        .count();
    assert_eq!(lines, 1);

    // A poll can't be edited, either: votes would point at different words.
    let edit = client()
        .patch(server.url(&format!("/messages/{}", poll.id)))
        .bearer_auth(&dex.access_token)
        .json(&json!({ "body": "different" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edit.status(), 422);
}

#[tokio::test]
async fn every_poll_closes_on_its_own_when_its_time_is_up() {
    let (server, host, room) = common::server_with_room("wow").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let tied = asked(&server, &host.access_token, &room).await;
    vote(&server, &host.access_token, &tied, &[0]).await;
    vote(&server, &callie.access_token, &tied, &[1]).await;
    let nobody = asked(&server, &host.access_token, &room).await;
    let later = asked(&server, &host.access_token, &room).await;

    // Not yet: nothing is due.
    assert_eq!(
        linger_server::polls::close_due(&server.state)
            .await
            .unwrap(),
        0
    );

    // Two of them run out; the third has time left.
    for poll in [&tied, &nobody] {
        sqlx::query("UPDATE polls SET closes_at = ? WHERE message_id = ?")
            .bind(linger_server::db::now_ms() - 1)
            .bind(poll.id.to_vec())
            .execute(&server.state.db.write)
            .await
            .unwrap();
    }
    // Voting in one whose time is up is refused, though the sweeper hasn't been yet.
    assert_eq!(
        vote(&server, &callie.access_token, &tied, &[0])
            .await
            .status(),
        422
    );
    assert_eq!(
        linger_server::polls::close_due(&server.state)
            .await
            .unwrap(),
        2
    );

    let held = history(&server, &host.access_token, &room).await;
    let poll_of = |id| {
        held.iter()
            .find(|m| m.id == id)
            .unwrap()
            .poll
            .clone()
            .unwrap()
    };
    assert!(poll_of(tied.id).closed_at.is_some());
    assert_eq!(poll_of(tied.id).closed_by, None, "closed on its own");
    assert!(poll_of(later.id).closed_at.is_none());
    let lines: Vec<&Message> = held.iter().filter(|m| m.poll_closed.is_some()).collect();
    assert_eq!(lines.len(), 2);
    let words: Vec<&str> = lines.iter().map(|m| m.body.as_str()).collect();
    assert!(
        words
            .iter()
            .any(|w| w.ends_with("Horde and Alliance tied.")),
        "{words:?}"
    );
    assert!(
        words.iter().any(|w| w.ends_with("Nobody voted.")),
        "{words:?}"
    );
    // A second pass finds nothing more to do.
    assert_eq!(
        linger_server::polls::close_due(&server.state)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn a_deleted_poll_is_neither_voted_in_nor_closed() {
    let (server, host, room) = common::server_with_room("wow").await;
    let poll = asked(&server, &host.access_token, &room).await;
    let gone = client()
        .delete(server.url(&format!("/messages/{}", poll.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert!(gone.status().is_success());
    assert_eq!(
        vote(&server, &host.access_token, &poll, &[0])
            .await
            .status(),
        404
    );
    sqlx::query("UPDATE polls SET closes_at = 0")
        .execute(&server.state.db.write)
        .await
        .unwrap();
    assert_eq!(
        linger_server::polls::close_due(&server.state)
            .await
            .unwrap(),
        0
    );
    assert!(history(&server, &host.access_token, &room)
        .await
        .iter()
        .all(|m| m.poll_closed.is_none()));
}

#[tokio::test]
async fn search_finds_a_poll_by_its_question_and_never_its_closed_line() {
    let (server, host, room) = common::server_with_room("wow").await;
    let poll = asked(&server, &host.access_token, &room).await;
    close(&server, &host.access_token, &poll).await;
    let hits: Vec<SearchHit> = client()
        .get(server.url("/search?q=faction"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].message_id, poll.id);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

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

async fn drain(ws: &mut Ws, window: Duration) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(Some(Ok(frame))) = tokio::time::timeout(window, ws.next()).await {
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
    ws.send(WsMessage::Text(
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } })
            .to_string()
            .into(),
    ))
    .await
    .expect("ws send");
    while recv_json(&mut ws).await["op"] != "ready" {}
    ws
}

#[tokio::test]
async fn the_room_sees_each_vote_and_the_close_as_they_happen() {
    let (server, host, room) = common::server_with_room("wow").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let mut watching = connect(&server, &callie.access_token).await;
    drain(&mut watching, SETTLE).await;

    let poll = asked(&server, &host.access_token, &room).await;
    vote(&server, &host.access_token, &poll, &[2]).await;
    close(&server, &host.access_token, &poll).await;
    let frames = drain(&mut watching, SETTLE).await;
    let ops: Vec<&str> = frames.iter().map(|f| f["op"].as_str().unwrap()).collect();
    // Asked; the vote; the poll as it closed, then its line.
    assert_eq!(
        ops,
        [
            "message.create",
            "message.update",
            "message.update",
            "message.create"
        ]
    );
    assert!(frames[0]["d"]["poll"].is_object());
    assert_eq!(
        frames[1]["d"]["poll"]["choices"][2]["voter_ids"],
        json!([host.user.id])
    );
    assert!(frames[2]["d"]["poll"]["closed_at"].is_number());
    assert_eq!(frames[3]["d"]["poll_closed"]["poll_id"], json!(poll.id));
}
