//! Co-host (#424, PROTOCOL §5) over real HTTP and real WebSockets, against a
//! temporary SQLite file.
//!
//! One switch with a fixed meaning: only the host turns it on or off, never
//! on themselves. A co-host can do what the host does in the app, except make
//! or clear co-hosts and act on the host.

mod common;

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_core::wire::{AuthResponse, Invite, Message, Report, Room, User};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn client() -> reqwest::Client {
    reqwest::Client::new()
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

/// Turn the switch on or off for somebody, as whoever `token` is.
async fn set_cohost(
    server: &common::TestServer,
    token: &str,
    who: impl std::fmt::Display,
    on: bool,
) -> reqwest::Response {
    let url = server.url(&format!("/users/{who}/cohost"));
    let request = if on {
        client().put(url)
    } else {
        client().delete(url)
    };
    request.bearer_auth(token).send().await.unwrap()
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

async fn invite(server: &common::TestServer, token: &str) -> Invite {
    client()
        .post(server.url("/invites"))
        .bearer_auth(token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// A host, a room, and two members, one of them made a co-host by the host.
async fn with_a_cohost() -> (
    common::TestServer,
    AuthResponse,
    Room,
    AuthResponse,
    AuthResponse,
) {
    let (server, host, room) = common::server_with_room("porch").await;
    let cohost = common::join_member(&server, &host.access_token, "eli").await;
    let member = common::join_member(&server, &host.access_token, "jules").await;
    let resp = set_cohost(&server, &host.access_token, cohost.user.id, true).await;
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    (server, host, room, cohost, member)
}

#[tokio::test]
async fn the_host_makes_and_clears_a_cohost_and_everybody_hears_it() {
    let (server, host, _room) = common::server_with_room("porch").await;
    let eli = common::join_member(&server, &host.access_token, "eli").await;
    let jules = common::join_member(&server, &host.access_token, "jules").await;
    assert!(!eli.user.is_cohost, "nobody starts as a co-host");
    let mut watching = connect_ready(&server, &jules.access_token).await;
    drain_for(&mut watching, Duration::from_millis(200)).await;

    let resp = set_cohost(&server, &host.access_token, eli.user.id, true).await;
    assert_eq!(resp.status(), 200);
    let made: User = resp.json().await.unwrap();
    assert!(made.is_cohost);
    assert!(!made.is_host);

    // Every client hears the person as they are now.
    let frame = wait_for(&mut watching, "user.update").await;
    assert_eq!(frame["d"]["id"], eli.user.id.to_string());
    assert_eq!(frame["d"]["is_cohost"], true);

    // It sticks, and the list everybody reads says so.
    let users: Vec<User> = client()
        .get(server.url("/users"))
        .bearer_auth(&jules.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let listed = users.iter().find(|user| user.id == eli.user.id).unwrap();
    assert!(listed.is_cohost);
    assert!(users
        .iter()
        .filter(|user| user.id != eli.user.id)
        .all(|user| !user.is_cohost));

    // Asking again changes nothing and answers the same.
    let again = set_cohost(&server, &host.access_token, eli.user.id, true).await;
    assert_eq!(again.status(), 200);
    let frame = wait_for(&mut watching, "user.update").await;
    assert_eq!(frame["d"]["is_cohost"], true);

    let resp = set_cohost(&server, &host.access_token, eli.user.id, false).await;
    assert_eq!(resp.status(), 200);
    let cleared: User = resp.json().await.unwrap();
    assert!(!cleared.is_cohost);
    let frame = wait_for(&mut watching, "user.update").await;
    assert_eq!(frame["d"]["id"], eli.user.id.to_string());
    assert_eq!(frame["d"]["is_cohost"], false);
}

#[tokio::test]
async fn only_the_host_sets_it_and_never_on_themselves() {
    let (server, host, _room, cohost, member) = with_a_cohost().await;
    let other = common::join_member(&server, &host.access_token, "dave").await;

    // A member can't.
    let resp = set_cohost(&server, &member.access_token, other.user.id, true).await;
    assert_eq!(resp.status(), 403);
    // A co-host can't make one, or clear one, themselves included.
    let resp = set_cohost(&server, &cohost.access_token, other.user.id, true).await;
    assert_eq!(resp.status(), 403);
    let resp = set_cohost(&server, &cohost.access_token, cohost.user.id, false).await;
    assert_eq!(resp.status(), 403);
    // And nobody can make the host one, the host included.
    let resp = set_cohost(&server, &host.access_token, host.user.id, true).await;
    assert_eq!(resp.status(), 422);
    let resp = set_cohost(&server, &cohost.access_token, host.user.id, true).await;
    assert_eq!(resp.status(), 403);
    // Somebody who isn't here isn't found.
    let resp = set_cohost(
        &server,
        &host.access_token,
        linger_core::UserId::new(),
        true,
    )
    .await;
    assert_eq!(resp.status(), 404);

    // None of that changed anybody.
    let users: Vec<User> = client()
        .get(server.url("/users"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cohosts: Vec<&str> = users
        .iter()
        .filter(|user| user.is_cohost)
        .map(|user| user.username.as_str())
        .collect();
    assert_eq!(cohosts, ["eli"]);
    assert!(users.iter().any(|user| user.is_host && !user.is_cohost));
}

#[tokio::test]
async fn a_cohost_does_what_the_host_does() {
    let (server, host, room, cohost, member) = with_a_cohost().await;
    let token = &cohost.access_token;

    // Rooms.
    let made = client()
        .post(server.url("/rooms"))
        .bearer_auth(token)
        .json(&json!({ "slug": "kitchen", "name": "Kitchen" }))
        .send()
        .await
        .unwrap();
    assert_eq!(made.status(), 200, "{}", made.text().await.unwrap());
    let made: Room = made.json().await.unwrap();
    let archived = client()
        .post(server.url(&format!("/rooms/{}/archive", made.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(archived.status(), 200);

    // Server settings.
    let renamed = client()
        .patch(server.url("/server"))
        .bearer_auth(token)
        .json(&json!({ "name": "The Porch" }))
        .send()
        .await
        .unwrap();
    assert_eq!(renamed.status(), 200, "{}", renamed.text().await.unwrap());

    // Deleting somebody else's message, and revoking their invite.
    let theirs = say(&server, &member.access_token, &room, "something to delete").await;
    let deleted = client()
        .delete(server.url(&format!("/messages/{}", theirs.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 204);
    let link = invite(&server, &member.access_token).await;
    let revoked = client()
        .delete(server.url(&format!("/invites/{}", link.code)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 204);

    // Reports: they're listed for a co-host, and a co-host closes one.
    let sent = client()
        .post(server.url("/reports"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_id": member.user.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 201);
    let report: Report = sent.json().await.unwrap();
    let open: Vec<Report> = client()
        .get(server.url("/reports"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(open.len(), 1);
    let closed = client()
        .delete(server.url(&format!("/reports/{}", report.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), 204);

    // Removing somebody, and letting them back in.
    let removed = client()
        .post(server.url(&format!("/users/{}/remove", member.user.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);
    let gone: Vec<User> = client()
        .get(server.url("/users/removed"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(gone.len(), 1);
    let restored = client()
        .post(server.url(&format!("/users/{}/restore", member.user.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(restored.status(), 204);

    // A member still can't do any of it.
    let refused = client()
        .get(server.url("/reports"))
        .bearer_auth(&common::sign_in(&server, "jules").await.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn a_cohost_cannot_act_on_the_host() {
    let (server, host, room, cohost, _member) = with_a_cohost().await;
    let token = &cohost.access_token;

    let removed = client()
        .post(server.url(&format!("/users/{}/remove", host.user.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 403);
    // Nor themselves.
    let themselves = client()
        .post(server.url(&format!("/users/{}/remove", cohost.user.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(themselves.status(), 403);

    let hosts = say(&server, &host.access_token, &room, "the host's words").await;
    let deleted = client()
        .delete(server.url(&format!("/messages/{}", hosts.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 403);

    let link = invite(&server, &host.access_token).await;
    let revoked = client()
        .delete(server.url(&format!("/invites/{}", link.code)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), 403);

    // The host is still here, and so is everything of theirs.
    let me: User = client()
        .get(server.url("/me"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(me.is_host);
    let invites: Vec<Invite> = client()
        .get(server.url("/invites"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let held = invites.iter().find(|one| one.code == link.code).unwrap();
    assert!(held.revoked_at.is_none());

    // The host can do all of it to a co-host.
    let cohosts = say(&server, token, &room, "the co-host's words").await;
    let deleted = client()
        .delete(server.url(&format!("/messages/{}", cohosts.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 204);
}

#[tokio::test]
async fn reports_reach_the_host_and_every_cohost_and_nobody_else() {
    let (server, host, _room, cohost, member) = with_a_cohost().await;
    let other = common::join_member(&server, &host.access_token, "dave").await;
    let mut host_ws = connect_ready(&server, &host.access_token).await;
    let mut cohost_ws = connect_ready(&server, &cohost.access_token).await;
    let mut member_ws = connect_ready(&server, &member.access_token).await;
    drain_for(&mut member_ws, Duration::from_millis(200)).await;

    let sent = client()
        .post(server.url("/reports"))
        .bearer_auth(&other.access_token)
        .json(&json!({ "user_id": member.user.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 201);

    wait_for(&mut host_ws, "reports.changed").await;
    wait_for(&mut cohost_ws, "reports.changed").await;
    let heard = drain_for(&mut member_ws, Duration::from_millis(400)).await;
    assert!(
        heard.iter().all(|frame| frame["op"] != "reports.changed"),
        "a member hears nothing of a report: {heard:?}"
    );

    // Cleared, they stop hearing of them and can't read them.
    let resp = set_cohost(&server, &host.access_token, cohost.user.id, false).await;
    assert_eq!(resp.status(), 200);
    drain_for(&mut cohost_ws, Duration::from_millis(200)).await;
    let again = client()
        .post(server.url("/reports"))
        .bearer_auth(&other.access_token)
        .json(&json!({ "user_id": host.user.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 201);
    wait_for(&mut host_ws, "reports.changed").await;
    let heard = drain_for(&mut cohost_ws, Duration::from_millis(400)).await;
    assert!(heard.iter().all(|frame| frame["op"] != "reports.changed"));
    let refused = client()
        .get(server.url("/reports"))
        .bearer_auth(&cohost.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn removing_a_cohost_ends_it_and_a_restore_brings_back_a_member() {
    let (server, host, _room, cohost, _member) = with_a_cohost().await;
    let removed = client()
        .post(server.url(&format!("/users/{}/remove", cohost.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);
    // Somebody removed can't be made a co-host: they aren't here.
    let resp = set_cohost(&server, &host.access_token, cohost.user.id, true).await;
    assert_eq!(resp.status(), 404);

    let restored = client()
        .post(server.url(&format!("/users/{}/restore", cohost.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(restored.status(), 204);
    let back = common::sign_in(&server, "eli").await;
    assert!(!back.user.is_cohost, "a restore brings back a member");
    let refused = client()
        .get(server.url("/reports"))
        .bearer_auth(&back.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 403);
}

#[tokio::test]
async fn a_cohost_never_sees_or_closes_a_report_about_themselves() {
    let (server, host, _room, cohost, member) = with_a_cohost().await;
    let sent: serde_json::Value = client()
        .post(server.url("/reports"))
        .bearer_auth(&member.access_token)
        .json(&json!({ "user_id": cohost.user.id, "note": "not great tonight" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = sent["id"].as_str().expect("the report's id").to_string();

    let open = |token: String| {
        let server_url = server.url("/reports");
        async move {
            let list: Vec<serde_json::Value> = client()
                .get(server_url)
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            list.into_iter()
                .map(|report| report["id"].as_str().unwrap_or_default().to_string())
                .collect::<Vec<_>>()
        }
    };
    // The host sees it; the co-host it's about doesn't, so they can't learn
    // who reported them (the person reported isn't told).
    assert_eq!(open(host.access_token.clone()).await, vec![id.clone()]);
    assert!(open(cohost.access_token.clone()).await.is_empty());

    // Nor close it: as far as they're concerned, there's no such report.
    let closed = client()
        .delete(server.url(&format!("/reports/{id}")))
        .bearer_auth(&cohost.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), 404);
    assert_eq!(open(host.access_token.clone()).await, vec![id.clone()]);

    // The host can.
    let closed = client()
        .delete(server.url(&format!("/reports/{id}")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(closed.status(), 204);
}
