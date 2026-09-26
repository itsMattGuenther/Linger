//! DMs and group DMs (SPEC §4.13, PROTOCOL §3.1, T-1301).
//!
//! T-1301's acceptance criterion is one sentence with three halves: a third
//! member's socket **never receives a DM frame**, **cannot fetch its messages
//! by id**, and **cannot list it**. Each has a test here, and the socket one is
//! the reason this file drives real WebSockets rather than asserting on a
//! function.
//!
//! Everything is written from the outsider's side on purpose. It is easy to
//! write a test that proves two people can talk to each other and call it a
//! private conversation; the only tests that mean anything are the ones where
//! somebody who should see nothing sees nothing.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{ErrorCode, ErrorEnvelope, Room, RoomKind};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Long enough that a frame the server was going to send has been sent. The
/// bus is in-process and a local socket is microseconds; a quarter of a second
/// is a very large multiple of that.
const SETTLE: Duration = Duration::from_millis(250);

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

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(WsMessage::Text(value.to_string().into()))
        .await
        .expect("ws send");
}

/// Every frame that turns up inside `window`. An empty answer is the point of
/// most of the calls below.
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
            return (ws, frame["d"].clone());
        }
    }
}

async fn make_dm(server: &common::TestServer, token: &str, with: &[&str]) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url("/dms"))
        .bearer_auth(token)
        .json(&json!({ "user_ids": with }))
        .send()
        .await
        .unwrap()
}

async fn dm_with(server: &common::TestServer, token: &str, with: &[&str]) -> Room {
    let resp = make_dm(server, token, with).await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn list_dms(server: &common::TestServer, token: &str) -> Vec<Room> {
    reqwest::Client::new()
        .get(server.url("/dms"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn say(
    server: &common::TestServer,
    token: &str,
    room: &str,
    body: &str,
) -> reqwest::Response {
    reqwest::Client::new()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap()
}

/// Host + two members. The third is the one who must never see anything.
async fn three_people(
    server: &common::TestServer,
    host: &linger_core::wire::AuthResponse,
) -> (
    linger_core::wire::AuthResponse,
    linger_core::wire::AuthResponse,
) {
    let callie = common::join_member(server, &host.access_token, "callie").await;
    let dave = common::join_member(server, &host.access_token, "dave").await;
    (callie, dave)
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

#[tokio::test]
async fn asking_twice_for_the_same_people_gives_the_same_dm() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;

    let first = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;
    let again = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;
    assert_eq!(first.id, again.id, "create-or-find, not create-again");

    // And from the other side: the order the members are named in cannot make
    // a second conversation, which is the whole job of the sorted member key.
    let from_callie = dm_with(&server, &callie.access_token, &[&host.user.id.to_string()]).await;
    assert_eq!(first.id, from_callie.id);

    // A different set is a different DM, including a superset.
    let group = dm_with(
        &server,
        &host.access_token,
        &[&callie.user.id.to_string(), &dave.user.id.to_string()],
    )
    .await;
    assert_ne!(group.id, first.id);
    let group_reordered = dm_with(
        &server,
        &dave.access_token,
        &[&host.user.id.to_string(), &callie.user.id.to_string()],
    )
    .await;
    assert_eq!(group.id, group_reordered.id);
}

#[tokio::test]
async fn a_dm_says_what_it_is_and_who_is_in_it() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, _dave) = three_people(&server, &host).await;

    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;
    assert_eq!(dm.kind, RoomKind::Dm);
    let mut members = dm.member_ids.clone().expect("a DM lists its members");
    members.sort();
    let mut expected = vec![host.user.id, callie.user.id];
    expected.sort();
    assert_eq!(members, expected);

    // A room is the other way round on both counts.
    let rooms: Vec<Room> = reqwest::Client::new()
        .get(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(rooms.iter().all(|r| r.kind == RoomKind::Room));
    assert!(
        rooms.iter().all(|r| r.member_ids.is_none()),
        "a room's members are everybody, and the absence is the information"
    );
}

#[tokio::test]
async fn the_lists_do_not_mix() {
    let (server, host, room) = common::server_with_room("garage").await;
    let (callie, _dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    // `GET /rooms` never carries a DM — not "filters them out", cannot produce
    // one (PROTOCOL §3).
    let rooms: Vec<Room> = reqwest::Client::new()
        .get(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(rooms.iter().any(|r| r.id == room.id));
    assert!(rooms.iter().all(|r| r.id != dm.id));

    // And `GET /dms` never carries a room.
    let dms = list_dms(&server, &host.access_token).await;
    assert_eq!(dms.len(), 1);
    assert_eq!(dms[0].id, dm.id);
}

#[tokio::test]
async fn the_membership_rules_are_enforced_with_sentences() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, _dave) = three_people(&server, &host).await;

    // Nobody to send it to.
    let resp = make_dm(&server, &host.access_token, &[]).await;
    assert_eq!(resp.status(), 422);

    // Naming yourself.
    let resp = make_dm(&server, &host.access_token, &[&host.user.id.to_string()]).await;
    assert_eq!(resp.status(), 422);

    // The same person twice.
    let twice = callie.user.id.to_string();
    let resp = make_dm(&server, &host.access_token, &[&twice, &twice]).await;
    assert_eq!(resp.status(), 422);

    // Somebody who is not on this server.
    let stranger = linger_core::UserId::new().to_string();
    let resp = make_dm(&server, &host.access_token, &[&stranger]).await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn a_group_dm_stops_at_eight() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let mut others = Vec::new();
    for n in 0..8 {
        let member = common::join_member(&server, &host.access_token, &format!("m{n}")).await;
        others.push(member.user.id.to_string());
    }

    // Seven others plus the caller is eight, which is the ceiling.
    let ok: Vec<&str> = others[..7].iter().map(String::as_str).collect();
    assert_eq!(
        make_dm(&server, &host.access_token, &ok).await.status(),
        200
    );

    // Eight others is nine, which is a room.
    let too_many: Vec<&str> = others.iter().map(String::as_str).collect();
    let resp = make_dm(&server, &host.access_token, &too_many).await;
    assert_eq!(resp.status(), 422);
    let body: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(body.error.code, ErrorCode::ValidationFailed);
}

#[tokio::test]
async fn the_dm_slug_prefix_is_reserved() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let resp = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "dm-sneaky", "name": "sneaky" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
}

// ---------------------------------------------------------------------------
// The acceptance criterion: a third member sees nothing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_non_member_cannot_list_a_dm() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    // Dave's list is empty, and stays empty.
    assert!(list_dms(&server, &dave.access_token).await.is_empty());

    // Including in the frame he gets the moment he connects.
    let (_ws, ready) = connect_ready(&server, &dave.access_token).await;
    let dms = ready["dms"].as_array().expect("ready carries dms");
    assert!(dms.is_empty(), "a stranger's ready frame has no DMs in it");
    let rooms = ready["rooms"].as_array().expect("ready carries rooms");
    assert!(
        rooms.iter().all(|r| r["id"] != json!(dm.id.to_string())),
        "and the room list is not a back door to the same thing"
    );
}

#[tokio::test]
async fn a_non_member_cannot_fetch_a_dms_messages() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;
    let dm_id = dm.id.to_string();

    assert_eq!(
        say(&server, &host.access_token, &dm_id, "just us")
            .await
            .status(),
        200
    );

    // A member reads it.
    let mine: Vec<Value> = reqwest::Client::new()
        .get(server.url(&format!("/rooms/{dm_id}/messages")))
        .bearer_auth(&callie.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(mine.len(), 1);

    // Dave gets 404 — **not 403**, which would confirm there is something
    // there to be refused (PROTOCOL §3.1).
    let resp = reqwest::Client::new()
        .get(server.url(&format!("/rooms/{dm_id}/messages")))
        .bearer_auth(&dave.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let body: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(body.error.code, ErrorCode::NotFound);

    // And he cannot post into it either.
    assert_eq!(
        say(&server, &dave.access_token, &dm_id, "hello?")
            .await
            .status(),
        404
    );
}

#[tokio::test]
async fn a_non_member_cannot_touch_a_dms_messages_by_id() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    let posted: Value = say(&server, &host.access_token, &dm.id.to_string(), "just us")
        .await
        .json()
        .await
        .unwrap();
    let message_id = posted["id"].as_str().unwrap().to_string();

    // A message id is a bare UUID and says nothing about which room it is in,
    // so every route that takes one is a way in if it does not check.
    let client = reqwest::Client::new();
    let cases: Vec<(&str, reqwest::RequestBuilder)> = vec![
        (
            "pin",
            client.post(server.url(&format!("/messages/{message_id}/pin"))),
        ),
        (
            "unpin",
            client.delete(server.url(&format!("/messages/{message_id}/pin"))),
        ),
        (
            "react",
            client.put(server.url(&format!("/messages/{message_id}/reactions/heart"))),
        ),
        (
            "unreact",
            client.delete(server.url(&format!("/messages/{message_id}/reactions/heart"))),
        ),
        (
            "delete",
            client.delete(server.url(&format!("/messages/{message_id}"))),
        ),
    ];
    for (what, request) in cases {
        let status = request
            .bearer_auth(&dave.access_token)
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(status, 404, "{what} let a non-member through");
    }

    // Editing needs a body, so it is its own call.
    let status = client
        .patch(server.url(&format!("/messages/{message_id}")))
        .bearer_auth(&dave.access_token)
        .json(&json!({ "body": "not yours" }))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404, "edit let a non-member through");

    // And a read marker is a way to ask "is this id real", which is the same
    // question wearing a hat.
    let status = client
        .put(server.url(&format!("/rooms/{}/read", dm.id)))
        .bearer_auth(&dave.access_token)
        .json(&json!({ "last_read_id": message_id }))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404, "the read marker let a non-member through");
}

#[tokio::test]
async fn a_non_members_socket_never_receives_a_dm_frame() {
    let (server, host, room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;

    // Dave is connected and watching before the DM exists, so he would see the
    // announcement too if it were fanned out to everybody.
    let (mut dave_ws, _) = connect_ready(&server, &dave.access_token).await;
    let (mut callie_ws, _) = connect_ready(&server, &callie.access_token).await;
    drain(&mut dave_ws, SETTLE).await;
    drain(&mut callie_ws, SETTLE).await;

    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;
    let dm_id = dm.id.to_string();

    // Everything that happens inside a DM, in one go.
    let posted: Value = say(&server, &host.access_token, &dm_id, "just us")
        .await
        .json()
        .await
        .unwrap();
    let message_id = posted["id"].as_str().unwrap().to_string();
    reqwest::Client::new()
        .put(server.url(&format!("/messages/{message_id}/reactions/heart")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    reqwest::Client::new()
        .patch(server.url(&format!("/messages/{message_id}")))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "just us, edited" }))
        .send()
        .await
        .unwrap();
    reqwest::Client::new()
        .delete(server.url(&format!("/messages/{message_id}")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();

    // Callie is in it, so she got the lot.
    let hers = drain(&mut callie_ws, SETTLE).await;
    let ops: Vec<&str> = hers.iter().filter_map(|f| f["op"].as_str()).collect();
    assert!(
        ops.contains(&"room.create"),
        "a member is told the DM exists"
    );
    assert!(
        ops.contains(&"message.create"),
        "and hears what is said in it"
    );
    assert!(ops.contains(&"reaction.update"));
    assert!(ops.contains(&"message.update"));
    assert!(ops.contains(&"message.delete"));

    // Dave is not, so he got none of it — and this is the assertion the whole
    // task is for.
    let his = drain(&mut dave_ws, SETTLE).await;
    for frame in &his {
        let text = frame.to_string();
        assert!(
            !text.contains(&dm_id),
            "a non-member's socket received a frame naming a DM: {frame}"
        );
        assert!(
            !text.contains(&message_id),
            "a non-member's socket received a frame naming a DM's message: {frame}"
        );
        assert!(
            !text.contains("just us"),
            "a non-member's socket received a DM's words: {frame}"
        );
    }

    // The room next door still works, which is the other half of "the filter is
    // right" — a filter that drops everything would pass the test above.
    say(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "in the open",
    )
    .await;
    let after = drain(&mut dave_ws, SETTLE).await;
    assert!(
        after
            .iter()
            .any(|f| f["op"] == "message.create" && f["d"]["body"] == "in the open"),
        "a public room's messages still reach everybody"
    );
}

/// Being in a DM is being **around**, to everybody, the DM's own people
/// included (Matt, 2026-09-26): nobody learns that somebody is DMing, let alone
/// with whom. The old client named them. And the person is not hidden: they
/// are still there, just not anywhere in particular.
#[tokio::test]
async fn being_in_a_dm_reads_as_around_to_everybody() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    let (mut dave_ws, _) = connect_ready(&server, &dave.access_token).await;
    let (mut callie_ws, _) = connect_ready(&server, &callie.access_token).await;
    let (mut host_ws, _) = connect_ready(&server, &host.access_token).await;
    drain(&mut dave_ws, SETTLE).await;
    drain(&mut callie_ws, SETTLE).await;

    // The host walks into the DM.
    send_json(
        &mut host_ws,
        json!({ "op": "room.focus", "d": { "room_id": dm.id.to_string() } }),
    )
    .await;

    for (who, ws) in [("a member", &mut callie_ws), ("a stranger", &mut dave_ws)] {
        let frames = drain(ws, SETTLE).await;
        let seen = frames
            .iter()
            .find(|f| {
                f["op"] == "presence.update" && f["d"]["user_id"] == json!(host.user.id.to_string())
            })
            .unwrap_or_else(|| panic!("{who} still hears that somebody is around"));
        assert_eq!(
            seen["d"]["state"], "around",
            "{who} was told somebody is in a room"
        );
        assert_eq!(
            seen["d"]["room_id"],
            Value::Null,
            "{who} was told which DM somebody is in"
        );
        assert!(
            !frames.iter().any(|f| f["op"] == "room.occupancy"
                || f["op"] == "room.enter"
                || f["op"] == "room.leave"),
            "{who} was told who is standing in a DM: {frames:?}"
        );
    }
}

/// The `ready` frame is a frame like any other, and it was not being filtered
/// like one. Found while building T-1302: the live `presence.update` path goes
/// through `visible_to` and the snapshot did not, so a client connecting *while*
/// somebody stood in a DM was handed that DM's id in its very first frame.
///
/// The order here is the whole test — the stranger connects **after** the DM is
/// already occupied, which is the case the live path never covers.
#[tokio::test]
async fn the_ready_snapshot_is_redacted_like_every_other_frame() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    // The host goes and stands in the DM first.
    let (mut host_ws, _) = connect_ready(&server, &host.access_token).await;
    send_json(
        &mut host_ws,
        json!({ "op": "room.focus", "d": { "room_id": dm.id.to_string() } }),
    )
    .await;
    tokio::time::sleep(SETTLE).await;

    // Now a stranger arrives and gets the snapshot.
    let (_dave_ws, dave_ready) = connect_ready(&server, &dave.access_token).await;
    let presence = dave_ready["presence"]
        .as_array()
        .expect("presence snapshot");
    let host_entry = presence
        .iter()
        .find(|e| e["user_id"] == json!(host.user.id.to_string()))
        .expect("a stranger still sees that somebody is around");
    assert_eq!(
        host_entry["room_id"],
        Value::Null,
        "the ready snapshot handed a stranger a DM's id"
    );

    assert_eq!(host_entry["state"], "around");

    // A member's snapshot says the same: being in a DM is being around, to
    // everybody (see above).
    let (_callie_ws, callie_ready) = connect_ready(&server, &callie.access_token).await;
    let seen = callie_ready["presence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["user_id"] == json!(host.user.id.to_string()))
        .expect("a member sees the host");
    assert_eq!(seen["room_id"], Value::Null);
    assert_eq!(seen["state"], "around");
}

#[tokio::test]
async fn an_outsider_cannot_stand_in_a_dm_or_type_in_it() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    let (mut callie_ws, _) = connect_ready(&server, &callie.access_token).await;
    let (mut dave_ws, _) = connect_ready(&server, &dave.access_token).await;
    drain(&mut callie_ws, SETTLE).await;

    // Dave points his client at a DM he is not in and starts typing. Both are
    // frames a client sends, so a broken or lying client can send them.
    send_json(
        &mut dave_ws,
        json!({ "op": "room.focus", "d": { "room_id": dm.id.to_string() } }),
    )
    .await;
    send_json(
        &mut dave_ws,
        json!({ "op": "typing.start", "d": { "room_id": dm.id.to_string() } }),
    )
    .await;

    // Callie, who is in the DM, sees no sign of him in it.
    let hers = drain(&mut callie_ws, SETTLE).await;
    for frame in &hers {
        assert!(
            frame["op"] != "typing",
            "an outsider made a typing line appear in a DM: {frame}"
        );
        if frame["op"] == "room.occupancy" && frame["d"]["room_id"] == json!(dm.id.to_string()) {
            let ids = frame["d"]["user_ids"].as_array().unwrap();
            assert!(
                !ids.contains(&json!(dave.user.id.to_string())),
                "an outsider appeared in a DM's occupancy: {frame}"
            );
        }
    }
}

#[tokio::test]
async fn the_host_is_not_an_exception() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, dave) = three_people(&server, &host).await;

    // A DM between two members. The host is not in it, and being the host is
    // not a way in (SPEC §4.13).
    let dm = dm_with(&server, &callie.access_token, &[&dave.user.id.to_string()]).await;
    let dm_id = dm.id.to_string();
    say(&server, &callie.access_token, &dm_id, "not for the host").await;

    assert!(list_dms(&server, &host.access_token).await.is_empty());
    let status = reqwest::Client::new()
        .get(server.url(&format!("/rooms/{dm_id}/messages")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404);

    // And the host's own controls do not reach inside one: renaming,
    // re-ordering or archiving somebody's conversation are all the host
    // reaching into a private space.
    let client = reqwest::Client::new();
    let status = client
        .patch(server.url(&format!("/rooms/{dm_id}")))
        .bearer_auth(&host.access_token)
        .json(&json!({ "name": "the host was here" }))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404, "the host renamed a DM");

    let status = client
        .post(server.url(&format!("/rooms/{dm_id}/archive")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404, "the host archived a DM");
}

#[tokio::test]
async fn a_removed_member_stops_seeing_a_dm_and_a_restored_one_gets_it_back() {
    let (server, host, _room) = common::server_with_room("garage").await;
    let (callie, _dave) = three_people(&server, &host).await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;

    assert_eq!(list_dms(&server, &callie.access_token).await.len(), 1);

    let client = reqwest::Client::new();
    let status = client
        .post(server.url(&format!("/users/{}/remove", callie.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 204);

    // She has to sign in again to have a token at all, and cannot — which is
    // T-413's business. What this test is for is the row: the membership
    // survives removal on purpose, and `restore` is what makes that pay.
    let members = list_dms(&server, &host.access_token).await[0]
        .member_ids
        .clone()
        .unwrap();
    assert_eq!(
        members,
        vec![host.user.id],
        "a removed member is not a member while they are removed"
    );

    let status = client
        .post(server.url(&format!("/users/{}/restore", callie.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 204);

    let mut back = list_dms(&server, &host.access_token).await[0]
        .member_ids
        .clone()
        .unwrap();
    back.sort();
    let mut expected = vec![host.user.id, callie.user.id];
    expected.sort();
    assert_eq!(
        back, expected,
        "restore puts somebody back into the DMs they were in"
    );
    assert_eq!(
        dm.id,
        list_dms(&server, &host.access_token).await[0].id,
        "and it is the same DM, not a new one"
    );
}
