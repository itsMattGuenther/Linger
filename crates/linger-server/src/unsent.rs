//! Files on their way into a message (#503): uploads still going up, and
//! finished ones nobody has posted yet.
//!
//! The pool (SPEC §4.10) is everybody's, and these are the part of it nobody
//! else can see. They are on no message, so they are not in the media
//! collection, and they are not the host's to delete. Asking for a slot
//! reserves the declared size against the pool before a byte moves, so before
//! #503 one member could ask for slot after slot without sending anything,
//! hold each one for two days, and leave everybody else told the server was
//! full. So these keep rules of their own:
//!
//! 1. **A cap per member.** One person can have [`MAX_GOING_UP_BYTES`] still
//!    going up at once. Past it, `POST /uploads` answers `QUOTA_EXCEEDED` in
//!    words about *their* uploads rather than the server's storage.
//! 2. **An hour of silence gives a reservation back.** A slot that has
//!    received nothing for [`IDLE_MS`] is released: a failed upload, a closed
//!    laptop, or somebody who never meant to send. This runs on the sweeper's
//!    timer (`expiry::spawn`) and again on the way into every new upload, so
//!    a slot that has just gone quiet never stands between somebody and
//!    their file.
//!
//! **Releasing a slot is not forgetting it.** Its space comes back at once
//! and the parts that arrived are discarded, but the row stays, marked
//! `released`, until the slot is [`CEILING_MS`] old. On S3 the app PUTs
//! straight at the bucket with links signed for a day, and the bucket takes a
//! part from anybody holding one whatever this server has decided: a laptop
//! that wakes after an hour, or somebody doing it on purpose, can still land
//! bytes. Forgetting the row at once would leave those in the bucket forever,
//! counted nowhere. At the ceiling every link has expired, so the parts are
//! discarded once more and only then does the row go. `released` counts
//! against nothing (`pool_used` and [`going_up`] count `pending` only), the
//! server's own part listener refuses it, and `complete` answers that there
//! is no such upload. A slot given up with `DELETE /uploads/:id` and a removed
//! member's slots are released the same way ([`release_slot`]).
//! 3. **A week for a finished file nobody posts** ([`UNPOSTED_DAYS`]), rather
//!    than the year a shared file gets. The sweeper takes them (`expiry`,
//!    rule 3) with [`unposted_cutoff`].
//! 4. **A removed member's go with them** ([`release_for`]).
//!
//! A server's emoji (#359) is a finished upload with no message too, and none
//! of this touches one: it is in use for as long as the emoji is.

use std::time::Duration;

use linger_core::{AttachmentId, UploadId, UserId};

use crate::config::Config;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;

/// How much one member can have going up at once: 1 GB, a little over two of
/// the biggest files (500 MB each).
///
/// That is more than anybody sends at once by hand, and on the default 50 GB
/// pool it would take fifty people at once to fill it. It is a fixed figure
/// rather than a share of the pool on purpose: a share small enough to matter
/// on a small pool would leave no room for one big file, and one file of up to
/// 500 MB is what SPEC §4.10 promises. On a pool smaller than this, the pool
/// is the limit that bites first.
pub const MAX_GOING_UP_BYTES: u64 = 1024 * 1024 * 1024;

/// A reservation that has received nothing for this long is given back.
/// An 8 MB part arrives in well under an hour on any connection an upload
/// could ever finish on, so an hour of nothing is an upload that has stopped.
pub const IDLE_MS: i64 = 60 * 60 * 1000;

/// Anything that never completed is forgotten once it is this old: its parts
/// are discarded one last time and its row goes, whatever storage says. Its
/// signed URLs lasted a day, so nothing more can arrive after this. A failed
/// or released slot holds no space and keeps its row until then, so a late
/// part that reached a bucket is still found, and a retried complete hears
/// that the upload failed rather than that there is no such upload.
pub const CEILING_MS: i64 = 48 * 60 * 60 * 1000;

/// How long a finished upload nobody has posted is kept: a week. Long enough
/// to attach something, get called away and send it the next day or after the
/// weekend; short enough that what somebody uploaded and forgot does not sit
/// on the pool for a year. Not the host's to turn off: it is not ageing out,
/// it is a file nothing will ever show.
pub const UNPOSTED_DAYS: u32 = 7;

/// How often the sweeper releases idle reservations. The window is an hour,
/// so a quarter of one keeps the figure members see honest.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(15 * 60);

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// What one release gave back to the pool, for the log line and the tests.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Released {
    pub uploads: u64,
    pub bytes: u64,
}

impl Released {
    fn add(&mut self, size_bytes: i64) {
        self.uploads += 1;
        self.bytes += u64::try_from(size_bytes).unwrap_or(0);
    }
}

/// What this member has going up right now: every slot they reserved that
/// has not completed.
///
/// Takes any executor so `routes::uploads` can read it inside the
/// transaction that reserves the next slot, which is what stops twenty
/// requests at once from all fitting under the cap.
pub async fn going_up<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    user: UserId,
) -> Result<u64, ApiError> {
    let (bytes,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM attachments
          WHERE uploader_id = ? AND state = 'pending'",
    )
    .bind(user.to_vec())
    .fetch_one(db)
    .await?;
    Ok(u64::try_from(bytes).unwrap_or(0))
}

/// The oldest a finished upload nobody posted may be before the sweeper
/// takes it: [`UNPOSTED_DAYS`], or the host's file window if that is shorter,
/// since a file nobody posted should never outlive one somebody did.
#[must_use]
pub fn unposted_cutoff(config: &Config, now: i64) -> i64 {
    let days = config
        .file_expiry_days
        .map_or(UNPOSTED_DAYS, |days| days.min(UNPOSTED_DAYS));
    now - i64::from(days) * DAY_MS
}

/// Give back every reservation that has gone quiet (rule 2), and forget
/// every slot whose links have all expired.
///
/// `now` is a parameter so a test can stand an hour, or two days, in the
/// future rather than wait. A slot younger than [`IDLE_MS`] is not looked at.
/// A pending one older than that asks storage when it last heard anything,
/// and only a slot that has heard nothing for the whole window is released.
/// Storage that cannot answer keeps the slot for the next pass: keeping it a
/// little longer is the safe mistake. Anything past [`CEILING_MS`] that never
/// completed, pending, failed or released, is discarded and forgotten.
pub async fn release_idle(state: &AppState, now: i64) -> Result<Released, ApiError> {
    let rows: Vec<(Vec<u8>, String, i64, i64)> = sqlx::query_as(
        "SELECT id, state, size_bytes, created_at FROM attachments
          WHERE state != 'complete' AND created_at < ?",
    )
    .bind(now - IDLE_MS)
    .fetch_all(&state.db.read)
    .await?;

    let mut released = Released::default();
    for (id, upload_state, size_bytes, created_at) in rows {
        let Ok(id) = AttachmentId::from_slice(&id) else {
            continue;
        };
        let upload = UploadId(id.0);
        let pending = upload_state == "pending";
        if created_at < now - CEILING_MS {
            // Every link it handed out has expired, so what is in storage
            // now is the last of it.
            let _ = state.storage.discard(upload).await;
            // `complete` may have finished it since the read: a file
            // somebody has just finished sending is not a dead slot.
            let gone = sqlx::query("DELETE FROM attachments WHERE id = ? AND state != 'complete'")
                .bind(id.to_vec())
                .execute(&state.db.write)
                .await?;
            if pending && gone.rows_affected() > 0 {
                released.add(size_bytes);
            }
            continue;
        }
        if !pending {
            continue;
        }
        let quiet = match state.storage.last_received(upload).await {
            Ok(heard) => heard.is_none_or(|at| at < now - IDLE_MS),
            Err(err) => {
                tracing::warn!(error = %err, upload = %upload, "could not ask storage about an upload");
                false
            }
        };
        if quiet && release_slot(state, id).await? {
            released.add(size_bytes);
        }
    }
    Ok(released)
}

/// Release one slot: its space back at once, the parts that arrived
/// discarded, the row kept as `released` until [`CEILING_MS`] (see the
/// module doc for why the row stays). Returns whether it was pending, and so
/// whether any space came back. A slot `complete` has just finished is left
/// alone: that is a file, not a reservation.
pub async fn release_slot(state: &AppState, id: AttachmentId) -> Result<bool, ApiError> {
    // The row first, so the server's own listener refuses a part from here on.
    let changed =
        sqlx::query("UPDATE attachments SET state = 'released' WHERE id = ? AND state = 'pending'")
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
    let _ = state.storage.discard(UploadId(id.0)).await;
    Ok(changed.rows_affected() > 0)
}

/// The sweeper's call to [`release_idle`]: logged, never fatal, because the
/// next pass is a quarter of an hour away.
pub async fn release_idle_logged(state: &AppState) {
    match release_idle(state, now_ms()).await {
        Ok(released) if released.uploads > 0 => tracing::info!(
            uploads = released.uploads,
            bytes = released.bytes,
            "released idle upload reservations"
        ),
        Ok(_) => {}
        Err(err) => tracing::warn!(error = ?err, "releasing idle uploads failed"),
    }
}

/// One file to let go of: its id, state, key, poster and display copy, size.
type Held = (Vec<u8>, String, String, Option<String>, Option<String>, i64);

/// Drop everything a member had on its way into a message (rule 4): their
/// reservations, released as [`release_slot`] does, and the finished files
/// they never posted, bytes first and row second (the order `expiry`
/// explains).
///
/// Called when the member is removed. Whatever they posted stays, as their
/// messages do (SPEC principle 3), and so does any emoji whose picture they
/// uploaded, which is the server's. A file storage will not delete right now
/// keeps its row, and the sweeper takes it within [`UNPOSTED_DAYS`].
pub async fn release_for(state: &AppState, user: UserId) -> Result<Released, ApiError> {
    let rows: Vec<Held> = sqlx::query_as(
        "SELECT id, state, object_key, poster_key, display_key, size_bytes
           FROM attachments
          WHERE uploader_id = ? AND message_id IS NULL
            AND state IN ('pending', 'complete')
            AND id NOT IN (SELECT attachment_id FROM custom_emoji)",
    )
    .bind(user.to_vec())
    .fetch_all(&state.db.read)
    .await?;

    let mut released = Released::default();
    for (id, upload_state, object_key, poster_key, display_key, size_bytes) in rows {
        let Ok(id) = AttachmentId::from_slice(&id) else {
            continue;
        };
        if upload_state == "pending" {
            if release_slot(state, id).await? {
                released.add(size_bytes);
            }
            continue;
        }
        if let Err(err) = state.storage.delete_object(&object_key).await {
            tracing::warn!(error = %err, key = object_key, "could not delete a removed member's file; the sweeper tries again");
            continue;
        }
        if let Some(key) = &poster_key {
            let _ = state.storage.delete_object(key).await;
        }
        if let Some(key) = display_key.as_ref().filter(|key| **key != object_key) {
            let _ = state.storage.delete_object(key).await;
        }
        let gone = sqlx::query("DELETE FROM attachments WHERE id = ? AND message_id IS NULL")
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
        if gone.rows_affected() > 0 {
            released.add(size_bytes);
        }
    }
    Ok(released)
}
