//! A server's own emoji (#359, PROTOCOL §5 "Custom emoji") over real HTTP and
//! real WebSockets, against a temporary SQLite file.
//!
//! The host or a co-host makes a finished upload into an emoji; everybody
//! reads the set and hears every change as the whole set; the picture never
//! expires and can't be thrown away or posted as an upload.

mod common;

use std::time::Duration;

use common::{bootstrap_host, join_member, server_with_room, spawn_server, TestServer};
use futures_util::{SinkExt, StreamExt};
use linger_core::limits::MAX_CUSTOM_EMOJI;
use linger_core::wire::{Attachment, CustomEmoji, Message, UploadSlot};
use linger_server::expiry;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Root-relative URLs on a server with no domain, as every test server is.
fn absolute(server: &TestServer, url: &str) -> String {
    format!("{}{url}", server.base)
}

/// Slot, PUT, complete: a finished upload.
async fn upload(
    server: &TestServer,
    token: &str,
    filename: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> Attachment {
    let slot: UploadSlot = client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&json!({ "filename": filename, "size_bytes": bytes.len(), "mime": mime }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let put = client()
        .put(absolute(server, &slot.url))
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 200);
    let done = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&json!({ "parts": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        done.status(),
        200,
        "complete: {}",
        done.text().await.unwrap()
    );
    done.json().await.unwrap()
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let canvas = image::RgbaImage::from_pixel(width, height, image::Rgba([240, 180, 40, 255]));
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// A PNG of noise, which no compression shrinks: well over 256 KB at 400 px.
fn heavy_png() -> Vec<u8> {
    let mut seed: u32 = 0x1234_5678;
    let canvas = image::RgbaImage::from_fn(400, 400, |_, _| {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let [a, b, c, d] = seed.to_le_bytes();
        image::Rgba([a, b, c, d | 1])
    });
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// A two-frame animated GIF.
fn animated_gif() -> Vec<u8> {
    use image::codecs::gif::{GifEncoder, Repeat};
    use image::{Delay, Frame, RgbaImage};
    let mut out = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut out);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        let frames = [[200u8, 40, 40, 255], [40, 40, 200, 255]].map(|color| {
            Frame::from_parts(
                RgbaImage::from_pixel(16, 16, image::Rgba(color)),
                0,
                0,
                Delay::from_numer_denom_ms(100, 1),
            )
        });
        encoder.encode_frames(frames).unwrap();
    }
    out
}

async fn add(
    server: &TestServer,
    token: &str,
    name: &str,
    attachment: &Attachment,
) -> reqwest::Response {
    client()
        .post(server.url("/emoji"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "attachment_id": attachment.id }))
        .send()
        .await
        .unwrap()
}

async fn added(
    server: &TestServer,
    token: &str,
    name: &str,
    attachment: &Attachment,
) -> CustomEmoji {
    let resp = add(server, token, name, attachment).await;
    assert_eq!(resp.status(), 200, "add: {}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn list(server: &TestServer, token: &str) -> Vec<CustomEmoji> {
    let resp = client()
        .get(server.url("/emoji"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

async fn rename(
    server: &TestServer,
    token: &str,
    emoji: &CustomEmoji,
    name: &str,
) -> reqwest::Response {
    client()
        .patch(server.url(&format!("/emoji/{}", emoji.id)))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .unwrap()
}

async fn remove(server: &TestServer, token: &str, emoji: &CustomEmoji) -> reqwest::Response {
    client()
        .delete(server.url(&format!("/emoji/{}", emoji.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

/// The status and the error code of a refusal.
async fn refusal(resp: reqwest::Response) -> (u16, String) {
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap();
    (
        status,
        body["error"]["code"].as_str().unwrap_or("").to_string(),
    )
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

/// Signed in on the gateway, with the `ready` it was greeted with.
async fn connect_ready(server: &TestServer, token: &str) -> (Ws, Value) {
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
    let ready = wait_for(&mut ws, "ready").await;
    (ws, ready)
}

fn names(frame: &Value) -> Vec<String> {
    frame["d"]["emoji"]
        .as_array()
        .expect("the whole set")
        .iter()
        .map(|one| one["name"].as_str().unwrap().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Adding, and who may
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_host_adds_an_emoji_and_everybody_sees_it_listed() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "callie").await;
    assert!(list(&server, &member.access_token).await.is_empty());

    let picture = upload(
        &server,
        &host.access_token,
        "party parrot.png",
        "image/png",
        png(64, 64),
    )
    .await;
    let emoji = added(&server, &host.access_token, "party_parrot", &picture).await;
    assert_eq!(emoji.name, "party_parrot");
    assert!(!emoji.animated);
    assert_eq!(emoji.created_by, host.user.id);
    assert_eq!(emoji.url, picture.url, "the picture is the upload's object");

    let seen = list(&server, &member.access_token).await;
    assert_eq!(seen, vec![emoji.clone()]);
    let served = client()
        .get(absolute(&server, &emoji.url))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), 200);
}

#[tokio::test]
async fn a_gif_stays_animated() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let picture = upload(
        &server,
        &host.access_token,
        "blink.gif",
        "image/gif",
        animated_gif(),
    )
    .await;
    let emoji = added(&server, &host.access_token, "blink", &picture).await;
    assert!(emoji.animated);
}

#[tokio::test]
async fn a_cohost_adds_one_and_a_member_is_refused() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let eli = join_member(&server, &host.access_token, "eli").await;
    let member = join_member(&server, &host.access_token, "callie").await;
    let on = client()
        .put(server.url(&format!("/users/{}/cohost", eli.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert!(on.status().is_success());

    let mine = upload(
        &server,
        &eli.access_token,
        "wave.png",
        "image/png",
        png(32, 32),
    )
    .await;
    added(&server, &eli.access_token, "wave", &mine).await;

    let theirs = upload(
        &server,
        &member.access_token,
        "nope.png",
        "image/png",
        png(32, 32),
    )
    .await;
    assert_eq!(
        refusal(add(&server, &member.access_token, "nope", &theirs).await).await,
        (403, "FORBIDDEN".into())
    );
    let one = list(&server, &member.access_token).await.remove(0);
    assert_eq!(
        refusal(rename(&server, &member.access_token, &one, "mine").await).await,
        (403, "FORBIDDEN".into())
    );
    assert_eq!(
        refusal(remove(&server, &member.access_token, &one).await).await,
        (403, "FORBIDDEN".into())
    );
}

// ---------------------------------------------------------------------------
// What's refused
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_name_that_breaks_the_rule_is_refused() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let picture = upload(
        &server,
        &host.access_token,
        "a.png",
        "image/png",
        png(32, 32),
    )
    .await;
    for bad in [
        "x",
        "Party",
        "party-parrot",
        "party parrot",
        ":ok:",
        &"x".repeat(33),
    ] {
        assert_eq!(
            refusal(add(&server, &host.access_token, bad, &picture).await).await,
            (422, "VALIDATION_FAILED".into()),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn a_name_already_taken_is_a_conflict() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let first = upload(
        &server,
        &host.access_token,
        "a.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let second = upload(
        &server,
        &host.access_token,
        "b.png",
        "image/png",
        png(32, 32),
    )
    .await;
    added(&server, &host.access_token, "cat", &first).await;
    assert_eq!(
        refusal(add(&server, &host.access_token, "cat", &second).await).await,
        (409, "CONFLICT".into())
    );
    // ...and the same picture twice is one too.
    assert_eq!(
        refusal(add(&server, &host.access_token, "cat_two", &first).await).await,
        (409, "CONFLICT".into())
    );
}

#[tokio::test]
async fn somebody_elses_upload_is_not_found() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "callie").await;
    let theirs = upload(
        &server,
        &member.access_token,
        "theirs.png",
        "image/png",
        png(32, 32),
    )
    .await;
    assert_eq!(
        refusal(add(&server, &host.access_token, "theirs", &theirs).await).await,
        (404, "NOT_FOUND".into())
    );
}

#[tokio::test]
async fn an_upload_already_on_a_message_is_a_conflict() {
    let (server, host, room) = server_with_room("general").await;
    let picture = upload(
        &server,
        &host.access_token,
        "posted.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let sent = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "", "attachment_ids": [picture.id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 200, "post: {}", sent.text().await.unwrap());
    assert_eq!(
        refusal(add(&server, &host.access_token, "posted", &picture).await).await,
        (409, "CONFLICT".into())
    );
}

#[tokio::test]
async fn a_file_that_isnt_a_picture_is_unsupported() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let notes = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        b"not a picture\n".to_vec(),
    )
    .await;
    assert_eq!(
        refusal(add(&server, &host.access_token, "notes", &notes).await).await,
        (415, "UNSUPPORTED_MEDIA".into())
    );
}

#[tokio::test]
async fn a_picture_too_heavy_or_too_wide_is_refused() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let heavy = upload(
        &server,
        &host.access_token,
        "heavy.png",
        "image/png",
        heavy_png(),
    )
    .await;
    assert!(
        heavy.size_bytes > 256 * 1024,
        "the noise really is heavy: {}",
        heavy.size_bytes
    );
    assert_eq!(
        refusal(add(&server, &host.access_token, "heavy", &heavy).await).await,
        (422, "VALIDATION_FAILED".into())
    );
    let wide = upload(
        &server,
        &host.access_token,
        "wide.png",
        "image/png",
        png(600, 8),
    )
    .await;
    assert_eq!(
        refusal(add(&server, &host.access_token, "wide", &wide).await).await,
        (422, "VALIDATION_FAILED".into())
    );
}

#[tokio::test]
async fn a_full_server_refuses_one_more() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    // The first 200, written straight in: each an upload row and an emoji row.
    for n in 0..MAX_CUSTOM_EMOJI {
        let attachment = linger_core::AttachmentId::new();
        sqlx::query(
            "INSERT INTO attachments (id, uploader_id, object_key, filename, mime, size_bytes, width, height, state, created_at)
             VALUES (?, ?, ?, 'e.png', 'image/png', 10, 8, 8, 'complete', 0)",
        )
        .bind(attachment.to_vec())
        .bind(host.user.id.to_vec())
        .bind(format!("filler/{n}"))
        .execute(&server.state.db.write)
        .await
        .unwrap();
        sqlx::query("INSERT INTO custom_emoji (id, name, attachment_id, created_by, created_at) VALUES (?, ?, ?, ?, 0)")
            .bind(linger_core::EmojiId::new().to_vec())
            .bind(format!("filler_{n}"))
            .bind(attachment.to_vec())
            .bind(host.user.id.to_vec())
            .execute(&server.state.db.write)
            .await
            .unwrap();
    }
    let picture = upload(
        &server,
        &host.access_token,
        "one_more.png",
        "image/png",
        png(32, 32),
    )
    .await;
    assert_eq!(
        refusal(add(&server, &host.access_token, "one_more", &picture).await).await,
        (422, "VALIDATION_FAILED".into())
    );
}

// ---------------------------------------------------------------------------
// Renaming and removing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_rename_takes_a_free_name_and_refuses_a_taken_one() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let a = upload(
        &server,
        &host.access_token,
        "a.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let b = upload(
        &server,
        &host.access_token,
        "b.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let cat = added(&server, &host.access_token, "cat", &a).await;
    added(&server, &host.access_token, "dog", &b).await;

    let resp = rename(&server, &host.access_token, &cat, "kitty").await;
    assert_eq!(resp.status(), 200);
    let renamed: CustomEmoji = resp.json().await.unwrap();
    assert_eq!((renamed.id, renamed.name.as_str()), (cat.id, "kitty"));
    // Its own name again is no clash.
    assert_eq!(
        rename(&server, &host.access_token, &renamed, "kitty")
            .await
            .status(),
        200
    );
    assert_eq!(
        refusal(rename(&server, &host.access_token, &renamed, "dog").await).await,
        (409, "CONFLICT".into())
    );
    assert_eq!(
        refusal(rename(&server, &host.access_token, &renamed, "Dog!").await).await,
        (422, "VALIDATION_FAILED".into())
    );
}

#[tokio::test]
async fn removing_an_emoji_takes_its_picture_with_it() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let picture = upload(
        &server,
        &host.access_token,
        "gone.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let emoji = added(&server, &host.access_token, "gone", &picture).await;

    assert_eq!(
        remove(&server, &host.access_token, &emoji).await.status(),
        204
    );
    assert!(list(&server, &host.access_token).await.is_empty());
    let served = client()
        .get(absolute(&server, &emoji.url))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), 404, "the picture is gone too");
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM attachments WHERE id = ?")
        .bind(picture.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(rows, 0);

    assert_eq!(
        refusal(remove(&server, &host.access_token, &emoji).await).await,
        (404, "NOT_FOUND".into())
    );
    assert_eq!(
        refusal(rename(&server, &host.access_token, &emoji, "back").await).await,
        (404, "NOT_FOUND".into())
    );
}

// ---------------------------------------------------------------------------
// The picture is the emoji's
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_emojis_picture_cant_be_thrown_away_or_posted_as_an_upload() {
    let (server, host, room) = server_with_room("general").await;
    let picture = upload(
        &server,
        &host.access_token,
        "keep.png",
        "image/png",
        png(32, 32),
    )
    .await;
    added(&server, &host.access_token, "keep", &picture).await;

    let thrown = client()
        .delete(server.url(&format!("/uploads/{}", picture.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refusal(thrown).await, (409, "CONFLICT".into()));

    let posted = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "look", "attachment_ids": [picture.id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(refusal(posted).await, (409, "CONFLICT".into()));
    assert_eq!(list(&server, &host.access_token).await.len(), 1);
}

#[tokio::test]
async fn an_emojis_picture_never_expires() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let picture = upload(
        &server,
        &host.access_token,
        "old.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let emoji = added(&server, &host.access_token, "old", &picture).await;
    // An unposted upload of the same age beside it, which does go.
    let orphan = upload(
        &server,
        &host.access_token,
        "orphan.png",
        "image/png",
        png(32, 32),
    )
    .await;
    sqlx::query("UPDATE attachments SET created_at = created_at - ?")
        .bind(10 * 365 * DAY_MS)
        .execute(&server.state.db.write)
        .await
        .unwrap();

    let swept = expiry::sweep(&server.state).await.unwrap();
    assert_eq!(swept.files, 1, "only the orphan goes");
    let left = client()
        .get(absolute(&server, &orphan.url))
        .send()
        .await
        .unwrap();
    assert_eq!(left.status(), 404);
    assert_eq!(list(&server, &host.access_token).await, vec![emoji.clone()]);
    let served = client()
        .get(absolute(&server, &emoji.url))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), 200);
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ready_carries_the_set_and_every_change_reaches_everybody() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "callie").await;
    let first = upload(
        &server,
        &host.access_token,
        "cat.png",
        "image/png",
        png(32, 32),
    )
    .await;
    added(&server, &host.access_token, "cat", &first).await;

    let (mut ws, ready) = connect_ready(&server, &member.access_token).await;
    assert_eq!(names(&ready), vec!["cat"]);

    let second = upload(
        &server,
        &host.access_token,
        "dog.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let dog = added(&server, &host.access_token, "dog", &second).await;
    assert_eq!(
        names(&wait_for(&mut ws, "emoji.update").await),
        vec!["cat", "dog"]
    );

    assert_eq!(
        rename(&server, &host.access_token, &dog, "aardvark")
            .await
            .status(),
        200
    );
    assert_eq!(
        names(&wait_for(&mut ws, "emoji.update").await),
        vec!["aardvark", "cat"]
    );

    assert_eq!(
        remove(&server, &host.access_token, &dog).await.status(),
        204
    );
    assert_eq!(names(&wait_for(&mut ws, "emoji.update").await), vec!["cat"]);
}

#[tokio::test]
async fn a_message_keeps_the_text_it_was_written_with() {
    let (server, host, room) = server_with_room("general").await;
    let picture = upload(
        &server,
        &host.access_token,
        "cat.png",
        "image/png",
        png(32, 32),
    )
    .await;
    let cat = added(&server, &host.access_token, "cat", &picture).await;
    let sent: Message = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "hello :cat:" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        remove(&server, &host.access_token, &cat).await.status(),
        204
    );
    let page: Vec<Message> = client()
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let kept = page
        .iter()
        .find(|m| m.id == sent.id)
        .expect("the message is there");
    assert_eq!(kept.body, "hello :cat:");
}
