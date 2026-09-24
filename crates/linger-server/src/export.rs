//! Full export (SPEC §4.11, PROTOCOL §7, T-801).
//!
//! **This is the anti-lock-in guarantee, so it is deliberately not clever.**
//! Any member can ask for the whole server at any time — no host approval, no
//! gatekeeping — and what comes back is a zip a person can open on any machine
//! with no software from this project: one markdown file per room, the files
//! themselves in `media/`, and an index. Nothing in it needs Linger to read.
//!
//! Three shapes decide how it is built:
//!
//! - **A background job, not a request.** A server with a year of photos cannot
//!   answer inside one HTTP request, so `POST /export` writes a row, spawns a
//!   task and hands back an id. The row *is* the job: progress lives in the
//!   database, not in memory, so a job interrupted by a restart is a stalled
//!   row somebody can see rather than a client polling a job that no longer
//!   exists.
//! - **One archive per member.** Asking again deletes the previous archive's
//!   bytes first. Otherwise a server accumulates a complete copy of itself per
//!   member per request, and the feature that is supposed to protect a host
//!   fills their disk instead.
//! - **One archive builds at a time, server-wide.** The per-member limits do
//!   not stop twenty members asking in the same minute, and every archive being
//!   built holds a copy of what it carries in scratch — twice over on S3, where
//!   the files are downloaded before they are zipped. So jobs wait their turn in
//!   `queued`, which the client already shows as work in progress.
//! - **The zip is written on a blocking thread.** `zip` is synchronous and an
//!   archive is hundreds of megabytes; writing it on the reactor would stall
//!   every other connection (AGENTS.md: never block the reactor).
//!
//! Times in the archive are UTC and say so. The server does not know what
//! timezone a reader is in, and quietly writing its own would be worse than
//! naming the one it used.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};

use linger_core::wire::{ExportJob, ExportState, Message, Room, RoomKind, User};
use linger_core::{ExportId, MessageId, RoomId, UserId};
use sqlx::Row;

use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;
use crate::storage::ServeAs;

/// `ApiError` is a response rather than a failure, so it is not a
/// `std::error::Error` and does not flow into `anyhow` on its own. The worker
/// answers nobody, so its errors end in the log and in the job row.
fn anyhowed(err: ApiError) -> anyhow::Error {
    anyhow::anyhow!(err.message)
}

/// How many messages one database round trip pulls. Big enough that a busy room
/// is a handful of queries, small enough that none of them holds much memory.
const BATCH: u32 = 500;

/// How many archives build at the same time across the whole server. One:
/// the peak scratch an export can take is then one member's archive, whatever
/// everybody else does, and nobody is waiting on anything but time.
pub const BUILDING_AT_ONCE: usize = 1;

/// Where an archive's bytes live. Not an `attachments` key: an export is not
/// part of the media collection, does not count against `LINGER_POOL_BYTES`,
/// and must never be drawn in the grid.
#[must_use]
pub fn object_key(id: ExportId) -> String {
    format!("exports/{id}.zip")
}

/// How an archive is served: a download, always, whatever the browser thinks.
#[must_use]
fn serve_as(filename: &str) -> ServeAs {
    ServeAs {
        content_type: "application/zip".to_string(),
        disposition: format!("attachment; filename=\"{filename}\""),
    }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/// Start an export for this member and return its id.
///
/// The previous one goes first, bytes and row both. A member has one archive,
/// which is the whole server; keeping every archive they ever asked for would
/// be a way to fill a host's disk by pressing a button repeatedly.
pub async fn start(state: &AppState, user_id: UserId) -> Result<ExportId, ApiError> {
    forget_previous(state, user_id).await?;

    let id = ExportId::new();
    sqlx::query(
        "INSERT INTO exports (id, user_id, state, progress, created_at)
         VALUES (?, ?, 'queued', 0, ?)",
    )
    .bind(id.to_vec())
    .bind(user_id.to_vec())
    .bind(now_ms())
    .execute(&state.db.write)
    .await?;

    let worker = state.clone();
    tokio::spawn(async move {
        // Wait for a turn before touching the disk. The permit is held until
        // this task ends, whichever way it ends. The semaphore is never
        // closed, so an error here cannot happen; the row stays `queued`.
        let Ok(_turn) = worker.exports.acquire().await else {
            return;
        };
        if let Err(err) = run(&worker, id, user_id).await {
            tracing::error!(export = %id, error = %err, "export failed");
            let _ = sqlx::query(
                "UPDATE exports SET state = 'failed', error = ?, finished_at = ? WHERE id = ?",
            )
            .bind(err.to_string())
            .bind(now_ms())
            .bind(id.to_vec())
            .execute(&worker.db.write)
            .await;
        }
    });

    Ok(id)
}

/// Delete this member's previous archive, bytes before row — the same order the
/// expiry sweeper uses, and for the same reason: the other way round can leave
/// an object with nothing pointing at it.
async fn forget_previous(state: &AppState, user_id: UserId) -> Result<(), ApiError> {
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT object_key FROM exports WHERE user_id = ? AND object_key IS NOT NULL",
    )
    .bind(user_id.to_vec())
    .fetch_all(&state.db.read)
    .await?;

    for key in keys {
        if let Err(err) = state.storage.delete_object(&key).await {
            // Worth knowing about and not worth refusing over: the row goes
            // either way, and a stray object is a tidiness problem rather than
            // a correctness one.
            tracing::warn!(%key, error = %err, "could not delete an old export");
        }
    }
    sqlx::query("DELETE FROM exports WHERE user_id = ?")
        .bind(user_id.to_vec())
        .execute(&state.db.write)
        .await?;
    Ok(())
}

/// One member's view of one job. `None` covers both "no such job" and
/// "somebody else's job" on purpose — an archive of the whole server is a
/// private thing to be building, and which of the two it was is not the
/// asker's business.
pub async fn job(
    state: &AppState,
    id: ExportId,
    user_id: UserId,
) -> Result<Option<ExportJob>, ApiError> {
    let row =
        sqlx::query("SELECT state, progress, object_key FROM exports WHERE id = ? AND user_id = ?")
            .bind(id.to_vec())
            .bind(user_id.to_vec())
            .fetch_optional(&state.db.read)
            .await?;

    let Some(row) = row else { return Ok(None) };
    let state_text: String = row.get("state");
    let key: Option<String> = row.get("object_key");
    Ok(Some(ExportJob {
        job_id: id,
        state: match state_text.as_str() {
            "queued" => ExportState::Queued,
            "running" => ExportState::Running,
            "complete" => ExportState::Complete,
            _ => ExportState::Failed,
        },
        #[allow(clippy::cast_possible_truncation)]
        progress: row.get::<f64, _>("progress") as f32,
        url: key.map(|key| format!("{}/objects/{key}", state.config.media_origin())),
    }))
}

async fn set_progress(state: &AppState, id: ExportId, progress: f64) {
    let _ = sqlx::query("UPDATE exports SET progress = ? WHERE id = ?")
        .bind(progress.clamp(0.0, 1.0))
        .bind(id.to_vec())
        .execute(&state.db.write)
        .await;
}

/// Build the archive, store it, mark the row complete.
async fn run(state: &AppState, id: ExportId, asker: UserId) -> anyhow::Result<()> {
    // While this job waited its turn, the member may have asked again, and
    // asking again deletes this row. Building it anyway would store an archive
    // nothing points at — the leak `forget_previous` exists to prevent.
    let claimed =
        sqlx::query("UPDATE exports SET state = 'running' WHERE id = ? AND state = 'queued'")
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
    if claimed.rows_affected() == 0 {
        tracing::info!(export = %id, "export was replaced while it waited; not building it");
        return Ok(());
    }

    // Scratch, not the data directory: everything here is thrown away, and
    // `TempDir` takes it with us whichever way this function leaves.
    tokio::fs::create_dir_all(state.config.staging_dir()).await?;
    let scratch = tempfile::tempdir_in(state.config.staging_dir())?;

    let plan = assemble(state, id, asker, scratch.path()).await?;
    let filename = archive_name(state).await;

    // The zip itself is synchronous work on a lot of bytes, so it happens on a
    // blocking thread rather than on the reactor.
    let zip_path = scratch.path().join("archive.zip");
    let target = zip_path.clone();
    let root = filename.trim_end_matches(".zip").to_string();
    tokio::task::spawn_blocking(move || write_zip(&target, &root, &plan)).await??;
    set_progress(state, id, 0.95).await;

    let size = tokio::fs::metadata(&zip_path).await?.len();
    let key = object_key(id);
    state
        .storage
        .put_object(&key, &zip_path, &serve_as(&filename))
        .await?;

    #[allow(clippy::cast_possible_wrap)]
    sqlx::query(
        "UPDATE exports
         SET state = 'complete', progress = 1.0, object_key = ?, size_bytes = ?,
             filename = ?, finished_at = ?
         WHERE id = ?",
    )
    .bind(&key)
    .bind(size as i64)
    .bind(&filename)
    .bind(now_ms())
    .bind(id.to_vec())
    .execute(&state.db.write)
    .await?;

    tracing::info!(export = %id, size_bytes = size, "export ready");
    Ok(())
}

/// What the host called this server. `server_config` is a key/value table, not
/// a row of columns — the same shape `routes::server` reads.
async fn server_name(state: &AppState) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM server_config WHERE key = 'name'")
        .fetch_optional(&state.db.read)
        .await
        .ok()
        .flatten()
        .filter(|name| !name.trim().is_empty())
}

/// What the download is called: the server's name and today's date, both
/// flattened to something every filesystem accepts.
async fn archive_name(state: &AppState) -> String {
    let server = server_name(state).await;
    let slug: String = server
        .unwrap_or_else(|| "linger".to_string())
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').replace("--", "-");
    let (y, m, d) = civil_date(now_ms());
    format!(
        "linger-{}-{y:04}-{m:02}-{d:02}.zip",
        if slug.is_empty() {
            "export".into()
        } else {
            slug
        }
    )
}

// ---------------------------------------------------------------------------
// What goes in
// ---------------------------------------------------------------------------

/// One thing that will become an entry in the archive.
struct Entry {
    /// Path inside the zip, under the top-level folder.
    name: String,
    /// Where the bytes are right now.
    source: PathBuf,
    /// Whether it is worth compressing. Markdown is; a JPEG is already
    /// compressed and running deflate over it burns CPU to save nothing.
    compress: bool,
}

/// Write every room, the media index and the read-me into `scratch`, and work
/// out where each media file's bytes are.
/// `asker` is who the archive is for, and every row that goes into it is
/// chosen with them in mind (SPEC §4.13).
///
/// An export is the promise that leaving is possible, and it has to carry a
/// person's whole conversation — including the DMs they were in, because those
/// are theirs as much as any room is. What it must not carry is the DMs they
/// were *not* in, and an export is the worst place to get that wrong: it is a
/// file that leaves the server, so a mistake here is not a screen somebody saw
/// once, it is a copy they keep.
async fn assemble(
    state: &AppState,
    id: ExportId,
    asker: UserId,
    scratch: &Path,
) -> anyhow::Result<Vec<Entry>> {
    let config = &state.config;
    let users = crate::repo::users::all(&state.db.read, config)
        .await
        .map_err(anyhowed)?;
    let by_id: HashMap<UserId, User> = users.iter().map(|u| (u.id, u.clone())).collect();
    // `repo::rooms::all` does not filter archived rooms out, which is what an
    // archive wants: an archived room is still where a year of somebody's
    // conversation is. It does filter DMs out, so they are added back here —
    // this person's, and only this person's.
    let mut rooms = crate::repo::rooms::all(&state.db.read)
        .await
        .map_err(anyhowed)?;
    rooms.extend(
        crate::repo::rooms::dms_for(&state.db.read, asker)
            .await
            .map_err(anyhowed)?,
    );
    let media = media_rows(state, asker).await?;

    // Every attachment gets its name inside the archive up front, so a message
    // can link to a file the loop has not reached yet.
    let mut taken: HashSet<String> = HashSet::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for item in &media {
        names.insert(
            item.object_key.clone(),
            archive_filename(&item.filename, &mut taken),
        );
    }

    let mut entries = Vec::new();
    tokio::fs::create_dir_all(scratch.join("rooms")).await?;
    tokio::fs::create_dir_all(scratch.join("direct")).await?;

    // Rooms are two thirds of the work and media is the other third, roughly.
    let total = rooms.len().max(1) as f64;
    for (done, room) in rooms.iter().enumerate() {
        let text = room_markdown(state, room, &by_id, &names, asker)
            .await
            .map_err(anyhowed)?;
        // DMs live in their own folder, named by who they are with. Mixing them
        // into `rooms/` would put a private conversation next to the server's
        // rooms in a file somebody opens a year from now with no other context.
        let name = if room.kind == RoomKind::Dm {
            format!("direct/{}.md", dm_slug(room, &by_id, asker))
        } else {
            format!("rooms/{}.md", room.slug)
        };
        let path = scratch.join(&name);
        tokio::fs::write(&path, text).await?;
        entries.push(Entry {
            name,
            source: path,
            compress: true,
        });
        set_progress(state, id, 0.6 * (done + 1) as f64 / total).await;
    }

    let index = scratch.join("media.md");
    tokio::fs::write(
        &index,
        media_markdown(&media, &by_id, &names, &rooms, asker),
    )
    .await?;
    entries.push(Entry {
        name: "media.md".to_string(),
        source: index,
        compress: true,
    });

    let readme = scratch.join("README.md");
    tokio::fs::write(&readme, readme_markdown(state, &rooms, &media).await).await?;
    entries.push(Entry {
        name: "README.md".to_string(),
        source: readme,
        compress: true,
    });

    // The files themselves. On the local backend this hands back the object's
    // own path and copies nothing; on S3 it downloads into scratch, because
    // there is no other way to get bytes out of a bucket.
    let files = scratch.join("media");
    tokio::fs::create_dir_all(&files).await?;
    let count = media.len().max(1) as f64;
    for (done, item) in media.iter().enumerate() {
        let Some(name) = names.get(&item.object_key) else {
            continue;
        };
        match localize(state, &item.object_key, &item.filename, &item.mime, &files).await {
            Ok(Some(source)) => entries.push(Entry {
                name: format!("media/{name}"),
                source,
                compress: false,
            }),
            // A row whose bytes are gone is a real state — the sweeper deletes
            // bytes before rows — and it must not cost somebody their whole
            // archive. `media.md` still lists it.
            Ok(None) => tracing::warn!(key = %item.object_key, "export: object is missing"),
            Err(err) => {
                tracing::warn!(key = %item.object_key, error = %err, "export: could not read object")
            }
        }
        set_progress(state, id, 0.6 + 0.3 * (done + 1) as f64 / count).await;
    }

    Ok(entries)
}

/// Get one stored object onto this machine's disk.
///
/// The local backend already has it there and the path is handed straight back.
/// S3 answers with a presigned URL, so those bytes are fetched into `scratch`.
async fn localize(
    state: &AppState,
    key: &str,
    filename: &str,
    mime: &str,
    scratch: &Path,
) -> anyhow::Result<Option<PathBuf>> {
    let serve = ServeAs::for_object(mime, filename);
    let Some(body) = state.storage.read_object(key, &serve).await? else {
        return Ok(None);
    };
    match body {
        crate::storage::ObjectBody::File(path, _) => Ok(Some(path)),
        crate::storage::ObjectBody::Redirect(url) => {
            let target = scratch.join(key.replace('/', "_"));
            let mut file = tokio::fs::File::create(&target).await?;
            let mut response = reqwest::get(&url).await?.error_for_status()?;
            while let Some(chunk) = response.chunk().await? {
                tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
            }
            tokio::io::AsyncWriteExt::flush(&mut file).await?;
            Ok(Some(target))
        }
    }
}

/// One media item, with the storage key the wire type deliberately does not
/// carry.
///
/// `media.md` names the room and the moment rather than linking to a message:
/// markdown has no portable anchor to link *to*, and a link that does not work
/// is worse than the two facts that find it by hand.
struct MediaRow {
    object_key: String,
    filename: String,
    mime: String,
    size_bytes: i64,
    uploader_id: UserId,
    room_id: Option<RoomId>,
    starred: bool,
    created_at: i64,
}

/// Every file in the archive.
///
/// The `LEFT JOIN` is what makes the visibility condition subtle: an attachment
/// with no message is an upload nobody posted, and it is in no room at all —
/// so a plain room check would silently drop every unposted file from every
/// archive. It belongs to whoever uploaded it, and to nobody else: before this
/// it went into *everybody's* archive, which meant a file somebody had picked
/// out to send in a DM and not yet sent was already in the next export anybody
/// asked for.
async fn media_rows(state: &AppState, asker: UserId) -> anyhow::Result<Vec<MediaRow>> {
    let rows = sqlx::query(&format!(
        "SELECT a.object_key, a.filename, a.mime, a.size_bytes, a.uploader_id,
                a.starred_at, a.created_at, a.message_id, m.room_id
         FROM attachments a
         LEFT JOIN messages m ON m.id = a.message_id
         WHERE a.state = 'complete'
           AND (
             (a.message_id IS NULL AND a.uploader_id = ?)
             OR {visible}
           )
         ORDER BY a.created_at, a.id",
        visible = crate::repo::rooms::visible_rooms("m"),
    ))
    .bind(asker.to_vec())
    .bind(asker.to_vec())
    .fetch_all(&state.db.read)
    .await?;

    rows.iter()
        .map(|row| {
            Ok(MediaRow {
                object_key: row.get("object_key"),
                filename: row.get("filename"),
                mime: row.get("mime"),
                size_bytes: row.get("size_bytes"),
                uploader_id: UserId::from_slice(&row.get::<Vec<u8>, _>("uploader_id"))?,
                room_id: row
                    .get::<Option<Vec<u8>>, _>("room_id")
                    .map(|b| RoomId::from_slice(&b))
                    .transpose()?,
                starred: row.get::<Option<i64>, _>("starred_at").is_some(),
                created_at: row.get("created_at"),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/// One room, in the order it happened.
///
/// Walks forward in batches rather than loading the room, because "every
/// What a DM is called inside an archive (SPEC §4.13).
///
/// A DM's `slug` is generated and means nothing, so an archive that used it
/// would hold `direct/dm-01a058c3….md` — which satisfies "the export contains
/// your DMs" and fails the point of one. The whole promise is that the archive
/// opens in a text editor and needs nothing from Linger, and a filename nobody
/// can read is a file nobody opens.
///
/// Usernames rather than display names: a username is `[a-z0-9_]` by
/// definition (PROTOCOL §2), so it is already a safe filename, and it is the
/// one name a person cannot change out from under an old archive.
fn dm_slug(room: &Room, users: &HashMap<UserId, User>, asker: UserId) -> String {
    let mut names: Vec<String> = room
        .member_ids
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|id| *id != asker)
        .map(|id| {
            users
                .get(&id)
                .map_or_else(|| "gone".to_string(), |u| u.username.clone())
        })
        .collect();
    names.sort();
    if names.is_empty() {
        // Everybody else has left the server. The conversation is still yours.
        return "just-you".to_string();
    }
    names.join("-")
}

/// How a conversation is titled in the archive and its index: `#garage` for a
/// room, and who it is with for a DM.
fn conversation_title(room: &Room, users: &HashMap<UserId, User>, asker: UserId) -> String {
    if room.kind == RoomKind::Dm {
        let names: Vec<&str> = room
            .member_ids
            .clone()
            .unwrap_or_default()
            .iter()
            .filter(|id| **id != asker)
            .filter_map(|id| users.get(id).map(|u| u.display_name.as_str()))
            .collect();
        if names.is_empty() {
            "a direct message".to_string()
        } else {
            format!("direct message with {}", names.join(", "))
        }
    } else {
        format!("#{}", room.slug)
    }
}

/// message" includes the room with four years in it.
async fn room_markdown(
    state: &AppState,
    room: &Room,
    users: &HashMap<UserId, User>,
    names: &HashMap<String, String>,
    asker: UserId,
) -> Result<String, ApiError> {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", conversation_title(room, users, asker)));
    if room.kind != RoomKind::Dm && room.name != room.slug {
        out.push_str(&format!("**{}**\n\n", room.name));
    }
    if let Some(topic) = &room.topic {
        if !topic.trim().is_empty() {
            out.push_str(&format!("*{}*\n\n", topic.trim()));
        }
    }
    if room.archived_at.is_some() {
        out.push_str("*This room was archived.*\n\n");
    }
    out.push_str("*Times are UTC.*\n");

    let mut after: Option<MessageId> = None;
    let mut day: Option<(i64, u32, u32)> = None;
    let mut wrote_any = false;
    // What each message said, in a few words, so a reply can quote the thing it
    // is answering. A reply pointing at nothing is the least readable part of a
    // transcript, and this is the whole cost of fixing it: a short string per
    // message, in a room this loop is already walking.
    let mut said: HashMap<MessageId, String> = HashMap::new();

    loop {
        let batch = crate::repo::messages::batch_ascending(
            &state.db.read,
            &state.config,
            room.id,
            after,
            BATCH,
        )
        .await?;
        if batch.is_empty() {
            break;
        }
        after = batch.last().map(|m| m.id);

        for message in &batch {
            // A deleted message is a tombstone with an empty body. Somebody
            // deleted it; an archive that resurrects it would be a worse
            // product than one that leaves it out.
            if message.deleted_at.is_some() {
                continue;
            }
            let today = civil_date(message.created_at);
            if day != Some(today) {
                let (y, m, d) = today;
                out.push_str(&format!("\n---\n\n## {y:04}-{m:02}-{d:02}\n\n"));
                day = Some(today);
            }
            out.push_str(&message_markdown(message, users, names, &said));
            said.insert(message.id, excerpt(message, users));
            wrote_any = true;
        }
    }

    if !wrote_any {
        out.push_str("\nNothing was ever said in this room.\n");
    }
    Ok(out)
}

/// One message: who, when, what, and what came with it.
fn message_markdown(
    message: &Message,
    users: &HashMap<UserId, User>,
    names: &HashMap<String, String>,
    said: &HashMap<MessageId, String>,
) -> String {
    let mut out = String::new();
    let who = users.get(&message.author_id).map_or_else(
        || "somebody who is gone".to_string(),
        |u| format!("{} (@{})", u.display_name, u.username),
    );
    let edited = if message.edited_at.is_some() {
        " *(edited)*"
    } else {
        ""
    };
    out.push_str(&format!(
        "**{}** — {}{}\n",
        clock(message.created_at),
        who,
        edited
    ));

    if let Some(replied_to) = message.reply_to {
        match said.get(&replied_to) {
            // A blockquote, which is what a reply looks like everywhere else.
            Some(quoted) => out.push_str(&format!("> ↩ {quoted}\n")),
            // The message it answered was deleted, or came before this room's
            // first batch. Say that rather than quoting nothing.
            None => out.push_str("> ↩ *a message that is no longer here*\n"),
        }
    }

    let body = message.body.trim();
    if body.is_empty() {
        out.push_str("\n*(no words)*\n");
    } else {
        out.push('\n');
        // Indent nothing and escape nothing: the body is already markdown, it
        // is what the person typed, and an archive should read the way the room
        // read.
        out.push_str(body);
        out.push('\n');
    }

    for attachment in &message.attachments {
        let file = names
            .get(&object_key_of(attachment))
            .cloned()
            .unwrap_or_else(|| attachment.filename.clone());
        out.push_str(&format!(
            "\n[{}](../media/{})\n",
            attachment.filename,
            link_target(&file)
        ));
    }

    if !message.reactions.is_empty() {
        let summary: Vec<String> = message
            .reactions
            .iter()
            .map(|group| format!("{} {}", group.key, group.count))
            .collect();
        out.push_str(&format!("\n`{}`\n", summary.join("  ")));
    }

    out.push('\n');
    out
}

/// A message in a few words, for the reply above it to quote.
fn excerpt(message: &Message, users: &HashMap<UserId, User>) -> String {
    let who = users
        .get(&message.author_id)
        .map_or("somebody who is gone", |u| u.display_name.as_str());
    let body: String = message
        .body
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let short: String = body.chars().take(60).collect();
    let short = if short.chars().count() < body.chars().count() {
        format!("{short}…")
    } else {
        short
    };
    if short.is_empty() {
        format!("**{who}**")
    } else {
        format!("**{who}**: {short}")
    }
}

/// The storage key behind a wire attachment.
///
/// `wire::Attachment` carries a URL and not a key, on purpose — object keys are
/// the server's business (PROTOCOL §6). The URL ends in the key, which is the
/// one place the two meet.
fn object_key_of(attachment: &linger_core::wire::Attachment) -> String {
    attachment
        .url
        .split("/objects/")
        .nth(1)
        .unwrap_or_default()
        .to_string()
}

/// The media index: every file, who shared it, when, and where it came from.
fn media_markdown(
    media: &[MediaRow],
    users: &HashMap<UserId, User>,
    names: &HashMap<String, String>,
    rooms: &[Room],
    asker: UserId,
) -> String {
    let rooms: HashMap<RoomId, &Room> = rooms.iter().map(|room| (room.id, room)).collect();
    let mut out = String::from("# Media\n\nEverything ever shared here. Times are UTC.\n\n");
    if media.is_empty() {
        out.push_str("Nothing has been shared yet.\n");
        return out;
    }
    out.push_str("| File | Shared by | When | Room | Size | |\n");
    out.push_str("|---|---|---|---|---|---|\n");
    for item in media {
        let name = names
            .get(&item.object_key)
            .cloned()
            .unwrap_or_else(|| item.filename.clone());
        let who = users
            .get(&item.uploader_id)
            .map_or("somebody who is gone", |u| u.display_name.as_str());
        let room = item.room_id.and_then(|id| rooms.get(&id)).map_or_else(
            || "—".to_string(),
            |room| conversation_title(room, users, asker),
        );
        let (y, m, d) = civil_date(item.created_at);
        out.push_str(&format!(
            "| [{}](media/{}) | {} | {y:04}-{m:02}-{d:02} {} | {} | {} | {} |\n",
            escape_cell(&item.filename),
            link_target(&name),
            escape_cell(who),
            clock(item.created_at),
            room,
            human_size(item.size_bytes),
            if item.starred { "★" } else { "" }
        ));
    }
    out
}

/// The first thing anybody opens.
async fn readme_markdown(state: &AppState, rooms: &[Room], media: &[MediaRow]) -> String {
    let name = server_name(state)
        .await
        .unwrap_or_else(|| "a Linger server".to_string());
    let (y, m, d) = civil_date(now_ms());
    let bytes: i64 = media.iter().map(|item| item.size_bytes).sum();

    format!(
        "# {name}\n\n\
         Everything on this server, exported on {y:04}-{m:02}-{d:02}. Times \
         throughout are UTC.\n\n\
         ## What is in here\n\n\
         - `rooms/` — one file per room, in the order things were said. \
         {} room{}.\n\
         - `media/` — every file anybody shared. {} file{}, {}.\n\
         - `media.md` — an index of those files: who shared each one, when, and \
         in which room.\n\n\
         ## Reading it\n\n\
         These are plain markdown and plain files. Any text editor opens the \
         rooms; anything at all opens the media. You do not need Linger, or an \
         account, or this server to still exist.\n\n\
         Deleted messages are not here. Somebody deleted them.\n",
        rooms.len(),
        if rooms.len() == 1 { "" } else { "s" },
        media.len(),
        if media.len() == 1 { "" } else { "s" },
        human_size(bytes),
    )
}

// ---------------------------------------------------------------------------
// The zip
// ---------------------------------------------------------------------------

/// Write the archive. Synchronous, and called from `spawn_blocking`.
fn write_zip(target: &Path, root: &str, entries: &[Entry]) -> anyhow::Result<()> {
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let file = std::fs::File::create(target)?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(file));

    for entry in entries {
        let options = SimpleFileOptions::default()
            .compression_method(if entry.compress {
                CompressionMethod::Deflated
            } else {
                // Media is already compressed. Deflating a JPEG spends the CPU
                // of the whole export to save a fraction of a percent.
                CompressionMethod::Stored
            })
            // An archive of a server with a lot of video is over 4 GB, which is
            // where zip needs its 64-bit fields.
            .large_file(true);
        zip.start_file(format!("{root}/{}", entry.name), options)?;

        let mut source = std::fs::File::open(&entry.source)?;
        std::io::copy(&mut source, &mut zip)?;
    }

    zip.finish()?.flush()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Small things
// ---------------------------------------------------------------------------

/// A filename that is safe inside an archive and still recognisable outside it.
///
/// Uploaded filenames are somebody else's text, so this is also the zip-slip
/// guard: no directories, no `..`, nothing that can climb out of `media/` when
/// an unzipper puts it back on a disk.
fn archive_filename(raw: &str, taken: &mut HashSet<String>) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    let cleaned = if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    };

    if taken.insert(cleaned.clone()) {
        return cleaned;
    }
    // Two people shared `IMG_0001.jpg`. Both keep their name.
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (cleaned.clone(), String::new()),
    };
    for n in 2..10_000 {
        let candidate = format!("{stem} ({n}){ext}");
        if taken.insert(candidate.clone()) {
            return candidate;
        }
    }
    cleaned
}

/// A filename inside a markdown link. Spaces and brackets end a link early.
fn link_target(name: &str) -> String {
    name.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}

/// A table cell that cannot break the table.
fn escape_cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

fn human_size(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    #[allow(clippy::cast_precision_loss)]
    let mut size = bytes.max(0) as f64;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{} B", bytes.max(0))
    } else {
        format!("{size:.1} {}", UNITS[unit])
    }
}

/// `HH:MM`, UTC.
fn clock(unix_ms: i64) -> String {
    let secs = unix_ms.div_euclid(1000);
    let day_secs = secs.rem_euclid(86_400);
    format!("{:02}:{:02}", day_secs / 3600, (day_secs % 3600) / 60)
}

/// Unix milliseconds to a UTC calendar date.
///
/// Written out rather than pulled in: one date format in one file does not
/// justify a date library, and the algorithm (Howard Hinnant's `civil_from_days`)
/// is short enough to read and test. UTC only — the server does not know what
/// timezone a reader is in, and the archive says which one it used.
fn civil_date(unix_ms: i64) -> (i64, u32, u32) {
    let days = unix_ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Uploaded filenames are somebody else's text, and this is the guard that
    /// stops one climbing out of `media/` when an archive is unzipped.
    #[test]
    fn a_filename_cannot_climb_out_of_the_archive() {
        let mut taken = HashSet::new();
        for hostile in [
            "../../etc/passwd",
            "..\\..\\windows\\system32\\config",
            "/etc/shadow",
            "..",
            "...",
            "",
            "   ",
        ] {
            let safe = archive_filename(hostile, &mut taken);
            assert!(!safe.contains('/'), "{hostile:?} became {safe:?}");
            assert!(!safe.contains('\\'), "{hostile:?} became {safe:?}");
            assert!(!safe.starts_with('.'), "{hostile:?} became {safe:?}");
            assert!(!safe.is_empty(), "{hostile:?} became empty");
        }
    }

    #[test]
    fn two_people_who_shared_img_0001_both_keep_their_file() {
        let mut taken = HashSet::new();
        assert_eq!(archive_filename("IMG_0001.jpg", &mut taken), "IMG_0001.jpg");
        assert_eq!(
            archive_filename("IMG_0001.jpg", &mut taken),
            "IMG_0001 (2).jpg"
        );
        assert_eq!(
            archive_filename("IMG_0001.jpg", &mut taken),
            "IMG_0001 (3).jpg"
        );
        // An ordinary name is left exactly as it was.
        assert_eq!(
            archive_filename("holiday photo.png", &mut taken),
            "holiday photo.png"
        );
    }

    #[test]
    fn dates_are_utc_and_survive_the_awkward_ones() {
        assert_eq!(civil_date(0), (1970, 1, 1));
        // A leap day, and the day after it.
        assert_eq!(civil_date(1_709_164_800_000), (2024, 2, 29));
        assert_eq!(civil_date(1_709_251_200_000), (2024, 3, 1));
        // 2000 is a leap year and 1900 was not; the century rule is where a
        // hand-written date function usually goes wrong.
        assert_eq!(civil_date(951_782_400_000), (2000, 2, 29));
        assert_eq!(civil_date(-2_208_988_800_000), (1900, 1, 1));
    }

    #[test]
    fn clocks_read_in_utc_and_do_not_wrap_backwards() {
        assert_eq!(clock(0), "00:00");
        assert_eq!(clock(3_600_000 + 120_000), "01:02");
        assert_eq!(clock(86_399_000), "23:59");
        // Before the epoch still reads as a time of day rather than as a
        // negative number of hours.
        assert_eq!(clock(-1_000), "23:59");
    }

    #[test]
    fn sizes_read_the_way_a_person_says_them() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(999), "999 B");
        assert_eq!(human_size(1024), "1.0 KB");
        assert_eq!(human_size(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn a_table_cell_cannot_break_the_table() {
        assert_eq!(escape_cell("a|b"), "a\\|b");
        assert_eq!(escape_cell("two\nlines"), "two lines");
    }

    #[test]
    fn an_export_key_is_never_mistaken_for_an_attachment() {
        let key = object_key(ExportId::new());
        assert!(key.starts_with("exports/"));
        assert!(key.ends_with(".zip"));
        // `key_owner` is what decides whether a key belongs to an attachment.
        assert_eq!(crate::storage::key_owner(&key), None);
    }
}
