//! Screen sharing over real sockets (SPEC §4.20, PROTOCOL §8 "Screen
//! sharing", #360): the screen socket's hello and refusals, a frame passed
//! from a share to its watcher only from a key frame on, what `voice.state`
//! says, and leaving voice ending both. The board's finer rules (formats,
//! falling behind, the ceiling) are `gateway::screens`'s own tests.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const SETTLE: Duration = Duration::from_millis(250);

async fn recv_json(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5s")
            .expect("socket still open")
            .expect("clean frame");
        if let WsMessage::Text(text) = msg {
            return serde_json::from_str(text.as_str()).expect("valid json");
        }
    }
}

async fn drain(ws: &mut Ws, window: Duration) -> Vec<Value> {
    let mut frames = Vec::new();
    loop {
        match tokio::time::timeout(window, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                frames.push(serde_json::from_str(text.as_str()).expect("valid json"));
            }
            Ok(Some(Ok(_))) => {}
            _ => return frames,
        }
    }
}

/// A gateway connection and its session id.
async fn gateway(server: &common::TestServer, token: &str) -> (Ws, String) {
    let (mut ws, _) = connect_async(server.gateway_url()).await.expect("ws");
    assert_eq!(recv_json(&mut ws).await["op"], "hello");
    ws.send(WsMessage::Text(
        json!({"op": "identify", "d": {"token": token, "client": "test/0"}})
            .to_string()
            .into(),
    ))
    .await
    .expect("identify");
    loop {
        let frame = recv_json(&mut ws).await;
        if frame["op"] == "ready" {
            return (ws, frame["d"]["session_id"].as_str().unwrap().to_string());
        }
    }
}

async fn join_voice(ws: &mut Ws, room: &str) {
    ws.send(WsMessage::Text(
        json!({"op": "voice.join", "d": {"room_id": room, "forwarding": true}})
            .to_string()
            .into(),
    ))
    .await
    .expect("join");
}

async fn leave_voice(ws: &mut Ws) {
    ws.send(WsMessage::Text(
        json!({"op": "voice.leave"}).to_string().into(),
    ))
    .await
    .expect("leave");
}

/// A screen socket, its hello sent.
async fn screen(server: &common::TestServer, hello: Value) -> Ws {
    let url = format!("{}/api/v1/screen", server.base.replace("http://", "ws://"));
    let (mut ws, _) = connect_async(url).await.expect("screen ws");
    ws.send(WsMessage::Text(hello.to_string().into()))
        .await
        .expect("hello");
    ws
}

/// The code a screen socket was closed with.
async fn closed_with(ws: &mut Ws) -> Option<u16> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Close(frame)))) => return frame.map(|f| u16::from(f.code)),
            Ok(Some(Ok(_))) => {}
            _ => return None,
        }
    }
}

async fn next_binary(ws: &mut Ws) -> Vec<u8> {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5s")
            .expect("socket still open")
            .expect("clean frame");
        if let WsMessage::Binary(bytes) = msg {
            return bytes.to_vec();
        }
    }
}

/// A frame as an app sends one: the 12-byte header and some picture.
fn frame(codec: u8, key: bool, fill: u8) -> Vec<u8> {
    let mut bytes = vec![1, codec, u8::from(key), 0];
    bytes.extend_from_slice(&42u64.to_be_bytes());
    bytes.extend_from_slice(&[fill; 64]);
    bytes
}

fn share_hello(token: &str, session: &str, fps: u8) -> Value {
    json!({"op": "share", "token": token, "session_id": session, "fps": fps, "encode": ["avc1", "vp8"]})
}

fn watch_hello(token: &str, session: &str, target: &str) -> Value {
    json!({"op": "watch", "token": token, "session_id": session, "target": target, "decode": ["vp8"]})
}

fn peer<'a>(frames: &'a [Value], room: &str, session: &str) -> Option<&'a Value> {
    frames
        .iter()
        .rev()
        .find(|f| f["op"] == "voice.state" && f["d"]["room_id"] == json!(room))
        .and_then(|state| {
            state["d"]["peers"]
                .as_array()?
                .iter()
                .find(|p| p["session_id"] == json!(session))
        })
}

#[tokio::test]
async fn a_share_reaches_its_watcher_from_a_key_frame_and_voice_state_says_who() {
    let (server, host, room) = common::voice_server_with_room("presentation").await;
    let room = room.id.to_string();
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    let (mut eli_gw, eli_session) = gateway(&server, &eli.access_token).await;
    join_voice(&mut host_gw, &room).await;
    join_voice(&mut eli_gw, &room).await;
    drain(&mut eli_gw, SETTLE).await;

    // The host shares. Nobody watches yet: the app is asked for nothing.
    let mut share = screen(&server, share_hello(&host.access_token, &host_session, 30)).await;
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": []})
    );
    let frames = drain(&mut eli_gw, SETTLE).await;
    let sharer = peer(&frames, &room, &host_session).expect("the host in voice.state");
    assert_eq!(sharer["screen"], json!({"fps": 30}));

    // Eli watches, playing VP8 only: the host is asked for VP8 and a key frame.
    let mut watch = screen(
        &server,
        watch_hello(&eli.access_token, &eli_session, &host_session),
    )
    .await;
    assert_eq!(
        recv_json(&mut watch).await,
        json!({"op": "showing", "target": host_session, "codec": "vp8"})
    );
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": ["vp8"]})
    );
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "keyframe", "codec": "vp8"})
    );
    let frames = drain(&mut host_gw, SETTLE).await;
    let watcher = peer(&frames, &room, &eli_session).expect("eli in voice.state");
    assert_eq!(watcher["watching"], json!(host_session));

    // An ordinary frame before any key frame, and an H.264 one nobody asked
    // for, go nowhere; from the key frame on, Eli gets them as sent.
    share
        .send(WsMessage::Binary(frame(1, false, 1).into()))
        .await
        .unwrap();
    share
        .send(WsMessage::Binary(frame(2, true, 2).into()))
        .await
        .unwrap();
    share
        .send(WsMessage::Binary(frame(1, true, 3).into()))
        .await
        .unwrap();
    share
        .send(WsMessage::Binary(frame(1, false, 4).into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut watch).await, frame(1, true, 3));
    assert_eq!(next_binary(&mut watch).await, frame(1, false, 4));

    // The host stops: Eli's socket says so and stays open; voice.state drops
    // both marks.
    share.close(None).await.unwrap();
    assert_eq!(
        recv_json(&mut watch).await,
        json!({"op": "showing", "target": null, "codec": null})
    );
    let frames = drain(&mut eli_gw, SETTLE).await;
    assert!(peer(&frames, &room, &host_session).expect("host")["screen"].is_null());
    assert!(peer(&frames, &room, &eli_session).expect("eli")["watching"].is_null());
}

#[tokio::test]
async fn a_hello_that_doesnt_pass_closes_with_its_reason() {
    let (server, host, room) = common::voice_server_with_room("garage").await;
    let room = room.id.to_string();
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    let (_eli_gw, eli_session) = gateway(&server, &eli.access_token).await;
    join_voice(&mut host_gw, &room).await;
    drain(&mut host_gw, SETTLE).await;

    // A token that isn't one.
    let mut ws = screen(&server, share_hello("not-a-token", &host_session, 30)).await;
    assert_eq!(closed_with(&mut ws).await, Some(4001));
    // Eli's session isn't in voice.
    let mut ws = screen(&server, share_hello(&eli.access_token, &eli_session, 30)).await;
    assert_eq!(closed_with(&mut ws).await, Some(4002));
    // Somebody else's session, though it is in voice.
    let mut ws = screen(&server, share_hello(&eli.access_token, &host_session, 30)).await;
    assert_eq!(closed_with(&mut ws).await, Some(4002));
    // Not a hello, and a speed that isn't one.
    let mut ws = screen(&server, json!({"op": "hello"})).await;
    assert_eq!(closed_with(&mut ws).await, Some(4005));
    let mut ws = screen(&server, share_hello(&host.access_token, &host_session, 45)).await;
    assert_eq!(closed_with(&mut ws).await, Some(4005));
    // Nobody shares, so there's nothing to watch.
    let mut ws = screen(
        &server,
        watch_hello(&host.access_token, &host_session, &eli_session),
    )
    .await;
    assert_eq!(closed_with(&mut ws).await, Some(4004));
}

#[tokio::test]
async fn a_fourth_share_in_a_room_is_refused() {
    let (server, host, room) = common::voice_server_with_room("raid").await;
    let room = room.id.to_string();
    let mut gateways = Vec::new();
    for _ in 0..4 {
        let (mut gw, session) = gateway(&server, &host.access_token).await;
        join_voice(&mut gw, &room).await;
        gateways.push((gw, session));
    }
    tokio::time::sleep(SETTLE).await;
    let mut shares = Vec::new();
    for (_, session) in gateways.iter().take(3) {
        let mut ws = screen(&server, share_hello(&host.access_token, session, 30)).await;
        assert_eq!(recv_json(&mut ws).await["op"], "want");
        shares.push(ws);
    }
    let mut fourth = screen(&server, share_hello(&host.access_token, &gateways[3].1, 30)).await;
    assert_eq!(closed_with(&mut fourth).await, Some(4003));
}

#[tokio::test]
async fn leaving_voice_ends_the_share_and_the_watching() {
    let (server, host, room) = common::voice_server_with_room("lounge").await;
    let room = room.id.to_string();
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    let (mut eli_gw, eli_session) = gateway(&server, &eli.access_token).await;
    join_voice(&mut host_gw, &room).await;
    join_voice(&mut eli_gw, &room).await;
    drain(&mut eli_gw, SETTLE).await;
    let mut share = screen(&server, share_hello(&host.access_token, &host_session, 60)).await;
    assert_eq!(recv_json(&mut share).await["op"], "want");
    let mut watch = screen(
        &server,
        watch_hello(&eli.access_token, &eli_session, &host_session),
    )
    .await;
    assert_eq!(recv_json(&mut watch).await["op"], "showing");

    leave_voice(&mut eli_gw).await;
    assert_eq!(closed_with(&mut watch).await, Some(4007));
    leave_voice(&mut host_gw).await;
    assert_eq!(closed_with(&mut share).await, Some(4007));
}

#[tokio::test]
async fn voice_state_names_no_window_and_no_application() {
    // Hard rule 2: what a peer carries is a short, closed list. A field that
    // could hold a window's title or an app's name fails here first.
    let (server, host, room) = common::voice_server_with_room("rules").await;
    let room = room.id.to_string();
    let (mut gw, session) = gateway(&server, &host.access_token).await;
    join_voice(&mut gw, &room).await;
    drain(&mut gw, SETTLE).await;
    let mut share = screen(&server, share_hello(&host.access_token, &session, 30)).await;
    assert_eq!(recv_json(&mut share).await["op"], "want");
    let frames = drain(&mut gw, SETTLE).await;
    let me = peer(&frames, &room, &session).expect("in voice.state");
    let keys: Vec<&str> = me.as_object().unwrap().keys().map(String::as_str).collect();
    for key in &keys {
        assert!(
            [
                "session_id",
                "user_id",
                "controls",
                "forwarded",
                "screen",
                "watching"
            ]
            .contains(key),
            "voice.state carries `{key}`"
        );
    }
    let screen_keys: Vec<&String> = me["screen"].as_object().unwrap().keys().collect();
    assert_eq!(screen_keys, vec!["fps"]);
}

#[tokio::test]
async fn the_server_says_whether_it_passes_screens_on() {
    let (server, host, _room) = common::voice_server_with_room("x").await;
    let info: Value = reqwest::Client::new()
        .get(server.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["screens"], json!(true));

    let (plain, host, _room) = common::server_with_room("y").await;
    let info: Value = reqwest::Client::new()
        .get(plain.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["screens"], json!(false));
}

#[tokio::test]
async fn a_host_can_turn_screens_off() {
    // LINGER_SCREENS=off (#360): voice carries on, nobody shares, and the
    // app is told so in GET /server before anybody tries.
    let (server, host, room) =
        common::voice_server_tuned("quiet", |config| config.screens = false).await;
    let room = room.id.to_string();
    let info: Value = reqwest::Client::new()
        .get(server.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["voice"], json!(true));
    assert_eq!(info["screens"], json!(false));
    let (mut gw, session) = gateway(&server, &host.access_token).await;
    join_voice(&mut gw, &room).await;
    drain(&mut gw, SETTLE).await;
    let mut ws = screen(&server, share_hello(&host.access_token, &session, 30)).await;
    assert_eq!(closed_with(&mut ws).await, Some(4008));
}

/// Read until the server says it's still there, answering its pings as the
/// web engines do; false if it doesn't within five seconds.
async fn hears_alive(ws: &mut Ws) -> bool {
    let until = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(until, ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let said: Value = serde_json::from_str(text.as_str()).expect("valid json");
                if said["op"] == "alive" {
                    return true;
                }
            }
            Ok(Some(Ok(_))) => {}
            _ => return false,
        }
    }
}

#[tokio::test]
async fn a_screen_socket_hears_it_is_still_there_and_one_that_stops_answering_is_let_go() {
    const ALIVE: Duration = Duration::from_millis(200);
    let (server, host, room) =
        common::voice_server_tuned("porch", |config| config.screen_alive = ALIVE).await;
    let room = room.id.to_string();
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    let (mut eli_gw, eli_session) = gateway(&server, &eli.access_token).await;
    join_voice(&mut host_gw, &room).await;
    join_voice(&mut eli_gw, &room).await;
    drain(&mut host_gw, SETTLE).await;
    let mut share = screen(&server, share_hello(&host.access_token, &host_session, 30)).await;
    assert_eq!(recv_json(&mut share).await["op"], "want");
    let mut watch = screen(
        &server,
        watch_hello(&eli.access_token, &eli_session, &host_session),
    )
    .await;
    assert_eq!(recv_json(&mut watch).await["op"], "showing");
    // Both hear it's still there, though nothing else is said: a still
    // screen sends nothing, and a watcher asks nothing.
    assert!(hears_alive(&mut share).await);
    assert!(hears_alive(&mut watch).await);
    drain(&mut host_gw, SETTLE).await;
    // Eli's line dies without closing: nothing is read from the watch
    // socket any more, so no ping is answered. The share goes on answering.
    // Within half a minute's worth of the server's asks (here a little over
    // a second) the watch is let go, and the room is told Eli isn't watching.
    let until =
        tokio::time::Instant::now() + ALIVE * (linger_core::limits::SCREEN_ALIVE_MISSED + 3);
    while let Ok(Some(Ok(_))) = tokio::time::timeout_at(until, share.next()).await {}
    let frames = drain(&mut host_gw, SETTLE).await;
    let eli_now = peer(&frames, &room, &eli_session).expect("eli in voice.state");
    assert!(eli_now["watching"].is_null(), "{eli_now:?}");
    // The share, which answered, carries on.
    assert!(hears_alive(&mut share).await);
    drop(watch);
}

#[tokio::test]
async fn a_frame_over_the_biggest_is_dropped_and_the_share_carries_on() {
    let (server, host, room) = common::voice_server_with_room("studio").await;
    let room = room.id.to_string();
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    let (mut eli_gw, eli_session) = gateway(&server, &eli.access_token).await;
    join_voice(&mut host_gw, &room).await;
    join_voice(&mut eli_gw, &room).await;
    drain(&mut host_gw, SETTLE).await;
    let mut share = screen(&server, share_hello(&host.access_token, &host_session, 30)).await;
    assert_eq!(recv_json(&mut share).await["op"], "want");
    let mut watch = screen(
        &server,
        watch_hello(&eli.access_token, &eli_session, &host_session),
    )
    .await;
    assert_eq!(recv_json(&mut watch).await["op"], "showing");
    // A key frame a byte over the biggest goes nowhere, and closes nothing.
    let mut big = frame(1, true, 9);
    big.resize(linger_core::limits::MAX_SCREEN_FRAME_BYTES + 1, 9);
    share
        .send(WsMessage::Binary(big.into()))
        .await
        .expect("sent");
    share
        .send(WsMessage::Binary(frame(1, true, 5).into()))
        .await
        .expect("still open");
    let got = next_binary(&mut watch).await;
    assert_eq!(got.len(), frame(1, true, 5).len());
    assert_eq!(got[12], 5);
}

#[tokio::test]
async fn too_many_screen_sockets_in_a_minute_says_so_rather_than_a_bad_hello() {
    let (server, host, room) = common::voice_server_with_room("busy").await;
    let room = room.id.to_string();
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    join_voice(&mut host_gw, &room).await;
    drain(&mut host_gw, SETTLE).await;
    let (allowed, _) = linger_core::limits::RATE_SCREEN_HELLO;
    for _ in 0..allowed {
        let mut ws = screen(&server, share_hello(&host.access_token, &host_session, 30)).await;
        assert_eq!(recv_json(&mut ws).await["op"], "want");
    }
    let mut ws = screen(&server, share_hello(&host.access_token, &host_session, 30)).await;
    assert_eq!(closed_with(&mut ws).await, Some(4009));
}

/// A packet of the computer's sound as an app sends one (#736): the 12-byte
/// header, kind 2 and Opus, then some sound.
fn sound(fill: u8) -> Vec<u8> {
    let mut bytes = vec![2, 1, 0, 0];
    bytes.extend_from_slice(&7u64.to_be_bytes());
    bytes.extend_from_slice(&[fill; 40]);
    bytes
}

fn sound_share_hello(token: &str, session: &str) -> Value {
    json!({"op": "share", "token": token, "session_id": session, "fps": 30, "encode": ["vp8"], "sound": true})
}

fn sound_watch_hello(token: &str, session: &str, target: &str) -> Value {
    json!({"op": "watch", "token": token, "session_id": session, "target": target, "decode": ["vp8"], "sound": true})
}

/// A member in the room's voice: their gateway, session and access token.
async fn in_voice(
    server: &common::TestServer,
    host: &str,
    name: &str,
    room: &str,
) -> (Ws, String, String) {
    let member = common::join_member(server, host, name).await;
    let (mut gw, session) = gateway(server, &member.access_token).await;
    join_voice(&mut gw, room).await;
    (gw, session, member.access_token)
}

#[tokio::test]
async fn a_shares_sound_reaches_the_watchers_who_asked_and_nobody_else() {
    let (server, host, room) = common::voice_server_with_room("cinema").await;
    let room = room.id.to_string();
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    join_voice(&mut host_gw, &room).await;
    let (_eli_gw, eli_session, eli) = in_voice(&server, &host.access_token, "eli", &room).await;
    let (_dave_gw, dave_session, dave) = in_voice(&server, &host.access_token, "dave", &room).await;
    let (_sam_gw, sam_session, sam) = in_voice(&server, &host.access_token, "sam", &room).await;
    let (_kim_gw, kim_session, kim) = in_voice(&server, &host.access_token, "kim", &room).await;
    drain(&mut host_gw, SETTLE).await;

    // The host shares with sound. Nobody watching: asked for nothing.
    let mut share = screen(
        &server,
        sound_share_hello(&host.access_token, &host_session),
    )
    .await;
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": []})
    );

    // Dave watches without asking for sound: the share asks for pictures
    // alone, and Dave is told the share carries sound.
    let mut dave_watch = screen(&server, watch_hello(&dave, &dave_session, &host_session)).await;
    assert_eq!(
        recv_json(&mut dave_watch).await,
        json!({"op": "showing", "target": host_session, "codec": "vp8", "sound": true})
    );
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": ["vp8"]})
    );
    assert_eq!(recv_json(&mut share).await["op"], "keyframe");

    // Eli watches and asks: the share is told to send its sound.
    let mut eli_watch = screen(
        &server,
        sound_watch_hello(&eli, &eli_session, &host_session),
    )
    .await;
    assert_eq!(
        recv_json(&mut eli_watch).await,
        json!({"op": "showing", "target": host_session, "codec": "vp8", "sound": true})
    );
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": ["vp8"], "sound": true})
    );

    // Sam shares with sound too, and Kim watches Sam's, asking for it.
    let mut sam_share = screen(&server, sound_share_hello(&sam, &sam_session)).await;
    assert_eq!(recv_json(&mut sam_share).await["op"], "want");
    let mut kim_watch = screen(&server, sound_watch_hello(&kim, &kim_session, &sam_session)).await;
    assert_eq!(recv_json(&mut kim_watch).await["op"], "showing");

    // Sound, then a key frame: Eli hears the sound before any picture, with
    // no key frame first; Dave gets the picture alone.
    share
        .send(WsMessage::Binary(sound(5).into()))
        .await
        .unwrap();
    share
        .send(WsMessage::Binary(frame(1, true, 6).into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut eli_watch).await, sound(5));
    assert_eq!(next_binary(&mut eli_watch).await, frame(1, true, 6));
    assert_eq!(next_binary(&mut dave_watch).await, frame(1, true, 6));
    // Kim, watching Sam's share, hears Sam's sound and none of the host's.
    sam_share
        .send(WsMessage::Binary(sound(8).into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut kim_watch).await, sound(8));

    // Eli turns the sound off: the share is told nobody wants it, and Eli
    // gets pictures alone.
    eli_watch
        .send(WsMessage::Text(
            json!({"op": "sound", "on": false}).to_string().into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": ["vp8"]})
    );
    share
        .send(WsMessage::Binary(sound(9).into()))
        .await
        .unwrap();
    share
        .send(WsMessage::Binary(frame(1, false, 10).into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut eli_watch).await, frame(1, false, 10));
}

#[tokio::test]
async fn sound_from_a_share_that_never_said_so_or_from_a_watcher_goes_nowhere() {
    let (server, host, room) = common::voice_server_with_room("hush").await;
    let room = room.id.to_string();
    let (mut host_gw, host_session) = gateway(&server, &host.access_token).await;
    join_voice(&mut host_gw, &room).await;
    let (_eli_gw, eli_session, eli) = in_voice(&server, &host.access_token, "eli", &room).await;
    let (_dave_gw, dave_session, dave) = in_voice(&server, &host.access_token, "dave", &room).await;
    drain(&mut host_gw, SETTLE).await;

    // A share from an app from before sound: its hello says nothing of it.
    let mut share = screen(&server, share_hello(&host.access_token, &host_session, 30)).await;
    assert_eq!(recv_json(&mut share).await["op"], "want");
    // Eli asks for sound all the same: Eli isn't told there's any, and the
    // share isn't asked for it.
    let mut eli_watch = screen(
        &server,
        sound_watch_hello(&eli, &eli_session, &host_session),
    )
    .await;
    assert_eq!(
        recv_json(&mut eli_watch).await,
        json!({"op": "showing", "target": host_session, "codec": "vp8"})
    );
    assert_eq!(
        recv_json(&mut share).await,
        json!({"op": "want", "codecs": ["vp8"]})
    );
    let mut dave_watch = screen(
        &server,
        sound_watch_hello(&dave, &dave_session, &host_session),
    )
    .await;
    assert_eq!(recv_json(&mut dave_watch).await["op"], "showing");

    // Sound it sends anyway goes nowhere, and closes nothing; nor does
    // anything binary from a watcher's socket. The frame after reaches both.
    share
        .send(WsMessage::Binary(sound(1).into()))
        .await
        .unwrap();
    dave_watch
        .send(WsMessage::Binary(sound(2).into()))
        .await
        .unwrap();
    dave_watch
        .send(WsMessage::Binary(frame(1, true, 3).into()))
        .await
        .unwrap();
    share
        .send(WsMessage::Binary(frame(1, true, 4).into()))
        .await
        .unwrap();
    assert_eq!(next_binary(&mut eli_watch).await, frame(1, true, 4));
    assert_eq!(next_binary(&mut dave_watch).await, frame(1, true, 4));
}

#[tokio::test]
async fn the_server_says_it_passes_a_screens_sound_on() {
    // An app finds sound in GET /server before offering it (PROTOCOL §9).
    let (server, host, _room) = common::voice_server_with_room("x").await;
    let info: Value = reqwest::Client::new()
        .get(server.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["screen_sound"], json!(true));
    let (quiet, host, _room) =
        common::voice_server_tuned("q", |config| config.screens = false).await;
    let info: Value = reqwest::Client::new()
        .get(quiet.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["screen_sound"], json!(false));
}
