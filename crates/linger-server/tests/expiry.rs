//! The file sweeper (T-505): what ages out, what never does, and the storage
//! figures `GET /server` reports.
//!
//! Everything here drives real HTTP against the production router, and every
//! file is a real upload through the real pipeline. The one thing a test cannot
//! do honestly is wait a year, so age is faked the only way it can be: the
//! `created_at` on the row is moved backwards, exactly as if the file had been
//! sitting there since last spring.

mod common;

use common::spawn_server;
use common::{bootstrap_host, spawn_tuned, TestServer};
use linger_core::wire::{Attachment, Message, RefreshResponse, Room, ServerInfo, UploadSlot};
use linger_server::config::{Config, FileExpiry};
use linger_server::db::now_ms;
use linger_server::expiry;
use sha2::{Digest, Sha256};

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

/// Renew a sign-in, as the app does every fifteen minutes or so: the token
/// presented is used up, and the reply carries the next one.
async fn renew(server: &TestServer, refresh_token: &str) -> reqwest::Response {
    client()
        .post(server.url("/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .unwrap()
}

/// The row a refresh token is kept as, by its hash, as `auth` stores it.
fn token_hash(refresh_token: &str) -> String {
    hex::encode(Sha256::digest(refresh_token.as_bytes()))
}

/// Every refresh token row's hash, sorted.
async fn token_rows(server: &TestServer) -> Vec<String> {
    sqlx::query_scalar("SELECT token_hash FROM refresh_tokens ORDER BY token_hash")
        .fetch_all(&server.state.db.read)
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The rule in SPEC §4.10, and both of its exceptions, in one pass.
#[tokio::test]
async fn an_old_file_goes_unless_it_is_starred_or_pinned() {
    let (server, token, room) = fixture(|config| config.file_expiry = FileExpiry::After(365)).await;

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
    let (server, token, room) = fixture(|config| config.file_expiry = FileExpiry::Off).await;
    let (_, file) = share(&server, &token, &room, "ancient.txt", filler(2000)).await;
    age_everything(&server, 4000).await;

    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
    assert_eq!(object_status(&server, &file).await, 200);
}

/// A shorter window is the same rule with a different number, and the number is
/// the host's.
#[tokio::test]
async fn a_host_can_ask_for_a_shorter_window() {
    let (server, token, room) = fixture(|config| config.file_expiry = FileExpiry::After(30)).await;
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
/// Its own window, a week, is in `uploads.rs` (#503); unfinished ones are
/// `unsent`'s.
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
        config.file_expiry = FileExpiry::After(90);
    })
    .await;

    let empty = info(&server, &token).await;
    assert_eq!(empty.storage_used_bytes, 0);
    assert_eq!(empty.storage_limit_bytes, 4 * 1024 * 1024 * 1024);
    assert_eq!(empty.file_expiry_days, Some(90));
    assert_eq!(empty.file_expiry_when_full, Some(false));

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
    let (server, token, _room) = fixture(|config| config.file_expiry = FileExpiry::Off).await;
    let said = info(&server, &token).await;
    assert_eq!(said.file_expiry_days, None);
    assert_eq!(said.file_expiry_when_full, Some(false));
}

/// Used sign-in tokens are deleted once their 30 days are up (#520). An app
/// left open renews its sign-in all day, and each renewal kept the token it
/// used up: about a hundred rows a day for every device, forever. Past its 30
/// days a token is refused anyway. One still inside them stays, so presenting
/// it again still ends the sign-in it came from (PROTOCOL §2), and the live
/// one keeps working.
#[tokio::test]
async fn used_sign_in_tokens_go_once_their_thirty_days_are_up() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let first = host.refresh_token;
    let second: RefreshResponse = renew(&server, &first).await.json().await.unwrap();
    let second = second.refresh_token;
    let third: RefreshResponse = renew(&server, &second).await.json().await.unwrap();
    let third = third.refresh_token;
    assert_eq!(token_rows(&server).await.len(), 3);

    // The first one's 30 days ran out yesterday.
    sqlx::query("UPDATE refresh_tokens SET expires_at = ? WHERE token_hash = ?")
        .bind(now_ms() - DAY_MS)
        .bind(token_hash(&first))
        .execute(&server.state.db.write)
        .await
        .unwrap();
    assert_eq!(expiry::sweep(&server.state).await.unwrap().tokens, 1);
    let mut kept = vec![token_hash(&second), token_hash(&third)];
    kept.sort();
    assert_eq!(
        token_rows(&server).await,
        kept,
        "the used token past its 30 days is gone, the rest kept"
    );

    // The live one still renews.
    let fourth = renew(&server, &third).await;
    assert_eq!(fourth.status(), 200);
    let fourth: RefreshResponse = fourth.json().await.unwrap();

    // A used one inside its 30 days is still caught: presenting it again
    // ends the whole sign-in, the newest token with it.
    assert_eq!(renew(&server, &second).await.status(), 401);
    assert_eq!(
        renew(&server, &fourth.refresh_token).await.status(),
        401,
        "reusing a used token still ends the sign-in"
    );
    assert_eq!(expiry::sweep(&server.state).await.unwrap().tokens, 0);
}

// ---------------------------------------------------------------------------
// `when-full`, the default (#583)
// ---------------------------------------------------------------------------

/// A tiny pool, so a few small files fill it: 90% is 90,000 bytes and 80%
/// is 80,000.
const POOL: u64 = 100_000;

fn when_full(config: &mut Config) {
    config.pool_bytes = POOL;
    config.file_expiry = FileExpiry::WhenFull;
}

/// Put a file's date back by `days`, so files can be told apart by age.
async fn age(server: &TestServer, attachment: &Attachment, days: i64) {
    sqlx::query("UPDATE attachments SET created_at = ? WHERE id = ?")
        .bind(linger_server::db::now_ms() - days * DAY_MS)
        .bind(attachment.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();
}

/// Wait for a pass an upload started in the background to finish.
async fn settle(server: &TestServer) {
    drop(server.state.making_room.lock().await);
}

async fn leaving_ids(server: &TestServer, token: &str) -> Vec<String> {
    let items: Vec<serde_json::Value> = client()
        .get(server.url("/media?leaving=true"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    items
        .iter()
        .map(|item| {
            item["attachment"]["id"]
                .as_str()
                .expect("only files leave")
                .to_string()
        })
        .collect()
}

/// The point of #583: a year-old photo on a half-empty server stays.
#[tokio::test]
async fn a_year_old_file_stays_while_the_server_has_room() {
    let (server, token, room) = fixture(|_| {}).await;
    let said = info(&server, &token).await;
    assert_eq!(said.file_expiry_days, None);
    assert_eq!(
        said.file_expiry_when_full,
        Some(true),
        "when-full is the default"
    );

    let (_, photo) = share(&server, &token, &room, "lake.txt", filler(4000)).await;
    age_everything(&server, 4000).await;
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
    assert_eq!(object_status(&server, &photo).await, 200);
    assert!(
        leaving_ids(&server, &token).await.is_empty(),
        "nothing is leaving soon with room to spare"
    );
}

/// Somebody else's upload still going up, `bytes` big: it counts against the
/// pool like a stored file does, without a message to sweep.
async fn going_up(server: &TestServer, bytes: i64) {
    sqlx::query(
        "INSERT INTO attachments (id, uploader_id, object_key, filename, mime, size_bytes, state, created_at)
         SELECT randomblob(16), id, 'objects/going-up', 'going-up.bin', 'application/octet-stream', ?, 'pending', ?
           FROM users LIMIT 1",
    )
    .bind(bytes)
    .bind(linger_server::db::now_ms())
    .execute(&server.state.db.write)
    .await
    .unwrap();
}

/// Past 90% the oldest file nobody starred or pinned goes first, and only
/// until the pool is back under 80%.
#[tokio::test]
async fn past_ninety_percent_the_oldest_go_until_it_is_under_eighty() {
    let (server, token, room) = fixture(when_full).await;
    // Eight files of 10,000 bytes: 80%, so nothing goes yet.
    let mut files = Vec::new();
    for n in 0..8 {
        files.push(share(&server, &token, &room, &format!("f{n}.txt"), filler(10_000)).await);
    }
    for (n, (_, file)) in files.iter().enumerate() {
        age(&server, file, 100 - n as i64).await;
    }
    let star = client()
        .put(server.url(&format!("/media/{}/star", files[0].1.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(star.status(), 204);
    let pin = client()
        .post(server.url(&format!("/messages/{}/pin", files[1].0.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(pin.status(), 200);
    assert_eq!(
        expiry::sweep(&server.state).await.unwrap().files,
        0,
        "80% has room"
    );

    // Another 10,000 going up takes it to 90%.
    going_up(&server, 10_000).await;
    let swept = expiry::sweep(&server.state).await.unwrap();
    assert_eq!(swept.files, 1, "one file brings it back to 80%");
    assert_eq!(info(&server, &token).await.storage_used_bytes, 80_000);
    // The oldest one nobody starred or pinned: never a starred file or one on
    // a pinned message, however old.
    assert_eq!(object_status(&server, &files[2].1).await, 404);
    for kept in [&files[0].1, &files[1].1, &files[3].1, &files[7].1] {
        assert_eq!(
            object_status(&server, kept).await,
            200,
            "{} should still be served",
            kept.filename
        );
    }
}

/// An upload that wouldn't fit makes the room it needs before it's refused.
#[tokio::test]
async fn an_upload_that_would_not_fit_makes_room_first() {
    let (server, token, room) = fixture(when_full).await;
    let (_, oldest) = share(&server, &token, &room, "oldest.txt", filler(40_000)).await;
    let (_, newer) = share(&server, &token, &room, "newer.txt", filler(40_000)).await;
    age(&server, &oldest, 30).await;
    age(&server, &newer, 10).await;

    // 80,000 used and 30,000 more is over the ceiling: the oldest goes.
    let big = upload(&server, &token, "big.txt", filler(30_000)).await;
    settle(&server).await;
    assert_eq!(object_status(&server, &oldest).await, 404);
    assert_eq!(object_status(&server, &newer).await, 200);
    assert_eq!(big.size_bytes, 30_000);
}

/// With every file starred there's nothing to take, and the host hears the
/// file space is nearly used up. While something could still go, they don't:
/// that's the setting working.
#[tokio::test]
async fn the_host_hears_the_file_space_is_full_only_when_nothing_can_go() {
    let (server, token, room) = fixture(when_full).await;
    let (_, file) = share(&server, &token, &room, "keep.txt", filler(85_000)).await;
    let star = client()
        .put(server.url(&format!("/media/{}/star", file.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(star.status(), 204);
    going_up(&server, 10_000).await;
    expiry::sweep(&server.state).await.unwrap();
    assert_eq!(object_status(&server, &file).await, 200, "a star keeps it");
    assert!(
        info(&server, &token)
            .await
            .health
            .unwrap()
            .file_space_nearly_full
    );

    // Without the star it could go, so the host isn't told.
    let unstar = client()
        .delete(server.url(&format!("/media/{}/star", file.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(unstar.status(), 204);
    assert!(
        !info(&server, &token)
            .await
            .health
            .unwrap()
            .file_space_nearly_full
    );
}

/// "Leaving soon" under an age rule: what's within a month of its date, never
/// a starred or pinned file, and never a link or a pin.
#[tokio::test]
async fn leaving_soon_is_a_month_ahead_under_an_age_rule() {
    let (server, token, room) = fixture(|config| config.file_expiry = FileExpiry::After(365)).await;
    let (_, soon) = share(&server, &token, &room, "soon.txt", filler(1000)).await;
    let (_, later) = share(&server, &token, &room, "later.txt", filler(1000)).await;
    let (_, starred) = share(&server, &token, &room, "starred.txt", filler(1000)).await;
    age(&server, &soon, 340).await;
    age(&server, &later, 100).await;
    age(&server, &starred, 340).await;
    let star = client()
        .put(server.url(&format!("/media/{}/star", starred.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(star.status(), 204);

    assert_eq!(
        leaving_ids(&server, &token).await,
        vec![soon.id.to_string()]
    );
}

/// "Leaving soon" under `when-full`: past 80%, the oldest that add up to a
/// tenth of the pool, which is what one pass at 90% takes.
#[tokio::test]
async fn leaving_soon_is_the_next_tenth_under_when_full() {
    let (server, token, room) = fixture(when_full).await;
    let mut files = Vec::new();
    for n in 0..4 {
        let (_, file) = share(&server, &token, &room, &format!("f{n}.txt"), filler(21_000)).await;
        files.push(file);
    }
    for (n, file) in files.iter().enumerate() {
        age(&server, file, 10 - n as i64).await;
    }
    // 84,000 used: past 80%, so the oldest 10,000 bytes' worth is next, which
    // is the oldest file.
    assert_eq!(
        leaving_ids(&server, &token).await,
        vec![files[0].id.to_string()]
    );
}

#[tokio::test]
async fn nothing_is_leaving_soon_with_expiry_off() {
    let (server, token, room) = fixture(|config| config.file_expiry = FileExpiry::Off).await;
    share(&server, &token, &room, "forever.txt", filler(1000)).await;
    age_everything(&server, 4000).await;
    assert!(leaving_ids(&server, &token).await.is_empty());
}
