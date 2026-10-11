//! The media collection and the link cards, over real HTTP (T-504).
//!
//! What this has to prove, from SPEC §4.4 and the task: everything shared shows
//! up in one list, it filters by person, by type and by date, a star sorts an
//! item first, every item names the message it came from — and paging through
//! the whole thing never repeats an item or drops one.
//!
//! The link-preview half is here too, and the test that matters most is
//! `a_preview_never_goes_looking_inside_the_network`: a real listener on
//! loopback that must receive **nothing**, however the URL is dressed up.

mod common;

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use common::{bootstrap_host, join_member, server_with_room, spawn_server, TestServer};
use linger_core::wire::{Attachment, MediaItem, Message, Room, UploadSlot};
use serde_json::json;

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn png() -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(8, 6);
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

/// Slot, PUT, complete — the whole upload, since every media test starts with
/// something having been uploaded.
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
    let resp = client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&json!({ "parts": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "complete refused");
    resp.json().await.unwrap()
}

async fn post(
    server: &TestServer,
    token: &str,
    room: &Room,
    body: &str,
    files: &[&Attachment],
) -> Message {
    let ids: Vec<String> = files.iter().map(|file| file.id.to_string()).collect();
    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&json!({
            "body": body,
            "reply_to": null,
            "attachment_ids": if ids.is_empty() { None } else { Some(ids) },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "post refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

async fn media(server: &TestServer, token: &str, query: &str) -> Vec<MediaItem> {
    let resp = client()
        .get(server.url(&format!("/media{query}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "media refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

fn kinds(items: &[MediaItem]) -> Vec<String> {
    items
        .iter()
        .map(|item| {
            serde_json::to_value(item.kind)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_collection_holds_everything_shared_and_every_item_names_its_moment() {
    let (server, host, room) = server_with_room("den").await;
    let token = &host.access_token;

    let image = upload(&server, token, "holiday.png", "image/png", png()).await;
    let with_image = post(&server, token, &room, "the good one", &[&image]).await;
    let with_link = post(
        &server,
        token,
        &room,
        "read this https://example.com/a",
        &[],
    )
    .await;
    let pinned = post(&server, token, &room, "keep this", &[]).await;
    client()
        .post(server.url(&format!("/messages/{}/pin", pinned.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();

    let items = media(&server, token, "").await;
    assert_eq!(items.len(), 3, "one per thing shared: {items:#?}");

    // Newest first, and every one of them says where it came from.
    for item in &items {
        assert_eq!(item.room_id, Some(room.id));
        assert_eq!(item.author_id, host.user.id);
    }
    let image_item = items.iter().find(|item| item.attachment.is_some()).unwrap();
    assert_eq!(image_item.message_id, Some(with_image.id));
    assert_eq!(image_item.excerpt.as_deref(), Some("the good one"));
    assert_eq!(image_item.attachment.as_ref().unwrap().id, image.id);

    let link_item = items.iter().find(|item| item.link.is_some()).unwrap();
    assert_eq!(link_item.message_id, Some(with_link.id));
    let card = link_item.link.as_ref().unwrap();
    assert_eq!(card.url, "https://example.com/a");
    assert_eq!(card.domain, "example.com");

    let pin_item = items
        .iter()
        .find(|item| item.attachment.is_none() && item.link.is_none())
        .unwrap();
    assert_eq!(pin_item.message_id, Some(pinned.id));
    assert_eq!(pin_item.excerpt.as_deref(), Some("keep this"));
}

#[tokio::test]
async fn the_grid_filters_by_person_by_type_and_by_date() {
    let (server, host, room) = server_with_room("den").await;
    let friend = join_member(&server, &host.access_token, "sam").await;

    let mine = upload(&server, &host.access_token, "a.png", "image/png", png()).await;
    post(&server, &host.access_token, &room, "", &[&mine]).await;

    let theirs = upload(
        &server,
        &friend.access_token,
        "notes.txt",
        "text/plain",
        b"just some notes".to_vec(),
    )
    .await;
    post(&server, &friend.access_token, &room, "", &[&theirs]).await;
    let their_link = post(
        &server,
        &friend.access_token,
        &room,
        "https://example.com/b",
        &[],
    )
    .await;

    // By type.
    let images = media(&server, &host.access_token, "?kind=image").await;
    assert_eq!(kinds(&images), vec!["image"]);
    let files = media(&server, &host.access_token, "?kind=file").await;
    assert_eq!(kinds(&files), vec!["file"]);
    let links = media(&server, &host.access_token, "?kind=link").await;
    assert_eq!(kinds(&links), vec!["link"]);

    // By person.
    let theirs_only = media(
        &server,
        &host.access_token,
        &format!("?author={}", friend.user.id),
    )
    .await;
    assert_eq!(theirs_only.len(), 2);
    assert!(theirs_only
        .iter()
        .all(|item| item.author_id == friend.user.id));

    // By date range. `mid` is a moment with things on both sides of it, so the
    // two halves have to add back up to the whole. It's halfway between the
    // times the server gave the third thing shared and the fourth, rather than
    // a guess at how soon after one post the next lands, which on a busy
    // machine can be any time at all (#525). The pause keeps the two from
    // landing in the same millisecond.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let latest = post(
        &server,
        &host.access_token,
        &room,
        "https://example.com/c",
        &[],
    )
    .await;
    assert!(
        latest.created_at - their_link.created_at >= 2,
        "no moment between the third thing shared ({}) and the fourth ({})",
        their_link.created_at,
        latest.created_at
    );
    let mid = their_link.created_at + (latest.created_at - their_link.created_at) / 2;

    let newer = media(&server, &host.access_token, &format!("?since={mid}")).await;
    assert_eq!(newer.len(), 1, "only what was shared after mid");
    assert_eq!(newer[0].message_id, Some(latest.id));

    let older = media(&server, &host.access_token, &format!("?until={mid}")).await;
    assert_eq!(older.len(), 3);
    assert!(older.iter().all(|item| item.created_at <= mid));

    let empty = media(&server, &host.access_token, "?since=99999999999999").await;
    assert!(empty.is_empty(), "nothing was shared in the future");

    let backwards = client()
        .get(server.url("/media?since=200&until=100"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(backwards.status(), 422);
}

#[tokio::test]
async fn a_star_sorts_first_and_paging_never_repeats_or_skips() {
    let (server, host, room) = server_with_room("den").await;
    let token = &host.access_token;

    // Nine things, in three shapes, so the merge across the three sources is
    // actually exercised rather than one table being paged on its own.
    let mut uploaded = Vec::new();
    for n in 0..4 {
        let file = upload(&server, token, &format!("{n}.png"), "image/png", png()).await;
        post(&server, token, &room, "", &[&file]).await;
        uploaded.push(file);
    }
    for n in 0..3 {
        post(
            &server,
            token,
            &room,
            &format!("https://example.com/{n}"),
            &[],
        )
        .await;
    }
    for n in 0..2 {
        let message = post(&server, token, &room, &format!("pin {n}"), &[]).await;
        client()
            .post(server.url(&format!("/messages/{}/pin", message.id)))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
    }

    // Star the oldest upload: it must come first anyway.
    let starred = &uploaded[0];
    let resp = client()
        .put(server.url(&format!("/media/{}/star", starred.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    let all = media(&server, token, "?limit=100").await;
    assert_eq!(all.len(), 9);
    assert_eq!(
        all[0].attachment.as_ref().map(|file| file.id),
        Some(starred.id),
        "a starred item sorts ahead of newer ones"
    );
    assert!(all[0].starred_at.is_some());

    // Walk it two at a time and compare with the whole list. Same items, same
    // order, nothing twice.
    let mut walked: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let query = match &cursor {
            None => "?limit=2".to_string(),
            Some(at) => format!("?limit=2&before={}", urlencoding(at)),
        };
        let page = media(&server, token, &query).await;
        if page.is_empty() {
            break;
        }
        cursor = Some(page.last().unwrap().cursor.clone());
        walked.extend(page.into_iter().map(|item| item.cursor));
    }
    let unique: HashSet<&String> = walked.iter().collect();
    assert_eq!(
        unique.len(),
        walked.len(),
        "an item came back twice: {walked:?}"
    );
    assert_eq!(
        walked,
        all.iter()
            .map(|item| item.cursor.clone())
            .collect::<Vec<_>>(),
        "paging saw a different collection than one big page did"
    );

    // And taking the star back puts it where its date says.
    let resp = client()
        .delete(server.url(&format!("/media/{}/star", starred.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
    let after = media(&server, token, "?limit=100").await;
    assert_ne!(
        after[0].attachment.as_ref().map(|file| file.id),
        Some(starred.id)
    );
    assert!(after.iter().all(|item| item.starred_at.is_none()));
}

/// `before=` values are opaque and contain a colon, which has to survive the
/// query string.
fn urlencoding(raw: &str) -> String {
    raw.replace(':', "%3A")
}

#[tokio::test]
async fn only_things_that_were_actually_shared_are_in_the_collection() {
    let (server, host, room) = server_with_room("den").await;
    let token = &host.access_token;

    // Uploaded but never posted: nobody has seen it.
    upload(&server, token, "private.png", "image/png", png()).await;

    // Posted and then deleted: it left the room.
    let doomed = upload(&server, token, "gone.png", "image/png", png()).await;
    let message = post(
        &server,
        token,
        &room,
        "https://example.com/gone",
        &[&doomed],
    )
    .await;
    client()
        .delete(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();

    assert!(media(&server, token, "").await.is_empty());
}

#[tokio::test]
async fn an_edit_changes_what_the_collection_remembers() {
    let (server, host, room) = server_with_room("den").await;
    let token = &host.access_token;

    let message = post(&server, token, &room, "look https://example.com/first", &[]).await;
    let before = media(&server, token, "?kind=link").await;
    assert_eq!(before.len(), 1);
    assert_eq!(
        before[0].link.as_ref().unwrap().url,
        "https://example.com/first"
    );

    client()
        .patch(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(token)
        .json(&json!({ "body": "never mind" }))
        .send()
        .await
        .unwrap();
    assert!(media(&server, token, "?kind=link").await.is_empty());
}

#[tokio::test]
async fn a_star_on_something_that_is_not_in_the_collection_is_a_404() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let nowhere = linger_core::AttachmentId::new();
    let resp = client()
        .put(server.url(&format!("/media/{nowhere}/star")))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn the_collection_needs_a_sign_in() {
    let server = spawn_server().await;
    let resp = client().get(server.url("/media")).send().await.unwrap();
    assert_eq!(resp.status(), 401);
}

// ---------------------------------------------------------------------------
// Link cards
// ---------------------------------------------------------------------------

async fn previews(server: &TestServer, token: &str, urls: &[&str]) -> Vec<serde_json::Value> {
    let resp = client()
        .post(server.url("/links/preview"))
        .bearer_auth(token)
        .json(&json!({ "urls": urls }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "preview refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// The one that matters. A listener on loopback, and every shape of URL that
/// might reach it — by address, by name, with a port, over IPv6. It must count
/// zero connections, and every card must still come back so the client has
/// something to draw.
#[tokio::test]
async fn a_preview_never_goes_looking_inside_the_network() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    let hits = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    {
        let hits = hits.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                hits.fetch_add(1, Ordering::SeqCst);
                drop(stream);
            }
        });
    }

    let targets = [
        format!("http://127.0.0.1:{port}/secret"),
        format!("http://localhost:{port}/secret"),
        format!("http://[::1]:{port}/secret"),
        "http://127.0.0.1/".to_string(),
        "http://192.168.1.1/admin".to_string(),
        "http://169.254.169.254/latest/meta-data/".to_string(),
        "http://10.0.0.1/".to_string(),
        "file:///etc/passwd".to_string(),
    ];
    let asked: Vec<&str> = targets.iter().map(String::as_str).collect();
    let cards = previews(&server, &host.access_token, &asked).await;

    assert_eq!(cards.len(), targets.len(), "one card per URL asked about");
    for card in &cards {
        assert!(
            card["title"].is_null(),
            "a refused fetch has no title: {card}"
        );
        assert!(
            card["icon"].is_null(),
            "a refused fetch has no icon: {card}"
        );
    }
    // Give anything in flight a moment to land before counting.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "the server connected to a private address"
    );
}

#[tokio::test]
async fn a_card_that_could_not_be_fetched_is_still_a_card_and_is_remembered() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    // `.invalid` never resolves, by RFC. This is a fetch that genuinely goes
    // through the guard and comes back with nothing.
    let cards = previews(&server, &host.access_token, &["https://nothing.invalid/a"]).await;
    assert_eq!(cards[0]["domain"], "nothing.invalid");
    assert!(cards[0]["title"].is_null());

    let (state,): (String,) =
        sqlx::query_as("SELECT state FROM link_previews WHERE url = 'https://nothing.invalid/a'")
            .fetch_one(&server.state.db.read)
            .await
            .unwrap();
    assert_eq!(state, "failed", "the attempt is remembered, not repeated");

    // Asking again answers from that row rather than going back out.
    let again = previews(&server, &host.access_token, &["https://nothing.invalid/a"]).await;
    assert_eq!(again[0]["domain"], "nothing.invalid");
}

#[tokio::test]
async fn a_link_dump_cannot_ask_for_an_unbounded_batch() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let many: Vec<String> = (0..40)
        .map(|n| format!("https://example.com/{n}"))
        .collect();
    let resp = client()
        .post(server.url("/links/preview"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "urls": many }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 422);
}
