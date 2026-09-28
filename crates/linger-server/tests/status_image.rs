//! A status has no picture any more (#269, SPEC §4.6), end to end over real
//! HTTP against a temp SQLite file.
//!
//! Statuses used to carry one. What is left is compatibility, and the tests
//! here are about that: an app from before the removal still sends `image_id`
//! on every save and still reads `image_id` and `image_url` on every status.
//! So a save with one in it has to work and store nothing, every status has to
//! come back with both fields null, and a server that had pictures has to lose
//! them — the migration clears what statuses pointed at, and the sweeper stops
//! keeping those files.

mod common;

use common::{bootstrap_host, join_member, spawn_server, TestServer};
use linger_core::wire::{Attachment, UploadSlot, User, UserStatus};
use linger_core::UserId;
use linger_server::expiry;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// A small real PNG, so the upload goes through the image pipeline the way a
/// picture from an older app would.
fn png() -> Vec<u8> {
    let canvas = image::RgbImage::from_pixel(40, 20, image::Rgb([200, 120, 40]));
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// Slot, PUT, complete. Every file in this module fits in one part.
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
        .json(&serde_json::json!({
            "filename": filename,
            "size_bytes": bytes.len() as u64,
            "mime": mime,
        }))
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

/// A whole status the way an older app sends one: with an image id in it.
fn status_naming(image_id: &str) -> serde_json::Value {
    serde_json::json!({
        "status": {
            "line": "mounting the drive",
            "reading": "Piranesi", "listening": null, "working_on": null,
            "image_id": image_id,
            "image_url": "https://somewhere.example/whatever.png",
            "away_message": null, "away_since": null
        }
    })
}

/// `PATCH /me`, expecting it to be taken.
async fn save(server: &TestServer, token: &str, body: serde_json::Value) -> User {
    let resp = client()
        .patch(server.url("/me"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "status refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

async fn get<T: serde::de::DeserializeOwned>(server: &TestServer, token: &str, path: &str) -> T {
    client()
        .get(server.url(path))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// Is the object still being served? The bytes are what matters, not the row.
async fn object_status(server: &TestServer, url: &str) -> u16 {
    client()
        .get(format!("{}{url}", server.base))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// A status wearing a picture, written the way a server before #269 wrote one:
/// the file's object key in `user_status.image_key`. Nothing can put one there
/// through the API any more, which is the point.
async fn picture_the_old_way(server: &TestServer, user: UserId, line: &str, file: &Attachment) {
    let key: String = sqlx::query_scalar("SELECT object_key FROM attachments WHERE id = ?")
        .bind(file.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_status (user_id, line, image_key, updated_at) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET line = excluded.line, image_key = excluded.image_key",
    )
    .bind(user.to_vec())
    .bind(line)
    .bind(&key)
    .execute(&server.state.db.write)
    .await
    .unwrap();
}

/// Upgrade to #269 by running the migration exactly as shipped.
async fn run_the_migration(server: &TestServer) {
    sqlx::raw_sql(include_str!("../migrations/0006_no_status_image.sql"))
        .execute(&server.state.db.write)
        .await
        .expect("the status image migration");
}

async fn keys_left(server: &TestServer) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM user_status WHERE image_key IS NOT NULL")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap()
}

fn assert_no_image(status: Option<&UserStatus>, line: &str) {
    let status = status.expect("the status is there");
    assert_eq!(status.line.as_deref(), Some(line), "the words survived");
    assert_eq!(status.image_id, None);
    assert_eq!(status.image_url, None);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/// The case that matters: an older app saving a status with a picture on it.
/// The rest is saved, the picture is not, and nothing is refused.
#[tokio::test]
async fn a_save_with_an_image_keeps_the_rest_and_no_image() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let image = upload(&server, &host.access_token, "me.png", "image/png", png()).await;

    let saved = save(
        &server,
        &host.access_token,
        status_naming(&image.id.to_string()),
    )
    .await;
    assert_no_image(saved.status.as_ref(), "mounting the drive");
    assert_eq!(
        saved.status.and_then(|s| s.reading).as_deref(),
        Some("Piranesi")
    );
    assert_eq!(keys_left(&server).await, 0, "nothing was stored for it");

    // The file is left alone: it is an upload nobody posted, and the sweeper
    // decides when it goes, the same as any other.
    assert_eq!(object_status(&server, &image.url).await, 200);
}

/// The old checks are gone with the picture. Every one of these used to be a
/// refusal; an older app must never be told its status did not save because
/// of a field the server no longer reads.
#[tokio::test]
async fn an_image_id_is_never_checked() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "jo").await;

    let theirs = upload(&server, &member.access_token, "jo.png", "image/png", png()).await;
    let notes = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        b"nothing to look at".to_vec(),
    )
    .await;
    let nothing = linger_core::AttachmentId::new().to_string();

    for id in [theirs.id.to_string(), notes.id.to_string(), nothing] {
        let saved = save(&server, &host.access_token, status_naming(&id)).await;
        assert_no_image(saved.status.as_ref(), "mounting the drive");
    }
    // And somebody else's file is not touched by a status naming it.
    assert_eq!(object_status(&server, &theirs.url).await, 200);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Every way a status is read says no image, even over a row that still names
/// one — a server that has not run the migration yet, or a row somebody edited
/// by hand.
#[tokio::test]
async fn every_status_reads_back_with_no_image() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "jo").await;
    let image = upload(&server, &host.access_token, "me.png", "image/png", png()).await;
    picture_the_old_way(&server, host.user.id, "on the porch", &image).await;

    let me: User = get(&server, &host.access_token, "/me").await;
    assert_no_image(me.status.as_ref(), "on the porch");

    let one: User = get(
        &server,
        &member.access_token,
        &format!("/users/{}", host.user.id),
    )
    .await;
    assert_no_image(one.status.as_ref(), "on the porch");

    let everyone: Vec<User> = get(&server, &member.access_token, "/users").await;
    let seen = everyone
        .iter()
        .find(|user| user.id == host.user.id)
        .expect("the host is in the list");
    assert_no_image(seen.status.as_ref(), "on the porch");

    // Both fields are on the wire, as nulls, for apps that read them.
    let raw: serde_json::Value = get(&server, &host.access_token, "/me").await;
    assert_eq!(raw["status"]["image_id"], serde_json::Value::Null);
    assert_eq!(raw["status"]["image_url"], serde_json::Value::Null);
    assert!(raw["status"].as_object().unwrap().contains_key("image_id"));
    assert!(raw["status"].as_object().unwrap().contains_key("image_url"));
}

// ---------------------------------------------------------------------------
// Upgrading a server that had pictures
// ---------------------------------------------------------------------------

/// The migration takes every picture off every status and leaves the words.
#[tokio::test]
async fn the_migration_clears_every_status_picture() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "jo").await;
    let mine = upload(&server, &host.access_token, "me.png", "image/png", png()).await;
    let theirs = upload(&server, &member.access_token, "jo.png", "image/png", png()).await;
    picture_the_old_way(&server, host.user.id, "on the porch", &mine).await;
    picture_the_old_way(&server, member.user.id, "at the shop", &theirs).await;
    assert_eq!(keys_left(&server).await, 2);

    run_the_migration(&server).await;

    assert_eq!(keys_left(&server).await, 0);
    let lines: Vec<String> = sqlx::query_scalar("SELECT line FROM user_status ORDER BY line")
        .fetch_all(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(lines, ["at the shop", "on the porch"]);
}

/// After the upgrade, a file a status used to wear goes the way of any upload
/// that was never posted: kept through the expiry window, then swept. Before
/// #269 the sweeper skipped it forever.
#[tokio::test]
async fn a_file_a_status_wore_is_swept_like_any_unposted_upload() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let image = upload(&server, &host.access_token, "me.png", "image/png", png()).await;
    picture_the_old_way(&server, host.user.id, "on the porch", &image).await;
    run_the_migration(&server).await;

    // Not at once: the window still applies, as it does to anything unposted.
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
    assert_eq!(object_status(&server, &image.url).await, 200);

    sqlx::query("UPDATE attachments SET created_at = created_at - ?")
        .bind(400 * DAY_MS)
        .execute(&server.state.db.write)
        .await
        .unwrap();

    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 1);
    assert_eq!(object_status(&server, &image.url).await, 404);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id = ?")
        .bind(image.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(left, 0, "the row goes with the bytes");
}
