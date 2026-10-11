//! The file sweeper (T-505): what ages out, what never does, and the storage
//! figures `GET /server` reports.
//!
//! Everything here drives real HTTP against the production router, and every
//! file is a real upload through the real pipeline. The one thing a test cannot
//! do honestly is wait a year, so age is faked the only way it can be: the
//! `created_at` on the row is moved backwards, exactly as if the file had been
//! sitting there since last spring.

mod common;

use common::{bootstrap_host, spawn_tuned, TestServer};
use linger_core::wire::{Attachment, Message, Room, ServerInfo, UploadSlot};
use linger_server::config::Config;
use linger_server::expiry;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// A server, its host, and one room — with the storage knobs turned to whatever
/// the test needs.
async fn fixture(tune: impl FnOnce(&mut Config)) -> (TestServer, String, Room) {
    let server = spawn_tuned(tune).await;
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

/// Slot, PUT, complete. Small enough to be one part.
async fn upload(server: &TestServer, token: &str, filename: &str, bytes: Vec<u8>) -> Attachment {
    let slot: UploadSlot = client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "filename": filename,
            "size_bytes": bytes.len() as u64,
            "mime": "text/plain",
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

/// Upload a file and post it on a message, which is the only way a file is ever
/// actually shared.
async fn share(
    server: &TestServer,
    token: &str,
    room: &Room,
    filename: &str,
    bytes: Vec<u8>,
) -> (Message, Attachment) {
    let attachment = upload(server, token, filename, bytes).await;
    let message: Message = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "body": filename, "attachment_ids": [attachment.id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    (message, attachment)
}

/// Make every file on this server as old as it needs to be. There is no other
/// way to test a year-long window inside a test that has to finish.
async fn age_everything(server: &TestServer, days: i64) {
    sqlx::query("UPDATE attachments SET created_at = created_at - ?")
        .bind(days * DAY_MS)
        .execute(&server.state.db.write)
        .await
        .unwrap();
}

/// Is the object still being served? The sweeper's real job is the bytes, not
/// the row, so this is the assertion that matters.
async fn object_status(server: &TestServer, attachment: &Attachment) -> u16 {
    client()
        .get(format!("{}{}", server.base, attachment.url))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn info(server: &TestServer, token: &str) -> ServerInfo {
    client()
        .get(server.url("/server"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn media_ids(server: &TestServer, token: &str) -> Vec<String> {
    let items: Vec<serde_json::Value> = client()
        .get(server.url("/media"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    items
        .iter()
        .filter_map(|item| item["attachment"]["id"].as_str().map(str::to_string))
        .collect()
}

fn filler(len: usize) -> Vec<u8> {
    vec![b'x'; len]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The rule in SPEC §4.10, and both of its exceptions, in one pass.
#[tokio::test]
async fn an_old_file_goes_unless_it_is_starred_or_pinned() {
    let (server, token, room) = fixture(|_| {}).await;

    let (_, plain) = share(&server, &token, &room, "plain.txt", filler(4000)).await;
    let (_, starred) = share(&server, &token, &room, "starred.txt", filler(3000)).await;
    let (pinned_message, pinned) = share(&server, &token, &room, "pinned.txt", filler(2000)).await;
    let (_, fresh) = share(&server, &token, &room, "fresh.txt", filler(1000)).await;

    let star = client()
        .put(server.url(&format!("/media/{}/star", starred.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(star.status(), 204);
    let pin = client()
        .post(server.url(&format!("/messages/{}/pin", pinned_message.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(pin.status(), 200);

    // Everything is a year and a day old except the one uploaded just now.
    age_everything(&server, 366).await;
    sqlx::query("UPDATE attachments SET created_at = ? WHERE id = ?")
        .bind(linger_server::db::now_ms())
        .bind(fresh.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();

    let swept = expiry::sweep(&server.state).await.unwrap();
    assert_eq!(swept.files, 1, "only the unstarred, unpinned old file goes");
    assert_eq!(swept.bytes, 4000);

    assert_eq!(
        object_status(&server, &plain).await,
        404,
        "swept file served"
    );
    for kept in [&starred, &pinned, &fresh] {
        assert_eq!(
            object_status(&server, kept).await,
            200,
            "{} should still be served",
            kept.filename
        );
    }

    let left = media_ids(&server, &token).await;
    assert!(!left.contains(&plain.id.to_string()));
    assert_eq!(left.len(), 3);

    // A second pass has nothing left to do.
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
}

/// `LINGER_FILE_EXPIRY_DAYS=off`. A host who wants to keep everything keeps
/// everything, however old it gets.
#[tokio::test]
async fn a_host_can_turn_expiry_off_entirely() {
    let (server, token, room) = fixture(|config| config.file_expiry_days = None).await;
    let (_, file) = share(&server, &token, &room, "ancient.txt", filler(2000)).await;
    age_everything(&server, 4000).await;

    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
    assert_eq!(object_status(&server, &file).await, 200);
}

/// A shorter window is the same rule with a different number, and the number is
/// the host's.
#[tokio::test]
async fn a_host_can_ask_for_a_shorter_window() {
    let (server, token, room) = fixture(|config| config.file_expiry_days = Some(30)).await;
    let (_, old) = share(&server, &token, &room, "old.txt", filler(2000)).await;
    let (_, recent) = share(&server, &token, &room, "recent.txt", filler(2000)).await;
    age_everything(&server, 31).await;
    // Ten days old is inside a thirty-day window and stays.
    sqlx::query("UPDATE attachments SET created_at = ? WHERE id = ?")
        .bind(linger_server::db::now_ms() - 10 * DAY_MS)
        .bind(recent.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();

    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 1);
    assert_eq!(object_status(&server, &old).await, 404);
    assert_eq!(object_status(&server, &recent).await, 200);
}

/// Deleting a message empties its body and deletes what it carried, at the
/// delete rather than at the next pass (#502), and a star does not save it: a
/// star stops a file ageing out, and this is not ageing out. The rest of #502
/// is in `deleted_files.rs`.
#[tokio::test]
async fn a_deleted_message_takes_its_file_with_it() {
    let (server, token, room) = fixture(|_| {}).await;
    let (message, file) = share(&server, &token, &room, "regret.txt", filler(5000)).await;
    let star = client()
        .put(server.url(&format!("/media/{}/star", file.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(star.status(), 204);

    let gone = client()
        .delete(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);

    // No sweep: the delete took it, and left the sweeper nothing.
    assert_eq!(object_status(&server, &file).await, 404);
    assert_eq!(info(&server, &token).await.storage_used_bytes, 0);
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
}

/// A file somebody uploaded and never posted has nobody waiting for it either.
/// The 48-hour sweep in `routes::uploads` only takes *unfinished* ones.
#[tokio::test]
async fn a_finished_upload_that_never_became_a_message_ages_out_too() {
    let (server, token, _room) = fixture(|_| {}).await;
    let orphan = upload(&server, &token, "unsent.txt", filler(1500)).await;
    age_everything(&server, 366).await;

    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 1);
    assert_eq!(object_status(&server, &orphan).await, 404);
}

/// Statuses have no pictures now (#269), so the sweeper no longer asks
/// whether one points at a file. Even a row that still names one — a server
/// that has not run migration 0006, or a row edited by hand — does not keep
/// the file past the window. The upgrade end to end is in `status_image.rs`.
#[tokio::test]
async fn a_file_a_status_still_names_ages_out_all_the_same() {
    let (server, token, _room) = fixture(|_| {}).await;
    let image = upload(&server, &token, "me.txt", filler(900)).await;

    // Set straight on the column, as a server before #269 did, so this stays a
    // test of the sweeper alone.
    let key = sqlx::query_scalar::<_, String>("SELECT object_key FROM attachments WHERE id = ?")
        .bind(image.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO user_status (user_id, image_key, updated_at)
         SELECT id, ?, 0 FROM users LIMIT 1
         ON CONFLICT(user_id) DO UPDATE SET image_key = excluded.image_key",
    )
    .bind(&key)
    .execute(&server.state.db.write)
    .await
    .unwrap();

    age_everything(&server, 900).await;
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 1);
    assert_eq!(object_status(&server, &image).await, 404);
}

/// The status bar's third figure (SPEC §5.6), and the ceiling it is measured
/// against.
#[tokio::test]
async fn the_server_reports_what_storage_is_used() {
    let (server, token, room) = fixture(|config| {
        config.pool_bytes = 4 * 1024 * 1024 * 1024;
        config.file_expiry_days = Some(90);
    })
    .await;

    let empty = info(&server, &token).await;
    assert_eq!(empty.storage_used_bytes, 0);
    assert_eq!(empty.storage_limit_bytes, 4 * 1024 * 1024 * 1024);
    assert_eq!(empty.file_expiry_days, Some(90));

    let (_, file) = share(&server, &token, &room, "notes.txt", filler(7000)).await;
    let used = info(&server, &token).await;
    assert_eq!(used.storage_used_bytes, file.size_bytes);

    age_everything(&server, 91).await;
    expiry::sweep(&server.state).await.unwrap();
    assert_eq!(info(&server, &token).await.storage_used_bytes, 0);
}

/// Turning expiry off is visible to everybody, not only to the host who set it.
#[tokio::test]
async fn expiry_being_off_is_reported_as_off() {
    let (server, token, _room) = fixture(|config| config.file_expiry_days = None).await;
    assert_eq!(info(&server, &token).await.file_expiry_days, None);
}
