//! Everywhere else a DM can leak (SPEC §4.13, T-1303).
//!
//! T-1301 made the gateway and the message routes private. This file is about
//! everything that *lists* things, which is the half that gets forgotten:
//! the media grid, search, the export, and the small mutating corners like
//! starring a file by its id.
//!
//! **Every test here is written from the outsider's side.** A test that proves
//! two people can see their own DM proves nothing about privacy — the only
//! useful assertion is that somebody who should see nothing sees nothing. Where
//! a test does check the member's view, it is to prove the filter is a filter
//! and not a blanket that hides the feature from everybody.
//!
//! The shape of every one of these is the same, on purpose: put something in a
//! DM, then ask the surface as a non-member, then ask it as a member.

mod common;

use linger_core::wire::{Attachment, MediaItem, Message, Room, SearchHit, UploadSlot};
use serde_json::{json, Value};

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// A one-pixel PNG. Small enough to be quick, real enough to be sniffed.
fn png() -> Vec<u8> {
    const B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(B64)
        .unwrap()
}

async fn upload(server: &common::TestServer, token: &str, filename: &str) -> Attachment {
    let bytes = png();
    let slot: UploadSlot = client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&json!({ "filename": filename, "size_bytes": bytes.len(), "mime": "image/png" }))
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
    let resp = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&json!({ "parts": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

async fn say(
    server: &common::TestServer,
    token: &str,
    room: &str,
    body: &str,
    files: &[&Attachment],
) -> Message {
    let ids: Vec<String> = files.iter().map(|f| f.id.to_string()).collect();
    let resp = client()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({
            "body": body,
            "attachment_ids": if ids.is_empty() { None } else { Some(ids) },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

async fn dm_with(server: &common::TestServer, token: &str, with: &[&str]) -> Room {
    let resp = client()
        .post(server.url("/dms"))
        .bearer_auth(token)
        .json(&json!({ "user_ids": with }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    resp.json().await.unwrap()
}

async fn media(server: &common::TestServer, token: &str, query: &str) -> Vec<MediaItem> {
    client()
        .get(server.url(&format!("/media{query}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn search(server: &common::TestServer, token: &str, q: &str) -> Vec<SearchHit> {
    client()
        .get(server.url(&format!("/search?q={q}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

/// A server with a room, a DM between the host and Callie, and Dave outside it.
/// Returns (server, host, callie, dave, dm).
async fn a_dm_and_an_outsider() -> (
    common::TestServer,
    linger_core::wire::AuthResponse,
    linger_core::wire::AuthResponse,
    linger_core::wire::AuthResponse,
    Room,
    Room,
) {
    let (server, host, room) = common::server_with_room("garage").await;
    let callie = common::join_member(&server, &host.access_token, "callie").await;
    let dave = common::join_member(&server, &host.access_token, "dave").await;
    let dm = dm_with(&server, &host.access_token, &[&callie.user.id.to_string()]).await;
    (server, host, callie, dave, dm, room)
}

// ---------------------------------------------------------------------------
// The media grid — three sources, three chances to get it wrong
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_media_grid_does_not_show_a_non_member_a_dms_files() {
    let (server, host, callie, dave, dm, room) = a_dm_and_an_outsider().await;

    let secret = upload(&server, &host.access_token, "private.png").await;
    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "look",
        &[&secret],
    )
    .await;
    let shared = upload(&server, &host.access_token, "public.png").await;
    say(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "look",
        &[&shared],
    )
    .await;

    // Dave sees the room's file and not the DM's.
    let his = media(&server, &dave.access_token, "").await;
    let names: Vec<String> = his
        .iter()
        .filter_map(|item| item.attachment.as_ref().map(|a| a.filename.clone()))
        .collect();
    assert!(names.contains(&"public.png".to_string()));
    assert!(
        !names.contains(&"private.png".to_string()),
        "a non-member's media grid held a DM's file"
    );

    // Callie sees both, so this is a filter and not a blanket.
    let hers = media(&server, &callie.access_token, "").await;
    let hers_names: Vec<String> = hers
        .iter()
        .filter_map(|item| item.attachment.as_ref().map(|a| a.filename.clone()))
        .collect();
    assert!(hers_names.contains(&"private.png".to_string()));
    assert!(hers_names.contains(&"public.png".to_string()));
}

#[tokio::test]
async fn the_media_grid_does_not_show_a_non_member_a_dms_links_or_pins() {
    let (server, host, callie, dave, dm, _room) = a_dm_and_an_outsider().await;

    let pinned = say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "see https://example.com/secret-plans for the thing",
        &[],
    )
    .await;
    let resp = client()
        .post(server.url(&format!("/messages/{}/pin", pinned.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    // Links and pins are two of the grid's three sources and each is its own
    // query, so each is its own chance to forget.
    let his = serde_json::to_string(&media(&server, &dave.access_token, "").await).unwrap();
    assert!(
        !his.contains("secret-plans"),
        "a DM's link reached a stranger"
    );
    assert!(!his.contains("see https"), "a DM's pin reached a stranger");

    let hers = serde_json::to_string(&media(&server, &callie.access_token, "").await).unwrap();
    assert!(
        hers.contains("secret-plans"),
        "a member lost their own DM's link"
    );
}

#[tokio::test]
async fn a_non_member_cannot_star_a_dms_file() {
    let (server, host, callie, dave, dm, _room) = a_dm_and_an_outsider().await;

    let secret = upload(&server, &host.access_token, "private.png").await;
    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "look",
        &[&secret],
    )
    .await;

    // A star is not a permission — anybody can star anything they can see. The
    // point of the check is that the answer would otherwise tell a stranger
    // holding an id whether that id is real.
    let refused = client()
        .put(server.url(&format!("/media/{}/star", secret.id)))
        .bearer_auth(&dave.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 404);

    let allowed = client()
        .put(server.url(&format!("/media/{}/star", secret.id)))
        .bearer_auth(&callie.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        allowed.status(),
        204,
        "a member could not star their own DM's file"
    );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[tokio::test]
async fn search_does_not_return_a_non_member_a_dms_words() {
    let (server, host, callie, dave, dm, room) = a_dm_and_an_outsider().await;

    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "the carburettor is private",
        &[],
    )
    .await;
    say(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "the carburettor is public",
        &[],
    )
    .await;

    let his = search(&server, &dave.access_token, "carburettor").await;
    assert_eq!(his.len(), 1, "a stranger's search reached into a DM");
    assert_eq!(his[0].room_id, room.id);

    let hers = search(&server, &callie.access_token, "carburettor").await;
    assert_eq!(hers.len(), 2, "a member lost their own DM from search");
}

#[tokio::test]
async fn search_does_not_find_a_dm_by_the_name_of_a_file_in_it() {
    let (server, host, _callie, dave, dm, _room) = a_dm_and_an_outsider().await;

    // The index covers filenames as well as words (SPEC §4.12), so it is a
    // second way into the same conversation and needs the same filter.
    let secret = upload(&server, &host.access_token, "carburettor-invoice.png").await;
    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "here",
        &[&secret],
    )
    .await;

    let his = search(&server, &dave.access_token, "carburettor-invoice").await;
    assert!(his.is_empty(), "a stranger found a DM by a filename in it");
}

#[tokio::test]
async fn a_search_cursor_from_inside_a_dm_answers_like_one_that_names_nothing() {
    let (server, host, _callie, dave, dm, room) = a_dm_and_an_outsider().await;

    say(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "the carburettor is public",
        &[],
    )
    .await;
    let private = say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "the carburettor is private",
        &[],
    )
    .await;

    // Search pages from the row a cursor's message was written to (#518). If
    // a stranger could page from a DM's message, he would get the older hits
    // where a made-up id gets none — and the difference would tell him the
    // message is real. A cursor is only looked up among messages he can see.
    let from_the_dm = search(
        &server,
        &dave.access_token,
        &format!("carburettor&before={}", private.id),
    )
    .await;
    let made_up = search(
        &server,
        &dave.access_token,
        &format!("carburettor&before={}", linger_core::MessageId::new()),
    )
    .await;
    let ids = |hits: &[SearchHit]| hits.iter().map(|hit| hit.message_id).collect::<Vec<_>>();
    assert_eq!(
        ids(&from_the_dm),
        ids(&made_up),
        "a search cursor told a stranger a DM's message exists"
    );
}

#[tokio::test]
async fn asking_to_search_inside_someone_elses_dm_is_not_found() {
    let (server, _host, _callie, dave, dm, _room) = a_dm_and_an_outsider().await;

    // Not an empty page: an empty page says "nothing matched in that room",
    // which is an answer only a room you can see should get.
    let resp = client()
        .get(server.url(&format!("/search?q=anything&room_id={}", dm.id)))
        .bearer_auth(&dave.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

// ---------------------------------------------------------------------------
// The export — the worst place to be wrong, because it leaves the server
// ---------------------------------------------------------------------------

async fn export_archive(server: &common::TestServer, token: &str) -> Vec<u8> {
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

    for _ in 0..100 {
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
                    .get(format!("{}{}", server.base, url))
                    .send()
                    .await
                    .unwrap()
                    .bytes()
                    .await
                    .unwrap();
                return bytes.to_vec();
            }
            Some("failed") => panic!("export failed: {job}"),
            _ => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
        }
    }
    panic!("export never finished");
}

/// Every file in the archive, unzipped.
///
/// **Reading the zip rather than its bytes is the whole point.** The entries
/// are deflated, so `bytes.contains("a secret")` is false for an archive that
/// holds the secret — a negative assertion against the raw bytes passes whether
/// the leak is there or not, which is the most comfortable kind of wrong test
/// to write. This suite got that wrong once before it got it right.
fn open_archive(bytes: Vec<u8>) -> Vec<(String, String)> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).expect("it opens");
    let mut out = Vec::new();
    for at in 0..zip.len() {
        let mut file = zip.by_index(at).unwrap();
        let name = file.name().to_string();
        let mut raw = Vec::new();
        file.read_to_end(&mut raw).unwrap();
        out.push((name, String::from_utf8_lossy(&raw).to_string()));
    }
    out
}

/// The whole archive as one string: every filename and everything in every
/// file. What a person who unzipped it and grepped would see.
fn everything(files: &[(String, String)]) -> String {
    files
        .iter()
        .map(|(name, text)| format!("{name}\n{text}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn an_export_holds_the_dms_you_are_in_and_no_others() {
    let (server, host, callie, dave, dm, room) = a_dm_and_an_outsider().await;

    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "kept between us",
        &[],
    )
    .await;
    say(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "said in the open",
        &[],
    )
    .await;

    // Dave's archive: the room, and no sign of the DM.
    let his = everything(&open_archive(
        export_archive(&server, &dave.access_token).await,
    ));
    assert!(
        his.contains("said in the open"),
        "the archive is empty, so this test proves nothing yet"
    );
    assert!(
        !his.contains("kept between us"),
        "an export carried a DM the asker was not in"
    );
    assert!(
        !his.contains(&dm.id.to_string()),
        "an export named a DM the asker was not in"
    );

    // Callie's archive has both. An export is the promise that leaving is
    // possible, and it has to carry the conversations that are hers.
    let hers = everything(&open_archive(
        export_archive(&server, &callie.access_token).await,
    ));
    assert!(
        hers.contains("kept between us"),
        "an export lost the asker's own DM"
    );
    assert!(hers.contains("said in the open"));
}

#[tokio::test]
async fn an_exported_dm_is_a_file_a_person_can_find() {
    let (server, host, callie, _dave, dm, _room) = a_dm_and_an_outsider().await;
    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "hello there",
        &[],
    )
    .await;

    let files = open_archive(export_archive(&server, &callie.access_token).await);
    let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();

    // Named by who it is with, not by the generated slug. An archive holding
    // `direct/dm-01a058c3….md` satisfies "your DMs are in it" and fails the
    // point of an export, which is that it opens without Linger. The archive
    // has a folder of its own at the top, so this matches the tail.
    assert!(
        names.iter().any(|name| name.ends_with("direct/matt.md")),
        "the DM is not where a person would look: {names:?}"
    );
    assert!(
        !names.iter().any(|name| name.contains(&dm.slug)),
        "the archive used the generated slug: {names:?}"
    );

    // And the file says who it is with, rather than a heading nobody can read.
    let (_, text) = files
        .iter()
        .find(|(name, _)| name.ends_with("direct/matt.md"))
        .unwrap();
    assert!(
        text.contains("direct message with Matt"),
        "the exported DM does not say who it is with: {text}"
    );
}

#[tokio::test]
async fn an_export_does_not_carry_somebody_elses_unposted_upload() {
    let (server, host, _callie, dave, _dm, _room) = a_dm_and_an_outsider().await;

    // Uploaded and never posted: it is in no room, so a plain room filter would
    // let it into everybody's archive. It belongs to whoever uploaded it —
    // which matters most for exactly the file somebody picked out to send in a
    // DM and has not sent yet.
    upload(&server, &host.access_token, "not-sent-yet.png").await;

    let his = everything(&open_archive(
        export_archive(&server, &dave.access_token).await,
    ));
    assert!(
        !his.contains("not-sent-yet.png"),
        "an export carried somebody else's unposted upload"
    );

    let theirs = everything(&open_archive(
        export_archive(&server, &host.access_token).await,
    ));
    assert!(
        theirs.contains("not-sent-yet.png"),
        "the uploader lost their own unposted file"
    );
}

// ---------------------------------------------------------------------------
// A removed member
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_removed_member_stops_seeing_a_dm_they_used_to_be_in() {
    let (server, host, callie, _dave, dm, room) = a_dm_and_an_outsider().await;

    let secret = upload(&server, &host.access_token, "was-hers-too.png").await;
    say(
        &server,
        &host.access_token,
        &dm.id.to_string(),
        "carburettor talk",
        &[&secret],
    )
    .await;
    say(
        &server,
        &host.access_token,
        &room.id.to_string(),
        "carburettor room",
        &[],
    )
    .await;

    // While she is a member, every surface answers.
    assert_eq!(
        search(&server, &callie.access_token, "carburettor")
            .await
            .len(),
        2
    );

    let removed = client()
        .post(server.url(&format!("/users/{}/remove", callie.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), 204);

    // Her sign-in is dead, so the honest way to ask "can she still see it" is
    // to let her back in and check the DM did not follow her out — removal
    // keeps the membership row so `restore` can put her back (T-413), and the
    // thing that must be true meanwhile is that she is not a member.
    let members = client()
        .get(server.url("/dms"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json::<Vec<Room>>()
        .await
        .unwrap()[0]
        .member_ids
        .clone()
        .unwrap();
    assert_eq!(
        members,
        vec![host.user.id],
        "a removed member was still in the DM"
    );

    let restored = client()
        .post(server.url(&format!("/users/{}/restore", callie.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(restored.status(), 204);

    // Back in, and it is the same DM with the same history rather than a new one.
    let again = common::sign_in(&server, "callie").await;
    assert_eq!(
        search(&server, &again.access_token, "carburettor")
            .await
            .len(),
        2
    );
    let hers = media(&server, &again.access_token, "").await;
    assert!(hers.iter().any(|item| item
        .attachment
        .as_ref()
        .is_some_and(|a| a.filename == "was-hers-too.png")));
    let _ = dm;
}
