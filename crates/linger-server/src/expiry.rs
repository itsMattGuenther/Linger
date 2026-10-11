//! The sweeper: what SPEC §4.10 means by "files expire after 365 days", and
//! the used sign-in tokens nothing else ever deleted (#520).
//!
//! A shared server fills up. Left alone it fills up forever, because nobody
//! goes back and tidies a year of screenshots, and the day it is full is the
//! day somebody cannot share the thing they wanted to share. So files age out —
//! and the two ways to say "keep this" are the two the product already has: a
//! star on the file, or a pin on the message carrying it (SPEC §4.4).
//!
//! Three kinds of object get taken, and only the first is about age:
//!
//! 1. **Old files** — complete, unstarred, not on a pinned message, older than
//!    `LINGER_FILE_EXPIRY_DAYS`. This is the rule in the spec.
//! 2. **Files on deleted messages** — a deleted message is a tombstone with an
//!    empty body (`routes::messages::delete`), and neither the stream nor the
//!    media collection will ever draw what it was carrying again. The bytes are
//!    unreachable and still counted against the pool, so they go at once rather
//!    than in a year. A star does not save one of these: a star means "do not
//!    let this age out", and somebody deleting the message is not age.
//! 3. **Finished uploads that never became a message** — somebody picked a file
//!    and then closed the composer. `routes::uploads` sweeps *unfinished* ones
//!    after 48 hours; a finished orphan has nothing to wait for either, but it
//!    is given the full expiry window in case a client is holding the id while
//!    a person types.
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
//! Deleting is bytes first, row second. The other order can lose an object with
//! nothing left pointing at it — a file nobody can see and nobody can remove.
//! Doing it this way, a crash in between leaves a row whose bytes are gone,
//! which the next pass tries again and finishes.
//!
//! **Sign-in tokens** are the other thing a pass takes. Renewing a sign-in
//! (`auth::rotate_refresh`) marks the refresh token it used up and makes a new
//! one, and an app left open renews all day: about a hundred rows a day for
//! every device, which nothing deleted. A pass deletes each token once its own
//! 30 days are up. It is refused by then anyway, and a used one inside its 30
//! days stays, so presenting it again still ends the sign-in it came from
//! (PROTOCOL §2). This is not about files, so turning file expiry off leaves
//! it running.

use std::time::Duration;

use linger_core::AttachmentId;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;

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
    pub files: u64,
    pub bytes: u64,
    /// Sign-in tokens past their 30 days (#520).
    pub tokens: u64,
}

/// Run the sweeper for as long as the process lives.
///
/// It runs a pass at startup and then on the interval, which matters for a
/// server that is only up for an hour a day: waiting six hours to do the first
/// pass would mean never doing one.
pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            drain(&state).await;
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
                if swept.files > 0 {
                    tracing::info!(
                        files = swept.files,
                        bytes = swept.bytes,
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
    let cutoff = state
        .config
        .file_expiry_days
        .map(|days| now_ms() - i64::from(days) * 24 * 60 * 60 * 1000);

    // Three reasons in one query so paging and counting stay one thing. The
    // `?` for the cutoff is bound twice and is NULL when expiry is off, which
    // makes both age comparisons false and leaves only the deleted-message
    // rule — that one is not about age and is not the host's to turn off.
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
    .bind(cutoff)
    .bind(SWEEP_BATCH)
    .fetch_all(&state.db.read)
    .await?;

    let mut swept = Swept::default();
    for (id, object_key, poster_key, display_key, size_bytes) in rows {
        let Ok(id) = AttachmentId::from_slice(&id) else {
            continue;
        };
        // A backend that cannot delete right now must not lose the row that
        // remembers what to delete, so a failure here leaves both in place for
        // the next pass.
        if let Err(err) = state.storage.delete_object(&object_key).await {
            tracing::warn!(error = %err, key = object_key, "could not delete an expired object");
            continue;
        }
        if let Some(key) = &poster_key {
            let _ = state.storage.delete_object(key).await;
        }
        if let Some(key) = display_key.as_ref().filter(|key| **key != object_key) {
            let _ = state.storage.delete_object(key).await;
        }
        sqlx::query("DELETE FROM attachments WHERE id = ?")
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
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
    Ok(swept)
}
