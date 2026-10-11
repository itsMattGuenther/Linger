//! The query plans the server depends on (#518).
//!
//! A query that returns the right rows slowly passes every other test, and
//! only shows itself on a server that has been running for a year. So these
//! ask SQLite how it would run the statements the server actually sends —
//! built by the same functions — against a database shaped like a grown
//! server, opened the way the server opens it. A change that quietly turns a
//! lookup back into a read of a whole table fails here.

use linger_core::wire::MediaKind;
use linger_core::UserId;
use sqlx::{Row, SqlitePool};
use tempfile::TempDir;

use crate::db::{self, Db};
use crate::repo::media;

/// A year of a small server at a fifth of the size the audit measured (#518):
/// twelve rooms and a DM, twenty people, 20,000 messages, a file on every
/// twentieth (a few of them starred), a link on every hundredth and a pin on
/// every thousandth. The ids are UUIDv7-shaped — the millisecond first — so
/// they sort by time the way real ones do.
const FILL: &str = "
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20)
INSERT INTO users (id, username, display_name, password_hash, created_at)
SELECT unhex(printf('%032X', i)), 'person' || i, 'Person ' || i, 'x', 0 FROM n;

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 13)
INSERT INTO rooms (id, slug, name, position, created_at, kind, member_key)
SELECT unhex(printf('%032X', i)), 'room-' || i, 'Room ' || i, i, 0,
       CASE WHEN i = 13 THEN 'dm' ELSE 'room' END,
       CASE WHEN i = 13 THEN 'dm-1-2' END
FROM n;

INSERT INTO room_members (room_id, user_id, created_at)
VALUES (unhex(printf('%032X', 13)), unhex(printf('%032X', 1)), 0),
       (unhex(printf('%032X', 13)), unhex(printf('%032X', 2)), 0);

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
INSERT INTO messages (id, room_id, author_id, body, pinned_at, created_at)
SELECT unhex(printf('%012X7000%016X', 1700000000000 + i * 1000, i)),
       unhex(printf('%032X', i % 13 + 1)),
       unhex(printf('%032X', i % 20 + 1)),
       'message number ' || i || CASE WHEN i % 100 = 0 THEN ' https://example.com/' || i ELSE '' END,
       CASE WHEN i % 1000 = 0 THEN 1700000000000 + i * 1000 END,
       1700000000000 + i * 1000
FROM n;

INSERT INTO attachments (id, message_id, uploader_id, object_key, filename, mime,
                         size_bytes, starred_at, state, created_at)
SELECT unhex(printf('%012X7000%016X', created_at, 1000000 + rowid)),
       id, author_id, 'objects/' || rowid, 'IMG_' || rowid || '.jpg', 'image/jpeg',
       1000, CASE WHEN rowid % 400 = 0 THEN created_at END, 'complete', created_at
FROM messages WHERE rowid % 20 = 0;

INSERT INTO message_links (message_id, position, url)
SELECT id, 0, 'https://example.com/' || rowid FROM messages WHERE rowid % 100 = 0;
";

/// The grown server, filled and then restarted, so its read connections open
/// the way they do on a real server: after `db::init` has done everything it
/// does at startup.
async fn grown_server() -> (TempDir, Db) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("linger.db");
    let first = db::init(&path).await.unwrap();
    sqlx::raw_sql(FILL).execute(&first.write).await.unwrap();
    first.read.close().await;
    first.write.close().await;
    let db = db::init(&path).await.unwrap();
    (dir, db)
}

/// How SQLite would run `sql`, one step per `|`. Unbound parameters plan as
/// NULL, which is fine: nothing here depends on a value.
async fn plan(pool: &SqlitePool, sql: &str) -> String {
    sqlx::query(&format!("EXPLAIN QUERY PLAN {sql}"))
        .fetch_all(pool)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>("detail"))
        .collect::<Vec<_>>()
        .join(" | ")
}

#[tokio::test]
async fn a_page_of_messages_finds_its_files_by_index() {
    let (_dir, db) = grown_server().await;
    let plan = plan(&db.read, &crate::repo::attachments::hydrate_sql(50)).await;
    assert!(
        plan.contains("USING INDEX idx_attachments_message (message_id=?)"),
        "hydrate reads every file ever uploaded: {plan}"
    );
}

#[tokio::test]
async fn a_media_cursor_finds_its_file_by_its_id() {
    let (_dir, db) = grown_server().await;
    let plan = plan(&db.read, crate::repo::media::IS_STARRED_SQL).await;
    assert!(
        plan.starts_with("SEARCH attachments USING INDEX") && plan.contains("(id=?)"),
        "the starred check reads every file to find one: {plan}"
    );
}

/// Every shape of Media's uploads query: the first page, a page partway
/// through the starred files and one past them, and each filter.
fn media_queries() -> Vec<(&'static str, media::Query, bool)> {
    let base = media::Query {
        viewer: UserId::from_slice(&[0; 16]).unwrap(),
        kind: None,
        author: None,
        before: None,
        since: None,
        until: None,
        limit: 60,
    };
    let cursor = Some(media::Cursor::parse(&format!("1700000500000:{}", "0".repeat(32))).unwrap());
    vec![
        ("the first page", base.clone(), false),
        (
            "a page among the starred",
            media::Query {
                before: cursor.clone(),
                ..base.clone()
            },
            false,
        ),
        (
            "a page past the starred",
            media::Query {
                before: cursor,
                ..base.clone()
            },
            true,
        ),
        (
            "photos only",
            media::Query {
                kind: Some(MediaKind::Image),
                ..base.clone()
            },
            false,
        ),
        (
            "one person's",
            media::Query {
                author: Some(UserId::new()),
                ..base.clone()
            },
            false,
        ),
        (
            "a date range",
            media::Query {
                since: Some(1),
                until: Some(2),
                ..base
            },
            false,
        ),
    ]
}

#[tokio::test]
async fn media_reads_files_in_its_own_order_and_sorts_nothing() {
    let (_dir, db) = grown_server().await;
    for (shape, query, past_starred) in media_queries() {
        let plan = plan(&db.read, &media::attachment_sql(&query, past_starred)).await;
        assert!(
            plan.starts_with("SCAN a USING INDEX idx_attachments_media_order")
                || plan.starts_with("SEARCH a USING INDEX idx_attachments_media_order"),
            "{shape}: Media does not start from its files, in order: {plan}"
        );
        assert!(
            !plan.contains("TEMP B-TREE"),
            "{shape}: Media sorts every file to hand back one page: {plan}"
        );
    }
}

#[tokio::test]
async fn media_links_start_from_the_links() {
    let (_dir, db) = grown_server().await;
    let (_, query, _) = media_queries().remove(0);
    let plan = plan(&db.read, &media::link_sql(&query)).await;
    assert!(
        plan.contains("SCAN l2 USING COVERING INDEX idx_message_links_message"),
        "the links page does not start from the links: {plan}"
    );
    assert!(
        !plan.contains("SCAN m"),
        "the links page reads every message: {plan}"
    );
}
