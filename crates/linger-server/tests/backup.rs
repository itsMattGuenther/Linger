//! The nightly copy of the database (#582): it is a real, whole database with
//! the messages in it, written while the server keeps taking writes, and the
//! folder keeps a week of dailies and a month of weeklies. And only the host
//! is told how the backups and the disk stand.

mod common;

use std::path::Path;

use common::{bootstrap_host, join_member, spawn_server, spawn_tuned, TestServer};
use linger_core::wire::{Room, ServerInfo};
use linger_server::backup;
use sqlx::Connection;

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn room(server: &TestServer, token: &str) -> Room {
    client()
        .post(server.url("/rooms"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "slug": "porch", "name": "#porch" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn say(server: &TestServer, token: &str, room: &Room, body: &str) {
    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "post: {}", resp.text().await.unwrap());
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

fn backups_dir(server: &TestServer) -> std::path::PathBuf {
    server.state.config.data_dir.join(backup::BACKUPS_DIR)
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A stand-in copy from an earlier day, as a past night would have left it.
fn old_copy(dir: &Path, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join(name), b"an older copy").unwrap();
}

#[tokio::test]
async fn a_copy_is_the_whole_database_and_checks_out() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let porch = room(&server, &host.access_token).await;
    say(
        &server,
        &host.access_token,
        &porch,
        "the lake photos are up",
    )
    .await;

    let made = backup::make(&server.state).await.expect("a copy");
    assert!(made.weekly, "the first copy is also the first weekly one");

    // It opens on its own, with no journal beside it, and the message is in it.
    let name = made
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        name.starts_with("linger-daily-") && name.ends_with(".db"),
        "{name}"
    );
    let dir = backups_dir(&server);
    for leftover in names_in(&dir) {
        assert!(
            !leftover.ends_with("-wal") && !leftover.ends_with(".partial"),
            "{leftover} left beside the copy"
        );
    }
    let mut copy = sqlx::sqlite::SqliteConnection::connect(&format!(
        "sqlite://{}?mode=ro",
        made.path.display()
    ))
    .await
    .unwrap();
    let (body,): (String,) =
        sqlx::query_as("SELECT body FROM messages WHERE body LIKE 'the lake%'")
            .fetch_one(&mut copy)
            .await
            .unwrap();
    assert_eq!(body, "the lake photos are up");
    let (check,): (String,) = sqlx::query_as("PRAGMA integrity_check")
        .fetch_one(&mut copy)
        .await
        .unwrap();
    assert_eq!(check, "ok");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&made.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "a copy is the server's owner's alone");
    }

    // The server knows it has a copy now.
    assert!(server.state.backups.last().is_some());
}

#[tokio::test]
async fn the_server_keeps_taking_writes_while_a_copy_is_made() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let porch = room(&server, &host.access_token).await;
    // Enough of a database that the copy takes a moment, written straight to
    // the table rather than through the rate-limited route.
    sqlx::raw_sql(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
         INSERT INTO messages (id, room_id, author_id, body, created_at)
         SELECT unhex(printf('%032X', i)), X'{room}', X'{me}', 'filler ' || i, i FROM n;",
        room = hex::encode(porch.id.to_vec()),
        me = hex::encode(host.user.id.to_vec()),
    ))
    .execute(&server.state.db.write)
    .await
    .unwrap();

    // Writing while the copy runs never fails or waits on it: the copy only
    // reads, and in WAL mode a reader doesn't hold up the one writer.
    let state = server.state.clone();
    let copying = tokio::spawn(async move { backup::make(&state).await });
    for n in 0..20 {
        sqlx::query("UPDATE rooms SET topic = ? WHERE id = ?")
            .bind(format!("during {n}"))
            .bind(porch.id.to_vec())
            .execute(&server.state.db.write)
            .await
            .expect("a write while the copy runs");
    }
    say(&server, &host.access_token, &porch, "still here").await;
    let made = copying.await.unwrap().expect("a copy while people type");

    let mut copy = sqlx::sqlite::SqliteConnection::connect(&format!(
        "sqlite://{}?mode=ro",
        made.path.display()
    ))
    .await
    .unwrap();
    let (filler,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM messages WHERE body LIKE 'filler %'")
            .fetch_one(&mut copy)
            .await
            .unwrap();
    assert_eq!(
        filler, 50000,
        "the copy holds everything from before it began"
    );
}

#[tokio::test]
async fn a_week_of_dailies_and_a_month_of_weeklies_are_kept() {
    let server = spawn_server().await;
    bootstrap_host(&server).await;
    let dir = backups_dir(&server);
    for day in 1..=9 {
        old_copy(&dir, &format!("linger-daily-2020-01-{day:02}.db"));
    }
    for day in [1, 8, 15, 22, 29] {
        old_copy(&dir, &format!("linger-weekly-2019-12-{day:02}.db"));
    }
    // What else is in the folder isn't the server's to delete; a copy a
    // crash left half-written is.
    old_copy(&dir, "notes.txt");
    old_copy(&dir, ".linger-daily-2020-01-09.db.partial");

    let made = backup::make(&server.state).await.unwrap();
    assert!(made.weekly, "the newest weekly copy is years old");

    let names = names_in(&dir);
    let dailies: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("linger-daily-"))
        .collect();
    let weeklies: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("linger-weekly-"))
        .collect();
    assert_eq!(dailies.len(), backup::DAILY_KEPT, "{names:?}");
    assert_eq!(weeklies.len(), backup::WEEKLY_KEPT, "{names:?}");
    // The newest are the ones kept.
    assert!(!names.contains(&"linger-daily-2020-01-01.db".to_string()));
    assert!(!names.contains(&"linger-daily-2020-01-02.db".to_string()));
    assert!(names.contains(&"linger-daily-2020-01-09.db".to_string()));
    assert!(!names.contains(&"linger-weekly-2019-12-01.db".to_string()));
    assert!(!names.contains(&"linger-weekly-2019-12-08.db".to_string()));
    assert!(names.contains(&"notes.txt".to_string()));
    assert!(!names.iter().any(|n| n.ends_with(".partial")), "{names:?}");
}

#[tokio::test]
async fn a_weekly_copy_waits_for_its_week() {
    let server = spawn_server().await;
    bootstrap_host(&server).await;
    let dir = backups_dir(&server);
    let today = jiff::Zoned::now()
        .with_time_zone(jiff::tz::TimeZone::UTC)
        .date();
    let three_days_ago = today.checked_sub(jiff::Span::new().days(3)).unwrap();
    old_copy(&dir, &format!("linger-weekly-{three_days_ago}.db"));

    let made = backup::make(&server.state).await.unwrap();
    assert!(!made.weekly, "this week already has its copy");
    assert!(!names_in(&dir).contains(&format!("linger-weekly-{today}.db")));
}

#[tokio::test]
async fn only_the_host_hears_how_the_machine_is() {
    let server = spawn_tuned(|config| config.pool_bytes = 1_000_000_000).await;
    let host = bootstrap_host(&server).await;
    let sam = join_member(&server, &host.access_token, "sam").await;
    let jules = join_member(&server, &host.access_token, "jules").await;
    let made_cohost = client()
        .put(server.url(&format!("/users/{}/cohost", jules.user.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert!(made_cohost.status().is_success());

    let seen = info(&server, &host.access_token).await;
    let health = seen.health.expect("the host is told");
    assert!(health.backups);
    assert_eq!(health.last_backup_at, None, "no copy yet");
    assert!(!health.backup_overdue, "the server only just started");
    assert!(!health.file_space_nearly_full);

    // Neither a member nor a co-host: the machine is the host's.
    assert!(info(&server, &sam.access_token).await.health.is_none());
    assert!(info(&server, &jules.access_token).await.health.is_none());

    // A copy is said once it's made.
    backup::make(&server.state).await.unwrap();
    let health = info(&server, &host.access_token).await.health.unwrap();
    assert!(health.last_backup_at.is_some());

    // Files taking 90% of the pool is the file space nearly used up.
    sqlx::query(
        "INSERT INTO attachments (id, uploader_id, object_key, filename, mime, size_bytes, state, created_at)
         VALUES (X'0F', ?, 'objects/big', 'big.bin', 'application/octet-stream', 900000000, 'complete', 0)",
    )
    .bind(host.user.id.to_vec())
    .execute(&server.state.db.write)
    .await
    .unwrap();
    let health = info(&server, &host.access_token).await.health.unwrap();
    assert!(health.file_space_nearly_full);
}

#[tokio::test]
async fn with_backups_off_there_is_nothing_to_be_overdue() {
    let server = spawn_tuned(|config| config.backups = false).await;
    let host = bootstrap_host(&server).await;
    let health = info(&server, &host.access_token).await.health.unwrap();
    assert!(!health.backups);
    assert!(!health.backup_overdue);
    assert!(
        backup::spawn(server.state.clone()).is_none(),
        "no task is started"
    );
}
