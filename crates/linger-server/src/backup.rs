//! The nightly copy of the database (#582).
//!
//! The server is the thing a group keeps: every message, every DM, who is
//! who. The host guide always said to back up `data/` on a schedule, and most
//! hosts never set one up. So the server does the part it can do by itself:
//! once a day it writes a copy of `linger.db` into `data/backups/`, checks the
//! copy opens cleanly, and keeps a week of daily copies and a month of weekly
//! ones. `LINGER_BACKUPS=off` turns it off for a host with a plan of their own.
//!
//! **It never stops the server and never holds up a write.** SQLite's `VACUUM
//! INTO` writes a consistent copy of the database as it stood when the copy
//! began, through a read transaction. In WAL mode a reader doesn't block the
//! one writer (`db.rs`), so everybody keeps typing while it runs. It opens a
//! connection of its own, read-only, rather than borrowing one of the read
//! pool's four for however long a big server's copy takes.
//!
//! The copy is the database alone. Uploaded files never change once they are
//! up, so copying them elsewhere is one `rsync` or `rclone` line, and the host
//! guide has it. Nor does a copy on the same disk survive that disk dying, and
//! the guide says that plainly too: this is the copy for a bad update, a
//! mistaken command or a corrupted file, not for a lost machine.
//!
//! Whether it's working is the host's to know without reading logs: `GET
//! /server` tells the host when the newest good copy was made, and whether the
//! server has gone three days running without one (`ServerHealth`).
//!
//! **Off the machine, if the host names a bucket** (#614,
//! `LINGER_BACKUP_S3_*`). After each copy checks out, the newest daily and
//! the newest weekly go to the bucket, each once, and the bucket keeps the
//! same week and month the folder does. Only names this module made are
//! ever touched there. A bucket that can't be reached never costs the copy
//! on disk: the copy is made first and counts on its own, and the send is
//! tried again every hour until it goes or the next copy is due. The host is
//! told when the newest copy in the bucket is three days old, as with the
//! folder.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
use sqlx::{ConnectOptions, Connection};

use crate::db::now_ms;
use crate::state::AppState;
use crate::storage::BackupBucket;

/// Where the copies go, inside the data folder.
pub const BACKUPS_DIR: &str = "backups";

/// How many daily copies are kept: a week.
pub const DAILY_KEPT: usize = 7;

/// How many weekly copies are kept: about a month.
pub const WEEKLY_KEPT: usize = 4;

/// How long between copies.
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// The wait before a server's first copy after it starts, when the newest one
/// is a day old or there is none: long enough that it isn't in the way of
/// everybody reconnecting at once, short enough to happen on a server that is
/// only up for an hour.
const FIRST_AFTER: Duration = Duration::from_secs(2 * 60);

/// After a copy fails, how soon it is tried again. A full disk is the likely
/// reason, and the check before writing costs nothing.
const RETRY_AFTER: Duration = Duration::from_secs(60 * 60);

/// How long the server may run without a good copy before the host is told.
pub const OVERDUE_AFTER_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// Free space a copy must leave on the disk beyond its own size, so a backup
/// is never what fills it.
const HEADROOM_BYTES: u64 = 256 * 1024 * 1024;

/// How the nightly copies stand, kept in memory: when the newest good one was
/// made, when the newest one reached the bucket (#614), and when this run of
/// the server started trying.
pub struct Backups {
    last: Mutex<Option<i64>>,
    since: i64,
    bucket: Option<BackupBucket>,
    sent: Mutex<Option<i64>>,
}

impl std::fmt::Debug for Backups {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Backups")
            .field("last", &self.last())
            .field("since", &self.since)
            .field("bucket", &self.bucket.as_ref().map(|bucket| &bucket.name))
            .field("sent", &self.sent())
            .finish()
    }
}

impl Backups {
    /// `last` is the newest good copy already on disk, `since` when the server
    /// started.
    #[must_use]
    pub fn new(last: Option<i64>, since: i64) -> Self {
        Self {
            last: Mutex::new(last),
            since,
            bucket: None,
            sent: Mutex::new(None),
        }
    }

    /// Send each copy to `bucket` as well (`LINGER_BACKUP_S3_*`).
    #[must_use]
    pub fn with_bucket(mut self, bucket: Option<BackupBucket>) -> Self {
        self.bucket = bucket;
        self
    }

    /// When the newest copy that checked out was made.
    pub fn last(&self) -> Option<i64> {
        self.last.lock().map_or(None, |held| *held)
    }

    fn made(&self, at: i64) {
        if let Ok(mut held) = self.last.lock() {
            *held = Some(at);
        }
    }

    /// Three days of running without a good copy. Counted from this start
    /// as well as from the last copy, so a server switched back on after a
    /// week away isn't "overdue" in the minutes before its first copy: only
    /// one that has been trying, and failing, for three days is.
    #[must_use]
    pub fn overdue(&self, now: i64) -> bool {
        Self::three_days_from(self.last(), self.since, now)
    }

    /// The bucket copies go to, by name, when there is one.
    pub fn bucket_name(&self) -> Option<&str> {
        self.bucket.as_ref().map(|bucket| bucket.name.as_str())
    }

    /// When the newest copy in the bucket got there, as the bucket says, or
    /// `None` before this run of the server has looked.
    pub fn sent(&self) -> Option<i64> {
        self.sent.lock().map_or(None, |held| *held)
    }

    fn reached(&self, at: Option<i64>) {
        if let Ok(mut held) = self.sent.lock() {
            *held = at.max(*held);
        }
    }

    /// Three days of running without a copy reaching the bucket, counted the
    /// way [`Backups::overdue`] is. Always `false` with no bucket.
    #[must_use]
    pub fn bucket_overdue(&self, now: i64) -> bool {
        self.bucket.is_some() && Self::three_days_from(self.sent(), self.since, now)
    }

    fn three_days_from(last: Option<i64>, since: i64, now: i64) -> bool {
        let from = last.map_or(since, |last| last.max(since));
        now - from >= OVERDUE_AFTER_MS
    }
}

/// What went wrong with a copy, for the log line.
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("not enough free disk for a copy of the database (it needs about {needed} bytes)")]
    NoRoom { needed: u64 },
    #[error("the copy did not pass its check: {0}")]
    Damaged(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The copy one run made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Made {
    pub path: PathBuf,
    /// Whether it was also kept as this week's copy.
    pub weekly: bool,
}

/// Make copies for as long as the process lives, or nothing with
/// `LINGER_BACKUPS=off`. Lives in `main.rs`, not in `AppState`, so that
/// building the state, which every integration test does, starts nothing.
pub fn spawn(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    if !state.config.backups {
        return None;
    }
    Some(tokio::spawn(async move {
        let mut wait = first_wait(state.backups.last(), now_ms());
        // With a bucket, look at it soon after starting rather than up to a
        // day later at the next copy: that's when the host's Settings learns
        // when the bucket last had one, and a copy the last run made but
        // never got there goes now.
        if state.backups.bucket.is_some() {
            tokio::time::sleep(FIRST_AFTER).await;
            send_logged(&state).await;
            wait = wait.saturating_sub(FIRST_AFTER);
        }
        loop {
            tokio::time::sleep(wait).await;
            let mut until_next = match make(&state).await {
                Ok(made) => {
                    tracing::info!(path = %made.path.display(), weekly = made.weekly, "backed up the database");
                    EVERY
                }
                Err(err) => {
                    tracing::warn!(error = %err, "could not back up the database; trying again in an hour");
                    RETRY_AFTER
                }
            };
            // A failed send is tried again each hour until it goes or the
            // next copy is due, which tries again anyway.
            if state.backups.bucket.is_some() {
                while !send_logged(&state).await && until_next > RETRY_AFTER {
                    tokio::time::sleep(RETRY_AFTER).await;
                    until_next -= RETRY_AFTER;
                }
            }
            wait = until_next;
        }
    }))
}

/// [`send`], with what happened in the log. Whether it went.
async fn send_logged(state: &AppState) -> bool {
    match send(state).await {
        Ok(sent) => {
            if !sent.is_empty() {
                tracing::info!(copies = ?sent, "sent the database's backup to the bucket");
            }
            true
        }
        Err(err) => {
            tracing::warn!(error = %err, "could not send the database's backup to the bucket");
            false
        }
    }
}

/// Make sure the newest daily copy and the newest weekly one in
/// `data/backups/` are in the bucket, then drop the bucket's copies past a
/// week of dailies and a month of weeklies, the folder's rule. Sends only
/// what the bucket doesn't already have under that name, so running it again
/// is cheap. Answers the names it sent; nothing with no bucket. Public so a
/// test can drive it.
pub async fn send(state: &AppState) -> anyhow::Result<Vec<String>> {
    let Some(bucket) = &state.backups.bucket else {
        return Ok(Vec::new());
    };
    let dir = state.config.data_dir.join(BACKUPS_DIR);
    let here = match names(&dir).await {
        Ok(names) => names,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return Err(err.into()),
    };

    let there = bucket.sent().await?;
    let mut newest_there = there
        .iter()
        .filter(|copy| kind_of(&copy.name).is_some())
        .filter_map(|copy| copy.at)
        .max();
    let mut names_there: Vec<String> = there.into_iter().map(|copy| copy.name).collect();

    let mut sent = Vec::new();
    for name in newest_of_each(&here) {
        if names_there.iter().any(|there| there == name) {
            continue;
        }
        bucket.send(name, &dir.join(name)).await?;
        newest_there = newest_there.max(Some(now_ms()));
        names_there.push(name.to_string());
        sent.push(name.to_string());
    }
    state.backups.reached(newest_there);

    for name in past_keeping(&names_there) {
        bucket.drop_copy(&name).await?;
    }
    Ok(sent)
}

/// How long until the next copy is due: a day after the newest, or a couple
/// of minutes from now when that's already passed.
fn first_wait(last: Option<i64>, now: i64) -> Duration {
    let every = i64::try_from(EVERY.as_millis()).unwrap_or(i64::MAX);
    match last {
        Some(last) if now >= last && now - last < every => {
            let left = u64::try_from(every - (now - last)).unwrap_or(0);
            Duration::from_millis(left).max(FIRST_AFTER)
        }
        _ => FIRST_AFTER,
    }
}

/// Make one copy now: write it, check it, keep it, and drop the copies past
/// a week of dailies and a month of weeklies. Public so a test can drive it
/// without waiting a day.
pub async fn make(state: &AppState) -> Result<Made, BackupError> {
    let dir = state.config.data_dir.join(BACKUPS_DIR);
    tokio::fs::create_dir_all(&dir).await?;
    let source = state.config.db_path();

    // The copy is about the size of the database; the WAL's pages are folded
    // in, so it can't be more than both together.
    let size = file_len(&source).await + file_len(&wal_of(&source)).await;
    let needed = size.saturating_add(HEADROOM_BYTES);
    if let Some(free) = crate::disk::free_bytes(dir.clone()).await {
        if free < needed {
            return Err(BackupError::NoRoom { needed });
        }
    }

    let now = now_ms();
    let date = utc_date(now);
    let partial = dir.join(format!(".linger-daily-{date}.db.partial"));
    remove_if_there(&partial).await?;

    copy_into(&source, &partial).await?;
    if let Err(err) = check(&partial).await {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(err);
    }
    restrict(&partial).await?;

    let daily = dir.join(format!("linger-daily-{date}.db"));
    tokio::fs::rename(&partial, &daily).await?;

    let weekly = if weekly_due(&dir, &date).await? {
        let path = dir.join(format!("linger-weekly-{date}.db"));
        remove_if_there(&path).await?;
        // A second name for the same file costs no disk; a copy only where
        // the filesystem can't do that.
        if tokio::fs::hard_link(&daily, &path).await.is_err() {
            tokio::fs::copy(&daily, &path).await?;
        }
        true
    } else {
        false
    };

    prune(&dir, &partial).await?;
    state.backups.made(now);
    Ok(Made {
        path: daily,
        weekly,
    })
}

/// The newest good copy in `data/backups/`, by when it was written: what the
/// server knows about its backups when it starts.
pub async fn newest(data_dir: &Path) -> Option<i64> {
    let dir = data_dir.join(BACKUPS_DIR);
    let mut entries = tokio::fs::read_dir(&dir).await.ok()?;
    let mut newest: Option<i64> = None;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        if kind_of(&name.to_string_lossy()).is_none() {
            continue;
        }
        let Ok(modified) = entry.metadata().await.and_then(|meta| meta.modified()) else {
            continue;
        };
        let Ok(since_epoch) = modified.duration_since(std::time::UNIX_EPOCH) else {
            continue;
        };
        let at = i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX);
        newest = Some(newest.map_or(at, |held| held.max(at)));
    }
    newest
}

/// `VACUUM INTO`, on a read-only connection of its own (see the module doc).
async fn copy_into(source: &Path, target: &Path) -> Result<(), BackupError> {
    let mut conn = SqliteConnectOptions::new()
        .filename(source)
        .read_only(true)
        .busy_timeout(Duration::from_secs(30))
        .disable_statement_logging()
        .connect()
        .await?;
    let into = target.to_string_lossy().into_owned();
    let result = sqlx::query("VACUUM INTO ?")
        .bind(into)
        .execute(&mut conn)
        .await;
    let _ = conn.close().await;
    result?;
    Ok(())
}

/// Open the copy as a database of its own and ask SQLite whether it is whole
/// (`PRAGMA integrity_check`). It is switched to the plain rollback journal
/// first, so the copy is one self-contained file a host can move anywhere,
/// with no `-wal` beside it.
async fn check(copy: &Path) -> Result<(), BackupError> {
    let mut conn = SqliteConnectOptions::new()
        .filename(copy)
        .journal_mode(SqliteJournalMode::Delete)
        .disable_statement_logging()
        .connect()
        .await?;
    let rows: Vec<(String,)> = sqlx::query_as("PRAGMA integrity_check")
        .fetch_all(&mut conn)
        .await?;
    let _ = conn.close().await;
    let said: Vec<String> = rows.into_iter().map(|(line,)| line).collect();
    if said == ["ok"] {
        Ok(())
    } else {
        Err(BackupError::Damaged(said.join("; ")))
    }
}

/// A copy is as private as the database it came from: the server's owner
/// alone (#506).
#[cfg(unix)]
async fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await
}

#[cfg(not(unix))]
async fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Whether today's copy should also be this week's: no weekly copy yet, or
/// the newest is seven days old or more.
async fn weekly_due(dir: &Path, today: &str) -> Result<bool, BackupError> {
    let Ok(today) = today.parse::<jiff::civil::Date>() else {
        return Ok(false);
    };
    let newest = names(dir)
        .await?
        .into_iter()
        .filter_map(|name| match kind_of(&name) {
            Some((Kind::Weekly, date)) => date.parse::<jiff::civil::Date>().ok(),
            _ => None,
        })
        .max();
    Ok(match newest {
        None => true,
        Some(newest) => newest
            .until(today)
            .map_or(true, |span| span.get_days() >= 7),
    })
}

/// Drop the copies past [`DAILY_KEPT`] dailies and [`WEEKLY_KEPT`]
/// weeklies, newest kept, and any half-written copy a crash left behind
/// (not `current`, which has just been renamed anyway).
async fn prune(dir: &Path, current: &Path) -> Result<(), BackupError> {
    let names = names(dir).await?;
    for name in &names {
        let stale = name.starts_with(".linger-daily-") && name.ends_with(".db.partial");
        if stale && dir.join(name) != *current {
            let _ = tokio::fs::remove_file(dir.join(name)).await;
        }
    }
    for name in past_keeping(&names) {
        tokio::fs::remove_file(dir.join(name)).await?;
    }
    Ok(())
}

/// Of a folder's or a bucket's names, the copies past [`DAILY_KEPT`]
/// dailies and [`WEEKLY_KEPT`] weeklies, oldest first. Anything not named
/// like a copy is never among them.
fn past_keeping(names: &[String]) -> Vec<String> {
    let mut daily = Vec::new();
    let mut weekly = Vec::new();
    for name in names {
        match kind_of(name) {
            Some((Kind::Daily, date)) => daily.push((date, name)),
            Some((Kind::Weekly, date)) => weekly.push((date, name)),
            None => {}
        }
    }
    let mut past = Vec::new();
    for (mut copies, keep) in [(daily, DAILY_KEPT), (weekly, WEEKLY_KEPT)] {
        copies.sort();
        let extra = copies.len().saturating_sub(keep);
        past.extend(copies.into_iter().take(extra).map(|(_, name)| name.clone()));
    }
    past
}

/// The newest daily copy and the newest weekly one among `names`, when
/// there are any: what the bucket should have.
fn newest_of_each(names: &[String]) -> Vec<&str> {
    [Kind::Daily, Kind::Weekly]
        .into_iter()
        .filter_map(|wanted| {
            names
                .iter()
                .filter_map(|name| match kind_of(name) {
                    Some((kind, date)) if kind == wanted => Some((date, name.as_str())),
                    _ => None,
                })
                .max()
                .map(|(_, name)| name)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Daily,
    Weekly,
}

/// A copy's kind and date from its name, `linger-daily-2026-10-11.db` or
/// `linger-weekly-2026-10-11.db`; `None` for anything else in the folder.
fn kind_of(name: &str) -> Option<(Kind, &str)> {
    let stem = name.strip_suffix(".db")?;
    let (kind, date) = if let Some(date) = stem.strip_prefix("linger-daily-") {
        (Kind::Daily, date)
    } else {
        (Kind::Weekly, stem.strip_prefix("linger-weekly-")?)
    };
    date.parse::<jiff::civil::Date>().ok()?;
    Some((kind, date))
}

async fn names(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut entries = tokio::fs::read_dir(dir).await?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// The day, in UTC, a copy is named for.
fn utc_date(at: i64) -> String {
    jiff::Timestamp::from_millisecond(at).map_or_else(
        |_| "1970-01-01".to_string(),
        |ts| ts.to_zoned(jiff::tz::TimeZone::UTC).date().to_string(),
    )
}

fn wal_of(db: &Path) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push("-wal");
    PathBuf::from(name)
}

async fn file_len(path: &Path) -> u64 {
    tokio::fs::metadata(path).await.map_or(0, |meta| meta.len())
}

async fn remove_if_there(path: &Path) -> std::io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn names_say_what_a_copy_is() {
        assert_eq!(
            kind_of("linger-daily-2026-10-11.db"),
            Some((Kind::Daily, "2026-10-11"))
        );
        assert_eq!(
            kind_of("linger-weekly-2026-10-04.db"),
            Some((Kind::Weekly, "2026-10-04"))
        );
        assert_eq!(kind_of("linger-daily-yesterday.db"), None);
        assert_eq!(kind_of(".linger-daily-2026-10-11.db.partial"), None);
        assert_eq!(kind_of("linger-0.4.9-2026-10-07.tar.gz"), None);
    }

    #[test]
    fn a_copy_is_named_for_its_day_in_utc() {
        // 2026-10-11 23:30 UTC, which is still the 11th whatever the
        // server's own zone says.
        assert_eq!(utc_date(1_791_761_400_000), "2026-10-11");
    }

    #[test]
    fn the_first_copy_waits_for_the_day_to_be_up_and_no_longer() {
        let now = 100 * DAY;
        assert_eq!(first_wait(None, now), FIRST_AFTER);
        assert_eq!(first_wait(Some(now - 2 * DAY), now), FIRST_AFTER);
        assert_eq!(
            first_wait(Some(now - 6 * 60 * 60 * 1000), now),
            Duration::from_secs(18 * 60 * 60)
        );
        // A copy dated in the future (the clock was moved) waits no longer
        // than a fresh start does.
        assert_eq!(first_wait(Some(now + DAY), now), FIRST_AFTER);
    }

    fn owned(names: &[&str]) -> Vec<String> {
        names.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn a_week_of_dailies_and_a_month_of_weeklies_are_kept() {
        let mut names: Vec<String> = (1..=10)
            .map(|day| format!("linger-daily-2026-10-{day:02}.db"))
            .collect();
        names.extend((0..6).map(|week| format!("linger-weekly-2026-0{}-01.db", week + 4)));
        names.push("notes.txt".to_string());
        names.push("linger-daily-someday.db".to_string());

        let mut past = past_keeping(&names);
        past.sort();
        assert_eq!(
            past,
            owned(&[
                "linger-daily-2026-10-01.db",
                "linger-daily-2026-10-02.db",
                "linger-daily-2026-10-03.db",
                "linger-weekly-2026-04-01.db",
                "linger-weekly-2026-05-01.db",
            ])
        );
    }

    #[test]
    fn nothing_goes_while_there_are_fewer_than_kept() {
        let names = owned(&[
            "linger-daily-2026-10-10.db",
            "linger-daily-2026-10-11.db",
            "linger-weekly-2026-10-04.db",
        ]);
        assert!(past_keeping(&names).is_empty());
    }

    #[test]
    fn a_bucket_gets_the_newest_daily_and_the_newest_weekly() {
        let names = owned(&[
            "linger-daily-2026-10-09.db",
            "linger-daily-2026-10-11.db",
            "linger-daily-2026-10-10.db",
            "linger-weekly-2026-09-27.db",
            "linger-weekly-2026-10-04.db",
            ".linger-daily-2026-10-12.db.partial",
            "linger-0.4.9-2026-10-07.tar.gz",
        ]);
        assert_eq!(
            newest_of_each(&names),
            ["linger-daily-2026-10-11.db", "linger-weekly-2026-10-04.db"]
        );
        assert!(newest_of_each(&owned(&["notes.txt"])).is_empty());
        assert_eq!(
            newest_of_each(&owned(&["linger-daily-2026-10-11.db"])),
            ["linger-daily-2026-10-11.db"]
        );
    }

    #[test]
    fn the_bucket_is_overdue_after_three_days_without_a_copy_getting_there() {
        let start = 100 * DAY;
        // No bucket, never overdue.
        let none = Backups::new(Some(start), start);
        assert!(!none.bucket_overdue(start + 30 * DAY));

        // A bucket that never got a copy: three days in.
        let bucket = BackupBucket::open(&crate::config::BackupBucketConfig {
            s3: crate::config::S3Config {
                bucket: "linger-backups".to_string(),
                region: "us-east-1".to_string(),
                endpoint: "https://objects.example".to_string(),
                path_style: true,
                access_key_id: "key".to_string(),
                secret_access_key: "secret".to_string(),
            },
            prefix: "backups/".to_string(),
        })
        .unwrap();
        let with = Backups::new(Some(start), start).with_bucket(Some(bucket));
        assert_eq!(with.bucket_name(), Some("linger-backups"));
        assert!(!with.bucket_overdue(start + 2 * DAY));
        assert!(with.bucket_overdue(start + 3 * DAY));

        // A copy reaching it resets the clock, and an older answer from the
        // bucket never moves it back.
        with.reached(Some(start + 2 * DAY));
        with.reached(Some(start + DAY));
        assert_eq!(with.sent(), Some(start + 2 * DAY));
        assert!(!with.bucket_overdue(start + 4 * DAY));
        assert!(with.bucket_overdue(start + 5 * DAY));
    }

    #[test]
    fn overdue_is_three_days_of_running_without_a_good_copy() {
        let start = 100 * DAY;
        // Nothing yet, three days in.
        let fresh = Backups::new(None, start);
        assert!(!fresh.overdue(start + 2 * DAY));
        assert!(fresh.overdue(start + 3 * DAY));

        // A week-old copy on a server that has just started back up is not
        // overdue: it hasn't had its chance yet.
        let back = Backups::new(Some(start - 7 * DAY), start);
        assert!(!back.overdue(start + 60_000));
        assert!(back.overdue(start + 3 * DAY));

        // A good copy resets the clock.
        back.made(start + 2 * DAY);
        assert!(!back.overdue(start + 4 * DAY));
        assert!(back.overdue(start + 5 * DAY));
    }
}
