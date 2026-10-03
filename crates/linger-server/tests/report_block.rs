//! Report and block (SPEC §4.15, PROTOCOL §5, T-1605) over real HTTP and real
//! WebSockets, against a temporary SQLite file.
//!
//! What matters is who hears what. A block is private: the person blocked is
//! never told, and only the blocker's own sessions hear of it. A report reaches
//! the host and nobody else, and nothing in it is a count.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{Message, Report};
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

async fn wait_for(ws: &mut Ws, op: &str) -> Value {
    loop {
        let frame = recv_json(ws).await;
        if frame["op"] == op {
            return frame;
        }
    }
}

/// Everything that arrives inside `window`: the only way to show a frame went
/// nowhere is to wait and look at what did.
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

async fn connect_ready(server: &common::TestServer, token: &str) -> Ws {
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
    wait_for(&mut ws, "ready").await;
    ws
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn say(server: &common::TestServer, token: &str, room: &str, body: &str) -> Message {
    let resp = client()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn report(server: &common::TestServer, token: &str, body: Value) -> reqwest::Response {
    client()
        .post(server.url("/reports"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn open_reports(server: &common::TestServer, token: &str) -> reqwest::Response {
    client()
        .get(server.url("/reports"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

async fn blocks(server: &common::TestServer, token: &str) -> Vec<String> {
    client()
        .get(server.url("/me/blocks"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn set_block(
    server: &common::TestServer,
    token: &str,
    who: impl std::fmt::Display,
    on: bool,
) -> u16 {
    let url = server.url(&format!("/me/blocks/{who}"));
    let request = if on {
        client().put(url)
    } else {
        client().delete(url)
    };
    request
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn code_of(resp: reqwest::Response) -> String {
    let body: Value = resp.json().await.expect("error envelope");
    body["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn a_block_is_your_own_list_and_nobody_elses() {
    let (server, host, _room) = common::server_with_room("porch").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;

    assert!(blocks(&server, &callie.access_token).await.is_empty());
    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, true).await,
        204
    );
    // Again changes nothing.
    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, true).await,
        204
    );
    assert_eq!(
        blocks(&server, &callie.access_token).await,
        vec![dex.user.id.to_string()]
    );
    // Nobody else's list has it, Dex's included.
    assert!(blocks(&server, &dex.access_token).await.is_empty());
    assert!(blocks(&server, &host.access_token).await.is_empty());

    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, false).await,
        204
    );
    assert!(blocks(&server, &callie.access_token).await.is_empty());
    // Unblocking somebody not blocked changes nothing either.
    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, false).await,
        204
    );
}

#[tokio::test]
async fn you_cant_block_yourself_or_somebody_who_isnt_here() {
    let (server, host, _room) = common::server_with_room("porch").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;

    let resp = client()
        .put(server.url(&format!("/me/blocks/{}", callie.user.id)))
        .bearer_auth(&callie.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
    assert_eq!(code_of(resp).await, "VALIDATION_FAILED");

    let stranger = linger_core::UserId::new();
    let resp = client()
        .put(server.url(&format!("/me/blocks/{stranger}")))
        .bearer_auth(&callie.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

/// A block made on one device holds on the blocker's others at once. The
/// person blocked hears nothing, and neither does anybody else.
#[tokio::test]
async fn a_block_reaches_the_blockers_sessions_and_nobody_elses() {
    let (server, host, _room) = common::server_with_room("porch").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;

    let mut phone = connect_ready(&server, &callie.access_token).await;
    let mut computer = connect_ready(&server, &callie.access_token).await;
    let mut blocked = connect_ready(&server, &dex.access_token).await;
    let mut bystander = connect_ready(&server, &host.access_token).await;

    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, true).await,
        204
    );
    for ws in [&mut phone, &mut computer] {
        let frame = wait_for(ws, "block.update").await;
        assert_eq!(frame["d"]["user_id"], dex.user.id.to_string());
        assert_eq!(frame["d"]["blocked"], true);
    }
    for ws in [&mut blocked, &mut bystander] {
        let frames = drain_for(ws, Duration::from_millis(400)).await;
        assert!(
            !frames.iter().any(|f| f["op"] == "block.update"),
            "a block reaches only the blocker, got {frames:?}"
        );
    }

    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, false).await,
        204
    );
    let frame = wait_for(&mut computer, "block.update").await;
    assert_eq!(frame["d"]["blocked"], false);
}

/// The server's one part in a block: a knock from somebody blocked is
/// answered like any knock, and goes nowhere.
#[tokio::test]
async fn a_blocked_persons_knock_is_answered_and_goes_nowhere() {
    let (server, host, _room) = common::server_with_room("porch").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;
    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, true).await,
        204
    );

    let mut target = connect_ready(&server, &callie.access_token).await;
    let knock = |token: String| {
        let url = server.url("/knock");
        let to = callie.user.id.to_string();
        async move {
            client()
                .post(url)
                .bearer_auth(token)
                .json(&json!({ "target_user_id": to }))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    };

    // Dex is told nothing: the same 204 as any knock.
    assert_eq!(knock(dex.access_token.clone()).await, 204);
    let frames = drain_for(&mut target, Duration::from_millis(400)).await;
    assert!(
        !frames.iter().any(|f| f["op"] == "knock"),
        "a blocked person's knock must not arrive, got {frames:?}"
    );

    // Anybody else still gets through.
    assert_eq!(knock(host.access_token.clone()).await, 204);
    let frame = wait_for(&mut target, "knock").await;
    assert_eq!(frame["d"]["from_user_id"], host.user.id.to_string());

    // Unblocked, Dex gets through again.
    assert_eq!(
        set_block(&server, &callie.access_token, dex.user.id, false).await,
        204
    );
    assert_eq!(knock(dex.access_token.clone()).await, 204);
    let frame = wait_for(&mut target, "knock").await;
    assert_eq!(frame["d"]["from_user_id"], dex.user.id.to_string());
}

/// A report reaches the host, with the message's words as they were, and
/// nobody else: not the person it's about, not a bystander.
#[tokio::test]
async fn a_report_reaches_the_host_and_only_the_host() {
    let (server, host, room) = common::server_with_room("kitchen").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;
    let room = room.id.to_string();
    let spam = say(
        &server,
        &dex.access_token,
        &room,
        "free gift cards, claim yours",
    )
    .await;

    let mut host_phone = connect_ready(&server, &host.access_token).await;
    let mut host_computer = connect_ready(&server, &host.access_token).await;
    let mut reported = connect_ready(&server, &dex.access_token).await;
    let mut reporter = connect_ready(&server, &callie.access_token).await;

    let resp = report(
        &server,
        &callie.access_token,
        json!({ "message_id": spam.id.to_string(), "note": "  I think Dex's account got hacked  " }),
    )
    .await;
    assert_eq!(resp.status(), 201);
    let sent: Report = resp.json().await.unwrap();
    assert_eq!(sent.reporter_id, callie.user.id);
    assert_eq!(sent.user_id, dex.user.id);
    assert_eq!(
        sent.note.as_deref(),
        Some("I think Dex's account got hacked")
    );

    for ws in [&mut host_phone, &mut host_computer] {
        let frame = wait_for(ws, "reports.changed").await;
        // Nothing in it, and certainly no number.
        assert_eq!(frame["d"], json!({}));
    }
    for ws in [&mut reported, &mut reporter] {
        let frames = drain_for(ws, Duration::from_millis(400)).await;
        assert!(
            !frames.iter().any(|f| f["op"] == "reports.changed"),
            "a report reaches only the host, got {frames:?}"
        );
    }

    // The words as they were, after Dex edits them away.
    let edited = client()
        .patch(server.url(&format!("/messages/{}", spam.id)))
        .bearer_auth(&dex.access_token)
        .json(&json!({ "body": "nothing to see here" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edited.status(), 200);
    let resp = open_reports(&server, &host.access_token).await;
    assert_eq!(resp.status(), 200);
    let open: Vec<Report> = resp.json().await.unwrap();
    assert_eq!(open.len(), 1);
    let message = open[0].message.as_ref().expect("the reported message");
    assert_eq!(message.id, spam.id);
    assert_eq!(message.excerpt, "free gift cards, claim yours");

    // Only the host reads them.
    for token in [&callie.access_token, &dex.access_token] {
        let resp = open_reports(&server, token).await;
        assert_eq!(resp.status(), 403);
    }
}

#[tokio::test]
async fn closing_a_report_takes_it_off_the_list_and_tells_the_host() {
    let (server, host, _room) = common::server_with_room("kitchen").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;

    let resp = report(
        &server,
        &callie.access_token,
        json!({ "user_id": dex.user.id.to_string() }),
    )
    .await;
    assert_eq!(resp.status(), 201);
    let sent: Report = resp.json().await.unwrap();
    assert!(sent.message.is_none());
    assert!(sent.note.is_none());

    let mut host_ws = connect_ready(&server, &host.access_token).await;
    // Somebody else can't close it.
    let resp = client()
        .delete(server.url(&format!("/reports/{}", sent.id)))
        .bearer_auth(&callie.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);

    let resp = client()
        .delete(server.url(&format!("/reports/{}", sent.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
    wait_for(&mut host_ws, "reports.changed").await;
    let open: Vec<Report> = open_reports(&server, &host.access_token)
        .await
        .json()
        .await
        .unwrap();
    assert!(open.is_empty());

    // Closing it again changes nothing, and says nothing.
    let resp = client()
        .delete(server.url(&format!("/reports/{}", sent.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
    let frames = drain_for(&mut host_ws, Duration::from_millis(300)).await;
    assert!(
        !frames.iter().any(|f| f["op"] == "reports.changed"),
        "{frames:?}"
    );

    // One that never existed is not found.
    let resp = client()
        .delete(server.url(&format!("/reports/{}", linger_core::ReportId::new())))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn a_report_names_one_thing_you_can_see_and_isnt_yours() {
    let (server, host, room) = common::server_with_room("kitchen").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;
    let room = room.id.to_string();
    let mine = say(&server, &callie.access_token, &room, "my own words").await;
    let theirs = say(&server, &dex.access_token, &room, "dex's words").await;

    // Your own message, yourself, both or neither: refused.
    for body in [
        json!({ "message_id": mine.id.to_string() }),
        json!({ "user_id": callie.user.id.to_string() }),
        json!({ "message_id": theirs.id.to_string(), "user_id": dex.user.id.to_string() }),
        json!({}),
        json!({ "user_id": dex.user.id.to_string(), "note": "x".repeat(1001) }),
    ] {
        let resp = report(&server, &callie.access_token, body.clone()).await;
        assert_eq!(resp.status(), 422, "{body}");
        assert_eq!(code_of(resp).await, "VALIDATION_FAILED", "{body}");
    }

    // A message in a DM you're not in is as unknown as one never sent.
    let dm: Value = client()
        .post(server.url("/dms"))
        .bearer_auth(&dex.access_token)
        .json(&json!({ "user_ids": [host.user.id.to_string()] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dm_id = dm["id"].as_str().expect("a DM").to_owned();
    let private = say(&server, &dex.access_token, &dm_id, "just between us").await;
    let resp = report(
        &server,
        &callie.access_token,
        json!({ "message_id": private.id.to_string() }),
    )
    .await;
    assert_eq!(resp.status(), 404);
    let resp = report(
        &server,
        &callie.access_token,
        json!({ "message_id": linger_core::MessageId::new().to_string() }),
    )
    .await;
    assert_eq!(resp.status(), 404);

    // The host, who's in it, can report it: a report about a DM shows the host
    // that one message, which is what the reporter is asking for.
    let resp = report(
        &server,
        &host.access_token,
        json!({ "message_id": private.id.to_string() }),
    )
    .await;
    assert_eq!(resp.status(), 201);
}

/// Ten an hour for each person reporting (`RATE_REPORT_PER_HOUR`).
#[tokio::test]
async fn the_eleventh_report_inside_an_hour_is_refused() {
    let (server, host, _room) = common::server_with_room("kitchen").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dex = common::join_member(&server, &host.access_token, "dex").await;
    for attempt in 1..=10 {
        let resp = report(
            &server,
            &callie.access_token,
            json!({ "user_id": dex.user.id.to_string() }),
        )
        .await;
        assert_eq!(resp.status(), 201, "report {attempt}");
    }
    let resp = report(
        &server,
        &callie.access_token,
        json!({ "user_id": dex.user.id.to_string() }),
    )
    .await;
    assert_eq!(resp.status(), 429);
    assert_eq!(code_of(resp).await, "RATE_LIMITED");
}
