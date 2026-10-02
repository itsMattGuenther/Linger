//! Display copies (#382, PROTOCOL §6): an image is drawn small from a copy
//! 960 px on its longest side, so an engine that decodes the whole picture
//! holds a few MB for a photo in a conversation instead of fifty.
//!
//! Real HTTP against the production router, and real uploads through the real
//! pipeline. The pictures are just over the line, 1600 px, because a test
//! build decodes and resizes slowly.

mod common;

use common::{bootstrap_host, spawn_server, TestServer};
use linger_core::wire::{Attachment, MediaItem, Message, Room, UploadSlot};
use linger_server::{display, expiry};

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// A server, its host's token, and a room.
async fn fixture() -> (TestServer, String, Room) {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room: Room = client()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "slug": "den", "name": "#den" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (server, host.access_token, room)
}

/// Slot, PUT, complete.
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
        .json(&serde_json::json!({ "filename": filename, "size_bytes": bytes.len() as u64, "mime": mime }))
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
    let done = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "parts": serde_json::Value::Null }))
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

/// Upload a file and post it on a message.
async fn share(server: &TestServer, token: &str, room: &Room, attachment: &Attachment) -> Message {
    client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "body": "look", "attachment_ids": [attachment.id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// The room's messages, newest last.
async fn messages(server: &TestServer, token: &str, room: &Room) -> Vec<Message> {
    client()
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// An object, fetched from the media origin as the app fetches it.
async fn fetch(server: &TestServer, url: &str) -> reqwest::Response {
    client()
        .get(format!("{}{url}", server.base))
        .send()
        .await
        .unwrap()
}

/// The picture at a URL, and how it was served.
async fn picture(server: &TestServer, url: &str) -> (image::DynamicImage, String) {
    let response = fetch(server, url).await;
    assert_eq!(response.status(), 200, "{url}");
    let headers = response.headers().clone();
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert!(headers["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("sandbox"));
    let bytes = response.bytes().await.unwrap();
    (
        image::load_from_memory(&bytes).unwrap(),
        headers["content-type"].to_str().unwrap().to_string(),
    )
}

fn canvas(width: u32, height: u32) -> image::DynamicImage {
    let mut canvas = image::RgbImage::new(width, height);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x % 256) as u8, (y % 256) as u8);
        *pixel = image::Rgb([r, g, 120]);
    }
    image::DynamicImage::ImageRgb8(canvas)
}

fn encoded(image: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
    let mut out = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut out), format)
        .unwrap();
    out
}

fn jpeg(width: u32, height: u32) -> Vec<u8> {
    encoded(&canvas(width, height), image::ImageFormat::Jpeg)
}

fn png(width: u32, height: u32) -> Vec<u8> {
    encoded(&canvas(width, height), image::ImageFormat::Png)
}

/// Two frames, so it is an animation.
fn gif(width: u32, height: u32) -> Vec<u8> {
    use image::codecs::gif::{GifEncoder, Repeat};
    let frames = [0u8, 255].map(|shade| {
        image::Frame::new(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([shade, 80, 80, 255]),
        ))
    });
    let mut out = Vec::new();
    {
        let mut encoder = GifEncoder::new(&mut out);
        encoder.set_repeat(Repeat::Infinite).unwrap();
        encoder.encode_frames(frames).unwrap();
    }
    out
}

/// Every image back to how it was before copies: no display key, and no copy.
async fn forget_copies(server: &TestServer) {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT object_key, display_key FROM attachments")
            .fetch_all(&server.state.db.read)
            .await
            .unwrap();
    for (object_key, display_key) in rows {
        if let Some(key) = display_key.filter(|key| *key != object_key) {
            server.state.storage.delete_object(&key).await.unwrap();
        }
    }
    sqlx::query("UPDATE attachments SET display_key = NULL")
        .execute(&server.state.db.write)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_large_photo_is_drawn_from_a_copy_960_px_on_its_longest_side() {
    let (server, token, _) = fixture().await;
    let photo = upload(&server, &token, "porch.jpg", "image/jpeg", jpeg(1600, 1200)).await;

    let display = photo
        .display_url
        .clone()
        .expect("a large photo has a display copy");
    assert_ne!(display, photo.url);
    let (copy, served_as) = picture(&server, &display).await;
    assert_eq!((copy.width(), copy.height()), (960, 720));
    assert_eq!(served_as, "image/jpeg");

    // The original is untouched, for the viewer and for downloads.
    let (original, _) = picture(&server, &photo.url).await;
    assert_eq!((original.width(), original.height()), (1600, 1200));
    assert_eq!((photo.width, photo.height), (Some(1600), Some(1200)));
}

#[tokio::test]
async fn a_large_png_is_copied_as_a_png() {
    let (server, token, _) = fixture().await;
    let shot = upload(&server, &token, "screen.png", "image/png", png(900, 1500)).await;
    let (copy, served_as) = picture(&server, &shot.display_url.unwrap()).await;
    assert_eq!((copy.width(), copy.height()), (576, 960));
    assert_eq!(served_as, "image/png");
}

#[tokio::test]
async fn a_small_image_and_an_animated_gif_are_drawn_as_they_are() {
    let (server, token, _) = fixture().await;
    let small = upload(&server, &token, "small.png", "image/png", png(400, 300)).await;
    assert_eq!(small.display_url.as_deref(), Some(small.url.as_str()));

    // A still copy would stop it moving.
    let moving = upload(&server, &token, "wave.gif", "image/gif", gif(1400, 8)).await;
    assert_eq!(moving.display_url.as_deref(), Some(moving.url.as_str()));
}

#[tokio::test]
async fn a_file_that_isnt_an_image_has_none() {
    let (server, token, _) = fixture().await;
    let notes = upload(
        &server,
        &token,
        "notes.txt",
        "text/plain",
        b"bring snacks".to_vec(),
    )
    .await;
    assert_eq!(notes.display_url, None);
    let raw: serde_json::Value = client()
        .get(server.url("/media?kind=file"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Left out on the wire, as an older server leaves it out.
    assert!(raw.to_string().find("display_url").is_none());
}

#[tokio::test]
async fn messages_and_media_carry_the_copy() {
    let (server, token, room) = fixture().await;
    let photo = upload(&server, &token, "porch.jpg", "image/jpeg", jpeg(1600, 1200)).await;
    share(&server, &token, &room, &photo).await;

    let listed = messages(&server, &token, &room).await;
    let on_message = &listed.last().unwrap().attachments[0];
    assert_eq!(on_message.display_url, photo.display_url);

    let media: Vec<MediaItem> = client()
        .get(server.url("/media?kind=image"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        media[0].attachment.as_ref().unwrap().display_url,
        photo.display_url
    );
}

#[tokio::test]
async fn a_copy_goes_with_its_file() {
    let (server, token, room) = fixture().await;

    // Thrown away before it was posted.
    let dropped = upload(
        &server,
        &token,
        "dropped.jpg",
        "image/jpeg",
        jpeg(1600, 1200),
    )
    .await;
    let gone = client()
        .delete(server.url(&format!("/uploads/{}", dropped.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
    assert_eq!(
        fetch(&server, &dropped.display_url.unwrap()).await.status(),
        404
    );

    // On a message that was deleted, and swept.
    let posted = upload(
        &server,
        &token,
        "posted.jpg",
        "image/jpeg",
        jpeg(1600, 1200),
    )
    .await;
    let message = share(&server, &token, &room, &posted).await;
    let deleted = client()
        .delete(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), 204);
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 1);
    assert_eq!(
        fetch(&server, &posted.display_url.unwrap()).await.status(),
        404
    );
}

#[tokio::test]
async fn images_from_before_copies_get_theirs_when_the_server_starts() {
    let (server, token, room) = fixture().await;
    let photo = upload(&server, &token, "porch.jpg", "image/jpeg", jpeg(1600, 1200)).await;
    let small = upload(&server, &token, "small.png", "image/png", png(400, 300)).await;
    let notes = upload(
        &server,
        &token,
        "notes.txt",
        "text/plain",
        b"bring snacks".to_vec(),
    )
    .await;
    for file in [&photo, &small, &notes] {
        share(&server, &token, &room, file).await;
    }
    forget_copies(&server).await;

    // Until it has, the app draws the original, as with an older server.
    let before = messages(&server, &token, &room).await;
    assert!(before
        .iter()
        .all(|message| message.attachments[0].display_url.is_none()));

    // Both images; the text file is no image.
    assert_eq!(display::catch_up(&server.state).await.unwrap(), 2);
    let after = messages(&server, &token, &room).await;
    let drawn = |name: &str| {
        after
            .iter()
            .find(|message| message.attachments[0].filename == name)
            .unwrap()
            .attachments[0]
            .clone()
    };
    let copied = drawn("porch.jpg").display_url.unwrap();
    assert_ne!(copied, photo.url);
    let (copy, _) = picture(&server, &copied).await;
    assert_eq!((copy.width(), copy.height()), (960, 720));
    assert_eq!(
        drawn("small.png").display_url.as_deref(),
        Some(small.url.as_str())
    );
    assert_eq!(drawn("notes.txt").display_url, None);

    // Done is done.
    assert_eq!(display::catch_up(&server.state).await.unwrap(), 0);
}

#[tokio::test]
async fn an_earlier_image_that_cant_be_read_is_drawn_as_it_was_and_not_tried_again() {
    let (server, token, _) = fixture().await;
    let photo = upload(&server, &token, "porch.jpg", "image/jpeg", jpeg(1600, 1200)).await;
    forget_copies(&server).await;
    let (key,): (String,) = sqlx::query_as("SELECT object_key FROM attachments")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    server
        .state
        .storage
        .put_bytes(
            &key,
            b"not a picture",
            &linger_server::storage::ServeAs::for_object("image/jpeg", "porch.jpg"),
        )
        .await
        .unwrap();

    assert_eq!(display::catch_up(&server.state).await.unwrap(), 1);
    let (drawn,): (Option<String>,) = sqlx::query_as("SELECT display_key FROM attachments")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(drawn.as_deref(), Some(key.as_str()));
    assert!(photo.url.ends_with(&key));
    assert_eq!(display::catch_up(&server.state).await.unwrap(), 0);
}
