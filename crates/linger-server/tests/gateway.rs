//! Gateway (PROTOCOL §8) against real WebSockets — including the M2 milestone
//! check: a client that loses its socket mid-stream resumes and replays with
//! **no gaps and no duplicates**, verified by sequence-number accounting.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

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

/// Read frames until one matches; returns it plus everything skipped.
async fn wait_for(ws: &mut Ws, op: &str) -> (Value, Vec<Value>) {
    let mut skipped = Vec::new();
    loop {
        let frame = recv_json(ws).await;
        if frame["op"] == op {
            return (frame, skipped);
        }
        skipped.push(frame);
    }
}

/// Collect every frame that arrives inside `window`.
async fn drain_for(ws: &mut Ws, window: Duration) -> Vec<Value> {
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

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(WsMessage::Text(value.to_string().into()))
        .await
        .expect("ws send");
}

/// Full handshake: hello → identify → ready. Returns the socket + session id.
async fn connect_ready(server: &common::TestServer, token: &str) -> (Ws, String) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["op"], "hello");
    assert_eq!(hello["d"]["heartbeat_interval_ms"], 30_000);
    assert!(hello.get("s").is_none(), "hello is a control frame");

    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } }),
    )
    .await;
    let (ready, _) = wait_for(&mut ws, "ready").await;
    assert_eq!(ready["s"], 0, "ready carries sequence 0");
    let session_id = ready["d"]["session_id"]
        .as_str()
        .expect("session id")
        .to_string();
    (ws, session_id)
}

async fn rest_send(server: &common::TestServer, token: &str, room: &str, body: &str) {
    let resp = reqwest::Client::new()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn ready_snapshot_heartbeat_and_message_fanout() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;

    let (mut a, _) = connect_ready(&server, &host.access_token).await;
    let (mut b, _) = connect_ready(&server, &member.access_token).await;

    // B's ready snapshot knows the world: both users, the room.
    // (Cheapest cross-check: re-connect a probe and inspect its ready.)
    let (mut probe, _) = connect_ready(&server, &member.access_token).await;
    // A message sent over REST reaches every connected client.
    rest_send(
        &server,
        &member.access_token,
        &room.id.to_string(),
        "anyone around?",
    )
    .await;
    for ws in [&mut a, &mut b, &mut probe] {
        let (frame, _) = wait_for(ws, "message.create").await;
        assert_eq!(frame["d"]["body"], "anyone around?");
        assert!(frame["s"].as_u64().is_some_and(|s| s >= 1));
    }

    // Heartbeat gets an un-sequenced ack.
    send_json(&mut a, json!({ "op": "heartbeat", "d": { "s": 3 } })).await;
    let (ack, _) = wait_for(&mut a, "heartbeat_ack").await;
    assert!(ack.get("s").is_none());
}

#[tokio::test]
async fn room_focus_enter_leave_occupancy_and_typing_limits() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut a, _) = connect_ready(&server, &host.access_token).await;
    let (mut b, _) = connect_ready(&server, &member.access_token).await;

    // A sits. Everyone gets occupancy + presence; only sitters get room.enter —
    // which includes A itself (the client filters its own entrance at playback).
    send_json(
        &mut a,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    let (own_enter, _) = wait_for(&mut a, "room.enter").await;
    assert_eq!(own_enter["d"]["user_id"], host.user.id.to_string());

    let (occupancy, _) = wait_for(&mut b, "room.occupancy").await;
    assert_eq!(occupancy["d"]["room_id"], room_id.as_str());
    assert_eq!(
        occupancy["d"]["user_ids"],
        json!([host.user.id.to_string()])
    );
    let (presence, skipped) = wait_for(&mut b, "presence.update").await;
    assert_eq!(presence["d"]["state"], "in_room");
    assert!(
        !skipped.iter().any(|f| f["op"] == "room.enter"),
        "B is not in the room and must not hear the entrance"
    );

    // B sits too: A (a sitter) hears B enter.
    send_json(
        &mut b,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    let (enter, _) = wait_for(&mut a, "room.enter").await;
    assert_eq!(enter["d"]["user_id"], member.user.id.to_string());
    assert_eq!(enter["d"]["room_id"], room_id.as_str());

    // Typing is server-limited to 1 per 4s per room.
    send_json(
        &mut b,
        json!({ "op": "typing.start", "d": { "room_id": room_id } }),
    )
    .await;
    send_json(
        &mut b,
        json!({ "op": "typing.start", "d": { "room_id": room_id } }),
    )
    .await;
    let (typing, _) = wait_for(&mut a, "typing").await;
    assert_eq!(typing["d"]["user_id"], member.user.id.to_string());
    let extra = drain_for(&mut a, Duration::from_millis(500)).await;
    assert!(
        !extra.iter().any(|f| f["op"] == "typing"),
        "second typing.start inside 4s must be dropped"
    );

    // B stands up: A hears the leave and the shrunken occupancy.
    send_json(
        &mut b,
        json!({ "op": "room.focus", "d": { "room_id": null } }),
    )
    .await;
    let (leave, _) = wait_for(&mut a, "room.leave").await;
    assert_eq!(leave["d"]["user_id"], member.user.id.to_string());
    let (occupancy, _) = wait_for(&mut a, "room.occupancy").await;
    assert_eq!(
        occupancy["d"]["user_ids"],
        json!([host.user.id.to_string()])
    );
}

/// THE M2 milestone check (ARCHITECTURE §10): forced disconnect mid-stream,
/// then resume replays without gaps or duplicates.
#[tokio::test]
async fn forced_disconnect_then_resume_replays_with_no_gaps_no_duplicates() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut ws, session_id) = connect_ready(&server, &member.access_token).await;

    let mut seen_seqs: Vec<u64> = Vec::new();
    let mut seen_bodies: Vec<String> = Vec::new();
    let track = |frame: &Value, seen_bodies: &mut Vec<String>, seen_seqs: &mut Vec<u64>| {
        if let Some(s) = frame["s"].as_u64() {
            seen_seqs.push(s);
        }
        if frame["op"] == "message.create" {
            seen_bodies.push(frame["d"]["body"].as_str().unwrap_or_default().to_string());
        }
    };

    // Phase 1: four messages arrive live.
    for i in 0..4 {
        rest_send(&server, &host.access_token, &room_id, &format!("live {i}")).await;
    }
    while seen_bodies.len() < 4 {
        let frame = recv_json(&mut ws).await;
        track(&frame, &mut seen_bodies, &mut seen_seqs);
    }
    let last_seen = *seen_seqs.last().expect("saw sequenced frames");

    // Phase 2: the socket dies mid-stream — no close frame, just gone.
    drop(ws);
    for i in 4..8 {
        rest_send(
            &server,
            &host.access_token,
            &room_id,
            &format!("offline {i}"),
        )
        .await;
    }
    // Give the server a beat to notice the dead socket.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Phase 3: resume from the last sequence we actually processed.
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("reconnect");
    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["op"], "hello");
    send_json(
        &mut ws,
        json!({ "op": "resume", "d": {
            "session_id": session_id,
            "token": member.access_token,
            "s": last_seen,
        }}),
    )
    .await;
    let (resumed, _) = wait_for(&mut ws, "resumed").await;
    assert!(
        resumed["d"]["replayed"].as_u64().is_some_and(|n| n >= 4),
        "replay must cover at least the four missed messages, got {resumed}"
    );

    while seen_bodies.len() < 8 {
        let frame = recv_json(&mut ws).await;
        track(&frame, &mut seen_bodies, &mut seen_seqs);
    }

    // Message integrity: all eight, in order, exactly once.
    let expected: Vec<String> = (0..4)
        .map(|i| format!("live {i}"))
        .chain((4..8).map(|i| format!("offline {i}")))
        .collect();
    assert_eq!(
        seen_bodies, expected,
        "messages missing, duplicated, or reordered"
    );

    // Sequence integrity: strictly increasing with NO gaps and NO duplicates
    // across the disconnect. This is the assertion the milestone names.
    for pair in seen_seqs.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "sequence gap or duplicate: {seen_seqs:?}"
        );
    }
}

#[tokio::test]
async fn resume_of_unknown_session_and_bad_identify_are_rejected() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;

    // Unknown session id ⇒ invalid_session: expired ⇒ client re-identifies.
    let (mut ws, _) = connect_async(server.gateway_url()).await.unwrap();
    let _hello = recv_json(&mut ws).await;
    send_json(
        &mut ws,
        json!({ "op": "resume", "d": {
            "session_id": "0000000000000000000000000000000",
            "token": host.access_token, "s": 0
        }}),
    )
    .await;
    let (invalid, _) = wait_for(&mut ws, "invalid_session").await;
    assert_eq!(invalid["d"]["reason"], "expired");

    // Garbage identify token ⇒ invalid_session: unauthenticated.
    let (mut ws, _) = connect_async(server.gateway_url()).await.unwrap();
    let _hello = recv_json(&mut ws).await;
    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": "garbage", "client": "t" } }),
    )
    .await;
    let (invalid, _) = wait_for(&mut ws, "invalid_session").await;
    assert_eq!(invalid["d"]["reason"], "unauthenticated");
}

/// Whether the server has hung up on this socket: reads whatever is waiting,
/// and answers true at a close or the end of the stream, false once it goes
/// quiet.
async fn hung_up(ws: &mut Ws) -> bool {
    loop {
        match tokio::time::timeout(Duration::from_millis(100), ws.next()).await {
            Err(_) => return false,
            Ok(None | Some(Err(_) | Ok(WsMessage::Close(_)))) => return true,
            Ok(Some(Ok(_))) => {}
        }
    }
}

/// #451. After a half-open blip the app has given up on its socket and
/// resumed on a new one, while the server still has the old one open (it
/// would notice after 75 seconds of silence). The resume takes the session
/// over, which ends the old socket; the old socket's cleanup must leave the
/// session on the new one, not hang up on that too.
#[tokio::test]
async fn resuming_while_the_old_socket_is_still_open_keeps_the_new_one() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;

    let (mut old, session_id) = connect_ready(&server, &member.access_token).await;
    let last_seen = drain_for(&mut old, Duration::from_millis(200))
        .await
        .iter()
        .filter_map(|frame| frame["s"].as_u64())
        .max()
        .unwrap_or(0);

    let (mut new, _) = connect_async(server.gateway_url())
        .await
        .expect("reconnect");
    assert_eq!(recv_json(&mut new).await["op"], "hello");
    send_json(
        &mut new,
        json!({ "op": "resume", "d": {
            "session_id": session_id,
            "token": member.access_token,
            "s": last_seen,
        }}),
    )
    .await;
    wait_for(&mut new, "resumed").await;

    assert!(hung_up(&mut old).await, "the replaced socket was left open");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !hung_up(&mut new).await,
        "the old socket's cleanup hung up on the socket that replaced it"
    );
    rest_send(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "still there?",
    )
    .await;
    let (frame, _) = wait_for(&mut new, "message.create").await;
    assert_eq!(frame["d"]["body"], "still there?");
}

/// #451. One of a person's connections drops without a goodbye while their
/// others are fine: a phone and a computer, or a fresh session while the old
/// one waits out its resume window. The session that dropped is the one
/// detached, and the others carry on.
///
/// The bug detached whichever of the person's sessions the server's map
/// listed first, hanging up on a healthy one and leaving the dropped one
/// attached to nothing, its voice seat with it. With four connections a
/// person catches it three times in four; six people make it slip past about
/// one run in four thousand.
#[tokio::test]
async fn dropping_one_connection_leaves_the_same_persons_others_alone() {
    let (server, host, room) = common::server_with_room("garage").await;
    let mut kept = Vec::new();
    for n in 0..6 {
        let person = common::join_member(&server, &host.access_token, &format!("person{n}")).await;
        let (gone, _) = connect_ready(&server, &person.access_token).await;
        let mut others = Vec::new();
        for _ in 0..3 {
            others.push(connect_ready(&server, &person.access_token).await.0);
        }
        drop(gone);
        tokio::time::sleep(Duration::from_millis(100)).await;
        for ws in &mut others {
            assert!(
                !hung_up(ws).await,
                "person {n}: a healthy connection was hung up on when another of theirs dropped"
            );
        }
        kept.extend(others);
    }
    rest_send(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "everyone still here?",
    )
    .await;
    for ws in &mut kept {
        let (frame, _) = wait_for(ws, "message.create").await;
        assert_eq!(frame["d"]["body"], "everyone still here?");
    }
}

/// T-413. A removed member has to *leave the room*, and the socket is the part
/// of that nothing else does: the token is checked once at identify, so an
/// already-open connection keeps receiving every message on the server forever.
#[tokio::test]
async fn removing_a_member_hangs_up_on_them_and_tells_everybody_else() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;

    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;

    let resp = reqwest::Client::new()
        .post(server.url(&format!("/users/{}/remove", member.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // Everybody still here is told, so the card leaves the roster with no reload.
    let (frame, _) = wait_for(&mut watcher, "user.remove").await;
    assert_eq!(frame["d"]["user_id"], member.user.id.to_string());

    // The removed member is told their token is no good...
    let (frame, _) = wait_for(&mut theirs, "invalid_session").await;
    assert_eq!(frame["d"]["reason"], "unauthenticated");

    // ...and the socket actually ends, rather than sitting open and quiet.
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match theirs.next().await {
                None | Some(Err(_)) => return true,
                Some(Ok(WsMessage::Close(_))) => return true,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert_eq!(closed, Ok(true), "the removed member's socket must close");

    // And identifying again does not get them back in.
    let (mut again, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    let hello = recv_json(&mut again).await;
    assert_eq!(hello["op"], "hello");
    send_json(
        &mut again,
        json!({ "op": "identify", "d": { "token": member.access_token, "client": "test/0" } }),
    )
    .await;
    let (frame, _) = wait_for(&mut again, "invalid_session").await;
    assert_eq!(frame["d"]["reason"], "unknown user");
}

#[tokio::test]
async fn a_new_member_shows_up_without_anybody_restarting() {
    let (server, host, room) = common::server_with_room("garage").await;
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    // The host's own "I am around" lands first; clear it so what follows is
    // only what registering caused.
    drain_for(&mut watcher, Duration::from_millis(200)).await;

    // Somebody joins while the host is already connected (T-415).
    let member = common::join_member(&server, &host.access_token, "callie").await;

    let (frame, skipped) = wait_for(&mut watcher, "user.update").await;
    assert_eq!(frame["d"]["id"], member.user.id.to_string());
    assert_eq!(frame["d"]["username"], "callie");
    assert_eq!(frame["d"]["is_host"], false);
    assert!(
        skipped.is_empty(),
        "registering says one thing and nothing else: {skipped:?}"
    );
    assert!(
        drain_for(&mut watcher, Duration::from_millis(300))
            .await
            .is_empty(),
        "and it does not repeat itself"
    );

    // The half that already worked and has to keep working: their dot and the
    // room they are in follow, now that there is a card to hang them on.
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;
    send_json(
        &mut theirs,
        json!({ "op": "room.focus", "d": { "room_id": room.id.to_string() } }),
    )
    .await;
    // Their first frame is `online`; the one worth asserting is the room.
    loop {
        let (presence, _) = wait_for(&mut watcher, "presence.update").await;
        assert_eq!(presence["d"]["user_id"], member.user.id.to_string());
        if presence["d"]["state"] == "in_room" {
            assert_eq!(presence["d"]["room_id"], room.id.to_string());
            break;
        }
    }
}

/// An away message sent over the socket is drawn beside the person's name on
/// everybody's list, so it loses the characters that change the direction of
/// text, as a saved one does (#488).
#[tokio::test]
async fn an_away_message_cannot_turn_itself_around() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": "back \u{202E}krow retfa" } }),
    )
    .await;
    loop {
        let (presence, _) = wait_for(&mut watcher, "presence.update").await;
        if presence["d"]["state"] == "away" {
            assert_eq!(presence["d"]["user_id"], member.user.id.to_string());
            assert_eq!(presence["d"]["away_message"], "back krow retfa");
            break;
        }
    }
}
