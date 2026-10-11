//! Reactions (SPEC §4.8, PROTOCOL §4, #485): any one emoji or one of the
//! server's own, six different on a message at most, a room the host turned
//! them off in, a server emoji that takes its reactions with it, and the
//! reactions left before the trial (#168) coming back as what they were.

mod common;

use common::{data_config, join_member, server_with_room, spawn_in, TestServer};
use linger_core::wire::{
    Attachment, AuthResponse, CustomEmoji, ErrorCode, ErrorEnvelope, Message, Room, UploadSlot,
};
use linger_core::{MessageId, RoomId, UserId};
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn send(server: &TestServer, token: &str, room: RoomId, body: &str) -> Message {
    let resp = client()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "send: {}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

/// `PUT /messages/:id/reactions/:key`, the key as the app sends it: escaped
/// for a path.
async fn react(
    server: &TestServer,
    token: &str,
    message: MessageId,
    key: &str,
) -> reqwest::Response {
    let mut url =
        reqwest::Url::parse(&server.url(&format!("/messages/{message}/reactions"))).unwrap();
    url.path_segments_mut().unwrap().push(key);
    client().put(url).bearer_auth(token).send().await.unwrap()
}

async fn unreact(
    server: &TestServer,
    token: &str,
    message: MessageId,
    key: &str,
) -> reqwest::Response {
    let mut url =
        reqwest::Url::parse(&server.url(&format!("/messages/{message}/reactions"))).unwrap();
    url.path_segments_mut().unwrap().push(key);
    client()
        .delete(url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

/// The message as the room's history now has it.
async fn now(server: &TestServer, token: &str, message: &Message) -> Message {
    let page: Vec<Message> = client()
        .get(server.url(&format!("/rooms/{}/messages", message.room_id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    page.into_iter()
        .find(|m| m.id == message.id)
        .expect("in the room")
}

/// Each emoji on a message and how many people left it, in order.
fn shown(message: &Message) -> Vec<(String, u32)> {
    message
        .reactions
        .iter()
        .map(|group| (group.key.clone(), group.count))
        .collect()
}

async fn refusal(resp: reqwest::Response) -> (u16, ErrorCode, String) {
    let status = resp.status().as_u16();
    let envelope: ErrorEnvelope = resp.json().await.unwrap();
    (status, envelope.error.code, envelope.error.message)
}

#[tokio::test]
async fn any_one_emoji_is_a_reaction_and_anything_else_is_not() {
    let (server, host, room) = server_with_room("garage").await;
    let token = &host.access_token;
    let message = send(&server, token, room.id, "react to me").await;

    for one in ["👍", "❤️", "👍🏽", "👩🏽‍💻", "🏳️‍🌈", "🇨🇦"] {
        assert_eq!(
            react(&server, token, message.id, one).await.status(),
            204,
            "{one}"
        );
    }
    // The names reactions had before the trial are words now, not emoji.
    for not in ["heart", "😀😀", "👍 ", "emoji:nope", "🏽"] {
        let (status, code, _) = refusal(react(&server, token, message.id, not).await).await;
        assert!(status == 422 || status == 404, "{not:?}: {status}");
        assert!(
            matches!(code, ErrorCode::ValidationFailed | ErrorCode::NotFound),
            "{not:?}"
        );
    }
    assert_eq!(
        shown(&now(&server, token, &message).await),
        vec![
            ("👍".to_string(), 1),
            ("❤️".to_string(), 1),
            ("👍🏽".to_string(), 1),
            ("👩🏽‍💻".to_string(), 1),
            ("🏳️‍🌈".to_string(), 1),
            ("🇨🇦".to_string(), 1),
        ]
    );
}

#[tokio::test]
async fn reactions_keep_the_order_they_were_first_left_and_twice_is_once() {
    let (server, host, room) = server_with_room("garage").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let message = send(&server, &host.access_token, room.id, "react to me").await;

    for (token, key) in [
        (&callie.access_token, "🔥"),
        (&host.access_token, "😂"),
        (&host.access_token, "🔥"),
        (&host.access_token, "🔥"),
    ] {
        assert_eq!(react(&server, token, message.id, key).await.status(), 204);
    }
    let seen = now(&server, &host.access_token, &message).await;
    assert_eq!(
        shown(&seen),
        vec![("🔥".to_string(), 2), ("😂".to_string(), 1)]
    );
    // Who, in the order they reacted: what a pill's hover says.
    assert_eq!(
        seen.reactions[0].user_ids,
        vec![callie.user.id, host.user.id]
    );

    assert_eq!(
        unreact(&server, &callie.access_token, message.id, "🔥")
            .await
            .status(),
        204
    );
    // Taking back what you never left is nothing, not an error.
    assert_eq!(
        unreact(&server, &callie.access_token, message.id, "🔥")
            .await
            .status(),
        204
    );
    assert_eq!(
        unreact(&server, &host.access_token, message.id, "😂")
            .await
            .status(),
        204
    );
    assert_eq!(
        shown(&now(&server, &host.access_token, &message).await),
        vec![("🔥".to_string(), 1)]
    );
}

#[tokio::test]
async fn a_message_holds_six_different_reactions_and_anybody_can_add_to_them() {
    let (server, host, room) = server_with_room("garage").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let message = send(&server, &host.access_token, room.id, "react to me").await;

    for key in ["😀", "😃", "😄", "😁", "😆", "😅"] {
        assert_eq!(
            react(&server, &host.access_token, message.id, key)
                .await
                .status(),
            204
        );
    }
    let (status, code, words) =
        refusal(react(&server, &callie.access_token, message.id, "🤣").await).await;
    assert_eq!((status, code), (409, ErrorCode::Conflict));
    assert!(words.contains("six"), "{words}");

    // One of the six is still anybody's to add to.
    assert_eq!(
        react(&server, &callie.access_token, message.id, "😀")
            .await
            .status(),
        204
    );
    // With one gone, there's room for another.
    assert_eq!(
        unreact(&server, &host.access_token, message.id, "😅")
            .await
            .status(),
        204
    );
    assert_eq!(
        react(&server, &callie.access_token, message.id, "🤣")
            .await
            .status(),
        204
    );
    let seen = now(&server, &host.access_token, &message).await;
    assert_eq!(seen.reactions.len(), 6);
    assert_eq!(shown(&seen)[0], ("😀".to_string(), 2));
}

fn png() -> Vec<u8> {
    let canvas = image::RgbaImage::from_pixel(64, 64, image::Rgba([240, 180, 40, 255]));
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// One of the server's own emoji, added by the host (#359).
async fn server_emoji(server: &TestServer, host: &AuthResponse, name: &str) -> CustomEmoji {
    let bytes = png();
    let slot: UploadSlot = client()
        .post(server.url("/uploads"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "filename": format!("{name}.png"), "size_bytes": bytes.len(), "mime": "image/png" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let put = client()
        .put(format!("{}{}", server.base, slot.url))
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let picture: Attachment = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "parts": null }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let resp = client()
        .post(server.url("/emoji"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "name": name, "attachment_id": picture.id }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "add: {}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

#[tokio::test]
async fn a_server_emoji_reacts_by_its_id_through_a_rename_and_goes_when_it_does() {
    let (server, host, room) = server_with_room("garage").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let porch = server_emoji(&server, &host, "porch_light").await;
    let first = send(&server, &host.access_token, room.id, "first").await;
    let second = send(&server, &host.access_token, room.id, "second").await;
    let key = format!("emoji:{}", porch.id);

    assert_eq!(
        react(&server, &callie.access_token, first.id, &key)
            .await
            .status(),
        204
    );
    assert_eq!(
        react(&server, &host.access_token, second.id, &key)
            .await
            .status(),
        204
    );
    assert_eq!(
        react(&server, &host.access_token, second.id, "👍")
            .await
            .status(),
        204
    );

    // Only an emoji this server has, written the one way ids are written.
    let hyphenated = porch.id.0.hyphenated().to_string();
    for not in [
        format!("emoji:{}", UserId::new()),
        format!("emoji:{hyphenated}"),
        "emoji:".to_string(),
    ] {
        let (status, code, _) =
            refusal(react(&server, &host.access_token, first.id, &not).await).await;
        assert_eq!((status, code), (404, ErrorCode::NotFound), "{not}");
    }

    // A new name changes nothing about who reacted with it.
    let renamed = client()
        .patch(server.url(&format!("/emoji/{}", porch.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "name": "lamp" }))
        .send()
        .await
        .unwrap();
    assert_eq!(renamed.status(), 200);
    assert_eq!(
        shown(&now(&server, &host.access_token, &first).await),
        vec![(key.clone(), 1)]
    );

    // Removing it takes every reaction it was, and nothing else.
    let removed = client()
        .delete(server.url(&format!("/emoji/{}", porch.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);
    assert!(now(&server, &host.access_token, &first)
        .await
        .reactions
        .is_empty());
    assert_eq!(
        shown(&now(&server, &host.access_token, &second).await),
        vec![("👍".to_string(), 1)]
    );
    let (status, _, _) = refusal(react(&server, &host.access_token, first.id, &key).await).await;
    assert_eq!(status, 404);
}

async fn set_reactions_off(
    server: &TestServer,
    token: &str,
    room: RoomId,
    off: bool,
) -> reqwest::Response {
    client()
        .patch(server.url(&format!("/rooms/{room}")))
        .bearer_auth(token)
        .json(&json!({ "reactions_off": off }))
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn a_host_turns_a_rooms_reactions_off_and_back_on_and_nothing_is_lost() {
    let (server, host, room) = server_with_room("garage").await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let message = send(&server, &host.access_token, room.id, "react to me").await;
    assert_eq!(
        react(&server, &callie.access_token, message.id, "👍")
            .await
            .status(),
        204
    );
    // "On" is the field left out.
    let raw: serde_json::Value = client()
        .get(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(raw[0].get("reactions_off").is_none(), "{raw}");

    // Only the host's powers turn them off.
    assert_eq!(
        set_reactions_off(&server, &callie.access_token, room.id, true)
            .await
            .status(),
        403
    );
    let resp = set_reactions_off(&server, &host.access_token, room.id, true).await;
    assert_eq!(resp.status(), 200);
    let turned: Room = resp.json().await.unwrap();
    assert_eq!(turned.reactions_off, Some(true));

    let (status, _, words) =
        refusal(react(&server, &callie.access_token, message.id, "🔥").await).await;
    assert_eq!(status, 403);
    assert_eq!(words, "Reactions are off in this room.");
    // Hidden, not deleted: what was left is still there, and still yours to
    // take back.
    assert_eq!(
        shown(&now(&server, &host.access_token, &message).await),
        vec![("👍".to_string(), 1)]
    );

    let resp = set_reactions_off(&server, &host.access_token, room.id, false).await;
    let turned: Room = resp.json().await.unwrap();
    assert_eq!(turned.reactions_off, None);
    assert_eq!(
        react(&server, &callie.access_token, message.id, "🔥")
            .await
            .status(),
        204
    );
    assert_eq!(
        unreact(&server, &callie.access_token, message.id, "👍")
            .await
            .status(),
        204
    );
}

#[tokio::test]
async fn nobody_reacts_to_the_line_a_closing_poll_leaves() {
    let (server, host, room) = server_with_room("garage").await;
    let token = &host.access_token;
    let poll: Message = client()
        .post(server.url(&format!("/rooms/{}/polls", room.id)))
        .bearer_auth(token)
        .json(&json!({ "question": "Pizza?", "choices": ["Yes", "No"], "multi": false, "closes_in_days": 7 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // A poll is something somebody said: it takes reactions.
    assert_eq!(react(&server, token, poll.id, "🍕").await.status(), 204);
    let closed = client()
        .post(server.url(&format!("/messages/{}/close", poll.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert!(closed.status().is_success());
    let page: Vec<Message> = client()
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let line = page
        .iter()
        .find(|m| m.poll_closed.is_some())
        .expect("the closing line");
    let (status, _, words) = refusal(react(&server, token, line.id, "👍").await).await;
    assert_eq!(
        (status, words.as_str()),
        (422, "Nobody can react to that line.")
    );
}

/// A server updated from before #485: its reactions were saved under the
/// twelve names (0001), and the new server's migration makes each the emoji
/// it always drew.
#[tokio::test]
async fn reactions_left_before_the_trial_come_back_as_their_emoji() {
    let dir = tempfile::tempdir().unwrap();
    let path = data_config(&dir).db_path();
    let old = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .unwrap();
    let mut before = sqlx::migrate!("./migrations");
    before.migrations = before
        .migrations
        .iter()
        .filter(|migration| migration.version <= 14)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&old).await.unwrap();

    let author = UserId::new();
    let hash = linger_server::auth::hash_password_sync("a perfectly fine password").unwrap();
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, is_host, created_at)
         VALUES (?, 'matt', 'Matt', ?, 1, 0)",
    )
    .bind(author.to_vec())
    .bind(hash)
    .execute(&old)
    .await
    .unwrap();
    let room = RoomId::new();
    sqlx::query("INSERT INTO rooms (id, slug, name, position, created_at) VALUES (?, 'general', 'general', 0, 0)")
        .bind(room.to_vec())
        .execute(&old)
        .await
        .unwrap();
    let message = MessageId::new();
    sqlx::query("INSERT INTO messages (id, room_id, author_id, body, created_at) VALUES (?, ?, ?, 'hello', 1)")
        .bind(message.to_vec())
        .bind(room.to_vec())
        .bind(author.to_vec())
        .execute(&old)
        .await
        .unwrap();
    for (at, key) in ["heart", "fire", "hundred"].into_iter().enumerate() {
        sqlx::query(
            "INSERT INTO reactions (message_id, user_id, key, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(message.to_vec())
        .bind(author.to_vec())
        .bind(key)
        .bind(at as i64)
        .execute(&old)
        .await
        .unwrap();
    }
    old.close().await;

    let server = spawn_in(dir, |_| {}).await;
    let token = common::sign_in(&server, "matt").await.access_token;
    let page: Vec<Message> = client()
        .get(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        shown(&page[0]),
        vec![
            ("❤️".to_string(), 1),
            ("🔥".to_string(), 1),
            ("💯".to_string(), 1)
        ]
    );
}
