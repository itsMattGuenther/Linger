//! A burst of moves or voice changes from one app is told as a few, then the
//! newest (#527, PROTOCOL §8). Each `room.focus` can send five frames to
//! everybody connected, and each seat taken or left in voice makes the
//! forwarding server offer everybody in the room a fresh connection, so one
//! app in a loop mustn't be every app on the server redrawing in one. And
//! however a burst is cut short, it has to end where the last frame said.

mod common;

use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use linger_core::limits::{RATE_ROOM_FOCUS, RATE_VOICE_SEAT};
use linger_core::wire::Room;
use linger_server::config::VoiceForwarding;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(WsMessage::Text(value.to_string().into()))
        .await
        .expect("ws send");
}

async fn recv_json(ws: &mut Ws, within: Duration) -> Option<Value> {
    loop {
        match tokio::time::timeout(within, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                return Some(serde_json::from_str(text.as_str()).expect("valid frame json"));
            }
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

/// Read frames until one matches, within a generous deadline; returns it
/// and everything before it.
async fn wait_until(ws: &mut Ws, what: impl Fn(&Value) -> bool) -> (Value, Vec<Value>) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut before = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let frame = recv_json(ws, left)
            .await
            .unwrap_or_else(|| panic!("nothing matched in time; saw {before:?}"));
        if what(&frame) {
            return (frame, before);
        }
        before.push(frame);
    }
}

/// Every frame that arrives until the socket has been quiet for `quiet`.
async fn drain(ws: &mut Ws, quiet: Duration) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Some(frame) = recv_json(ws, quiet).await {
        frames.push(frame);
    }
    frames
}

/// Full handshake; returns the socket, its `ready` and its session id.
async fn connect(server: &common::TestServer, token: &str) -> (Ws, Value, String) {
    let (mut ws, _) = connect_async(server.gateway_url())
        .await
        .expect("ws connect");
    send_json(
        &mut ws,
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } }),
    )
    .await;
    let (ready, _) = wait_until(&mut ws, |f| f["op"] == "ready").await;
    let session = ready["d"]["session_id"]
        .as_str()
        .expect("a session")
        .to_string();
    (ws, ready, session)
}

/// Wait until the server has dealt with everything sent on this socket so
/// far: frames are handled in order, so the answer to a heartbeat comes
/// after all of them.
async fn settled(ws: &mut Ws) -> Vec<Value> {
    send_json(ws, json!({ "op": "heartbeat", "d": { "s": 0 } })).await;
    wait_until(ws, |f| f["op"] == "heartbeat_ack").await.1
}

async fn make_room(server: &common::TestServer, token: &str, slug: &str) -> String {
    let room: Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(token)
        .json(&json!({ "slug": slug, "name": format!("#{slug}") }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    room.id.to_string()
}

/// The most a limit lets out over `elapsed`: the whole bucket, and one more
/// for each token that has come back since. Measured rather than assumed, so
/// a slow machine can't fail a test of it.
fn allowed((burst, per_seconds): (u32, u64), elapsed: Duration) -> usize {
    #[allow(clippy::cast_precision_loss)]
    let refilled = elapsed.as_secs_f64() * f64::from(burst) / per_seconds as f64;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let allowed = burst as usize + refilled.ceil() as usize;
    allowed
}

fn about<'a>(frames: &'a [Value], op: &str, user_id: &str) -> Vec<&'a Value> {
    frames
        .iter()
        .filter(|f| f["op"] == op && f["d"]["user_id"] == user_id)
        .collect()
}

#[tokio::test]
async fn a_burst_of_moves_is_told_as_a_few_and_ends_in_the_last_room() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let callie = member.user.id.to_string();
    let a = make_room(&server, &host.access_token, "attic").await;
    let b = make_room(&server, &host.access_token, "barn").await;
    let c = make_room(&server, &host.access_token, "cellar").await;

    let (mut watcher, _, _) = connect(&server, &host.access_token).await;
    let (mut theirs, _, _) = connect(&server, &member.access_token).await;
    // Her arrival is the server's to tell, and not part of the burst.
    wait_until(&mut watcher, |f| {
        f["op"] == "presence.update" && f["d"]["user_id"] == callie
    })
    .await;

    let started = Instant::now();
    for n in 0..200 {
        let room = if n % 2 == 0 { &a } else { &b };
        send_json(
            &mut theirs,
            json!({ "op": "room.focus", "d": { "room_id": room } }),
        )
        .await;
    }
    send_json(
        &mut theirs,
        json!({ "op": "room.focus", "d": { "room_id": c } }),
    )
    .await;
    settled(&mut theirs).await;
    let elapsed = started.elapsed();

    // The move itself is not held back: anybody connecting now is told
    // she's in the cellar.
    let (_, ready, _) = connect(&server, &host.access_token).await;
    let entry = ready["d"]["presence"]
        .as_array()
        .expect("presence")
        .iter()
        .find(|p| p["user_id"] == json!(callie))
        .expect("callie is connected")
        .clone();
    assert_eq!(entry["room_id"], json!(c), "ready has her where she is");
    assert_eq!(entry["state"], "in_room");

    // Everybody else is told a few moves, then where she ended up.
    let (last, before) = wait_until(&mut watcher, |f| {
        f["op"] == "presence.update" && f["d"]["user_id"] == callie && f["d"]["room_id"] == c
    })
    .await;
    assert_eq!(last["d"]["state"], "in_room");
    let mut told = before;
    told.push(last);
    told.extend(drain(&mut watcher, Duration::from_millis(1_500)).await);

    let allowed = allowed(RATE_ROOM_FOCUS, started.elapsed().max(elapsed));
    let presences = about(&told, "presence.update", &callie).len();
    let leaves = about(&told, "room.leave", &callie).len();
    assert!(
        presences <= allowed && leaves <= allowed,
        "201 moves were told as {presences} presence changes and {leaves} leaves, \
         more than the {allowed} the limit lets out"
    );

    // And every room's last word on who's in it is right.
    for (room, inside) in [(&a, false), (&b, false), (&c, true)] {
        if let Some(occupancy) = told
            .iter()
            .rev()
            .find(|f| f["op"] == "room.occupancy" && f["d"]["room_id"] == json!(room))
        {
            let has_her = occupancy["d"]["user_ids"]
                .as_array()
                .expect("user ids")
                .contains(&json!(callie));
            assert_eq!(has_her, inside, "{room}'s occupancy is wrong: {occupancy}");
        } else {
            assert!(!inside, "nobody was told she's in the cellar");
        }
    }
}

/// An app going away leaves its room first, then says it's away (PROTOCOL
/// §8). With the leave held behind the limit, the turn that tells it must not
/// undo the away that came after: the move happened when it arrived, so the
/// turn tells where she is now, away and all.
#[tokio::test]
async fn going_away_behind_the_limit_stays_away() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let callie = member.user.id.to_string();
    let a = make_room(&server, &host.access_token, "attic").await;
    let b = make_room(&server, &host.access_token, "barn").await;

    let (mut watcher, _, _) = connect(&server, &host.access_token).await;
    let (mut theirs, _, _) = connect(&server, &member.access_token).await;
    wait_until(&mut watcher, |f| {
        f["op"] == "presence.update" && f["d"]["user_id"] == callie
    })
    .await;

    let (burst, _) = RATE_ROOM_FOCUS;
    for n in 0..burst * 2 {
        let room = if n % 2 == 0 { &a } else { &b };
        send_json(
            &mut theirs,
            json!({ "op": "room.focus", "d": { "room_id": room } }),
        )
        .await;
    }
    send_json(
        &mut theirs,
        json!({ "op": "room.focus", "d": { "room_id": null } }),
    )
    .await;
    send_json(
        &mut theirs,
        json!({ "op": "presence.update", "d": { "state": "away", "away_message": "brb" } }),
    )
    .await;
    settled(&mut theirs).await;

    // Past the held turn, and then some.
    let told = drain(&mut watcher, Duration::from_millis(2_500)).await;
    let last = about(&told, "presence.update", &callie)
        .last()
        .copied()
        .expect("told something about her")
        .clone();
    assert_eq!(
        last["d"]["state"], "away",
        "the turn undid her away: {told:?}"
    );
    assert_eq!(last["d"]["away_message"], "brb");
    assert_eq!(last["d"]["room_id"], Value::Null);
}

/// A server that forwards voice, with a room and two members.
async fn forwarding_server() -> (common::TestServer, String, String, String) {
    let server = common::spawn_tuned(|config| {
        config.voice_forwarding = Some(VoiceForwarding {
            bind: "127.0.0.1:0".parse().unwrap(),
            public: "127.0.0.1:0".parse().unwrap(),
        });
    })
    .await;
    let host = common::bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    (server, host.access_token, callie.access_token, room)
}

fn in_voice(state: &Value, session: &str) -> bool {
    state["d"]["peers"]
        .as_array()
        .expect("peers")
        .iter()
        .any(|p| p["session_id"] == json!(session))
}

fn join(room: &str, muted: bool) -> Value {
    json!({ "op": "voice.join", "d": {
        "room_id": room,
        "controls": { "muted": muted, "deafened": false },
        "forwarding": true,
    }})
}

#[tokio::test]
async fn a_burst_of_joins_and_leaves_is_told_as_a_few_and_ends_where_the_last_said() {
    let (server, host, callie, room) = forwarding_server().await;
    let (mut a, _, a_id) = connect(&server, &host).await;
    let (mut b, _, _) = connect(&server, &callie).await;
    send_json(&mut b, join(&room, false)).await;
    settled(&mut b).await;
    drain(&mut b, Duration::from_millis(300)).await;

    // Every seat taken or left is a `voice.state` to the room and a round of
    // fresh offers from the forwarding server, so the room's `voice.state`s
    // count the rounds.
    let started = Instant::now();
    for _ in 0..100 {
        send_json(&mut a, join(&room, false)).await;
        send_json(&mut a, json!({ "op": "voice.leave" })).await;
    }
    send_json(&mut a, join(&room, false)).await;
    settled(&mut a).await;

    let (last, before) =
        wait_until(&mut b, |f| f["op"] == "voice.state" && in_voice(f, &a_id)).await;
    let mut told = before;
    told.push(last);
    told.extend(drain(&mut b, Duration::from_millis(1_500)).await);

    let states: Vec<&Value> = told.iter().filter(|f| f["op"] == "voice.state").collect();
    let allowed = allowed(RATE_VOICE_SEAT, started.elapsed());
    assert!(
        states.len() <= allowed,
        "201 joins and leaves were told as {} rounds, more than the {allowed} the limit lets out",
        states.len()
    );
    assert!(
        in_voice(states.last().expect("told something"), &a_id),
        "the burst ended with a join, so she's in voice"
    );

    // And she has a connection to use: an offer came.
    let to_a = drain(&mut a, Duration::from_millis(500)).await;
    assert!(
        to_a.iter().any(|f| f["op"] == "voice.offer"),
        "no offer for the seat she ended in: {to_a:?}"
    );
}

/// A leave and a join back into the same room, held behind the limit, still
/// leave the app with a fresh offer: it closed its connection when it left,
/// and the turn that seats it where it was must not leave it waiting for an
/// offer that never comes. The room, which never saw it go, sees nothing.
#[tokio::test]
async fn leaving_and_coming_back_behind_the_limit_still_brings_a_fresh_offer() {
    let (server, host, callie, room) = forwarding_server().await;
    let (mut a, _, a_id) = connect(&server, &host).await;
    let (mut b, _, _) = connect(&server, &callie).await;

    send_json(&mut a, join(&room, false)).await;
    settled(&mut a).await;
    let (_, _) = wait_until(&mut a, |f| f["op"] == "voice.offer").await;

    // Twice the bucket in mute changes, which don't need a new connection,
    // all at once so the limit is reached; then, behind it, out and straight
    // back in, unmuted.
    let (burst, _) = RATE_VOICE_SEAT;
    for n in 0..burst * 2 {
        send_json(&mut a, join(&room, n % 2 == 0)).await;
    }
    send_json(&mut a, json!({ "op": "voice.leave" })).await;
    send_json(&mut a, join(&room, false)).await;
    settled(&mut a).await;

    let (offer, _) = wait_until(&mut a, |f| f["op"] == "voice.offer").await;
    assert!(offer["d"]["sdp"]
        .as_str()
        .is_some_and(|sdp| !sdp.is_empty()));
    let to_b = drain(&mut b, Duration::from_millis(1_500)).await;
    assert!(
        to_b.iter()
            .filter(|f| f["op"] == "voice.state")
            .all(|f| in_voice(f, &a_id)),
        "the room was told she left: {to_b:?}"
    );
}
