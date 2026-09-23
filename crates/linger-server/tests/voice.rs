//! Voice signalling over the gateway (SPEC §4.14, PROTOCOL §8, T-1401).
//!
//! No audio anywhere in here — this task ends with two clients having exchanged
//! everything they need and nothing playing, so the payloads are strings and
//! the assertions are about who got which frame.
//!
//! T-1401's acceptance criterion is *two clients complete a full exchange
//! across a forced reconnect without the session ending up half-connected*, and
//! "half-connected" is the interesting half. Two ways to get there and both
//! have a test: a client that drops and comes back must **keep** its seat, and
//! a client that drops and stays gone must **lose** it. Getting either backwards
//! leaves somebody in a peer list they cannot be reached at.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Long enough that a frame the server was going to send has been sent. The bus
/// is in-process and the socket is local; this is a very large multiple of that.
const SETTLE: Duration = Duration::from_millis(250);

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

/// Handshake, and the session id the server gave us — which is this client's
/// identity for the whole of voice.
async fn connect(server: &common::TestServer, token: &str) -> (Ws, String) {
    let (ws, ready) = connect_ready(server, token).await;
    (ws, ready["d"]["session_id"].as_str().unwrap().to_string())
}

async fn connect_ready(server: &common::TestServer, token: &str) -> (Ws, Value) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    let hello = recv_json(&mut ws).await;
    assert_eq!(hello["op"], "hello");
    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } }),
    )
    .await;
    loop {
        let frame = recv_json(&mut ws).await;
        if frame["op"] == "ready" {
            return (ws, frame);
        }
    }
}

async fn join_voice(ws: &mut Ws, room: &str) {
    send_json(ws, json!({ "op": "voice.join", "d": { "room_id": room } })).await;
}

async fn controls(ws: &mut Ws, room: &str, muted: bool, deafened: bool) {
    send_json(
        ws,
        json!({"op":"voice.join", "d":{
            "room_id":room, "controls":{"muted":muted, "deafened":deafened}
        }}),
    )
    .await;
}

#[tokio::test]
async fn controls_are_session_scoped_normalized_and_legacy_safe() {
    let (server, host, room) = common::server_with_room("garage").await;
    let room = room.id.to_string();
    // Two sessions of one person must not control one another.
    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &host.access_token).await;
    join_voice(&mut a, &room).await;
    join_voice(&mut b, &room).await;
    drain(&mut b, SETTLE).await;
    controls(&mut a, &room, false, true).await;
    let frames = drain(&mut b, SETTLE).await;
    let peers = voice_state(&frames, &room).unwrap()["d"]["peers"]
        .as_array()
        .unwrap();
    let mine = peers.iter().find(|p| p["session_id"] == a_id).unwrap();
    assert_eq!(mine["controls"], json!({"muted":true,"deafened":true}));
    assert!(peers
        .iter()
        .find(|p| p["session_id"] == b_id)
        .unwrap()
        .get("controls")
        .is_none());
    // Legacy duplicate joins and identical reports do not erase state or emit noise.
    join_voice(&mut a, &room).await;
    controls(&mut a, &room, true, true).await;
    assert!(voice_state(&drain(&mut b, SETTLE).await, &room).is_none());
    controls(&mut b, &room, false, false).await;
    let frames = drain(&mut b, SETTLE).await;
    assert_eq!(
        voice_state(&frames, &room).unwrap()["d"]["peers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["session_id"] == a_id)
            .unwrap()["controls"]["deafened"],
        true
    );
    send_json(&mut a, json!({"op":"voice.leave","d":null})).await;
    join_voice(&mut a, &room).await;
    let frames = drain(&mut b, SETTLE).await;
    assert!(voice_state(&frames, &room).unwrap()["d"]["peers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["session_id"] == a_id)
        .unwrap()
        .get("controls")
        .is_none());
}

/// The newest `voice.state` for a room in a batch of frames, if there is one.
fn voice_state<'a>(frames: &'a [Value], room: &str) -> Option<&'a Value> {
    frames
        .iter()
        .rev()
        .find(|f| f["op"] == "voice.state" && f["d"]["room_id"] == json!(room))
}

fn peer_sessions(state: &Value) -> Vec<String> {
    state["d"]["peers"]
        .as_array()
        .expect("peers")
        .iter()
        .map(|p| p["session_id"].as_str().unwrap().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Joining and leaving
// ---------------------------------------------------------------------------

#[tokio::test]
async fn joining_voice_tells_the_room_who_is_in_it() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &callie.access_token).await;
    drain(&mut a, SETTLE).await;
    drain(&mut b, SETTLE).await;

    join_voice(&mut a, &room_id).await;
    tokio::time::sleep(SETTLE).await;

    // Both of them are told, including the one who has not joined: who is in
    // voice is a fact about the room, not about the people in the call.
    for (who, ws) in [("the joiner", &mut a), ("the room", &mut b)] {
        let frames = drain(ws, SETTLE).await;
        let state = voice_state(&frames, &room_id).unwrap_or_else(|| panic!("{who} was not told"));
        assert_eq!(peer_sessions(state), vec![a_id.clone()]);
    }

    join_voice(&mut b, &room_id).await;
    tokio::time::sleep(SETTLE).await;

    // The list is the whole list, every time, and in session-id order — which
    // is the order both ends compare to decide who offers.
    let frames = drain(&mut a, SETTLE).await;
    let state = voice_state(&frames, &room_id).expect("a is told b arrived");
    let mut expected = vec![a_id.clone(), b_id.clone()];
    expected.sort();
    assert_eq!(peer_sessions(state), expected);
}

#[tokio::test]
async fn leaving_voice_takes_you_out_of_the_list() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, _b_id) = connect(&server, &callie.access_token).await;
    join_voice(&mut a, &room_id).await;
    join_voice(&mut b, &room_id).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut a, SETTLE).await;

    send_json(&mut b, json!({ "op": "voice.leave", "d": null })).await;
    tokio::time::sleep(SETTLE).await;

    let frames = drain(&mut a, SETTLE).await;
    let state = voice_state(&frames, &room_id).expect("a is told b left");
    assert_eq!(peer_sessions(state), vec![a_id]);
}

#[tokio::test]
async fn you_are_in_voice_in_one_room_at_a_time() {
    let (server, host, room) = common::server_with_room("garage").await;
    let porch: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let garage_id = room.id.to_string();
    let porch_id = porch.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    join_voice(&mut a, &garage_id).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut a, SETTLE).await;

    join_voice(&mut a, &porch_id).await;
    tokio::time::sleep(SETTLE).await;
    let frames = drain(&mut a, SETTLE).await;

    // Both rooms are told, and the one being left says so — otherwise a seat
    // stays behind in a room nobody is in.
    let left = voice_state(&frames, &garage_id).expect("the room being left is told");
    assert!(peer_sessions(left).is_empty(), "a seat was left behind");
    let arrived = voice_state(&frames, &porch_id).expect("the new room is told");
    assert_eq!(peer_sessions(arrived), vec![a_id]);
}

// ---------------------------------------------------------------------------
// Signalling
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_full_exchange_reaches_the_other_peer_and_nobody_else() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;
    let room_id = room.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &callie.access_token).await;
    // Dave is in the room and *not* in voice, so he is the check that a signal
    // is addressed rather than broadcast.
    let (mut c, _c_id) = connect(&server, &dave.access_token).await;
    join_voice(&mut a, &room_id).await;
    join_voice(&mut b, &room_id).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut a, SETTLE).await;
    drain(&mut b, SETTLE).await;
    drain(&mut c, SETTLE).await;

    // Offer → answer → candidate, the whole exchange.
    send_json(
        &mut a,
        json!({ "op": "voice.signal", "d": { "to": b_id, "kind": "offer", "payload": "v=0 the offer" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;
    let to_b = drain(&mut b, SETTLE).await;
    let offer = to_b
        .iter()
        .find(|f| f["op"] == "voice.signal")
        .expect("b got the offer");
    assert_eq!(offer["d"]["from"], json!(a_id));
    assert_eq!(offer["d"]["kind"], "offer");
    assert_eq!(offer["d"]["payload"], "v=0 the offer");

    send_json(
        &mut b,
        json!({ "op": "voice.signal", "d": { "to": a_id, "kind": "answer", "payload": "v=0 the answer" } }),
    )
    .await;
    send_json(
        &mut b,
        json!({ "op": "voice.signal", "d": { "to": a_id, "kind": "candidate", "payload": "candidate:1 udp" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;

    let to_a = drain(&mut a, SETTLE).await;
    let kinds: Vec<&str> = to_a
        .iter()
        .filter(|f| f["op"] == "voice.signal")
        .filter_map(|f| f["d"]["kind"].as_str())
        .collect();
    assert_eq!(
        kinds,
        vec!["answer", "candidate"],
        "in the order they were sent"
    );

    // Dave heard the joins, because that is the room's business — and none of
    // the signalling, because that is not.
    let to_c = drain(&mut c, SETTLE).await;
    assert!(
        to_c.iter().all(|f| f["op"] != "voice.signal"),
        "a signal reached somebody who was not the peer it named"
    );
    assert!(
        !serde_json::to_string(&to_c).unwrap().contains("the offer"),
        "a payload reached somebody outside the call"
    );
}

#[tokio::test]
async fn a_signal_to_somebody_outside_your_voice_room_goes_nowhere() {
    let (server, host, room) = common::server_with_room("garage").await;
    let porch: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let callie = common::join_member(&server, &host.access_token, "callie").await;

    let (mut a, _a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &callie.access_token).await;
    join_voice(&mut a, &room.id.to_string()).await;
    join_voice(&mut b, &porch.id.to_string()).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut b, SETTLE).await;

    // Otherwise this frame is a way to hand an arbitrary string to any session
    // on the server — a side channel nothing else here has.
    send_json(
        &mut a,
        json!({ "op": "voice.signal", "d": { "to": b_id, "kind": "offer", "payload": "not for you" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;

    let to_b = drain(&mut b, SETTLE).await;
    assert!(
        to_b.iter().all(|f| f["op"] != "voice.signal"),
        "a signal crossed between two different voice rooms"
    );
}

#[tokio::test]
async fn a_signal_from_somebody_not_in_voice_goes_nowhere() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;

    let (mut a, _a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &callie.access_token).await;
    join_voice(&mut b, &room.id.to_string()).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut b, SETTLE).await;

    // A never joined voice. Both ends have to be in it, not just the target.
    send_json(
        &mut a,
        json!({ "op": "voice.signal", "d": { "to": b_id, "kind": "offer", "payload": "uninvited" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;

    assert!(
        drain(&mut b, SETTLE)
            .await
            .iter()
            .all(|f| f["op"] != "voice.signal"),
        "somebody outside voice sent a signal into it"
    );
}

#[tokio::test]
async fn an_oversized_payload_is_dropped_and_the_socket_survives() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &callie.access_token).await;
    join_voice(&mut a, &room_id).await;
    join_voice(&mut b, &room_id).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut b, SETTLE).await;

    let huge = "x".repeat(linger_core::limits::MAX_VOICE_PAYLOAD_BYTES + 1);
    send_json(
        &mut a,
        json!({ "op": "voice.signal", "d": { "to": b_id, "kind": "offer", "payload": huge } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;
    assert!(
        drain(&mut b, SETTLE)
            .await
            .iter()
            .all(|f| f["op"] != "voice.signal"),
        "an oversized payload was relayed"
    );

    // And the connection is still good: an ignored frame is ignored, not fatal.
    send_json(
        &mut a,
        json!({ "op": "voice.signal", "d": { "to": b_id, "kind": "offer", "payload": "fine" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;
    let after = drain(&mut b, SETTLE).await;
    let signal = after
        .iter()
        .find(|f| f["op"] == "voice.signal")
        .expect("the socket still works after a refused frame");
    assert_eq!(signal["d"]["from"], json!(a_id));
}

// ---------------------------------------------------------------------------
// The acceptance criterion: a forced reconnect, and no half-connected state
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_resumed_session_keeps_its_seat_and_replays_what_it_missed() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, b_id) = connect(&server, &callie.access_token).await;
    join_voice(&mut a, &room_id).await;
    join_voice(&mut b, &room_id).await;
    tokio::time::sleep(SETTLE).await;

    // Note where B is up to, then drop its socket mid-call. The session lives
    // on for the resume window; this is a network blip, not a hang-up.
    let seen = drain(&mut b, SETTLE).await;
    let last_seq = seen
        .iter()
        .filter_map(|f| f["s"].as_u64())
        .max()
        .expect("b saw something");
    drop(b);
    tokio::time::sleep(SETTLE).await;

    controls(&mut a, &room_id, true, true).await;

    // A signals into the gap. Nothing is listening, and the ring buffer holds it.
    send_json(
        &mut a,
        json!({ "op": "voice.signal", "d": { "to": b_id, "kind": "offer", "payload": "sent while away" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;

    // A must still see B in the room. This is the half-connected case: hanging
    // up on a blip would take B out of the list while B still thinks it is in.
    let a_frames = drain(&mut a, SETTLE).await;
    let mut expected = vec![a_id.clone(), b_id.clone()];
    expected.sort();
    // Same shape as above: no frame means nothing changed, which is what should
    // have happened. A frame saying B is gone is the failure.
    let seats = voice_state(&a_frames, &room_id).map_or_else(|| expected.clone(), peer_sessions);
    assert_eq!(
        seats, expected,
        "a dropped socket took its peer out of voice before the resume window"
    );

    // B comes back on the same session id and picks up where it left off.
    let (mut b2, _) = connect_async(server.gateway_url())
        .await
        .expect("reconnect");
    let hello = recv_json(&mut b2).await;
    assert_eq!(hello["op"], "hello");
    send_json(
        &mut b2,
        json!({ "op": "resume", "d": { "session_id": b_id, "token": callie.access_token, "s": last_seq } }),
    )
    .await;

    let replayed = drain(&mut b2, Duration::from_millis(500)).await;
    assert!(
        replayed.iter().any(|f| f["op"] == "resumed"),
        "the session did not resume: {replayed:?}"
    );
    let offer = replayed
        .iter()
        .find(|f| f["op"] == "voice.signal")
        .expect("the signal sent while away was replayed");
    assert_eq!(offer["d"]["payload"], "sent while away");
    let replayed_state = voice_state(&replayed, &room_id).expect("control change replayed");
    assert_eq!(
        replayed_state["d"]["peers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["session_id"] == a_id)
            .unwrap()["controls"],
        json!({"muted":true,"deafened":true})
    );

    // And the exchange finishes across the seam: B answers on the new socket
    // and A hears it, which is what "a full exchange across a forced reconnect"
    // means.
    drain(&mut a, SETTLE).await;
    send_json(
        &mut b2,
        json!({ "op": "voice.signal", "d": { "to": a_id, "kind": "answer", "payload": "answered after" } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;
    let to_a = drain(&mut a, SETTLE).await;
    let answer = to_a
        .iter()
        .find(|f| f["op"] == "voice.signal")
        .expect("a heard the answer sent after the reconnect");
    assert_eq!(answer["d"]["payload"], "answered after");
    assert_eq!(answer["d"]["from"], json!(b_id), "and it is the same peer");
}

#[tokio::test]
async fn a_session_that_ends_leaves_voice_and_the_room_is_told() {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut b, _b_id) = connect(&server, &callie.access_token).await;
    join_voice(&mut a, &room_id).await;
    join_voice(&mut b, &room_id).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut a, SETTLE).await;

    // A clean close is a hang-up, not a blip: the socket says goodbye, the
    // session ends, and the seat goes with it. The other half of the same
    // rule the resume test checks — a seat that outlived its client would be
    // somebody in the list who cannot be reached.
    b.close(None).await.ok();
    drop(b);

    // The session task notices on its own sweep, so this waits rather than
    // assuming an instant.
    let mut left = false;
    for _ in 0..40 {
        let frames = drain(&mut a, Duration::from_millis(200)).await;
        if let Some(state) = voice_state(&frames, &room_id) {
            if peer_sessions(state) == vec![a_id.clone()] {
                left = true;
                break;
            }
        }
    }
    assert!(left, "a closed client stayed in the voice list");
}

// ---------------------------------------------------------------------------
// Privacy: a voice room inside a DM is as private as the DM
// ---------------------------------------------------------------------------

#[tokio::test]
async fn voice_in_a_dm_is_invisible_to_everybody_else() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;

    let dm: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_ids": [callie.user.id.to_string()] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dm_id = dm.id.to_string();

    let (mut a, _a_id) = connect(&server, &host.access_token).await;
    let (mut c, _c_id) = connect(&server, &callie.access_token).await;
    let (mut d, _d_id) = connect(&server, &dave.access_token).await;
    drain(&mut c, SETTLE).await;
    drain(&mut d, SETTLE).await;

    join_voice(&mut a, &dm_id).await;
    tokio::time::sleep(SETTLE).await;

    // Callie is in the DM, so she is told.
    let hers = drain(&mut c, SETTLE).await;
    assert!(
        voice_state(&hers, &dm_id).is_some(),
        "a member was not told about voice in their own DM"
    );

    // Dave is not, so nothing about it reaches him — not who is in it, not
    // that it exists.
    let his = drain(&mut d, SETTLE).await;
    assert!(
        !serde_json::to_string(&his).unwrap().contains(&dm_id),
        "voice in a DM leaked its room to a stranger: {his:?}"
    );

    controls(&mut a, &dm_id, true, true).await;
    let changes = drain(&mut c, SETTLE).await;
    assert_eq!(
        voice_state(&changes, &dm_id).unwrap()["d"]["peers"][0]["controls"]["deafened"],
        true
    );
    assert!(voice_state(&drain(&mut d, SETTLE).await, &dm_id).is_none());
    // A non-member cannot use a control report to enter the private voice room.
    controls(&mut d, &dm_id, false, false).await;
    assert!(voice_state(&drain(&mut c, SETTLE).await, &dm_id).is_none());
}

#[tokio::test]
async fn you_cannot_join_voice_in_a_dm_you_are_not_in() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;

    let dm: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_ids": [callie.user.id.to_string()] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dm_id = dm.id.to_string();

    let (mut a, a_id) = connect(&server, &host.access_token).await;
    let (mut d, _d_id) = connect(&server, &dave.access_token).await;
    join_voice(&mut a, &dm_id).await;
    tokio::time::sleep(SETTLE).await;
    drain(&mut a, SETTLE).await;

    // Dave points his client at a DM he is not in. `voice.join` is a client
    // frame, so a broken or lying client can send it — and standing in
    // somebody's private call is the inward direction the fan-out does not
    // cover on its own.
    join_voice(&mut d, &dm_id).await;
    tokio::time::sleep(SETTLE).await;

    // Asserted whether or not a frame arrives: no frame is the *right* answer
    // (nothing changed), and a frame that names Dave is the wrong one. An
    // `if let` around this would let the test pass by never running.
    let frames = drain(&mut a, SETTLE).await;
    let seats = voice_state(&frames, &dm_id).map_or_else(|| vec![a_id.clone()], peer_sessions);
    assert_eq!(seats, vec![a_id], "an outsider joined voice in a DM");
}

#[tokio::test]
async fn fresh_connections_see_existing_voice_without_joining_and_cannot_see_private_voice() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "member").await;
    let outsider = common::join_member(&server, &host.access_token, "outsider").await;
    let (mut speaker, speaker_id) = connect(&server, &host.access_token).await;
    controls(&mut speaker, &room.id.to_string(), true, false).await;
    assert!(voice_state(&drain(&mut speaker, SETTLE).await, &room.id.to_string()).is_some());
    let (mut observer, snapshot) = connect_ready(&server, &member.access_token).await;
    assert_eq!(snapshot["d"]["voice"][0]["room_id"], room.id.to_string());
    assert_eq!(
        snapshot["d"]["voice"][0]["peers"][0]["session_id"],
        speaker_id
    );
    assert_eq!(
        snapshot["d"]["voice"][0]["peers"][0]["controls"]["muted"],
        true
    );
    assert_eq!(
        snapshot["d"]["voice"][0]["peers"].as_array().unwrap().len(),
        1
    );
    let dm: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({"user_ids": [member.user.id]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    join_voice(&mut speaker, &dm.id.to_string()).await;
    let changes = drain(&mut observer, SETTLE).await;
    assert!(peer_sessions(voice_state(&changes, &room.id.to_string()).unwrap()).is_empty());
    let (_private_observer, snapshot) = connect_ready(&server, &member.access_token).await;
    assert_eq!(snapshot["d"]["voice"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["d"]["voice"][0]["room_id"], dm.id.to_string());
    let (mut stranger, snapshot) = connect_ready(&server, &outsider.access_token).await;
    assert_eq!(snapshot["d"]["voice"], json!([]));
    assert!(!snapshot.to_string().contains(&dm.id.to_string()));
    send_json(&mut speaker, json!({"op":"voice.leave","d":null})).await;
    assert!(!serde_json::to_string(&drain(&mut stranger, SETTLE).await)
        .unwrap()
        .contains(&dm.id.to_string()));
    let (_empty_observer, snapshot) = connect_ready(&server, &member.access_token).await;
    assert_eq!(snapshot["d"]["voice"], json!([]));
}
