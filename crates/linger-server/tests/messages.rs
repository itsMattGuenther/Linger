//! Messages and read markers (PROTOCOL §4; reactions are reactions.rs): pagination edges,
//! tombstones, the permission matrix, and — by its absence — the unread count.

mod common;

use linger_core::wire::{ErrorCode, ErrorEnvelope, Message};
use linger_core::MessageId;

async fn send(server: &common::TestServer, token: &str, room: &str, body: &str) -> Message {
    let resp = reqwest::Client::new()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "send failed: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

async fn fetch(server: &common::TestServer, token: &str, room: &str, query: &str) -> Vec<Message> {
    reqwest::Client::new()
        .get(server.url(&format!("/rooms/{room}/messages{query}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn pagination_is_newest_first_with_working_edges() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room = room.id.to_string();

    // Empty room pages cleanly.
    assert!(fetch(&server, &host.access_token, &room, "")
        .await
        .is_empty());

    // 8 messages, alternating authors (stays under the per-user rate limit).
    let mut sent = Vec::new();
    for i in 0..8 {
        let token = if i % 2 == 0 {
            &host.access_token
        } else {
            &member.access_token
        };
        sent.push(send(&server, token, &room, &format!("message {i}")).await);
    }

    // Newest-first, default page.
    let page = fetch(&server, &host.access_token, &room, "").await;
    assert_eq!(page.len(), 8);
    assert_eq!(page[0].body, "message 7");
    assert_eq!(page[7].body, "message 0");

    // limit clamps and slices from the newest end.
    let top3 = fetch(&server, &host.access_token, &room, "?limit=3").await;
    assert_eq!(
        top3.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        ["message 7", "message 6", "message 5"]
    );

    // before: strictly older than the anchor; exact-limit boundary.
    let before = fetch(
        &server,
        &host.access_token,
        &room,
        &format!("?before={}&limit=5", sent[5].id),
    )
    .await;
    assert_eq!(
        before.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        [
            "message 4",
            "message 3",
            "message 2",
            "message 1",
            "message 0"
        ]
    );

    // after: strictly newer, still returned newest-first.
    let after = fetch(
        &server,
        &host.access_token,
        &room,
        &format!("?after={}", sent[5].id),
    )
    .await;
    assert_eq!(
        after.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        ["message 7", "message 6"]
    );

    // before + after together bound a window.
    let window = fetch(
        &server,
        &host.access_token,
        &room,
        &format!("?after={}&before={}", sent[1].id, sent[5].id),
    )
    .await;
    assert_eq!(
        window.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        ["message 4", "message 3", "message 2"]
    );
}

#[tokio::test]
async fn body_validation_and_reply_room_checks() {
    let (server, host, room_a) = common::server_with_room("garage").await;
    let client = reqwest::Client::new();
    let room_b: linger_core::wire::Room = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    for bad in ["", "   ", &"x".repeat(8001)] {
        let resp = client
            .post(server.url(&format!("/rooms/{}/messages", room_a.id)))
            .bearer_auth(&host.access_token)
            .json(&serde_json::json!({ "body": bad }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 422);
    }

    // Cross-room reply is invalid.
    let in_a = send(
        &server,
        &host.access_token,
        &room_a.id.to_string(),
        "hello garage",
    )
    .await;
    let resp = client
        .post(server.url(&format!("/rooms/{}/messages", room_b.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "body": "reply from porch", "reply_to": in_a.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);

    // Archived rooms don't take messages.
    client
        .post(server.url(&format!("/rooms/{}/archive", room_b.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    let resp = client
        .post(server.url(&format!("/rooms/{}/messages", room_b.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "body": "anyone home?" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
}

#[tokio::test]
async fn edit_delete_permission_matrix_and_tombstones() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let client = reqwest::Client::new();
    let room = room.id.to_string();

    let theirs = send(&server, &member.access_token, &room, "callie's message").await;
    let reply = send(&server, &host.access_token, &room, "a reply").await;

    // Host cannot edit someone else's message…
    let resp = client
        .patch(server.url(&format!("/messages/{}", theirs.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "body": "rewritten" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);

    // …the author can.
    let edited: Message = client
        .patch(server.url(&format!("/messages/{}", theirs.id)))
        .bearer_auth(&member.access_token)
        .json(&serde_json::json!({ "body": "callie's edited message" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(edited.edited_at.is_some());

    // A member can't delete someone else's message; the host can (tombstone).
    let denied = client
        .delete(server.url(&format!("/messages/{}", reply.id)))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);

    let deleted = client
        .delete(server.url(&format!("/messages/{}", theirs.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 204);

    // Tombstone: still present in the page, body empty, deleted_at set.
    let page = fetch(&server, &host.access_token, &room, "").await;
    let stone = page
        .iter()
        .find(|m| m.id == theirs.id)
        .expect("tombstone survives");
    assert_eq!(stone.body, "");
    assert!(stone.deleted_at.is_some());

    // Tombstones can't be edited or pinned.
    let resp = client
        .patch(server.url(&format!("/messages/{}", theirs.id)))
        .bearer_auth(&member.access_token)
        .json(&serde_json::json!({ "body": "necromancy" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let resp = client
        .post(server.url(&format!("/messages/{}/pin", theirs.id)))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn any_member_pins_and_unpins() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let client = reqwest::Client::new();

    let msg = send(&server, &host.access_token, &room.id.to_string(), "pin me").await;
    let pinned: Message = client
        .post(server.url(&format!("/messages/{}/pin", msg.id)))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(pinned.pinned_at.is_some());

    let unpinned: Message = client
        .delete(server.url(&format!("/messages/{}/pin", msg.id)))
        .bearer_auth(&member.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(unpinned.pinned_at.is_none());
}

#[tokio::test]
async fn read_markers_round_trip_and_never_carry_counts() {
    let (server, host, room) = common::server_with_room("garage").await;
    let client = reqwest::Client::new();
    let room_id = room.id.to_string();

    let m1 = send(&server, &host.access_token, &room_id, "one").await;
    let m2 = send(&server, &host.access_token, &room_id, "two").await;

    let resp = client
        .put(server.url(&format!("/rooms/{room_id}/read")))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "last_read_id": m1.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    // Idempotent update to the newer marker.
    let resp = client
        .put(server.url(&format!("/rooms/{room_id}/read")))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "last_read_id": m2.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    let map: serde_json::Value = client
        .get(server.url("/read"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(map[room_id.as_str()], serde_json::json!(m2.id.to_string()));

    // The hard rule, mechanically checked: no count-shaped field anywhere in
    // the read response or a room object.
    let rooms_raw = client
        .get(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    for forbidden in ["unread", "count", "badge"] {
        assert!(
            !rooms_raw.contains(forbidden),
            "GET /rooms leaked a count-shaped field: {forbidden}"
        );
    }

    // Marker for a message from another room is rejected.
    let other: linger_core::wire::Room = client
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let resp = client
        .put(server.url(&format!("/rooms/{}/read", other.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "last_read_id": m2.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
}

async fn read_map(server: &common::TestServer, token: &str) -> serde_json::Value {
    reqwest::Client::new()
        .get(server.url("/read"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn put_read(server: &common::TestServer, token: &str, room: &str, id: MessageId) {
    let resp = reqwest::Client::new()
        .put(server.url(&format!("/rooms/{room}/read")))
        .bearer_auth(token)
        .json(&serde_json::json!({ "last_read_id": id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
}

/// #454: a message you sent from your phone made the room look new on your
/// desktop, because only the sending device ever moved your read marker, and
/// a phone put away straight after sending never got round to it.
#[tokio::test]
async fn sending_moves_your_own_read_marker_and_nobody_elses() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let theirs = send(&server, &member.access_token, &room_id, "you around?").await;
    put_read(&server, &host.access_token, &room_id, theirs.id).await;
    let mine = send(&server, &host.access_token, &room_id, "yep").await;

    let map = read_map(&server, &host.access_token).await;
    assert_eq!(
        map[room_id.as_str()],
        serde_json::json!(mine.id.to_string())
    );
    // Callie read nothing after her own message: the host's reply is new for her.
    let map = read_map(&server, &member.access_token).await;
    assert_eq!(
        map[room_id.as_str()],
        serde_json::json!(theirs.id.to_string())
    );
}

/// #454: two devices, one person. The one that comes back with an older
/// position mustn't pull back what the other has already read.
#[tokio::test]
async fn a_read_marker_never_moves_backwards() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let first = send(&server, &member.access_token, &room_id, "one").await;
    let second = send(&server, &member.access_token, &room_id, "two").await;

    put_read(&server, &host.access_token, &room_id, second.id).await;
    put_read(&server, &host.access_token, &room_id, first.id).await;

    let map = read_map(&server, &host.access_token).await;
    assert_eq!(
        map[room_id.as_str()],
        serde_json::json!(second.id.to_string())
    );
}

/// Make every new read marker fail, or stop doing so. The sender's read
/// marker is the last thing a post writes, so this fails a post at its very
/// end, after the message, its links and its files are written.
async fn refuse_read_markers(server: &common::TestServer, refuse: bool) {
    let sql = if refuse {
        "CREATE TRIGGER refuse_read_markers BEFORE INSERT ON read_markers
         BEGIN SELECT RAISE(ABORT, 'refused by the test'); END"
    } else {
        "DROP TRIGGER refuse_read_markers"
    };
    sqlx::query(sql)
        .execute(&server.state.db.write)
        .await
        .unwrap();
}

async fn count(server: &common::TestServer, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
        .fetch_one(&server.state.db.read)
        .await
        .unwrap()
}

/// #524: a post that fails partway leaves nothing behind. Each of a post's
/// writes used to be saved on its own, so one that failed at the read marker
/// left the message in the room while the sender was told it hadn't sent,
/// and pressing Retry posted it twice.
#[tokio::test]
async fn a_post_that_fails_partway_leaves_nothing_behind() {
    let (server, host, room) = common::server_with_room("garage").await;
    let room_id = room.id.to_string();
    let (messages, links) = (
        count(&server, "messages").await,
        count(&server, "message_links").await,
    );

    refuse_read_markers(&server, true).await;
    let body = "the parts list: https://example.com/parts";
    let resp = reqwest::Client::new()
        .post(server.url(&format!("/rooms/{room_id}/messages")))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 500);
    assert_eq!(
        count(&server, "messages").await,
        messages,
        "the message stayed"
    );
    assert_eq!(
        count(&server, "message_links").await,
        links,
        "its link stayed"
    );
    assert!(fetch(&server, &host.access_token, &room_id, "")
        .await
        .is_empty());

    // Retry, once whatever failed has passed, posts it once.
    refuse_read_markers(&server, false).await;
    let sent = send(&server, &host.access_token, &room_id, body).await;
    let page = fetch(&server, &host.access_token, &room_id, "").await;
    assert_eq!(page.iter().map(|m| m.id).collect::<Vec<_>>(), vec![sent.id]);
    assert_eq!(count(&server, "message_links").await, links + 1);
}

#[tokio::test]
async fn message_send_is_rate_limited() {
    let (server, host, room) = common::server_with_room("garage").await;
    let room = room.id.to_string();

    // 10/10s: the burst goes through, the 11th gets the envelope.
    for i in 0..10 {
        send(&server, &host.access_token, &room, &format!("burst {i}")).await;
    }
    let resp = reqwest::Client::new()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "body": "one too many" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 429);
    let env: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(env.error.code, ErrorCode::RateLimited);
    assert!(env.error.retry_after_ms.is_some_and(|ms| ms > 0));
}

/// `around` (PROTOCOL §4): the window search lands in.
///
/// The case that matters is the one paging cannot do — a message far from
/// either edge, reached in one request with history on both sides of it.
#[tokio::test]
async fn a_window_lands_on_a_message_with_history_either_side() {
    let (server, host, room) = common::server_with_room("garage").await;
    let member = common::join_member(&server, &host.access_token, "callie").await;
    let room_id = room.id.to_string();

    let mut sent = Vec::new();
    for i in 0..20 {
        let token = if i % 2 == 0 {
            &host.access_token
        } else {
            &member.access_token
        };
        sent.push(send(&server, token, &room_id, &format!("message {i}")).await);
    }
    let target = &sent[10];

    let page = fetch(
        &server,
        &host.access_token,
        &room_id,
        &format!("?around={}&limit=9", target.id),
    )
    .await;

    // Nine messages, newest first, with the target in them.
    assert_eq!(page.len(), 9);
    assert!(page.windows(2).all(|pair| pair[0].id > pair[1].id));
    assert!(page.iter().any(|held| held.id == target.id));

    // The odd one goes to the older half: five at or before the target,
    // four after it. Scrollback above a message is what gives it context.
    let older = page.iter().filter(|held| held.id <= target.id).count();
    assert_eq!(older, 5);
    assert_eq!(page.len() - older, 4);

    // And the window really is centred: it is neither the newest page nor the
    // oldest one.
    assert!(page[0].id < sent[19].id);
    assert!(page[8].id > sent[0].id);
}

#[tokio::test]
async fn a_window_at_an_edge_is_short_rather_than_wrong() {
    let (server, host, room) = common::server_with_room("garage").await;
    let room_id = room.id.to_string();

    let mut sent = Vec::new();
    for i in 0..6 {
        sent.push(send(&server, &host.access_token, &room_id, &format!("m{i}")).await);
    }

    // The oldest message has nothing above it, so the window is short on that
    // side — which is how a client learns it has reached the start.
    let page = fetch(
        &server,
        &host.access_token,
        &room_id,
        &format!("?around={}&limit=10", sent[0].id),
    )
    .await;
    assert_eq!(page.len(), 6);
    assert_eq!(page[5].id, sent[0].id);

    // Same at the other end — and the window is *five*, not six. Each half has
    // its own cap and neither borrows from the other, which is what lets a
    // client read the two halves separately: a short older half means the start
    // of the room, a short newer half means the newest message. A window that
    // quietly grew one side to fill the limit would make both signals a guess.
    let page = fetch(
        &server,
        &host.access_token,
        &room_id,
        &format!("?around={}&limit=10", sent[5].id),
    )
    .await;
    assert_eq!(page.len(), 5);
    assert_eq!(page[0].id, sent[5].id);
    assert_eq!(page[4].id, sent[1].id);
}

#[tokio::test]
async fn a_window_refuses_a_second_edge_and_a_message_from_elsewhere() {
    let (server, host, room) = common::server_with_room("garage").await;
    let room_id = room.id.to_string();
    let other: linger_core::wire::Room = reqwest::Client::new()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let here = send(&server, &host.access_token, &room_id, "here").await;
    let elsewhere = send(
        &server,
        &host.access_token,
        &other.id.to_string(),
        "elsewhere",
    )
    .await;

    // Two pages asked for at once is a mistake worth saying out loud.
    let resp = reqwest::Client::new()
        .get(server.url(&format!(
            "/rooms/{room_id}/messages?around={}&before={}",
            here.id, here.id
        )))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
    let body: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(body.error.code, ErrorCode::ValidationFailed);

    // A message that is real but in another room is not this room's window.
    let resp = reqwest::Client::new()
        .get(server.url(&format!(
            "/rooms/{room_id}/messages?around={}",
            elsewhere.id
        )))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let body: ErrorEnvelope = resp.json().await.unwrap();
    assert_eq!(body.error.code, ErrorCode::NotFound);
}
