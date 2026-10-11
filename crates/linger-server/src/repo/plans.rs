//! The query plans the server depends on (#518).
//!
//! A query that returns the right rows slowly passes every other test, and
//! only shows itself on a server that has been running for a year. So these
//! ask SQLite how it would run the statements the server actually sends —
//! built by the same functions — against a database shaped like a grown
//! server, opened the way the server opens it. A change that quietly turns a
//! lookup back into a read of a whole table fails here.

use sqlx::{Row, SqlitePool};
use tempfile::TempDir;

use crate::db::{self, Db};

/// A year of a small server at a fifth of the size the audit measured: four
/// rooms and a DM, 20,000 messages, a file on every twentieth (a few of them
/// starred), a link on every hundredth and a pin on every thousandth. The ids
/// are UUIDv7-shaped — the millisecond first — so they sort by time the way
/// real ones do.
const FILL: &str = "
INSERT INTO users (id, username, display_name, password_hash, created_at)
SELECT unhex(printf('%032X', n)), 'person' || n, 'Person ' || n, 'x', 0
FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3);

INSERT INTO rooms (id, slug, name, position, created_at, kind, member_key)
SELECT unhex(printf('%032X', n)),
       'room-' || n, 'Room ' || n, n, 0,
       CASE WHEN n = 5 THEN 'dm' ELSE 'room' END,
       CASE WHEN n = 5 THEN 'dm-1-2' END
FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
      UNION ALL SELECT 5);

INSERT INTO room_members (room_id, user_id, created_at)
VALUES (unhex(printf('%032X', 5)), unhex(printf('%032X', 1)), 0),
       (unhex(printf('%032X', 5)), unhex(printf('%032X', 2)), 0);

WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
INSERT INTO messages (id, room_id, author_id, body, pinned_at, created_at)
SELECT unhex(printf('%012X7000%016X', 1700000000000 + i * 1000, i)),
       unhex(printf('%032X', i % 5 + 1)),
       unhex(printf('%032X', i % 3 + 1)),
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
