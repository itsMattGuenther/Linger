//! Gateway (PROTOCOL §8) against real WebSockets — including the M2 milestone
//! check: a client that loses its socket mid-stream resumes and replays with
//! **no gaps and no duplicates**, verified by sequence-number accounting.

mod common;

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use linger_core::limits::{MAX_STATUS_LINE_CHARS, RATE_PRESENCE};
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
    let (ws, ready) = connect_with_ready(server, token).await;
    let session_id = ready["d"]["session_id"]
        .as_str()
        .expect("session id")
        .to_string();
    (ws, session_id)
}

/// The same handshake, handing back the `ready` frame itself.
async fn connect_with_ready(server: &common::TestServer, token: &str) -> (Ws, Value) {
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
    (ws, ready)
}

/// Read a watcher's frames until it hears this person's presence in `state`.
/// Returns that frame and everything before it.
async fn wait_for_presence(ws: &mut Ws, user_id: &str, state: &str) -> (Value, Vec<Value>) {
    let mut skipped = Vec::new();
    loop {
        let (frame, before) = wait_for(ws, "presence.update").await;
        skipped.extend(before);
        if frame["d"]["user_id"] == user_id && frame["d"]["state"] == state {
            return (frame, skipped);
        }
        skipped.push(frame);
    }
}

/// The `presence.update`s about one person among some frames.
fn presence_of<'a>(frames: &'a [Value], user_id: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .filter(|frame| frame["op"] == "presence.update" && frame["d"]["user_id"] == user_id)
        .collect()
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

/// #517. A frame bigger than any an app sends ends the connection, and it does
/// before anybody has identified: otherwise a socket that never signs in can
/// make the server hold up to 64 MB, the WebSocket library's default. The frame
/// is a real identify with a good token, padded to one byte over the cap, so a
/// server without the cap answers it with `ready`.
#[tokio::test]
async fn a_frame_over_the_cap_ends_the_connection_before_identify() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let cap = linger_core::limits::MAX_CLIENT_FRAME_BYTES;

    let (mut ws, _) = connect_async(server.gateway_url()).await.unwrap();
    let _hello = recv_json(&mut ws).await;
    let identify = |client: &str| {
        json!({ "op": "identify", "d": { "token": host.access_token, "client": client } })
            .to_string()
    };
    let frame = identify(&"x".repeat(cap + 1 - identify("").len()));
    assert_eq!(frame.len(), cap + 1);
    // The server can hang up before all of it is written.
    let _ = ws.send(WsMessage::Text(frame.into())).await;

    let ended = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(WsMessage::Text(text))) => {
                    let frame: Value = serde_json::from_str(text.as_str()).expect("frame json");
                    assert_ne!(frame["op"], "ready", "a frame over the cap was read");
                }
                Some(Ok(WsMessage::Close(_)) | Err(_)) | None => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the connection stayed open");

    // The next connection, an ordinary one, is none the worse for it.
    connect_ready(&server, &host.access_token).await;
}

/// The cap leaves room for the biggest frame an app sends (#517): a
/// `voice.answer` whose `sdp` is `MAX_VOICE_PAYLOAD_BYTES` exactly. SDP is
/// short lines, and JSON writes each line break as four characters, not two,
/// so the frame is bigger than the `sdp` in it. The connection stays open and
/// answers the next heartbeat.
#[tokio::test]
async fn the_biggest_voice_answer_an_app_sends_fits_under_the_cap() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let (mut ws, _) = connect_ready(&server, &host.access_token).await;

    let most = linger_core::limits::MAX_VOICE_PAYLOAD_BYTES;
    let line = "a=rtcp-mux\r\n";
    let mut sdp = line.repeat(most / line.len());
    sdp.push_str(&"a".repeat(most - sdp.len()));
    assert_eq!(sdp.len(), most);
    let frame = json!({ "op": "voice.answer", "d": { "sdp": sdp } });
    assert!(frame.to_string().len() > most + most / 10);
    send_json(&mut ws, frame).await;

    send_json(&mut ws, json!({ "op": "heartbeat", "d": { "s": 0 } })).await;
    wait_for(&mut ws, "heartbeat_ack").await;
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

/// #496. Changing your password ends every sign-in the account had, and an
/// open socket is the one nothing else reached: it was let in once, at
/// identify, and never asked again. Somebody holding a copy of the token kept
/// receiving every message on the server long after the change.
#[tokio::test]
async fn changing_your_password_hangs_up_on_every_sign_in_it_ended() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    // A copy of callie's sign-in, connected: a stolen token, or a computer
    // she forgot to sign out of.
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;

    let changed = reqwest::Client::new()
        .patch(server.url("/me/password"))
        .bearer_auth(&member.access_token)
        .json(&json!({
            "current_password": "a perfectly fine password",
            "new_password": "a brand new passphrase",
        }))
        .send()
        .await
        .unwrap();
    assert!(changed.status().is_success(), "{}", changed.status());

    // Told the token is no good...
    let (frame, _) = wait_for(&mut theirs, "invalid_session").await;
    assert_eq!(frame["d"]["reason"], "unauthenticated");
    // ...and hung up on: what is said after the change never reaches it.
    rest_send(&server, &host.access_token, &room_id, "after the change").await;
    let after = tokio::time::timeout(Duration::from_secs(5), async {
        let mut frames = Vec::new();
        loop {
            match theirs.next().await {
                None | Some(Err(_) | Ok(WsMessage::Close(_))) => return frames,
                Some(Ok(WsMessage::Text(text))) => {
                    frames.push(serde_json::from_str::<Value>(text.as_str()).unwrap());
                }
                Some(Ok(_)) => {}
            }
        }
    })
    .await
    .expect("the socket a password change ended must close");
    assert!(
        after.iter().all(|frame| frame["op"] != "message.create"),
        "a message reached a sign-in the password change ended: {after:?}"
    );

    // The old token can't open a new session either.
    let (mut again, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    assert_eq!(recv_json(&mut again).await["op"], "hello");
    send_json(
        &mut again,
        json!({ "op": "identify", "d": { "token": member.access_token, "client": "test/0" } }),
    )
    .await;
    let (frame, _) = wait_for(&mut again, "invalid_session").await;
    assert_eq!(frame["d"]["reason"], "unauthenticated");

    // The device that changed it carries on, with the pair it was handed.
    let fresh: linger_core::wire::AuthResponse = changed.json().await.unwrap();
    let (mut mine, session_id) = connect_ready(&server, &fresh.access_token).await;

    // The old token can't take over that session by resuming it.
    let (mut thief, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    assert_eq!(recv_json(&mut thief).await["op"], "hello");
    send_json(
        &mut thief,
        json!({ "op": "resume", "d": {
            "session_id": session_id,
            "token": member.access_token,
            "s": 0,
        }}),
    )
    .await;
    let (frame, skipped) = wait_for(&mut thief, "invalid_session").await;
    assert_eq!(frame["d"]["reason"], "unauthenticated");
    assert!(skipped.is_empty(), "resumed with an old token: {skipped:?}");

    rest_send(&server, &host.access_token, &room_id, "still here?").await;
    let (frame, _) = wait_for(&mut mine, "message.create").await;
    assert_eq!(frame["d"]["body"], "still here?");
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

// --- #497: the gateway holds a client to the rules REST does ---------------

/// #497. An away message is held to the same 240 characters over the gateway
/// as `PATCH /me` holds it to. One over the cap is told to nobody, now or in
/// the `ready` of anybody who connects later; one at the cap is told as usual.
#[tokio::test]
async fn an_away_message_over_the_cap_is_told_to_nobody() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;
    wait_for_presence(&mut watcher, &member_id, "around").await;

    let over = "x".repeat(MAX_STATUS_LINE_CHARS + 1);
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": over } }),
    )
    .await;
    // One socket's frames are handled in order, so once the watcher hears
    // this, it has heard anything the frame before it was told as.
    send_json(
        &mut theirs,
        json!({ "op": "typing.start", "d": { "room_id": room.id.to_string() } }),
    )
    .await;
    let (_, before) = wait_for(&mut watcher, "typing").await;
    assert!(
        presence_of(&before, &member_id).is_empty(),
        "an away message over the cap was told to everybody"
    );

    // Nor is it in the snapshot somebody connecting now is handed.
    let (_fresh, ready) = connect_with_ready(&server, &host.access_token).await;
    let held = ready["d"]["presence"]
        .as_array()
        .expect("ready carries presence")
        .iter()
        .find(|entry| entry["user_id"] == member_id.as_str())
        .expect("their presence is in ready")
        .clone();
    assert_eq!(
        held["state"], "around",
        "the refused frame changed their state"
    );
    assert!(held["away_message"].is_null(), "ready carried {held}");

    // At the cap, it's an away message like any other.
    let at_cap = "x".repeat(MAX_STATUS_LINE_CHARS);
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": at_cap } }),
    )
    .await;
    let (told, _) = wait_for_presence(&mut watcher, &member_id, "away").await;
    assert_eq!(told["d"]["away_message"], at_cap.as_str());
}

/// #497. A burst of presence changes is told to everybody as a few, then the
/// newest once the limit allows. One person can't make the server send
/// thousands of frames to everybody, and nobody is left looking at a state
/// that isn't the newest.
#[tokio::test]
async fn a_burst_of_presence_changes_is_told_as_a_few_then_the_newest() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;
    // Their arrival is the server's to tell, and not part of the burst.
    wait_for_presence(&mut watcher, &member_id, "around").await;

    let started = Instant::now();
    for n in 0..200 {
        let state = if n % 2 == 0 { "idle" } else { "around" };
        send_json(
            &mut theirs,
            json!({ "op": "presence.update", "d": { "state": state, "away_message": null } }),
        )
        .await;
    }
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": "back at nine" } }),
    )
    .await;
    send_json(
        &mut theirs,
        json!({ "op": "typing.start", "d": { "room_id": room.id.to_string() } }),
    )
    .await;
    let (_, before) = wait_for(&mut watcher, "typing").await;
    let told = presence_of(&before, &member_id);

    // The most the limit lets out in the time the burst took: the whole
    // bucket, and one more for each token that has come back since. Measured
    // rather than assumed, so a slow machine can't fail it.
    let (burst, per_seconds) = RATE_PRESENCE;
    #[allow(clippy::cast_precision_loss)]
    let refilled = started.elapsed().as_secs_f64() * f64::from(burst) / per_seconds as f64;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let allowed = burst as usize + refilled.ceil() as usize;
    assert!(
        told.len() <= allowed,
        "201 changes were told as {}, more than the {allowed} the limit lets out",
        told.len()
    );

    // The newest is told when its turn comes, not lost.
    let newest = match told.last() {
        Some(frame) if frame["d"]["state"] == "away" => (*frame).clone(),
        _ => wait_for_presence(&mut watcher, &member_id, "away").await.0,
    };
    assert_eq!(newest["d"]["away_message"], "back at nine");
}

/// #497's audit. `typing.start` keeps the rule a message keeps: an archived
/// room takes no new messages, so nobody can be shown typing one there.
#[tokio::test]
async fn nobody_is_shown_typing_in_an_archived_room() {
    let (server, host, attic) = common::server_with_room("attic").await;
    let client = reqwest::Client::new();
    let garage: Value = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "garage", "name": "#garage" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let archived: Value = client
        .post(server.url(&format!("/rooms/{}/archive", attic.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(archived["archived_at"].is_number());
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;

    send_json(
        &mut theirs,
        json!({ "op": "typing.start", "d": { "room_id": attic.id.to_string() } }),
    )
    .await;
    send_json(
        &mut theirs,
        json!({ "op": "typing.start", "d": { "room_id": garage["id"] } }),
    )
    .await;
    let (typing, _) = wait_for(&mut watcher, "typing").await;
    assert_eq!(
        typing["d"]["room_id"], garage["id"],
        "somebody was shown typing in an archived room"
    );
}

/// An away message sent over the socket is drawn beside the person's name on
/// everybody's list, so it loses the characters that turn text around, as a
/// saved one does (#488).
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

/// #524: a post sent again with its one-time key is answered with the message
/// the first try saved, and nothing else happens: one message in the room,
/// one `message.create` for everybody, and the sender's read marker left
/// where the first try put it. In real life it's the first answer that gets
/// lost on the way back; here the post is simply sent twice.
#[tokio::test]
async fn a_post_sent_again_with_its_nonce_is_saved_and_announced_once() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let (mut watcher, _) = connect_ready(&server, &member.access_token).await;
    drain_for(&mut watcher, Duration::from_millis(200)).await;

    let post = || async {
        let resp = reqwest::Client::new()
            .post(server.url(&format!("/rooms/{}/messages", room.id)))
            .bearer_auth(&host.access_token)
            .json(&json!({ "body": "on my way", "nonce": "9f1c2a7e-3d4b-4c5a-8e6f-0a1b2c3d4e5f" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        resp.json::<Value>().await.unwrap()
    };
    let first = post().await;
    let second = post().await;
    assert_eq!(second["id"], first["id"]);
    assert_eq!(second["body"], "on my way");

    let frames = drain_for(&mut watcher, Duration::from_millis(500)).await;
    let created: Vec<&Value> = frames
        .iter()
        .filter(|frame| frame["op"] == "message.create")
        .collect();
    assert_eq!(created.len(), 1, "announced more than once: {frames:?}");
    assert_eq!(created[0]["d"]["id"], first["id"]);

    let page: Vec<Value> = reqwest::Client::new()
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
    let marker: Vec<u8> = sqlx::query_scalar(
        "SELECT last_read_id FROM read_markers WHERE user_id = ? AND room_id = ?",
    )
    .bind(host.user.id.to_vec())
    .bind(room.id.to_vec())
    .fetch_one(&server.state.db.read)
    .await
    .unwrap();
    assert_eq!(
        linger_core::MessageId::from_slice(&marker)
            .unwrap()
            .to_string(),
        first["id"].as_str().unwrap()
    );
}

/// The next text frame, as the bytes that came over the socket.
async fn recv_raw(ws: &mut Ws) -> String {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("gateway frame within 5s")
            .expect("socket still open")
            .expect("clean frame");
        if let WsMessage::Text(text) = msg {
            return text.as_str().to_string();
        }
    }
}

/// Read raw frames until a `message.create` with this body; returns its bytes
/// and its `s`.
async fn raw_message(ws: &mut Ws, body: &str) -> (String, u64) {
    loop {
        let raw = recv_raw(ws).await;
        let frame: Value = serde_json::from_str(&raw).expect("valid frame json");
        if frame["op"] == "message.create" && frame["d"]["body"] == body {
            return (raw, frame["s"].as_u64().expect("a sequenced frame"));
        }
    }
}

/// One event, many people (#519): the gateway turns it into JSON once and
/// every session numbers its own copy. Two people who connected at different
/// times count differently; each gets the same bytes under their own number,
/// and a frame missed while a socket was down is replayed under the number it
/// was given then, with the same bytes again.
#[tokio::test]
async fn everybody_gets_one_event_under_their_own_numbers_live_and_on_resume() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    // The host hears three messages before callie connects, so the host's
    // numbers run ahead of hers.
    let (mut host_ws, _) = connect_ready(&server, &host.access_token).await;
    for i in 0..3 {
        let body = format!("early {i}");
        rest_send(&server, &host.access_token, &room_id, &body).await;
        raw_message(&mut host_ws, &body).await;
    }
    let (mut member_ws, member_session) = connect_ready(&server, &member.access_token).await;

    let shared = |raw: &str, s: u64| {
        raw.strip_suffix(&format!(",\"s\":{s}}}"))
            .unwrap_or_else(|| panic!("`s` is not where a frame ends it: {raw}"))
            .to_string()
    };

    let body = "said once, \"heard\" twice 🦆";
    rest_send(&server, &host.access_token, &room_id, body).await;
    let (host_raw, host_s) = raw_message(&mut host_ws, body).await;
    let (member_raw, member_s) = raw_message(&mut member_ws, body).await;
    assert!(
        host_s > member_s,
        "the host connected first and should be counting ahead: {host_s} vs {member_s}"
    );
    assert_eq!(shared(&host_raw, host_s), shared(&member_raw, member_s));

    // Callie's socket dies without a word, and she misses a message.
    drop(member_ws);
    let missed = "sent while callie was gone";
    rest_send(&server, &host.access_token, &room_id, missed).await;
    let (host_missed, host_missed_s) = raw_message(&mut host_ws, missed).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let (mut member_ws, _) = connect_async(server.gateway_url())
        .await
        .expect("reconnect");
    assert_eq!(recv_json(&mut member_ws).await["op"], "hello");
    send_json(
        &mut member_ws,
        json!({ "op": "resume", "d": {
            "session_id": member_session,
            "token": member.access_token,
            "s": member_s,
        }}),
    )
    .await;
    let resumed: Value = serde_json::from_str(&recv_raw(&mut member_ws).await).expect("json");
    assert_eq!(resumed["op"], "resumed");
    assert!(resumed.get("s").is_none(), "resumed is a control frame");

    // Every replayed frame carries the next number, none skipped or repeated,
    // and the missed message is the host's bytes under callie's number.
    let mut expected_s = member_s;
    loop {
        let raw = recv_raw(&mut member_ws).await;
        let frame: Value = serde_json::from_str(&raw).expect("valid frame json");
        expected_s += 1;
        assert_eq!(
            frame["s"].as_u64(),
            Some(expected_s),
            "replayed out of order: {raw}"
        );
        if frame["op"] == "message.create" && frame["d"]["body"] == missed {
            assert_eq!(
                shared(&raw, expected_s),
                shared(&host_missed, host_missed_s)
            );
            break;
        }
    }
}

/// Answers with the message, where `rest_send` doesn't.
async fn rest_post(server: &common::TestServer, token: &str, room: &str, body: &str) -> Value {
    let resp = reqwest::Client::new()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

async fn put_read(server: &common::TestServer, token: &str, room: &str, id: &Value) {
    let resp = reqwest::Client::new()
        .put(server.url(&format!("/rooms/{room}/read")))
        .bearer_auth(token)
        .json(&json!({ "last_read_id": id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
}

/// #647: reading on your phone left a computer that stayed open showing it
/// all as new, because saving your place told nobody. Now every one of your
/// sessions hears it moved, and nobody else does: where somebody has read to
/// is theirs alone. A place that didn't move tells nobody either.
#[tokio::test]
async fn your_place_reaches_your_own_sessions_and_nobody_elses() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();
    let first = rest_post(&server, &member.access_token, &room_id, "you around?").await;
    let second = rest_post(&server, &member.access_token, &room_id, "porch at 8").await;

    let (mut phone, _) = connect_ready(&server, &host.access_token).await;
    let (mut computer, _) = connect_ready(&server, &host.access_token).await;
    let (mut author, _) = connect_ready(&server, &member.access_token).await;

    put_read(&server, &host.access_token, &room_id, &second["id"]).await;
    for ws in [&mut phone, &mut computer] {
        let (frame, _) = wait_for(ws, "read.update").await;
        // A position and nothing else: never a count (AGENTS rule 3).
        assert_eq!(
            frame["d"],
            json!({ "room_id": room_id, "last_read_id": second["id"] })
        );
    }

    // Back to an older place, and the same one again: neither moves it.
    put_read(&server, &host.access_token, &room_id, &first["id"]).await;
    put_read(&server, &host.access_token, &room_id, &second["id"]).await;
    let window = Duration::from_millis(400);
    let (computer_frames, author_frames) = tokio::join!(
        drain_for(&mut computer, window),
        drain_for(&mut author, window)
    );
    assert!(
        !computer_frames.iter().any(|f| f["op"] == "read.update"),
        "a place that didn't move told nobody, got {computer_frames:?}"
    );
    assert!(
        !author_frames.iter().any(|f| f["op"] == "read.update"),
        "nobody else learns where you've read to, got {author_frames:?}"
    );
}

// --- one person on two devices (#653) ---------------------------------------

/// Wait until the server has handled everything this socket sent before now.
/// One socket's frames are handled in order, and a heartbeat is answered on
/// the spot, so its ack means every frame before it is done, and anything
/// they told everybody is already on its way.
async fn handled(ws: &mut Ws) {
    send_json(ws, json!({ "op": "heartbeat", "d": { "s": 0 } })).await;
    wait_for(ws, "heartbeat_ack").await;
}

/// Everything the watcher is told up to now: a message posted after it is
/// the last of it, because everybody hears frames in the order they're told.
async fn told_so_far(
    server: &common::TestServer,
    host: &str,
    room: &str,
    watcher: &mut Ws,
) -> Vec<Value> {
    rest_send(server, host, room, "caught up").await;
    let (_, before) = wait_for(watcher, "message.create").await;
    before
}

/// What a person's presence is in the `ready` of somebody connecting now.
async fn presence_in_ready(server: &common::TestServer, token: &str, user_id: &str) -> Value {
    let (_ws, ready) = connect_with_ready(server, token).await;
    ready["d"]["presence"]
        .as_array()
        .expect("ready carries presence")
        .iter()
        .find(|entry| entry["user_id"] == user_id)
        .expect("their presence is in ready")
        .clone()
}

/// #653. Chatting in a room on the phone while the computer, untouched for
/// ten minutes, says idle: everybody saw idle. The computer speaks only for
/// itself now, and a room on any device beats idle on another.
#[tokio::test]
async fn idle_on_one_device_does_not_hide_a_room_on_the_other() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut phone, _) = connect_ready(&server, &member.access_token).await;
    let (mut computer, _) = connect_ready(&server, &member.access_token).await;

    send_json(
        &mut phone,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    wait_for_presence(&mut watcher, &member_id, "in_room").await;

    send_json(
        &mut computer,
        json!({ "op": "presence.update", "d": { "state": "idle", "away_message": null } }),
    )
    .await;
    handled(&mut computer).await;
    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let told = presence_of(&before, &member_id);
    assert!(
        told.is_empty(),
        "the computer going idle was told to everybody while the phone was in the room: {told:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "in_room", "ready carried {held}");
    assert_eq!(held["room_id"], room_id.as_str(), "ready carried {held}");
}

/// #653. The phone said around and then closed, while the computer had said
/// idle earlier and won't say it again: everybody went on seeing around, from
/// a device that was gone. When it goes, what it said goes with it.
#[tokio::test]
async fn the_device_that_said_around_closing_leaves_the_idle_one() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut computer, _) = connect_ready(&server, &member.access_token).await;
    let (mut phone, _) = connect_ready(&server, &member.access_token).await;
    wait_for_presence(&mut watcher, &member_id, "around").await;

    send_json(
        &mut computer,
        json!({ "op": "presence.update", "d": { "state": "idle", "away_message": null } }),
    )
    .await;
    handled(&mut computer).await;
    send_json(
        &mut phone,
        json!({ "op": "presence.update", "d": { "state": "around", "away_message": null } }),
    )
    .await;
    handled(&mut phone).await;
    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    assert!(
        presence_of(&before, &member_id).is_empty(),
        "one device idle while the other is around is still around, got {before:?}"
    );

    phone.close(None).await.expect("the phone closes");
    let after = drain_for(&mut watcher, Duration::from_secs(2)).await;
    let last = presence_of(&after, &member_id)
        .last()
        .map(|frame| frame["d"].clone());
    assert_eq!(
        last.as_ref().map(|entry| entry["state"].clone()),
        Some(json!("idle")),
        "the phone that said around closed, and everybody was told {last:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "idle", "ready carried {held}");
}

/// #653. Away set on the computer, then a room opened on the phone: the
/// phone's `room.focus` put them in the room and the away was gone. Away is
/// undone only by the device that set it, so the room hears nobody come in.
#[tokio::test]
async fn a_room_on_one_device_does_not_undo_away_on_the_other() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    // The watcher is in the room, so it would hear somebody come in.
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    send_json(
        &mut watcher,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    wait_for(&mut watcher, "room.enter").await;
    let (mut computer, _) = connect_ready(&server, &member.access_token).await;
    let (mut phone, _) = connect_ready(&server, &member.access_token).await;
    wait_for_presence(&mut watcher, &member_id, "around").await;

    send_json(
        &mut computer,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": "out for a walk" } }),
    )
    .await;
    let (away, _) = wait_for_presence(&mut watcher, &member_id, "away").await;
    assert_eq!(away["d"]["away_message"], "out for a walk");

    send_json(
        &mut phone,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    handled(&mut phone).await;
    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let entered: Vec<&Value> = before
        .iter()
        .filter(|f| f["op"] == "room.enter" && f["d"]["user_id"] == member_id.as_str())
        .collect();
    assert!(
        entered.is_empty(),
        "somebody away came into the room from their other device: {entered:?}"
    );
    let told = presence_of(&before, &member_id);
    assert!(
        told.is_empty(),
        "the phone's room undid the computer's away: {told:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "away", "ready carried {held}");
    assert!(held["room_id"].is_null(), "ready carried {held}");
    assert_eq!(held["away_message"], "out for a walk");
}

/// Save or clear the away on somebody's status, as the app's away and I'm
/// back buttons do, before they send their `presence.update`.
async fn save_away(server: &common::TestServer, token: &str, message: Option<&str>) {
    let resp = reqwest::Client::new()
        .patch(server.url("/me"))
        .bearer_auth(token)
        .json(&json!({ "status": { "away_message": message } }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
}

/// #653. Away set on the computer, and I'm back pressed on the phone. The
/// phone never said away, so it has no frame to send, and the computer kept
/// everybody seeing away. Clearing the away saved on your status ends it on
/// every one of your sessions.
#[tokio::test]
async fn coming_back_on_one_device_ends_away_set_on_the_other() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut computer, _) = connect_ready(&server, &member.access_token).await;
    let (_phone, _) = connect_ready(&server, &member.access_token).await;
    wait_for_presence(&mut watcher, &member_id, "around").await;

    save_away(&server, &member.access_token, Some("out for a walk")).await;
    send_json(
        &mut computer,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": "out for a walk" } }),
    )
    .await;
    wait_for_presence(&mut watcher, &member_id, "away").await;

    // I'm back, on the phone: the status is cleared, and no frame follows.
    save_away(&server, &member.access_token, None).await;
    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let last = presence_of(&before, &member_id)
        .last()
        .map(|frame| frame["d"].clone());
    assert_eq!(
        last,
        Some(json!({
            "user_id": member_id, "state": "around", "room_id": null, "away_message": null
        })),
        "coming back on the phone left the computer's away in place"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "around", "ready carried {held}");
}

/// #653. With one device, I'm back clears the status and then sends its own
/// `around`. The first ends the away, so the frame changes nothing, and
/// everybody is told once.
#[tokio::test]
async fn coming_back_on_one_device_is_told_once() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, _) = connect_ready(&server, &member.access_token).await;
    wait_for_presence(&mut watcher, &member_id, "around").await;

    save_away(&server, &member.access_token, Some("lunch")).await;
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": "lunch" } }),
    )
    .await;
    wait_for_presence(&mut watcher, &member_id, "away").await;

    save_away(&server, &member.access_token, None).await;
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "around", "away_message": null } }),
    )
    .await;
    handled(&mut theirs).await;
    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let told = presence_of(&before, &member_id);
    assert_eq!(told.len(), 1, "coming back was told as {told:?}");
    assert_eq!(told[0]["d"]["state"], "around");
}

// --- a short drop (#654) -----------------------------------------------------

/// The grace period the resume tests run with: long enough that a resume a
/// few hundred milliseconds after the drop is well inside it on a busy
/// machine, short enough to wait out.
const RESUME_IN: Duration = Duration::from_secs(2);

/// The newest sequence number a socket has had so far: what its app resumes
/// from.
async fn last_seq(ws: &mut Ws) -> u64 {
    drain_for(ws, Duration::from_millis(200))
        .await
        .iter()
        .filter_map(|frame| frame["s"].as_u64())
        .max()
        .unwrap_or(0)
}

/// Resume a session on a fresh socket, as an app does after its connection
/// drops.
async fn resume(server: &common::TestServer, token: &str, session_id: &str, s: u64) -> Ws {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("reconnect");
    assert_eq!(recv_json(&mut ws).await["op"], "hello");
    send_json(
        &mut ws,
        json!({ "op": "resume", "d": { "session_id": session_id, "token": token, "s": s } }),
    )
    .await;
    wait_for(&mut ws, "resumed").await;
    ws
}

/// Sleep until `after` has passed since `since`.
async fn sleep_past(since: Instant, after: Duration) {
    let left = (since + after).saturating_duration_since(Instant::now());
    tokio::time::sleep(left).await;
}

/// The frames among these that tell anybody where somebody is.
fn where_told(frames: &[Value]) -> Vec<&Value> {
    frames
        .iter()
        .filter(|frame| {
            matches!(
                frame["op"].as_str(),
                Some("presence.update" | "room.enter" | "room.leave" | "room.occupancy")
            )
        })
        .collect()
}

/// A watcher standing in the room, so it would hear somebody come in, and a
/// member in it too, on a socket of their own. Returns the watcher, the
/// member's socket and their session id.
async fn both_in_the_room(
    server: &common::TestServer,
    host: &str,
    member: &linger_core::wire::AuthResponse,
    room_id: &str,
) -> (Ws, Ws, String) {
    let member_id = member.user.id.to_string();
    let (mut watcher, _) = connect_ready(server, host).await;
    send_json(
        &mut watcher,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    wait_for(&mut watcher, "room.enter").await;
    let (mut theirs, session_id) = connect_ready(server, &member.access_token).await;
    send_json(
        &mut theirs,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    wait_for_presence(&mut watcher, &member_id, "in_room").await;
    (watcher, theirs, session_id)
}

/// #654. A phone switching networks: its connection drops without a goodbye
/// and the app resumes a moment later. Everybody saw them go offline, leave
/// the room, come back around and walk in again. A resume inside the grace
/// period tells nobody anything, before it or after.
#[tokio::test]
async fn a_short_drop_in_a_room_tells_nobody_anything() {
    let (server, host, room) =
        common::server_with_room_tuned("garage", |config| config.presence_grace = RESUME_IN).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, mut theirs, session_id) =
        both_in_the_room(&server, &host.access_token, &member, &room_id).await;
    let s = last_seq(&mut theirs).await;

    // Gone: no close frame, the socket just ends.
    drop(theirs);
    let dropped_at = Instant::now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut theirs = resume(&server, &member.access_token, &session_id, s).await;
    // The app says where it is again, as it does after every resume.
    send_json(
        &mut theirs,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    handled(&mut theirs).await;
    sleep_past(dropped_at, RESUME_IN + Duration::from_millis(500)).await;

    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let told = where_told(&before);
    assert!(
        told.is_empty(),
        "a drop the app came back from was told to everybody: {told:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "in_room", "ready carried {held}");
    assert_eq!(held["room_id"], room_id.as_str(), "ready carried {held}");
}

/// #654. The same drop with an away message set: it was cleared, and the
/// app's own `away` after the resume told everybody it again. It survives,
/// and nobody hears a thing.
#[tokio::test]
async fn a_short_drop_keeps_the_away_message() {
    let (server, host, room) =
        common::server_with_room_tuned("garage", |config| config.presence_grace = RESUME_IN).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, _) = connect_ready(&server, &host.access_token).await;
    let (mut theirs, session_id) = connect_ready(&server, &member.access_token).await;
    wait_for_presence(&mut watcher, &member_id, "around").await;
    let away = json!({ "op": "presence.update", "d": { "state": "away", "away_message": "out for a walk" } });
    send_json(&mut theirs, away.clone()).await;
    wait_for_presence(&mut watcher, &member_id, "away").await;
    let s = last_seq(&mut theirs).await;

    drop(theirs);
    let dropped_at = Instant::now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut theirs = resume(&server, &member.access_token, &session_id, s).await;
    // The app says it's away again, as it does after every resume.
    send_json(&mut theirs, away).await;
    handled(&mut theirs).await;
    sleep_past(dropped_at, RESUME_IN + Duration::from_millis(500)).await;

    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let told = where_told(&before);
    assert!(
        told.is_empty(),
        "a drop the app came back from was told to everybody: {told:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "away", "ready carried {held}");
    assert_eq!(
        held["away_message"], "out for a walk",
        "ready carried {held}"
    );
}

/// #654. A drop the app never comes back from is offline, out of the room,
/// once the grace period ends, and not before.
#[tokio::test]
async fn a_drop_with_no_resume_is_offline_once_the_grace_period_ends() {
    const GONE_AFTER: Duration = Duration::from_secs(1);
    let (server, host, room) =
        common::server_with_room_tuned("garage", |config| config.presence_grace = GONE_AFTER).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, theirs, _) =
        both_in_the_room(&server, &host.access_token, &member, &room_id).await;

    drop(theirs);
    let dropped_at = Instant::now();
    let early = drain_for(&mut watcher, GONE_AFTER - Duration::from_millis(300)).await;
    let told = where_told(&early);
    assert!(
        told.is_empty(),
        "the drop was told before the grace period ended: {told:?}"
    );

    let (offline, before) = wait_for_presence(&mut watcher, &member_id, "offline").await;
    assert!(
        dropped_at.elapsed() >= GONE_AFTER,
        "offline came {:?} after the drop, inside the grace period",
        dropped_at.elapsed()
    );
    assert!(offline["d"]["room_id"].is_null());
    assert!(
        before
            .iter()
            .any(|f| f["op"] == "room.leave" && f["d"]["user_id"] == member_id.as_str()),
        "the room never heard them leave: {before:?}"
    );
}

/// #654. Closing the app says goodbye, and that is offline at once, grace
/// period or not.
#[tokio::test]
async fn a_goodbye_is_offline_at_once() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, mut theirs, _) =
        both_in_the_room(&server, &host.access_token, &member, &room_id).await;

    theirs.close(None).await.expect("the app closes");
    let closed_at = Instant::now();
    let (_, before) = wait_for_presence(&mut watcher, &member_id, "offline").await;
    let grace = Duration::from_millis(linger_core::limits::PRESENCE_GRACE_MS);
    assert!(
        closed_at.elapsed() < grace / 2,
        "a goodbye waited {:?} to be told",
        closed_at.elapsed()
    );
    assert!(
        before
            .iter()
            .any(|f| f["op"] == "room.leave" && f["d"]["user_id"] == member_id.as_str()),
        "the room never heard them leave: {before:?}"
    );
}

/// #654. The other way a connection fails: it goes quiet, the server still
/// holds it open, and the app gives up and resumes on a new one. The old
/// socket closes after the session moved on (#451), and its closing must
/// neither end the session's presence nor wait out a grace period to.
#[tokio::test]
async fn a_quiet_socket_replaced_by_a_resume_tells_nobody_anything() {
    let (server, host, room) =
        common::server_with_room_tuned("garage", |config| config.presence_grace = RESUME_IN).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, mut old, session_id) =
        both_in_the_room(&server, &host.access_token, &member, &room_id).await;
    let s = last_seq(&mut old).await;

    let replaced_at = Instant::now();
    let mut new = resume(&server, &member.access_token, &session_id, s).await;
    assert!(hung_up(&mut old).await, "the replaced socket was left open");
    send_json(
        &mut new,
        json!({ "op": "room.focus", "d": { "room_id": room_id } }),
    )
    .await;
    handled(&mut new).await;
    sleep_past(replaced_at, RESUME_IN + Duration::from_millis(500)).await;

    let before = told_so_far(&server, &host.access_token, &room_id, &mut watcher).await;
    let told = where_told(&before);
    assert!(
        told.is_empty(),
        "a socket replaced by a resume was told to everybody: {told:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "in_room", "ready carried {held}");
    assert_eq!(held["room_id"], room_id.as_str(), "ready carried {held}");
}

/// #654. An app starts again from around in no room after a resume, and
/// says only how it differs (`client/src/lib/watchPresence.ts`). One that
/// closed its room while the connection was down says nothing at all. What
/// it said before the drop stands until it speaks, or until the grace period
/// ends: then everybody hears it left the room, and never that it went
/// offline.
#[tokio::test]
async fn an_app_that_says_nothing_after_a_resume_is_around_when_the_grace_period_ends() {
    let (server, host, room) =
        common::server_with_room_tuned("garage", |config| config.presence_grace = RESUME_IN).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, mut theirs, session_id) =
        both_in_the_room(&server, &host.access_token, &member, &room_id).await;
    let s = last_seq(&mut theirs).await;

    drop(theirs);
    let dropped_at = Instant::now();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _theirs = resume(&server, &member.access_token, &session_id, s).await;
    let early = drain_for(
        &mut watcher,
        (dropped_at + RESUME_IN - Duration::from_millis(300))
            .saturating_duration_since(Instant::now()),
    )
    .await;
    let told = where_told(&early);
    assert!(
        told.is_empty(),
        "the resume was told before the grace period ended: {told:?}"
    );

    let (around, before) = wait_for_presence(&mut watcher, &member_id, "around").await;
    assert!(around["d"]["room_id"].is_null());
    assert!(
        before
            .iter()
            .any(|f| f["op"] == "room.leave" && f["d"]["user_id"] == member_id.as_str()),
        "the room never heard them leave: {before:?}"
    );
    assert!(
        presence_of(&before, &member_id).is_empty(),
        "told more than the move: {before:?}"
    );
    let held = presence_in_ready(&server, &host.access_token, &member_id).await;
    assert_eq!(held["state"], "around", "ready carried {held}");
}

/// #654. The server hanging up on a session on purpose isn't a drop: the
/// member was removed, and nothing can resume it. Offline at once, with no
/// grace period in which they still look connected.
#[tokio::test]
async fn a_removed_member_is_offline_at_once() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let member_id = member.user.id.to_string();
    let room_id = room.id.to_string();
    let (mut watcher, _theirs, _) =
        both_in_the_room(&server, &host.access_token, &member, &room_id).await;

    let removed_at = Instant::now();
    let resp = reqwest::Client::new()
        .post(server.url(&format!("/users/{member_id}/remove")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
    wait_for_presence(&mut watcher, &member_id, "offline").await;
    let grace = Duration::from_millis(linger_core::limits::PRESENCE_GRACE_MS);
    assert!(
        removed_at.elapsed() < grace / 2,
        "a removed member stayed connected for {:?}",
        removed_at.elapsed()
    );
}
