//! Voice forwarding over the gateway (#197): a client that can forward, on a
//! server that does, is offered one connection to the server, and each offer
//! says whose voice every m-line carries. There is no other way into voice
//! since the mesh was taken out (#306). The audio itself is proved in
//! `linger-sfu`'s own tests; this is the wiring.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_server::config::VoiceForwarding;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SETTLE: Duration = Duration::from_millis(300);

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

async fn connect(server: &common::TestServer, token: &str) -> (Ws, String) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } }),
    )
    .await;
    loop {
        let frames = drain(&mut ws, SETTLE).await;
        if let Some(ready) = frames.iter().find(|f| f["op"] == "ready") {
            return (
                ws,
                ready["d"]["session_id"]
                    .as_str()
                    .expect("a session")
                    .to_string(),
            );
        }
    }
}

/// A server that forwards voice, on this machine, with a room and two members.
async fn forwarding_server(on: bool) -> (common::TestServer, String, String, String) {
    let server = common::spawn_tuned(|config| {
        if on {
            config.voice_forwarding = Some(VoiceForwarding {
                bind: "127.0.0.1:0".parse().unwrap(),
                public: "127.0.0.1:0".parse().unwrap(),
            });
        }
    })
    .await;
    let host = common::bootstrap_host(&server).await;
    let room: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "garage", "name": "#garage" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    (
        server,
        host.access_token,
        callie.access_token,
        room.id.to_string(),
    )
}

fn offers(frames: &[Value]) -> Vec<&Value> {
    frames.iter().filter(|f| f["op"] == "voice.offer").collect()
}

fn track_sessions(offer: &Value) -> Vec<String> {
    offer["d"]["tracks"]
        .as_array()
        .expect("tracks")
        .iter()
        .map(|t| t["session_id"].as_str().unwrap().to_string())
        .collect()
}

fn forwarded_in(frames: &[Value], session: &str) -> Option<Value> {
    let state = frames.iter().rev().find(|f| f["op"] == "voice.state")?;
    state["d"]["peers"]
        .as_array()?
        .iter()
        .find(|p| p["session_id"] == json!(session))
        .map(|p| p["forwarded"].clone())
}

#[tokio::test]
async fn a_client_that_can_forward_is_offered_the_server_and_each_offer_names_the_voices() {
    let (server, host, callie, room) = forwarding_server(true).await;
    let (mut a, a_id) = connect(&server, &host).await;
    let (mut b, b_id) = connect(&server, &callie).await;

    send_json(
        &mut a,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    let frames = drain(&mut a, SETTLE).await;
    let first = offers(&frames);
    assert_eq!(first.len(), 1, "one offer, for the microphone: {frames:?}");
    assert!(
        track_sessions(first[0]).is_empty(),
        "nobody else is there yet"
    );
    let sdp = first[0]["d"]["sdp"].as_str().unwrap();
    // Full ICE: an ICE-lite server dropped connections carrying voice both ways (#210).
    assert!(!sdp.contains("a=ice-lite"), "the server runs full ICE");
    assert!(
        sdp.contains("127.0.0.1"),
        "the offer names where to send voice"
    );
    assert_eq!(forwarded_in(&frames, &a_id), Some(json!(true)));

    send_json(
        &mut b,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    let to_b = drain(&mut b, SETTLE).await;
    let to_a = drain(&mut a, SETTLE).await;
    let b_offer = offers(&to_b);
    assert_eq!(b_offer.len(), 1);
    assert_eq!(
        track_sessions(b_offer[0]),
        vec![a_id.clone()],
        "b is offered a's voice"
    );
    // a's first offer is still unanswered, so a's next one waits for it.
    assert!(
        offers(&to_a).is_empty(),
        "a got a second offer before answering the first"
    );
    assert_eq!(forwarded_in(&to_a, &b_id), Some(json!(true)));
}

#[tokio::test]
async fn somebody_leaving_is_taken_out_of_the_next_offer() {
    let (server, host, callie, room) = forwarding_server(true).await;
    let (mut a, _) = connect(&server, &host).await;
    let (mut b, b_id) = connect(&server, &callie).await;
    send_json(
        &mut b,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    drain(&mut b, SETTLE).await;
    send_json(
        &mut a,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    let frames = drain(&mut a, SETTLE).await;
    assert_eq!(track_sessions(offers(&frames)[0]), vec![b_id.clone()]);

    // An answer the server can't use is dropped; the socket survives it.
    send_json(&mut a, json!({"op":"voice.answer","d":{"sdp":"not sdp"}})).await;
    send_json(&mut b, json!({"op":"voice.leave"})).await;
    drain(&mut a, SETTLE).await;
    send_json(&mut a, json!({"op":"heartbeat","d":{"s":0}})).await;
    let after = drain(&mut a, SETTLE).await;
    assert!(
        after.iter().any(|f| f["op"] == "heartbeat_ack"),
        "the socket is still up: {after:?}"
    );
}

/// An app from before 0.4.1 never says it can forward, and spoke only the
/// mesh, which is gone (#306). It gets no seat, and the room it knocked on
/// carries on as it was.
#[tokio::test]
async fn an_app_that_cant_forward_gets_no_seat_and_the_room_carries_on() {
    let (server, host, callie, room) = forwarding_server(true).await;
    let (mut old, old_id) = connect(&server, &host).await;
    let (mut new, new_id) = connect(&server, &callie).await;

    send_json(
        &mut new,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    let frames = drain(&mut new, SETTLE).await;
    assert_eq!(offers(&frames).len(), 1);
    assert_eq!(forwarded_in(&frames, &new_id), Some(json!(true)));

    send_json(&mut old, json!({"op":"voice.join","d":{"room_id":room}})).await;
    let to_old = drain(&mut old, SETTLE).await;
    let to_new = drain(&mut new, SETTLE).await;
    assert!(
        offers(&to_old).is_empty(),
        "an older app was offered forwarding"
    );
    for frames in [&to_old, &to_new] {
        assert_eq!(
            forwarded_in(frames, &old_id),
            None,
            "an older app got a seat"
        );
    }
    assert!(
        to_new.iter().all(|f| f["op"] != "voice.state"),
        "the room was told something changed: {to_new:?}"
    );
}

/// Apps 0.4.1 to 0.4.3 had a Settings switch for the old way, and join with
/// `forwarding: false` when it's off. There is no old way now: they're
/// forwarded anyway, and their engine follows `voice.state` there (#306).
#[tokio::test]
async fn a_join_that_asks_for_the_old_way_is_forwarded_anyway() {
    let (server, host, callie, room) = forwarding_server(true).await;
    let (mut a, a_id) = connect(&server, &host).await;
    let (mut b, b_id) = connect(&server, &callie).await;
    send_json(
        &mut a,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    drain(&mut a, SETTLE).await;
    send_json(
        &mut b,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":false}}),
    )
    .await;
    let to_b = drain(&mut b, SETTLE).await;
    let to_a = drain(&mut a, SETTLE).await;
    assert_eq!(offers(&to_b).len(), 1, "no offer: {to_b:?}");
    for frames in [&to_a, &to_b] {
        assert_eq!(forwarded_in(frames, &a_id), Some(json!(true)), "{frames:?}");
        assert_eq!(forwarded_in(frames, &b_id), Some(json!(true)));
    }

    // Switching it in a call changes nothing and announces nothing.
    send_json(
        &mut b,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    let quiet = drain(&mut a, SETTLE).await;
    assert!(
        !quiet.iter().any(|f| f["op"] == "voice.state"),
        "an unchanged join was announced: {quiet:?}"
    );
}

/// A server whose host hasn't set `LINGER_VOICE_ADDRESS` carries no voice:
/// nobody gets a seat, and its info says so, so the app can say it before
/// anybody tries (#306).
#[tokio::test]
async fn a_server_that_doesnt_forward_seats_nobody_and_says_it_has_no_voice() {
    let (server, host, _, room) = forwarding_server(false).await;
    let (mut a, a_id) = connect(&server, &host).await;
    send_json(
        &mut a,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    let frames = drain(&mut a, SETTLE).await;
    assert!(offers(&frames).is_empty());
    assert_eq!(
        forwarded_in(&frames, &a_id),
        None,
        "somebody got a seat: {frames:?}"
    );
    assert_eq!(voice_in_info(&server, &host).await, json!(false));

    let (forwarding, token, _, _) = forwarding_server(true).await;
    assert_eq!(voice_in_info(&forwarding, &token).await, json!(true));
}

async fn voice_in_info(server: &common::TestServer, token: &str) -> Value {
    let info: Value = reqwest::Client::new()
        .get(server.url("/server"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    info["voice"].clone()
}

#[tokio::test]
async fn a_restart_brings_a_fresh_offer_and_the_room_sees_nothing() {
    let (server, host, callie, room) = forwarding_server(true).await;
    let (mut a, _) = connect(&server, &host).await;
    let (mut b, _) = connect(&server, &callie).await;
    send_json(
        &mut a,
        json!({"op":"voice.join","d":{"room_id":room,"forwarding":true}}),
    )
    .await;
    assert_eq!(offers(&drain(&mut a, SETTLE).await).len(), 1);
    drain(&mut b, SETTLE).await;

    send_json(&mut a, json!({"op":"voice.restart"})).await;
    let to_a = drain(&mut a, SETTLE).await;
    let to_b = drain(&mut b, SETTLE).await;
    assert_eq!(
        offers(&to_a).len(),
        1,
        "no fresh offer after a restart: {to_a:?}"
    );
    assert!(
        to_b.iter().all(|f| f["op"] != "voice.state"),
        "the room was told something changed: {to_b:?}"
    );

    // From somebody not in voice, it's ignored.
    send_json(&mut b, json!({"op":"voice.restart"})).await;
    assert!(offers(&drain(&mut b, SETTLE).await).is_empty());
}
