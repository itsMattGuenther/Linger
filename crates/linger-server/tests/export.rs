//! Full export, over real HTTP, unzipped and read (SPEC §4.11, PROTOCOL §7,
//! T-801).
//!
//! The milestone check for M8 is "one archive contains every message and file,
//! and it opens", so these tests do exactly that rather than asserting about
//! the job row: seed a server, ask for an archive, download it from the media
//! origin the way a person would, open it with an unrelated zip reader, and
//! read what is inside.

mod common;

use std::io::Read;
use std::time::Duration;

use common::{bootstrap_host, join_member, spawn_named_server, spawn_server, TestServer};
use linger_core::wire::{
    Attachment, AuthResponse, ExportJob, ExportStarted, ExportState, Message, Room, UploadSlot,
};

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        // The named server's URLs point at a hostname that does not resolve;
        // every request here is aimed at the test server's real address and
        // carries the name in a Host header instead.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

async fn make_room(server: &TestServer, token: &str, slug: &str, topic: Option<&str>) -> Room {
    let resp = client()
        .post(server.url("/rooms"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "slug": slug, "name": slug, "topic": topic }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn say(server: &TestServer, token: &str, room: &Room, body: &str) -> Message {
    post(server, token, room, body, None).await
}

async fn reply(server: &TestServer, token: &str, room: &Room, body: &str, to: &Message) -> Message {
    post(server, token, room, body, Some(to)).await
}

async fn post(
    server: &TestServer,
    token: &str,
    room: &Room,
    body: &str,
    to: Option<&Message>,
) -> Message {
    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "body": body,
            "reply_to": to.map(|m| m.id.to_string()),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

/// A small real PNG, so the upload survives sniffing and re-encoding.
fn png() -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(8, 8);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x * 30 % 256) as u8, (y * 30 % 256) as u8);
        *pixel = image::Rgba([r, g, 180, 255]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// Upload one file and post it into a room.
async fn share(
    server: &TestServer,
    token: &str,
    room: &Room,
    filename: &str,
    body: &str,
) -> Attachment {
    let bytes = png();
    let slot: UploadSlot = client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "filename": filename,
            "size_bytes": bytes.len() as u64,
            "mime": "image/png",
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

    let attachment: Attachment = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "parts": null }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "body": body,
            "attachment_ids": [attachment.id],
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    attachment
}

/// Ask for an archive and wait for it, with a bound so a hang fails loudly
/// instead of stalling the suite.
async fn export_now(server: &TestServer, token: &str) -> ExportJob {
    let started: ExportStarted = client()
        .post(server.url("/export"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    for _ in 0..200 {
        let job: ExportJob = client()
            .get(server.url(&format!("/export/{}", started.job_id)))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(job.job_id, started.job_id);
        match job.state {
            ExportState::Complete => return job,
            ExportState::Failed => panic!("the export failed"),
            ExportState::Queued | ExportState::Running => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    panic!("the export never finished");
}

/// Every file in the archive, by name.
fn open_archive(bytes: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("it opens");
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        let name = file.name().to_string();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        out.push((name, bytes));
    }
    out
}

fn text_of<'a>(files: &'a [(String, Vec<u8>)], suffix: &str) -> &'a str {
    let (_, bytes) = files
        .iter()
        .find(|(name, _)| name.ends_with(suffix))
        .unwrap_or_else(|| panic!("the archive has no {suffix}; it has {:?}", names(files)));
    std::str::from_utf8(bytes).expect("markdown is utf-8")
}

fn names(files: &[(String, Vec<u8>)]) -> Vec<&str> {
    files.iter().map(|(name, _)| name.as_str()).collect()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_archive_holds_every_message_and_every_file_and_it_opens() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;

    let general = make_room(&server, &host.access_token, "general", Some("the big one")).await;
    let quiet = make_room(&server, &host.access_token, "quiet", None).await;

    let opener = say(&server, &host.access_token, &general, "first thing said").await;
    reply(
        &server,
        &sam.access_token,
        &general,
        "**bold** reply",
        &opener,
    )
    .await;
    let doomed = say(&server, &sam.access_token, &general, "regret this").await;
    share(
        &server,
        &sam.access_token,
        &general,
        "holiday photo.png",
        "look at this",
    )
    .await;
    say(&server, &host.access_token, &quiet, "anybody in here").await;

    // A deleted message is a tombstone. It must not come back in the archive.
    let gone = client()
        .delete(server.url(&format!("/messages/{}", doomed.id)))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);

    let job = export_now(&server, &host.access_token).await;
    let url = job.url.expect("a finished export has a url");

    // The archive is served from the object path, the same way an upload is.
    let archive = client()
        .get(format!("{}{}", server.base, url))
        .send()
        .await
        .unwrap();
    assert_eq!(archive.status(), 200);
    assert_eq!(
        archive
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/zip")
    );
    let files = open_archive(archive.bytes().await.unwrap().to_vec());

    // Every room, whether or not anybody said anything in it.
    let general_md = text_of(&files, "rooms/general.md");
    assert!(general_md.contains("first thing said"));
    assert!(general_md.contains("**bold** reply"));
    assert!(general_md.contains("the big one"), "the topic is in there");
    assert!(general_md.contains("Matt (@matt)"));
    // A reply quotes what it answered. A transcript where replies point at
    // nothing is the least readable kind there is.
    assert!(
        general_md.contains("> ↩ **Matt**: first thing said"),
        "a reply did not quote what it answered: {general_md}"
    );
    assert!(general_md.contains("sam (@sam)"));
    assert!(
        !general_md.contains("regret this"),
        "a deleted message came back: {general_md}"
    );
    assert!(text_of(&files, "rooms/quiet.md").contains("anybody in here"));

    // The file itself, under its own name, with its bytes.
    let (_, image) = files
        .iter()
        .find(|(name, _)| name.ends_with("media/holiday photo.png"))
        .unwrap_or_else(|| panic!("no media entry in {:?}", names(&files)));
    assert!(!image.is_empty());
    assert_eq!(&image[1..4], b"PNG", "the bytes are the real file");

    // …and the index that finds it.
    let index = text_of(&files, "media.md");
    assert!(index.contains("holiday photo.png"));
    assert!(index.contains("#general"));
    assert!(index.contains("sam"));

    let readme = text_of(&files, "README.md");
    assert!(readme.contains("test server"));
    assert!(readme.contains("UTC"));

    // Everything sits under one folder, so unzipping it does not scatter files
    // across somebody's downloads.
    assert!(
        names(&files).iter().all(|name| name.starts_with("linger-")),
        "entries are not under one folder: {:?}",
        names(&files)
    );
}

#[tokio::test]
async fn a_second_export_within_the_hour_is_refused() {
    let (server, host) = {
        let server = spawn_server().await;
        let host = bootstrap_host(&server).await;
        (server, host)
    };
    make_room(&server, &host.access_token, "general", None).await;

    let first = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);

    let second = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 429);
    let body: serde_json::Value = second.json().await.unwrap();
    assert_eq!(body["error"]["code"], "RATE_LIMITED");
    assert!(
        body["error"]["retry_after_ms"].as_u64().unwrap() > 0,
        "a refusal says when to come back"
    );
}

#[tokio::test]
async fn an_export_belongs_to_the_person_who_asked_for_it() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    make_room(&server, &host.access_token, "general", None).await;

    let started: ExportStarted = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    // Somebody else's job is not found rather than forbidden: which of the two
    // it was is not the asker's business.
    let peek = client()
        .get(server.url(&format!("/export/{}", started.job_id)))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(peek.status(), 404);

    // And it is a member-level feature, not a host one — sam can have their own.
    let sams = client()
        .post(server.url("/export"))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(sams.status(), 200);
}

#[tokio::test]
async fn an_archive_is_served_from_the_media_host_and_nowhere_else() {
    // The origin split (ARCHITECTURE §7) covers archives too: the whole server
    // in one file has no business being same-origin with the app.
    let server = spawn_named_server("linger.example", "cdn.linger.example").await;
    let host = bootstrap_host(&server).await;
    make_room(&server, &host.access_token, "general", None).await;
    say(
        &server,
        &host.access_token,
        &make_room(&server, &host.access_token, "talk", None).await,
        "hello",
    )
    .await;

    let job = export_now(&server, &host.access_token).await;
    let url = job.url.expect("a finished export has a url");
    assert!(
        url.starts_with("https://cdn.linger.example/objects/"),
        "an archive is served from the media origin, got {url}"
    );

    let path = url.trim_start_matches("https://cdn.linger.example");

    // On the app's own name: not here.
    let wrong = client()
        .get(format!("{}{path}", server.base))
        .header(reqwest::header::HOST, "linger.example")
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 404);

    // On the media name: here.
    let right = client()
        .get(format!("{}{path}", server.base))
        .header(reqwest::header::HOST, "cdn.linger.example")
        .send()
        .await
        .unwrap();
    assert_eq!(right.status(), 200);
    let files = open_archive(right.bytes().await.unwrap().to_vec());
    assert!(text_of(&files, "rooms/talk.md").contains("hello"));
}

#[tokio::test]
async fn an_archive_can_be_fetched_in_pieces() {
    // A browser resuming a big download asks for the rest of the file rather
    // than starting over, the same way a video player seeks (#222).
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let general = make_room(&server, &host.access_token, "general", None).await;
    say(&server, &host.access_token, &general, "hello").await;
    share(&server, &host.access_token, &general, "a.png", "a picture").await;

    let job = export_now(&server, &host.access_token).await;
    let url = format!(
        "{}{}",
        server.base,
        job.url.expect("a finished export has a url")
    );

    let whole = client().get(&url).send().await.unwrap();
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.headers()["accept-ranges"], "bytes");
    let whole_headers = whole.headers().clone();
    let archive = whole.bytes().await.unwrap();
    let len = archive.len();
    assert!(len > 100, "an archive with a picture in it is not tiny");

    let rest = client()
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=100-")
        .send()
        .await
        .unwrap();
    assert_eq!(rest.status(), 206);
    assert_eq!(
        rest.headers()["content-range"],
        format!("bytes 100-{}/{len}", len - 1)
    );
    assert_eq!(rest.headers()["content-length"], (len - 100).to_string());
    // Still a download, still not cached, still inert: a piece carries every
    // header the whole archive does.
    for name in [
        "content-type",
        "content-disposition",
        "cache-control",
        "x-content-type-options",
        "content-security-policy",
        "cross-origin-resource-policy",
        "accept-ranges",
    ] {
        assert!(whole_headers.contains_key(name), "{name}");
        assert_eq!(rest.headers().get(name), whole_headers.get(name), "{name}");
    }
    assert_eq!(rest.headers()["content-type"], "application/zip");
    assert_eq!(rest.headers()["cache-control"], "private, no-store");
    assert_eq!(rest.bytes().await.unwrap(), archive[100..]);

    let past = client()
        .get(&url)
        .header(reqwest::header::RANGE, format!("bytes={len}-"))
        .send()
        .await
        .unwrap();
    assert_eq!(past.status(), 416);
    assert_eq!(past.headers()["content-range"], format!("bytes */{len}"));

    let several = client()
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=0-9,20-29")
        .send()
        .await
        .unwrap();
    assert_eq!(several.status(), 200);
    assert_eq!(several.bytes().await.unwrap(), archive);
}

#[tokio::test]
async fn asking_again_replaces_the_previous_archive() {
    // One archive per member. Otherwise a member with a button can fill a
    // host's disk with copies of their own server.
    let server = spawn_server().await;
    let host: AuthResponse = bootstrap_host(&server).await;
    make_room(&server, &host.access_token, "general", None).await;

    let first = export_now(&server, &host.access_token).await;
    let first_url = first.url.expect("a finished export has a url");

    // The limiter is what stops this in the product; the test is about what the
    // *second* export does to the first one's bytes, so it goes straight at the
    // worker rather than through the door.
    let job_id = linger_server::export::start(&server.state, host.user.id)
        .await
        .unwrap();
    for _ in 0..200 {
        let job = linger_server::export::job(&server.state, job_id, host.user.id)
            .await
            .unwrap()
            .unwrap();
        if matches!(job.state, ExportState::Complete) {
            break;
        }
        assert!(!matches!(job.state, ExportState::Failed));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let stale = client()
        .get(format!("{}{first_url}", server.base))
        .send()
        .await
        .unwrap();
    assert_eq!(
        stale.status(),
        404,
        "the previous archive is still downloadable"
    );
}

/// Poll one job through the worker, not the door, until it finishes.
async fn wait_for(server: &TestServer, id: linger_core::ExportId, user: linger_core::UserId) {
    for _ in 0..200 {
        let job = linger_server::export::job(&server.state, id, user)
            .await
            .unwrap()
            .expect("the job exists");
        match job.state {
            ExportState::Complete => return,
            ExportState::Failed => panic!("the export failed"),
            ExportState::Queued | ExportState::Running => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    panic!("the export never finished");
}

#[tokio::test]
async fn exports_wait_their_turn_rather_than_building_side_by_side() {
    // The per-member limits do not stop every member asking at once, and
    // every archive being built holds its own copy of the server in scratch.
    // So there is one turn, server-wide, and everybody else waits in `queued`.
    let server = spawn_server().await;
    let host: AuthResponse = bootstrap_host(&server).await;
    let member = join_member(&server, &host.access_token, "callie").await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    say(&server, &host.access_token, &room, "hello").await;

    // Somebody else's archive is building: the one turn is taken.
    let turn = server.state.exports.clone().acquire_owned().await.unwrap();

    let mut started = Vec::new();
    for who in [&host, &member] {
        let job: ExportStarted = client()
            .post(server.url("/export"))
            .bearer_auth(&who.access_token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        started.push((who, job.job_id));
    }

    tokio::time::sleep(Duration::from_millis(300)).await;
    for (who, id) in &started {
        let job = linger_server::export::job(&server.state, *id, who.user.id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(job.state, ExportState::Queued),
            "an export started building while another held the turn"
        );
        assert!(job.progress.abs() < f32::EPSILON);
    }
    // Waiting costs no disk: nothing has been staged yet.
    let staged = std::fs::read_dir(server.state.config.staging_dir())
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(staged, 0, "a waiting export wrote to scratch");

    drop(turn);
    for (who, id) in started {
        wait_for(&server, id, who.user.id).await;
    }
}

#[tokio::test]
async fn an_export_replaced_while_it_waited_is_never_built() {
    // Asking again deletes the previous job's row. A job that was still
    // waiting for its turn must notice, or it builds and stores an archive
    // with nothing pointing at it — bytes on the host's disk nobody can reach.
    use linger_server::storage::{ObjectStore, ServeAs};

    let server = spawn_server().await;
    let host: AuthResponse = bootstrap_host(&server).await;
    make_room(&server, &host.access_token, "general", None).await;

    let turn = server.state.exports.clone().acquire_owned().await.unwrap();
    let replaced = linger_server::export::start(&server.state, host.user.id)
        .await
        .unwrap();
    let current = linger_server::export::start(&server.state, host.user.id)
        .await
        .unwrap();
    drop(turn);

    wait_for(&server, current, host.user.id).await;
    // Whichever of the two got the turn first, give the other time to take
    // it and give it back.
    for _ in 0..40 {
        if server.state.exports.available_permits() == linger_server::export::BUILDING_AT_ONCE {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        linger_server::export::job(&server.state, replaced, host.user.id)
            .await
            .unwrap()
            .is_none()
    );
    let serve = ServeAs::for_object("application/zip", "archive.zip");
    let object: &dyn ObjectStore = server.state.storage.as_ref();
    assert!(
        object
            .read_object(&linger_server::export::object_key(replaced), &serve)
            .await
            .unwrap()
            .is_none(),
        "the replaced export was built and stored anyway"
    );
}

// ---------------------------------------------------------------------------
// How long an archive lasts, and what it leaves on the disk (#504)
// ---------------------------------------------------------------------------

/// Is this archive still being handed out? What a person holding the link
/// would see.
async fn link_status(server: &TestServer, url: &str) -> u16 {
    client()
        .get(format!("{}{url}", server.base))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

/// Are the archive's bytes still in the store? The link going dead is what a
/// person sees; the bytes going is what the host's disk sees.
async fn stored(server: &TestServer, id: linger_core::ExportId) -> bool {
    use linger_server::storage::{ObjectStore, ServeAs};
    let serve = ServeAs::for_object("application/zip", "archive.zip");
    let store: &dyn ObjectStore = server.state.storage.as_ref();
    store
        .read_object(&linger_server::export::object_key(id), &serve)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn an_archive_lasts_a_week_and_then_the_sweeper_takes_it() {
    // An export is something you download, not something the server keeps.
    // Before #504 every member who ever exported left a copy of the whole
    // server on the host's disk, for good.
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    say(&server, &host.access_token, &room, "hello").await;

    let before = linger_server::db::now_ms();
    let job = export_now(&server, &host.access_token).await;
    let url = job.url.clone().expect("a finished export has a url");

    // The answer says when the link stops working, so the app can say it.
    let week = linger_server::export::KEPT_FOR_MS;
    let expires_at = job.expires_at.expect("a finished export says when it goes");
    assert!(
        expires_at >= before + week && expires_at <= linger_server::db::now_ms() + week,
        "the archive should last a week from when it finished, got {expires_at}"
    );

    // Inside its week, a sweep leaves it alone.
    linger_server::expiry::sweep(&server.state).await.unwrap();
    assert_eq!(link_status(&server, &url).await, 200);

    // A week and a minute later, it goes: bytes, row and link.
    sqlx::query("UPDATE exports SET finished_at = finished_at - ?")
        .bind(week + 60_000)
        .execute(&server.state.db.write)
        .await
        .unwrap();
    let swept = linger_server::expiry::sweep(&server.state).await.unwrap();
    assert_eq!(swept.archives, 1);
    assert_eq!(
        link_status(&server, &url).await,
        404,
        "an old archive is still served"
    );
    assert!(
        !stored(&server, job.job_id).await,
        "an old archive's bytes are still on disk"
    );
    let asked = client()
        .get(server.url(&format!("/export/{}", job.job_id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(asked.status(), 404);
}

#[tokio::test]
async fn removing_a_member_takes_their_archive_with_them() {
    // A removed member can't sign in, and before #504 their archive's link
    // still worked: the whole server, for anybody holding a URL.
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    say(&server, &host.access_token, &room, "hello").await;

    let job = export_now(&server, &sam.access_token).await;
    let url = job.url.expect("a finished export has a url");
    assert_eq!(link_status(&server, &url).await, 200);

    let removed = client()
        .post(server.url(&format!("/users/{}/remove", sam.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);

    assert_eq!(
        link_status(&server, &url).await,
        404,
        "a removed member's archive is still served"
    );
    assert!(
        !stored(&server, job.job_id).await,
        "a removed member's archive is still on disk"
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM exports WHERE user_id = ?")
        .bind(sam.user.id.to_vec())
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a removed member's job is still on record");
}

#[tokio::test]
async fn a_job_cut_off_by_a_restart_is_failed_and_the_next_one_builds() {
    // A job's worker lives in the server process. Stop the process mid-zip
    // and, before #504, the row said `running` forever and its scratch stayed
    // in `staging/` for good.
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    say(&server, &host.access_token, &room, "hello").await;

    // What the last run of the server left: a job half built, and its
    // scratch, plus an S3 upload's that was being gathered.
    let cut_off = linger_core::ExportId::new();
    sqlx::query(
        "INSERT INTO exports (id, user_id, state, progress, created_at)
         VALUES (?, ?, 'running', 0.4, ?)",
    )
    .bind(cut_off.to_vec())
    .bind(host.user.id.to_vec())
    .bind(linger_server::db::now_ms())
    .execute(&server.state.db.write)
    .await
    .unwrap();
    let staging = server.state.config.staging_dir();
    std::fs::create_dir_all(staging.join(".tmpHalfBuilt/media")).unwrap();
    std::fs::write(staging.join(".tmpHalfBuilt/archive.zip"), b"half a zip").unwrap();
    std::fs::create_dir_all(staging.join("0192aaaa-upload")).unwrap();
    std::fs::write(staging.join("0192aaaa-upload/assembled"), b"half a file").unwrap();

    // What `main` does before it answers anybody.
    let recovered = linger_server::export::recover(&server.state).await.unwrap();
    assert_eq!(recovered.jobs, 1);

    let job: ExportJob = client()
        .get(server.url(&format!("/export/{cut_off}")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        job.state,
        ExportState::Failed,
        "a job nobody is building still says it is"
    );
    assert!(job.url.is_none());
    let left: Vec<_> = std::fs::read_dir(&staging)
        .map(|entries| entries.map(|entry| entry.unwrap().file_name()).collect())
        .unwrap_or_default();
    assert!(left.is_empty(), "scratch survived a restart: {left:?}");

    // And the person can simply ask again.
    let fresh = export_now(&server, &host.access_token).await;
    assert_ne!(fresh.job_id, cut_off);
    assert_eq!(link_status(&server, &fresh.url.expect("a url")).await, 200);
}

#[tokio::test]
async fn an_export_the_disk_cannot_hold_is_refused_in_words() {
    // Building an archive needs about its own size in free space (twice that
    // on S3). Running the disk out stops SQLite writing, and the server with
    // it, so a server that can't hold one says so instead of trying.
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    share(&server, &host.access_token, &room, "huge.png", "a big one").await;
    // An exbibyte: no disk this test runs on has that free.
    sqlx::query("UPDATE attachments SET size_bytes = ?")
        .bind(1_i64 << 60)
        .execute(&server.state.db.write)
        .await
        .unwrap();

    let refused = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 507);
    let body: serde_json::Value = refused.json().await.unwrap();
    assert_eq!(body["error"]["code"], "QUOTA_EXCEEDED");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("doesn't have room") && message.contains("free"),
        "the refusal should say why in words: {message}"
    );
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM exports")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a refused export left a job behind");
}

#[tokio::test]
async fn an_export_that_waited_is_checked_for_room_again_when_its_turn_comes() {
    // Ten members asking in the same minute all pass the check at the door,
    // since nothing is built yet. What protects the disk is checking again
    // when each one's turn comes.
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    share(&server, &host.access_token, &room, "photo.png", "a photo").await;

    let turn = server.state.exports.clone().acquire_owned().await.unwrap();
    let waiting = linger_server::export::start(&server.state, host.user.id)
        .await
        .unwrap();
    // While it waited, the disk filled up, as far as this export can tell.
    sqlx::query("UPDATE attachments SET size_bytes = ?")
        .bind(1_i64 << 60)
        .execute(&server.state.db.write)
        .await
        .unwrap();
    drop(turn);

    for _ in 0..200 {
        let job = linger_server::export::job(&server.state, waiting, host.user.id)
            .await
            .unwrap()
            .expect("the job exists");
        match job.state {
            ExportState::Failed => {
                assert!(!stored(&server, waiting).await);
                return;
            }
            ExportState::Complete => panic!("an export the disk can't hold was built"),
            ExportState::Queued | ExportState::Running => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    panic!("the export never finished");
}

#[tokio::test]
async fn a_refusal_for_room_does_not_spend_the_hour() {
    // Nothing was built, so the member hasn't had their export this hour.
    // Before, a "no room" refusal used the hour up, and asking again once the
    // host had made room got "you already asked for one recently".
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let room = make_room(&server, &host.access_token, "general", None).await;
    share(&server, &host.access_token, &room, "photo.png", "a photo").await;
    let real: i64 = sqlx::query_scalar("SELECT size_bytes FROM attachments")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();

    sqlx::query("UPDATE attachments SET size_bytes = ?")
        .bind(1_i64 << 60)
        .execute(&server.state.db.write)
        .await
        .unwrap();
    let refused = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 507);

    // The host makes room.
    sqlx::query("UPDATE attachments SET size_bytes = ?")
        .bind(real)
        .execute(&server.state.db.write)
        .await
        .unwrap();
    let job = export_now(&server, &host.access_token).await;
    assert!(job.url.is_some());

    // And having had it, the hour now counts.
    let again = client()
        .post(server.url("/export"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 429);
}
