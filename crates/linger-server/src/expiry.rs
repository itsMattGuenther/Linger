//! The sweeper: what SPEC §4.10 means by "files stay until the server needs
//! the room", and the used sign-in tokens nothing else ever deleted (#520).
//!
//! A shared server fills up. Left alone it fills up forever, because nobody
//! goes back and tidies a year of screenshots, and the day it is full is the
//! day somebody cannot share the thing they wanted to share. So old files go —
//! and the two ways to say "keep this" are the two the product already has: a
//! star on the file, or a pin on the message carrying it (SPEC §4.4).
//!
//! Three kinds of object get taken, and only the first is about the host's
//! setting:
//!
//! 1. **Old files** — complete, unstarred, not on a pinned message. What makes
//!    one go is `LINGER_FILE_EXPIRY_DAYS` (`config::FileExpiry`, #583):
//!    - `when-full`, the default: nothing goes while the pool has room. Once
//!      it is 90% full the oldest go, oldest first, until it is down to 80%
//!      ([`keep_room`]). A year-old photo on a half-empty server stays, which
//!      is the point: a setting used to delete it on day 365 whatever the disk
//!      said. A pass checks on the reservations' fifteen-minute clock, and an
//!      upload that wouldn't fit makes the room it needs before it is refused
//!      ([`make_room_for`]).
//!    - a number of days: a file goes that long after it was shared, the rule
//!      from before #583.
//!    - `off`: none go, and a full pool refuses uploads.
//! 2. **Files on deleted messages** — a deleted message is a tombstone with an
//!    empty body (`routes::messages::delete`), and what it carried is deleted
//!    with it. The delete itself takes them, through [`take_from_message`],
//!    the moment it happens (#502); this rule is the retry, for a store that
//!    could not delete right then and for a message deleted on a server from
//!    before that. Until it runs nothing serves, shows, lists or exports the
//!    file: `routes::objects`, `repo::attachments::hydrate`, `repo::media`
//!    and `export` all pass over a file whose message is deleted. A star does
//!    not save one of these: a star means "do not let this age out", and
//!    somebody deleting the message is not age.
//! 3. **Finished uploads that never became a message** — somebody picked a file
//!    and then closed the composer. They get a week (`unsent::UNPOSTED_DAYS`,
//!    #503), or the host's window if that is shorter, in case a client is
//!    holding the id while a person is called away; not the year a shared file
//!    gets, and not forever when expiry is off. Uploads that never *finished*
//!    are `unsent`'s, released after an hour of silence on a timer of their
//!    own, which runs from here.
//!
//! A status used to carry a picture, and the sweeper skipped any file one
//! pointed at. Statuses have no pictures now (#269), so a file uploaded for one
//! is a finished upload that never became a message, and rule 3 takes it like
//! any other.
//!
//! A server's emoji (#359) is the one finished upload with no message that
//! rule 3 leaves alone: it is in use for as long as the emoji is, whatever its
//! age, and removing the emoji removes it.
//!
//! Each pass also takes **export archives** a week after they finished
//! (`export::sweep`, #504). They are not uploads and not in the pool, but they
//! are on the same disk or in the same bucket, and without this each member who
//! ever exported kept a copy of the whole server there for good. That rule is
//! not `LINGER_FILE_EXPIRY_DAYS`, and turning file expiry off does not stop it.
//!
//! Deleting is bytes first, row second. The other order can lose an object with
//! nothing left pointing at it — a file nobody can see and nobody can remove.
//! Doing it this way, a crash in between leaves a row whose bytes are gone,
//! which the next pass tries again and finishes.
//!
//! A pass takes **sign-in tokens** as well. Renewing a sign-in
//! (`auth::rotate_refresh`) marks the refresh token it used up and makes a new
//! one, and an app left open renews all day: about a hundred rows a day for
//! every device, which nothing deleted. A pass deletes each token once its own
//! 30 days are up. It is refused by then anyway, and a used one inside its 30
//! days stays, so presenting it again still ends the sign-in it came from
//! (PROTOCOL §2). This is not about files, so turning file expiry off leaves
//! it running.

use std::time::Duration;

use linger_core::limits::{WHEN_FULL_START_PERCENT, WHEN_FULL_TARGET_PERCENT};
use linger_core::{AttachmentId, MessageId};

use crate::config::FileExpiry;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo::attachments::pool_used;
use crate::state::AppState;
use crate::unsent;

/// How often the sweeper wakes. The interval is not the point — expiry is
/// measured in days, and a file taken six hours late is taken on time.
const SWEEP_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// How many objects one pass will take. A pass holds the single WAL writer for
/// a moment per row, so a first run against a server that has never swept
/// stops for breath rather than sitting on the writer while everyone types.
const SWEEP_BATCH: i64 = 500;

/// The breath between full batches. Long enough that a backlog does not starve
/// everybody typing, short enough that a year of files clears in one evening
/// rather than one batch every six hours for a week.
const BATCH_PAUSE: Duration = Duration::from_secs(5);

/// One file a pass takes: its id, its key, its poster's and its display
/// copy's (#382), and its size.
type Expired = (Vec<u8>, String, Option<String>, Option<String>, i64);

/// What a pass took, for the log line and for the tests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Swept {
    /// Uploads, and the bytes they held.
    pub files: u64,
    pub bytes: u64,
    /// Sign-in tokens past their 30 days (#520).
    pub tokens: u64,
    /// Export archives past their week (`export::sweep`).
    pub archives: u64,
}

/// Run the sweeper for as long as the process lives.
///
/// It runs a pass at startup and then on the interval, which matters for a
/// server that is only up for an hour a day: waiting six hours to do the first
/// pass would mean never doing one. Each pass ends with [`crate::db::optimize`].
/// Upload reservations that have gone quiet are given back on a shorter clock
/// of their own (`unsent`, #503): their window is an hour, not days.
pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        let mut reservations = tokio::time::interval(unsent::SWEEP_INTERVAL);
        reservations.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    drain(&state).await;
                    // The sweep is the server's one regular chore and it has
                    // just changed the files table, so the planner's
                    // statistics are kept up to date alongside it (#518). In
                    // this arm, not after the `select!`, or the reservations'
                    // fifteen-minute clock would run it too.
                    if let Err(err) = crate::db::optimize(&state.db.write).await {
                        tracing::warn!(error = %err, "could not update the query planner's statistics");
                    }
                }
                _ = reservations.tick() => {
                    unsent::release_idle_logged(&state).await;
                    // Under `when-full`, the pool is looked at four times an
                    // hour rather than every six, so a busy evening of
                    // photos doesn't run it up to the ceiling between passes.
                    match keep_room(&state).await {
                        Ok(swept) if swept.files > 0 => tracing::info!(
                            files = swept.files,
                            bytes = swept.bytes,
                            "made room: took the oldest files nobody starred or pinned"
                        ),
                        Ok(_) => {}
                        Err(err) => tracing::warn!(error = ?err, "could not make room in the file space"),
                    }
                }
            }
        }
    })
}

/// Sweep until a pass comes back with room to spare.
///
/// The first run on a server that has been up for a year has a year of files
/// to take, and one batch per interval would spend a week getting through them
/// while the pool stayed full the whole time.
async fn drain(state: &AppState) {
    loop {
        match sweep(state).await {
            Ok(swept) => {
                if swept.files > 0 || swept.archives > 0 {
                    tracing::info!(
                        files = swept.files,
                        bytes = swept.bytes,
                        archives = swept.archives,
                        "swept expired files"
                    );
                }
                if swept.tokens > 0 {
                    tracing::info!(tokens = swept.tokens, "swept expired sign-in tokens");
                }
                #[allow(clippy::cast_sign_loss)]
                if swept.files < SWEEP_BATCH as u64 && swept.tokens < SWEEP_BATCH as u64 {
                    return;
                }
                tokio::time::sleep(BATCH_PAUSE).await;
            }
            // A failed pass is not worth taking the server down for: the next
            // one is a few hours away and the disk is not on fire.
            Err(err) => {
                tracing::warn!(error = ?err, "file sweep failed");
                return;
            }
        }
    }
}

/// One pass. Public so an integration test can drive it against real uploads
/// without waiting six hours or backdating the clock.
pub async fn sweep(state: &AppState) -> Result<Swept, ApiError> {
    let now = now_ms();
    // The age rule's cutoff; NULL under `when-full` and `off`, which makes
    // the age comparison below false.
    let cutoff = state
        .config
        .file_expiry
        .days()
        .map(|days| now - i64::from(days) * DAY_MS);
    let unposted = unsent::unposted_cutoff(&state.config, now);

    // Three reasons in one query so paging and counting stay one thing. The
    // first `?` is the file window, NULL when expiry is off, which makes its
    // comparison false. The second is the unposted window (#503), never NULL:
    // like the deleted-message rule, it is not about age and is not the
    // host's to turn off.
    let rows: Vec<Expired> = sqlx::query_as(
        "SELECT a.id, a.object_key, a.poster_key, a.display_key, a.size_bytes
           FROM attachments a
           LEFT JOIN messages m ON m.id = a.message_id
          WHERE a.state = 'complete'
            AND (
                  (m.id IS NOT NULL AND m.deleted_at IS NOT NULL)
               OR (a.starred_at IS NULL AND (
                     (m.id IS NOT NULL AND m.pinned_at IS NULL AND a.created_at < ?)
                  OR (m.id IS NULL AND a.created_at < ?
                      AND a.id NOT IN (SELECT attachment_id FROM custom_emoji))))
            )
          ORDER BY a.created_at
          LIMIT ?",
    )
    .bind(cutoff)
    .bind(unposted)
    .bind(SWEEP_BATCH)
    .fetch_all(&state.db.read)
    .await?;

    let mut swept = Swept::default();
    for (id, object_key, poster_key, display_key, size_bytes) in rows {
        let Ok(id) = AttachmentId::from_slice(&id) else {
            continue;
        };
        if !take(
            state,
            id,
            &object_key,
            poster_key.as_deref(),
            display_key.as_deref(),
        )
        .await?
        {
            continue;
        }
        swept.files += 1;
        #[allow(clippy::cast_sign_loss)]
        {
            swept.bytes += size_bytes.max(0) as u64;
        }
    }

    // Sign-in tokens past their 30 days (#520), a batch at a time like the
    // files: a server that has never swept them has a row for every renewal
    // since it started. `rotate_refresh` refuses one at `expires_at <= now`,
    // so that is the line here too.
    swept.tokens = sqlx::query(
        "DELETE FROM refresh_tokens WHERE id IN (
           SELECT id FROM refresh_tokens WHERE expires_at <= ? LIMIT ?)",
    )
    .bind(now_ms())
    .bind(SWEEP_BATCH)
    .execute(&state.db.write)
    .await?
    .rows_affected();

    swept.archives = crate::export::sweep(state).await?;

    let made = keep_room(state).await?;
    swept.files += made.files;
    swept.bytes += made.bytes;
    Ok(swept)
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Where `when-full` starts taking files, and where it stops (#583): 90% and
/// 80% of the pool.
#[must_use]
pub fn when_full_marks(pool: u64) -> (u64, u64) {
    (
        pool / 100 * WHEN_FULL_START_PERCENT,
        pool / 100 * WHEN_FULL_TARGET_PERCENT,
    )
}

/// The files `when-full` may take, oldest first: complete, unstarred, on a
/// message that is neither pinned nor deleted. A file nobody posted is rule
/// 3's, with its week (#503), and the server's emoji are on no message, so
/// neither is here. The order is a file's age and nothing else: no "least
/// looked at", no guessing what matters (SPEC §2).
///
/// It reads Media's own index (`idx_attachments_media_order`, migration 0017)
/// from the unstarred end, oldest first, so finding the oldest few doesn't
/// sort every file on the server. That is why "unstarred" is written as the
/// index's own expression, and why `CROSS JOIN` puts the files first.
pub(crate) const OLDEST_FIRST_SQL: &str =
    "SELECT a.id, a.object_key, a.poster_key, a.display_key, a.size_bytes
       FROM attachments a CROSS JOIN messages m ON m.id = a.message_id
      WHERE a.state = 'complete' AND (a.starred_at IS NOT NULL) = 0
        AND m.deleted_at IS NULL AND m.pinned_at IS NULL
      ORDER BY a.created_at, a.id
      LIMIT ?";

/// Under `when-full`, a pool 90% full is brought down to 80% (#583). Anything
/// else, or a pool with room, takes nothing. Another pass already making room
/// is left to it.
pub async fn keep_room(state: &AppState) -> Result<Swept, ApiError> {
    if state.config.file_expiry != FileExpiry::WhenFull {
        return Ok(Swept::default());
    }
    let (start, target) = when_full_marks(state.config.pool_bytes);
    if pool_used(&state.db.read).await? < start {
        return Ok(Swept::default());
    }
    let Ok(_turn) = state.making_room.try_lock() else {
        return Ok(Swept::default());
    };
    take_oldest(state, target).await
}

/// Under `when-full`, make room for an upload of `size` bytes that wouldn't
/// otherwise fit, before it is refused (#583). Only what it needs, so the
/// request doesn't wait on a whole pass: the rest is [`keep_room`]'s, which
/// the upload starts in the background. Waits for a pass already running,
/// which may make the room by itself.
pub async fn make_room_for(state: &AppState, size: u64) -> Result<Swept, ApiError> {
    if state.config.file_expiry != FileExpiry::WhenFull {
        return Ok(Swept::default());
    }
    let _turn = state.making_room.lock().await;
    take_oldest(state, state.config.pool_bytes.saturating_sub(size)).await
}

/// Take the oldest files nobody starred or pinned until everything spoken for
/// is at or under `target` bytes, or there are none left to take. Holding
/// the caller's turn (`AppState::making_room`), so two passes never pick the
/// same files.
async fn take_oldest(state: &AppState, target: u64) -> Result<Swept, ApiError> {
    let mut swept = Swept::default();
    loop {
        let used = pool_used(&state.db.read).await?;
        if used <= target {
            break;
        }
        let over = used - target;
        let rows: Vec<Expired> = sqlx::query_as(OLDEST_FIRST_SQL)
            .bind(SWEEP_BATCH)
            .fetch_all(&state.db.read)
            .await?;
        if rows.is_empty() {
            break;
        }
        let mut freed: u64 = 0;
        for (id, object_key, poster_key, display_key, size_bytes) in rows {
            if freed >= over {
                break;
            }
            let Ok(id) = AttachmentId::from_slice(&id) else {
                continue;
            };
            if take(
                state,
                id,
                &object_key,
                poster_key.as_deref(),
                display_key.as_deref(),
            )
            .await?
            {
                let size = u64::try_from(size_bytes).unwrap_or(0);
                freed = freed.saturating_add(size);
                swept.files += 1;
                swept.bytes = swept.bytes.saturating_add(size);
            }
        }
        // A store refusing every delete: the next pass tries again.
        if freed == 0 {
            break;
        }
    }
    Ok(swept)
}

/// Whether `when-full` has anything left it could take: a pool past 90%
/// with nothing to take is one only the host can fix (#582's foot line).
pub async fn anything_to_take(state: &AppState) -> Result<bool, ApiError> {
    let found: Option<Expired> = sqlx::query_as(OLDEST_FIRST_SQL)
        .bind(1_i64)
        .fetch_optional(&state.db.read)
        .await?;
    Ok(found.is_some())
}

/// What Media's "Leaving soon" shows (#583): files nobody starred or pinned,
/// shared at or before the moment this returns. `None` is nothing leaving
/// soon at all.
///
/// - Days: within 30 days of their date.
/// - `when-full`: once the pool is past 80%, the oldest that add up to a
///   tenth of it, which is what one pass takes when it reaches 90%. Below
///   80% nothing is leaving soon, and saying otherwise would have people
///   starring things for nothing.
/// - `off`: nothing.
pub async fn leaving_cutoff(state: &AppState, now: i64) -> Result<Option<i64>, ApiError> {
    match state.config.file_expiry {
        FileExpiry::Off => Ok(None),
        FileExpiry::After(days) => {
            let warning = i64::from(days.saturating_sub(LEAVING_SOON_DAYS));
            Ok(Some(now - warning * DAY_MS))
        }
        FileExpiry::WhenFull => {
            let pool = state.config.pool_bytes;
            let (_, target) = when_full_marks(pool);
            if pool_used(&state.db.read).await? < target {
                return Ok(None);
            }
            let batch = i64::try_from(pool / 10).unwrap_or(i64::MAX);
            let (at,): (Option<i64>,) = sqlx::query_as(LEAVING_WHEN_FULL_SQL)
                .bind(batch)
                .fetch_one(&state.db.read)
                .await?;
            // Not a tenth's worth left to take: all of it is next in line.
            Ok(Some(at.unwrap_or(i64::MAX)))
        }
    }
}

/// Under `when-full`, the date of the newest file in the next tenth of the
/// pool to go, oldest first: a running total over the same files, in the
/// same order, as [`OLDEST_FIRST_SQL`].
/// `NULL` when they don't add up to that much.
pub(crate) const LEAVING_WHEN_FULL_SQL: &str = "SELECT MIN(created_at) FROM (
       SELECT a.created_at,
              SUM(a.size_bytes) OVER (ORDER BY a.created_at, a.id) AS running
         FROM attachments a CROSS JOIN messages m ON m.id = a.message_id
        WHERE a.state = 'complete' AND (a.starred_at IS NOT NULL) = 0
          AND m.deleted_at IS NULL AND m.pinned_at IS NULL)
      WHERE running >= ?";

/// How long before its date a file shows as leaving soon, under an age rule.
pub const LEAVING_SOON_DAYS: u32 = 30;

// ---------------------------------------------------------------------------
// Taking a file. Everything a pass does belongs in `sweep` above; these two
// are the per-file step, shared with the message delete.
// ---------------------------------------------------------------------------

/// Take the files a message carried, now: what deleting the message means
/// for them (#502). How many went.
///
/// Called by the delete straight after the tombstone, so a deleted message's
/// photo is gone when the delete answers rather than at the next pass, up to
/// six hours later. A file the store refuses stays for that pass, which is
/// the retry, and is unreachable meanwhile (rule 2 in the module doc).
pub async fn take_from_message(state: &AppState, message_id: MessageId) -> Result<u64, ApiError> {
    let rows: Vec<Expired> = sqlx::query_as(
        "SELECT id, object_key, poster_key, display_key, size_bytes
           FROM attachments
          WHERE message_id = ? AND state = 'complete'",
    )
    .bind(message_id.to_vec())
    .fetch_all(&state.db.read)
    .await?;
    let mut taken = 0;
    for (id, object_key, poster_key, display_key, _) in rows {
        let Ok(id) = AttachmentId::from_slice(&id) else {
            continue;
        };
        if take(
            state,
            id,
            &object_key,
            poster_key.as_deref(),
            display_key.as_deref(),
        )
        .await?
        {
            taken += 1;
        }
    }
    Ok(taken)
}

/// Delete one file, bytes first and row second (see the module doc): the
/// original, its poster frame and its display copy (#382), then the row.
/// `false` when the store refused the original, which leaves both for the
/// next pass.
async fn take(
    state: &AppState,
    id: AttachmentId,
    object_key: &str,
    poster_key: Option<&str>,
    display_key: Option<&str>,
) -> Result<bool, ApiError> {
    // A backend that cannot delete right now must not lose the row that
    // remembers what to delete.
    if let Err(err) = state.storage.delete_object(object_key).await {
        tracing::warn!(error = %err, key = object_key, "could not delete a file's object; the next sweep tries again");
        return Ok(false);
    }
    if let Some(key) = poster_key {
        let _ = state.storage.delete_object(key).await;
    }
    if let Some(key) = display_key.filter(|key| *key != object_key) {
        let _ = state.storage.delete_object(key).await;
    }
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await?;
    Ok(true)
}
