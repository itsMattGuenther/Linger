//! SQLite access (ARCHITECTURE §5). WAL mode, `foreign_keys=ON`,
//! `synchronous=NORMAL`.
//!
//! WAL permits exactly one writer. Rather than hoping a pool serializes writes,
//! the structure makes it impossible to get wrong: [`Db::write`] is a pool with
//! **one** connection (all writes queue behind it), and [`Db::read`] is a
//! read-only pool for everything else. Do not "fix" contention by raising the
//! write pool size — that reintroduces `SQLITE_BUSY` under load (AGENTS.md).

use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

#[derive(Debug, Clone)]
pub struct Db {
    /// Single-connection pool: the one WAL writer. Use for INSERT/UPDATE/DELETE.
    pub write: SqlitePool,
    /// Read-only pool for queries. WAL readers never block the writer.
    pub read: SqlitePool,
}

/// The pragmas every connection to this database gets, whichever process opens
/// it. Callers add `create_if_missing` and any longer busy timeout themselves.
fn connect_options(db_path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(db_path)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5))
}

/// Open (creating if missing) the server database and run pending migrations.
pub async fn init(db_path: &Path) -> anyhow::Result<Db> {
    if let Some(parent) = db_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let base = connect_options(db_path).create_if_missing(true);

    let write = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(base.clone())
        .await?;

    sqlx::migrate!("./migrations").run(&write).await?;

    // Before the read pool opens: a connection reads the planner's statistics
    // when it opens, so this is what lets the first reads after an upgrade use
    // them. A failure costs speed, not correctness, so it does not stop the
    // server from starting.
    if let Err(err) = optimize(&write).await {
        tracing::warn!(error = %err, "could not update the query planner's statistics");
    }

    let read = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(base.read_only(true).create_if_missing(false))
        .await?;

    Ok(Db { write, read })
}

/// The upkeep SQLite asks of a program that keeps its database open (#518).
///
/// The query planner picks indexes using measurements of each table — how
/// many rows, how many share a value — kept in `sqlite_stat1`. Nothing takes
/// them unless asked, and without them the planner guesses; on a grown server
/// some of its guesses read a whole table to find a handful of rows. This
/// takes them for any table that has never been measured or has grown or
/// shrunk tenfold since it was, and does nothing otherwise. Most runs take
/// microseconds. The first one on a server from before #518 measures
/// everything: a few hundred milliseconds on a year of messages, once.
///
/// `0x10012` is the mask SQLite's documentation gives a long-lived connection
/// at open (`0x10002`: check every table's size, not just the ones this
/// connection has queried), plus the `0x10` bit plain `PRAGMA optimize`
/// carries, which caps how much of each index a measurement reads. Checking
/// every table matters more here than usual: this is the writer, almost every
/// read goes through the other pool, and "the tables this connection has
/// queried" would leave out most of the database.
///
/// It runs on the writer because measuring writes `sqlite_stat1`. A connection
/// reads the measurements when it opens, so [`init`] runs this before the read
/// pool exists, and after a later run each read connection picks the new
/// numbers up when the pool replaces it (sqlx retires a connection after 30
/// minutes). Like every query here, the work happens on the connection's own
/// thread, not the async runtime's.
pub async fn optimize(write: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA optimize=0x10012")
        .execute(write)
        .await?;
    Ok(())
}

/// Current wall-clock time as Unix milliseconds — the only timestamp format on
/// the wire and in the database (PROTOCOL preamble).
#[must_use]
#[allow(clippy::cast_possible_truncation)]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open the single WAL writer against a database that must already exist, for a
/// one-shot command line rather than the server (T-414's `reset-password`).
///
/// Three deliberate differences from [`init`]. It refuses to create the file: a
/// typo in `LINGER_DATA_DIR` should say so, not quietly make an empty server and
/// then report that nobody by that name lives there. Its busy timeout is long,
/// because the honest failure mode is running this while the server is still up
/// — WAL allows one writer, and waiting is a kinder answer than `SQLITE_BUSY`.
/// And it does not run migrations: a second process migrating a live server's
/// database is exactly what the single-writer discipline exists to prevent.
pub async fn open_writer(db_path: &Path) -> anyhow::Result<SqlitePool> {
    if !db_path.exists() {
        anyhow::bail!(
            "There is no Linger database at {}. Set LINGER_DATA_DIR to the server's data directory.",
            db_path.display()
        );
    }
    let options = connect_options(db_path)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(30));
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn init_creates_schema_and_both_pools_work() {
        let dir = tempfile::tempdir().unwrap();
        let db = init(&dir.path().join("linger.db")).await.unwrap();

        // Writer can write.
        sqlx::query("INSERT INTO server_config (key, value) VALUES ('name', 'test server')")
            .execute(&db.write)
            .await
            .unwrap();

        // Reader sees it and is actually read-only.
        let (value,): (String,) =
            sqlx::query_as("SELECT value FROM server_config WHERE key = 'name'")
                .fetch_one(&db.read)
                .await
                .unwrap();
        assert_eq!(value, "test server");

        let denied = sqlx::query("INSERT INTO server_config (key, value) VALUES ('x', 'y')")
            .execute(&db.read)
            .await;
        assert!(denied.is_err(), "read pool must reject writes");
    }

    /// A room, a person and messages `from..=to` in it, written straight to
    /// the table: what the planner's statistics count, without the routes.
    async fn add_messages(pool: &SqlitePool, from: i64, to: i64) {
        sqlx::raw_sql(&format!(
            "INSERT OR IGNORE INTO users (id, username, display_name, password_hash, created_at)
             VALUES (X'01', 'pat', 'Pat', 'x', 0);
             INSERT OR IGNORE INTO rooms (id, slug, name, position, created_at)
             VALUES (X'02', 'porch', 'Porch', 0, 0);
             WITH RECURSIVE n(i) AS (SELECT {from} UNION ALL SELECT i + 1 FROM n WHERE i < {to})
             INSERT INTO messages (id, room_id, author_id, body, created_at)
             SELECT unhex(printf('%032X', i)), X'02', X'01', 'message ' || i, i FROM n;"
        ))
        .execute(pool)
        .await
        .unwrap();
    }

    /// How many messages the planner's statistics say there are.
    async fn messages_measured(pool: &SqlitePool) -> Option<i64> {
        let stat: Option<(String,)> =
            sqlx::query_as("SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_messages_room'")
                .fetch_optional(pool)
                .await
                .unwrap();
        stat.and_then(|(stat,)| stat.split(' ').next()?.parse().ok())
    }

    #[tokio::test]
    async fn startup_measures_the_tables_and_a_later_run_notices_growth() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("linger.db");
        let db = init(&path).await.unwrap();
        add_messages(&db.write, 1, 200).await;
        db.read.close().await;
        db.write.close().await;

        // A restart measures what is there.
        let db = init(&path).await.unwrap();
        assert_eq!(messages_measured(&db.read).await, Some(200));

        // Tenfold growth later is noticed by the writer, although it never
        // reads the messages table through an index itself.
        add_messages(&db.write, 201, 5000).await;
        optimize(&db.write).await.unwrap();
        assert_eq!(messages_measured(&db.read).await, Some(5000));

        // And with nothing new, a run leaves the measurements alone.
        add_messages(&db.write, 5001, 5100).await;
        optimize(&db.write).await.unwrap();
        assert_eq!(messages_measured(&db.read).await, Some(5000));
    }

    #[tokio::test]
    async fn migrations_are_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("linger.db");
        let _ = init(&path).await.unwrap();
        let _ = init(&path).await.unwrap(); // second run must be a no-op, not an error
    }
}
