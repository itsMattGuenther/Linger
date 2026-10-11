//! A deleted message's files are deleted with it, at once (#502, SPEC §4.10,
//! ARCHITECTURE §8).
//!
//! Before this, a delete emptied the message and left its files to the
//! sweeper, up to six hours later. Until then the file's address still served
//! it, history still showed the deleted message carrying its name and
//! address, and anybody's export took a copy.
//!
//! Real HTTP against the production router, real uploads through the real
//! pipeline, and a temp SQLite file. Every assertion is made straight after
//! the delete answers, with no sweep in between, because "at once" is the
//! whole of the bug.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{bootstrap_host, join_member, spawn_server, spawn_with_store, TestServer};
use linger_core::wire::{
    Attachment, CompletedPart, MediaItem, Message, Room, ServerInfo, UploadSlot,
};
use linger_core::{AttachmentId, UploadId};
use linger_server::expiry;
use linger_server::storage::{ObjectBody, ObjectStore, ServeAs, Staged};
use serde_json::{json, Value};

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn make_room(server: &TestServer, token: &str, slug: &str) -> Room {
    let resp = client()
        .post(server.url("/rooms"))
        .bearer_auth(token)
        .json(&json!({ "slug": slug, "name": format!("#{slug}") }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
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
        .json(&json!({ "filename": filename, "size_bytes": bytes.len(), "mime": mime }))
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
        .json(&json!({ "parts": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(done.status(), 200, "{}", done.text().await.unwrap());
    done.json().await.unwrap()
}

/// Post a message carrying these files.
async fn say(
    server: &TestServer,
    token: &str,
    room: &Room,
    body: &str,
    files: &[&Attachment],
) -> Message {
    let ids: Vec<String> = files.iter().map(|f| f.id.to_string()).collect();
    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&json!({ "body": body, "attachment_ids": ids }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn delete(server: &TestServer, token: &str, message: &Message) {
    let resp = client()
        .delete(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
}

/// The room's history, as the app loads it.
async fn history(server: &TestServer, token: &str, room: &Room) -> Vec<Message> {
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

async fn media(server: &TestServer, token: &str) -> Vec<MediaItem> {
    client()
        .get(server.url("/media"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn storage_used(server: &TestServer, token: &str) -> u64 {
    let info: ServerInfo = client()
        .get(server.url("/server"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    info.storage_used_bytes
}

/// What anybody holding the address gets: no session, as an `<img>` asks.
async fn status_of(server: &TestServer, url: &str) -> u16 {
    client()
        .get(format!("{}{url}", server.base))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// Whether the bytes behind a served address are still in the store, asked
/// of the store itself rather than of the route that serves them.
async fn stored(server: &TestServer, url: &str) -> bool {
    let key = url
        .rsplit_once("/objects/")
        .expect("a served URL is under /objects/")
        .1;
    server
        .state
        .storage
        .read_object(key, &ServeAs::for_object("application/octet-stream", "x"))
        .await
        .unwrap()
        .is_some()
}

/// An unzipped archive: its entries' names, and every name and every entry's
/// contents as one string, which is what a person who unzipped it and
/// searched it would see.
struct Archive {
    names: Vec<String>,
    text: String,
}

/// Ask for an archive, wait for it, and unzip it.
async fn export(server: &TestServer, token: &str) -> Archive {
    use std::io::Read;

    let started: Value = client()
        .post(server.url("/export"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let job_id = started["job_id"].as_str().expect("job id").to_string();
    for _ in 0..200 {
        let job: Value = client()
            .get(server.url(&format!("/export/{job_id}")))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        match job["state"].as_str() {
            Some("complete") => {
                let url = job["url"].as_str().expect("a finished export has a url");
                let bytes = client()
                    .get(format!("{}{url}", server.base))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap();
                let mut zip =
                    zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).expect("it opens");
                let mut out = Archive {
                    names: Vec::new(),
                    text: String::new(),
                };
                for at in 0..zip.len() {
                    let mut file = zip.by_index(at).unwrap();
                    let mut raw = Vec::new();
                    file.read_to_end(&mut raw).unwrap();
                    out.names.push(file.name().to_string());
                    out.text.push_str(file.name());
                    out.text.push('\n');
                    out.text.push_str(&String::from_utf8_lossy(&raw));
                    out.text.push('\n');
                }
                return out;
            }
            Some("failed") => panic!("export failed: {job}"),
            _ => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
    panic!("export never finished");
}

/// A photo just over the display line, so it has a copy beside it (#382).
fn photo() -> Vec<u8> {
    let mut canvas = image::RgbImage::new(1200, 900);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x % 256) as u8, (y % 256) as u8);
        *pixel = image::Rgb([r, g, 120]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    out
}

/// Every address a file is reachable at: itself, and its display copy if it
/// has one of its own.
fn addresses(file: &Attachment) -> Vec<String> {
    let mut out = vec![file.url.clone()];
    if let Some(display) = file.display_url.as_ref().filter(|d| **d != file.url) {
        out.push(display.clone());
    }
    out
}

// ---------------------------------------------------------------------------

/// The issue, end to end: a photo and a file on one message, deleted, and
/// every way to reach either checked straight after.
#[tokio::test]
async fn a_deleted_messages_files_are_gone_the_moment_it_is_deleted() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let room = make_room(&server, &host.access_token, "porch").await;

    let pic = upload(
        &server,
        &sam.access_token,
        "regret.jpg",
        "image/jpeg",
        photo(),
    )
    .await;
    let notes = upload(
        &server,
        &sam.access_token,
        "regret notes.txt",
        "text/plain",
        b"what I should not have sent".to_vec(),
    )
    .await;
    assert!(
        pic.display_url.as_ref().is_some_and(|d| *d != pic.url),
        "the photo has a display copy of its own"
    );
    let message = say(&server, &sam.access_token, &room, "oops", &[&pic, &notes]).await;
    say(&server, &host.access_token, &room, "still here", &[]).await;

    let everywhere: Vec<String> = [&pic, &notes].into_iter().flat_map(addresses).collect();
    for url in &everywhere {
        assert_eq!(status_of(&server, url).await, 200, "{url} before");
    }

    delete(&server, &sam.access_token, &message).await;

    // The addresses answer as if there had never been a file, and the bytes
    // themselves are out of the store: not hidden, gone.
    for url in &everywhere {
        assert_eq!(status_of(&server, url).await, 404, "{url} still served");
        assert!(!stored(&server, url).await, "{url} still stored");
    }

    // History keeps the tombstone, for reply chains, and nothing on it.
    let messages = history(&server, &host.access_token, &room).await;
    let tombstone = messages
        .iter()
        .find(|m| m.id == message.id)
        .expect("a deleted message stays in history as a tombstone");
    assert!(tombstone.deleted_at.is_some());
    assert!(
        tombstone.attachments.is_empty(),
        "the deleted message still carries {:?}",
        tombstone.attachments
    );

    assert!(
        media(&server, &host.access_token).await.is_empty(),
        "the media collection still lists a deleted message's files"
    );
    assert_eq!(
        storage_used(&server, &host.access_token).await,
        0,
        "the pool still counts them"
    );

    let archive = export(&server, &host.access_token).await;
    assert!(
        archive.text.contains("still here"),
        "the archive is a real one"
    );
    assert!(
        !archive.text.contains("regret"),
        "an export started straight after carries the deleted files: {:?}",
        archive.names
    );

    // Nothing is left for the sweeper.
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 0);
}

/// A DM's files go the same way, for the other person in it too.
#[tokio::test]
async fn a_dms_file_goes_with_its_message_too() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let callie = join_member(&server, &host.access_token, "callie").await;
    let resp = client()
        .post(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "user_ids": [callie.user.id.to_string()] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let dm: Room = resp.json().await.unwrap();

    let file = upload(
        &server,
        &callie.access_token,
        "just for you.txt",
        "text/plain",
        b"between us".to_vec(),
    )
    .await;
    let message = say(&server, &callie.access_token, &dm, "for you", &[&file]).await;
    assert_eq!(status_of(&server, &file.url).await, 200);

    delete(&server, &callie.access_token, &message).await;

    assert_eq!(status_of(&server, &file.url).await, 404);
    assert!(!stored(&server, &file.url).await);
    let seen = history(&server, &host.access_token, &dm).await;
    assert!(seen.iter().all(|m| m.attachments.is_empty()));
}

/// When the store can't delete at the moment of the delete (a bucket that is
/// down), the file waits for the sweeper, which is the retry. A message
/// deleted on a server from before #502 is in the same state. Either way,
/// from the moment of the delete nothing hands the file out.
///
/// The message is tombstoned straight in the database, as the delete leaves
/// it when the store refuses, since the local store never refuses.
#[tokio::test]
async fn a_file_a_delete_left_behind_is_out_of_reach_until_the_sweeper_takes_it() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "porch").await;

    let pic = upload(
        &server,
        &host.access_token,
        "left behind.jpg",
        "image/jpeg",
        photo(),
    )
    .await;
    let message = say(&server, &host.access_token, &room, "oops", &[&pic]).await;
    say(&server, &host.access_token, &room, "still here", &[]).await;

    sqlx::query("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?")
        .bind(linger_server::db::now_ms())
        .bind(message.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();

    for url in addresses(&pic) {
        assert!(stored(&server, &url).await, "the bytes are still there");
        assert_eq!(status_of(&server, &url).await, 404, "{url} still served");
    }
    let messages = history(&server, &host.access_token, &room).await;
    assert!(
        messages.iter().all(|m| m.attachments.is_empty()),
        "history hands out a deleted message's file"
    );
    assert!(media(&server, &host.access_token).await.is_empty());
    let archive = export(&server, &host.access_token).await;
    assert!(
        archive.text.contains("still here"),
        "the archive is a real one"
    );
    assert!(
        !archive.text.contains("left behind"),
        "an export carries a deleted message's file: {:?}",
        archive.names
    );

    // The sweeper finishes it: bytes, copy and row.
    assert_eq!(expiry::sweep(&server.state).await.unwrap().files, 1);
    for url in addresses(&pic) {
        assert!(!stored(&server, &url).await, "{url} outlived the sweep");
    }
    assert_eq!(storage_used(&server, &host.access_token).await, 0);
}

/// A store that does all a real one does except delete: asked to, it never
/// answers, like a bucket that has stopped responding without hanging up.
struct NeverDeletes(Arc<dyn ObjectStore>);

#[async_trait::async_trait]
impl ObjectStore for NeverDeletes {
    fn slot(
        &self,
        upload_id: UploadId,
        attachment_id: AttachmentId,
        size_bytes: u64,
    ) -> anyhow::Result<UploadSlot> {
        self.0.slot(upload_id, attachment_id, size_bytes)
    }

    async fn assemble(
        &self,
        upload_id: UploadId,
        parts: Option<&[CompletedPart]>,
        expected_parts: u32,
    ) -> anyhow::Result<Staged> {
        self.0.assemble(upload_id, parts, expected_parts).await
    }

    async fn put_object(
        &self,
        key: &str,
        from: &std::path::Path,
        serve: &ServeAs,
    ) -> anyhow::Result<()> {
        self.0.put_object(key, from, serve).await
    }

    async fn put_bytes(&self, key: &str, bytes: &[u8], serve: &ServeAs) -> anyhow::Result<()> {
        self.0.put_bytes(key, bytes, serve).await
    }

    async fn read_object(&self, key: &str, serve: &ServeAs) -> anyhow::Result<Option<ObjectBody>> {
        self.0.read_object(key, serve).await
    }

    async fn delete_object(&self, _key: &str) -> anyhow::Result<()> {
        std::future::pending().await
    }

    async fn discard(&self, upload_id: UploadId) -> anyhow::Result<()> {
        self.0.discard(upload_id).await
    }
}

/// A store that stops answering must not hold up the delete. The app gives up
/// on an answer at 30 seconds, and a delete that waited longer than that for
/// the bucket would look like it failed while the message was already gone.
/// The file is out of reach all the same, and left for the sweeper.
#[tokio::test]
async fn a_store_that_never_answers_does_not_hold_up_the_delete() {
    let server = spawn_with_store(|store| Arc::new(NeverDeletes(store))).await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "porch").await;
    let file = upload(
        &server,
        &host.access_token,
        "stuck.txt",
        "text/plain",
        b"the bucket is down".to_vec(),
    )
    .await;
    let message = say(&server, &host.access_token, &room, "oops", &[&file]).await;

    tokio::time::timeout(
        Duration::from_secs(20),
        delete(&server, &host.access_token, &message),
    )
    .await
    .expect("the delete waited on the store and never answered");

    assert_eq!(status_of(&server, &file.url).await, 404);
    assert!(
        stored(&server, &file.url).await,
        "the bytes wait for the sweeper"
    );
    let messages = history(&server, &host.access_token, &room).await;
    assert!(messages.iter().all(|m| m.attachments.is_empty()));
}
