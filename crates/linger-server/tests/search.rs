//! Search, over real HTTP (SPEC §4.12, PROTOCOL §6, T-1201 + T-1202).
//!
//! Two halves. The index has to stay *true* — a word taken out of a message
//! stops matching it, a deleted message cannot be found at all, and a server
//! that already had history is searchable the moment it comes up on this
//! version. The endpoint has to page without repeating or dropping a hit, and
//! has to refuse an empty query rather than answering it with the whole server.
//!
//! The one thing worth naming for whoever reads this next: **the index is the
//! only copy of a message's text outside `messages`**, so every test that
//! changes a message asserts on what search says afterwards, not on what the
//! message says.

mod common;

use std::collections::HashSet;
use std::time::Instant;

use common::{join_member, server_with_room, TestServer};
use linger_core::limits::{MAX_MESSAGE_CHARS, MAX_SEARCH_QUERY_CHARS, RATE_SEARCH};
use linger_core::wire::{Attachment, Message, Room, SearchHit, UploadSlot};
use serde_json::json;

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn post(server: &TestServer, token: &str, room: &Room, body: &str) -> Message {
    post_with(server, token, room, body, &[]).await
}

async fn post_with(
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

fn png() -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(4, 4);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x * 60 % 256) as u8, (y * 60 % 256) as u8);
        *pixel = image::Rgba([r, g, 200, 255]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

async fn upload(server: &TestServer, token: &str, filename: &str) -> Attachment {
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
    assert_eq!(resp.status(), 200, "complete refused");
    resp.json().await.unwrap()
}

async fn search_raw(server: &TestServer, token: &str, query: &str) -> reqwest::Response {
    client()
        .get(server.url(&format!("/search{query}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
}

async fn search(server: &TestServer, token: &str, query: &str) -> Vec<SearchHit> {
    let resp = search_raw(server, token, query).await;
    assert_eq!(
        resp.status(),
        200,
        "search refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// `?q=` with the value percent-encoded, so a test can search for a phrase.
fn q(term: &str) -> String {
    let encoded: String = term
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b => format!("%{b:02X}"),
        })
        .collect();
    format!("?q={encoded}")
}

fn ids(hits: &[SearchHit]) -> Vec<String> {
    hits.iter().map(|hit| hit.message_id.to_string()).collect()
}

/// The whole snippet as one string, markers dropped — for asserting on text.
fn snippet_text(hit: &SearchHit) -> String {
    hit.snippet.iter().map(|part| part.text.as_str()).collect()
}

// ---------------------------------------------------------------------------
// T-1201 — the index
// ---------------------------------------------------------------------------

/// The backfill, which is the only part of the migration that a server built
/// before today ever runs.
///
/// The scenario is an upgrade: a server full of history, and then a version of
/// Linger that has search in it. Rather than hand-build an old database, this
/// posts real messages and then takes the index away — dropping the table and
/// its triggers puts the server exactly where an old one is — and replays the
/// shipped migration file over it.
#[tokio::test]
async fn a_word_in_an_old_message_is_findable_after_the_backfill() {
    let (server, host, room) = server_with_room("garage").await;
    let file = upload(&server, &host.access_token, "drive-cage.png").await;
    let old = post_with(
        &server,
        &host.access_token,
        &room,
        "did the drive get here yet",
        &[&file],
    )
    .await;
    let deleted = post(&server, &host.access_token, &room, "forget the drive").await;
    client()
        .delete(server.url(&format!("/messages/{}", deleted.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();

    // Become a server that predates search.
    for statement in [
        "DROP TRIGGER message_fts_ai",
        "DROP TRIGGER message_fts_au",
        "DROP TRIGGER message_fts_ad",
        "DROP TRIGGER message_fts_attach_au",
        "DROP TRIGGER message_fts_attach_ad",
        "DROP TABLE message_fts",
    ] {
        sqlx::query(statement)
            .execute(&server.state.db.write)
            .await
            .expect("undo the search migration");
    }
    assert!(
        search_raw(&server, &host.access_token, &q("drive"))
            .await
            .status()
            .is_server_error(),
        "with no index there is nothing to search — the test is proving the next step"
    );

    // Then upgrade, by running the migration exactly as shipped.
    sqlx::raw_sql(include_str!("../migrations/0004_search.sql"))
        .execute(&server.state.db.write)
        .await
        .expect("the search migration");

    let hits = search(&server, &host.access_token, &q("drive")).await;
    assert_eq!(
        ids(&hits),
        vec![old.id.to_string()],
        "the backfill missed history, or indexed a tombstone"
    );
    // And the file that was already on that message came with it.
    let hits = search(&server, &host.access_token, &q("cage")).await;
    assert_eq!(ids(&hits), vec![old.id.to_string()]);
}

#[tokio::test]
async fn an_edit_changes_what_a_message_matches() {
    let (server, host, room) = server_with_room("shop").await;
    let message = post(&server, &host.access_token, &room, "mounting the drive").await;
    assert_eq!(
        ids(&search(&server, &host.access_token, &q("drive")).await),
        vec![message.id.to_string()]
    );

    let resp = client()
        .patch(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "mounting the bracket" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    assert!(
        search(&server, &host.access_token, &q("drive"))
            .await
            .is_empty(),
        "an edit must replace what a message matches, not add to it"
    );
    assert_eq!(
        ids(&search(&server, &host.access_token, &q("bracket")).await),
        vec![message.id.to_string()]
    );
}

/// A deleted message is deleted — the same rule the export follows. Both halves
/// of the index go: the words and the names of the files that were on it.
#[tokio::test]
async fn a_deleted_message_is_unfindable_by_its_words_or_its_files() {
    let (server, host, room) = server_with_room("porch").await;
    let file = upload(&server, &host.access_token, "receipts.png").await;
    let message = post_with(
        &server,
        &host.access_token,
        &room,
        "the invoice is attached",
        &[&file],
    )
    .await;
    assert_eq!(
        search(&server, &host.access_token, &q("invoice"))
            .await
            .len(),
        1
    );
    assert_eq!(
        search(&server, &host.access_token, &q("receipts"))
            .await
            .len(),
        1
    );

    let resp = client()
        .delete(server.url(&format!("/messages/{}", message.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    assert!(search(&server, &host.access_token, &q("invoice"))
        .await
        .is_empty());
    assert!(
        search(&server, &host.access_token, &q("receipts"))
            .await
            .is_empty(),
        "a tombstone kept the name of the file it was carrying"
    );
}

#[tokio::test]
async fn a_file_is_findable_by_its_name_and_the_hit_says_which_file() {
    let (server, host, room) = server_with_room("garage").await;
    let file = upload(&server, &host.access_token, "turbo invoice 2026.png").await;
    let other = upload(&server, &host.access_token, "holiday.png").await;
    let message = post_with(
        &server,
        &host.access_token,
        &room,
        "here it is",
        &[&file, &other],
    )
    .await;

    let hits = search(&server, &host.access_token, &q("invoice")).await;
    assert_eq!(ids(&hits), vec![message.id.to_string()]);
    assert_eq!(
        hits[0].matched_filenames,
        vec!["turbo invoice 2026.png".to_string()],
        "a hit has to say which file matched, spaces and all — and not name the others"
    );

    // An upload nobody has posted yet is not part of the conversation.
    let unposted = upload(&server, &host.access_token, "scratchpad.png").await;
    assert!(search(&server, &host.access_token, &q("scratchpad"))
        .await
        .is_empty());
    let posted = post_with(&server, &host.access_token, &room, "", &[&unposted]).await;
    let hits = search(&server, &host.access_token, &q("scratchpad")).await;
    assert_eq!(ids(&hits), vec![posted.id.to_string()]);
    assert!(
        hits[0].snippet.is_empty(),
        "a photo posted with no caption has no words to show"
    );
}

/// Stemming is the reason the tokenizer line in the migration is what it is: a
/// search that only matched the exact form somebody typed would miss most of
/// the times anybody mentioned the thing.
#[tokio::test]
async fn simple_english_endings_are_the_same_word() {
    let (server, host, room) = server_with_room("porch").await;
    let message = post(&server, &host.access_token, &room, "look at these photos").await;
    assert_eq!(
        ids(&search(&server, &host.access_token, &q("photo")).await),
        vec![message.id.to_string()]
    );
}

/// PROTOCOL §4 caps a message at 8,000 characters, so T-1201's "5,000 words"
/// cannot be posted through the API at all — the largest legal message is
/// nearer 1,300. This posts twenty of those and asserts the insert path has not
/// turned into something you can feel. The threshold is deliberately loose: it
/// is there to catch a regression that makes indexing quadratic, not to measure
/// a machine.
#[tokio::test]
async fn a_maximum_size_message_does_not_slow_an_insert_to_a_crawl() {
    let (server, host, room) = server_with_room("shop").await;
    let mut body = String::new();
    let mut word = 0;
    while body.len() + 8 < MAX_MESSAGE_CHARS {
        body.push_str(&format!("word{word} "));
        word += 1;
    }
    let body = body.trim().to_string();

    // Nine, not more: RATE_MESSAGE_SEND allows a burst of ten and this test is
    // about the index, not about the rate limiter.
    let started = Instant::now();
    for _ in 0..9 {
        post(&server, &host.access_token, &room, &body).await;
    }
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_secs() < 5,
        "nine maximum-size messages took {elapsed:?}"
    );
    assert_eq!(
        search(&server, &host.access_token, &q("word7")).await.len(),
        9
    );
}

// ---------------------------------------------------------------------------
// T-1202 — the endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn filters_combine() {
    let (server, host, garage) = server_with_room("garage").await;
    let shop: Room = client()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "shop", "name": "#shop" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let callie = join_member(&server, &host.access_token, "callie").await;

    let host_in_garage = post(&server, &host.access_token, &garage, "the drive is here").await;
    let host_in_shop = post(&server, &host.access_token, &shop, "the drive cage is here").await;
    let callie_in_garage = post(&server, &callie.access_token, &garage, "which drive").await;

    let all = search(&server, &host.access_token, &q("drive")).await;
    assert_eq!(all.len(), 3);

    let by_room = search(
        &server,
        &host.access_token,
        &format!("{}&room_id={}", q("drive"), garage.id),
    )
    .await;
    assert_eq!(
        ids(&by_room),
        vec![
            callie_in_garage.id.to_string(),
            host_in_garage.id.to_string()
        ],
        "newest first, and only the one room"
    );

    let by_author = search(
        &server,
        &host.access_token,
        &format!("{}&author_id={}", q("drive"), host.user.id),
    )
    .await;
    assert_eq!(
        ids(&by_author),
        vec![host_in_shop.id.to_string(), host_in_garage.id.to_string()]
    );

    let both = search(
        &server,
        &host.access_token,
        &format!(
            "{}&room_id={}&author_id={}",
            q("drive"),
            garage.id,
            host.user.id
        ),
    )
    .await;
    assert_eq!(ids(&both), vec![host_in_garage.id.to_string()]);

    // Two words means both words, not either.
    let both_words = search(&server, &host.access_token, &q("drive cage")).await;
    assert_eq!(ids(&both_words), vec![host_in_shop.id.to_string()]);

    // A filter naming something that is not here says so, rather than looking
    // like a search that found nothing.
    let missing = search_raw(
        &server,
        &host.access_token,
        &format!("{}&room_id={}", q("drive"), linger_core::RoomId::new()),
    )
    .await;
    assert_eq!(missing.status(), 404);
}

#[tokio::test]
async fn paging_never_repeats_or_skips_a_hit() {
    let (server, host, room) = server_with_room("garage").await;
    // Three people, because RATE_MESSAGE_SEND is ten per person and this needs
    // more messages than that to page through.
    let callie = join_member(&server, &host.access_token, "callie").await;
    let dave = join_member(&server, &host.access_token, "dave").await;
    let tokens = [&host.access_token, &callie.access_token, &dave.access_token];

    let mut expected = Vec::new();
    for n in 0..24 {
        expected.push(
            post(
                &server,
                tokens[n % tokens.len()],
                &room,
                &format!("drive number {n}"),
            )
            .await
            .id
            .to_string(),
        );
    }
    expected.reverse(); // the endpoint answers newest first

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let query = match &cursor {
            Some(before) => format!("{}&limit=7&before={before}", q("drive")),
            None => format!("{}&limit=7", q("drive")),
        };
        let page = search(&server, &host.access_token, &query).await;
        if page.is_empty() {
            break;
        }
        assert!(page.len() <= 7, "a page came back over its limit");
        cursor = Some(page[page.len() - 1].cursor.clone());
        seen.extend(ids(&page));
    }

    assert_eq!(
        seen, expected,
        "paging repeated, dropped or reordered a hit"
    );
    assert_eq!(
        seen.iter().collect::<HashSet<_>>().len(),
        seen.len(),
        "the same message came back twice"
    );
}

#[tokio::test]
async fn an_empty_query_is_a_refusal_rather_than_every_message_on_the_server() {
    let (server, host, room) = server_with_room("porch").await;
    post(&server, &host.access_token, &room, "something to find").await;

    for query in ["", "?q=", "?q=%20%20", "?q=***%20---"] {
        let resp = search_raw(&server, &host.access_token, query).await;
        assert_eq!(
            resp.status(),
            422,
            "an empty search answered instead of refusing: {query}"
        );
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    }

    let long = "x".repeat(MAX_SEARCH_QUERY_CHARS + 1);
    assert_eq!(
        search_raw(&server, &host.access_token, &q(&long))
            .await
            .status(),
        422
    );
}

/// FTS5 has its own query language, and none of it may reach the index as
/// syntax. Every one of these is a word to look for, not an operator, and the
/// endpoint answers rather than throwing.
#[tokio::test]
async fn fts_syntax_arrives_as_words_to_look_for() {
    let (server, host, room) = server_with_room("shop").await;
    let message = post(&server, &host.access_token, &room, "the drive OR the cage").await;

    for query in [
        "drive OR cage",
        "drive AND cage",
        "NEAR(drive cage)",
        "drive*",
        "\"drive",
        "drive)) (((",
        "drive^cage",
        "drive:cage",
    ] {
        let resp = search_raw(&server, &host.access_token, &q(query)).await;
        assert_eq!(resp.status(), 200, "`{query}` was not treated as words");
    }

    // "drive OR cage" means all three words, because OR is not an operator here.
    assert_eq!(
        ids(&search(&server, &host.access_token, &q("drive OR cage")).await),
        vec![message.id.to_string()]
    );
    // A quoted run is a phrase: these words in this order.
    let phrase = post(&server, &host.access_token, &room, "the cage drive arrived").await;
    assert_eq!(
        ids(&search(&server, &host.access_token, &q("\"cage drive\"")).await),
        vec![phrase.id.to_string()]
    );
}

/// A control character in the box splits words the way a space does (#498). A
/// NUL used to reach `MATCH` inside a phrase, where SQLite reads the string
/// only as far as the NUL, and the search came back a 500.
#[tokio::test]
async fn a_control_character_in_a_query_separates_words_rather_than_breaking_search() {
    let (server, host, room) = server_with_room("shop").await;
    let message = post(&server, &host.access_token, &room, "the drive cage arrived").await;

    for query in [
        "drive\0cage",
        "\"drive\0cage\"",
        "drive\u{1}\u{7f}cage",
        "\0drive cage\0",
    ] {
        assert_eq!(
            ids(&search(&server, &host.access_token, &q(query)).await),
            vec![message.id.to_string()],
            "{query:?} did not search for the two words"
        );
    }

    // Nothing but control characters is nothing to search for, the same as a
    // blank box.
    for query in ["\0", "\0\u{1}\u{1b}\u{7f}", "\"\0\""] {
        let resp = search_raw(&server, &host.access_token, &q(query)).await;
        assert_eq!(resp.status(), 422, "{query:?} answered instead of refusing");
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["error"]["code"], "VALIDATION_FAILED");
    }
}

#[tokio::test]
async fn a_hit_marks_the_words_that_matched() {
    let (server, host, room) = server_with_room("garage").await;
    post(
        &server,
        &host.access_token,
        &room,
        "did the drive get here yet",
    )
    .await;

    let hits = search(&server, &host.access_token, &q("drive")).await;
    assert_eq!(hits.len(), 1);
    assert_eq!(snippet_text(&hits[0]), "did the drive get here yet");
    let marked: Vec<&str> = hits[0]
        .snippet
        .iter()
        .filter(|part| part.matched)
        .map(|part| part.text.as_str())
        .collect();
    assert_eq!(marked, vec!["drive"]);
}

#[tokio::test]
async fn a_bad_cursor_is_a_refusal_rather_than_a_guess() {
    let (server, host, _room) = server_with_room("porch").await;
    for cursor in ["nonsense", "ab", ""] {
        let resp = search_raw(
            &server,
            &host.access_token,
            &format!("{}&before={cursor}", q("drive")),
        )
        .await;
        assert_eq!(resp.status(), 422, "cursor `{cursor}` was accepted");
    }
}

#[tokio::test]
async fn search_is_rate_limited_and_only_members_can_do_it() {
    let (server, host, room) = server_with_room("shop").await;
    post(&server, &host.access_token, &room, "the drive").await;

    let anyone = client()
        .get(server.url(&format!("/search{}", q("drive"))))
        .send()
        .await
        .unwrap();
    assert_eq!(anyone.status(), 401);

    // The bucket refills while these are in flight, so the assertion is that
    // the refusal comes *after* the burst is spent, not on an exact request.
    let (allowed, _) = RATE_SEARCH;
    let mut refused_at = None;
    for n in 0..allowed * 3 {
        let resp = search_raw(&server, &host.access_token, &q("drive")).await;
        if resp.status() == 429 {
            let body: serde_json::Value = resp.json().await.unwrap();
            assert_eq!(body["error"]["code"], "RATE_LIMITED");
            assert!(body["error"]["retry_after_ms"].as_u64().unwrap_or(0) > 0);
            refused_at = Some(n);
            break;
        }
        assert_eq!(
            resp.status(),
            200,
            "search {n} failed for some other reason"
        );
    }
    let refused_at = refused_at.expect("search is not rate limited at all");
    assert!(
        refused_at >= allowed,
        "the burst was cut short at {refused_at}, under the {allowed} allowed"
    );

    // The bucket is per person, so one busy member does not lock out the rest.
    let callie = join_member(&server, &host.access_token, "callie").await;
    assert_eq!(
        search_raw(&server, &callie.access_token, &q("drive"))
            .await
            .status(),
        200
    );
}
