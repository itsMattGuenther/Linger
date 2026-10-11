//! The media collection (SPEC §4.4, PROTOCOL §6).
//!
//! Everything shared on a server, in one list: uploads, links people typed, and
//! messages the room pinned. Three different rows in three different tables, so
//! this reads each source separately and merges them here rather than fighting
//! SQLite into a `UNION` of columns that do not line up.
//!
//! **Ordering.** Starred first (SPEC §4.4), then newest first. Only an upload
//! can be starred, so "starred first" means everything starred comes before
//! any link or pin.
//!
//! **Paging** is keyset, not offset: a grid that people scroll while other
//! people are posting must not skip an item because everything shifted by one.
//! The cursor is `<created_at>:<id hex>` — the timestamp first because it is
//! what the sort is on, the id after it to break ties between two things shared
//! in the same millisecond. A link item carries a third field, its position in
//! the message, so every item has a cursor of its own to use as a key; `before`
//! ignores it.
//!
//! **Ids are compared as the bytes they are stored as**, not as `hex(id)`.
//! Every id is 16 bytes, and hex strings of the same length sort the way the
//! bytes they spell do, so it is the same order either way — but only the
//! bytes can be read off an index, and sorting by `hex(id)` made SQLite sort
//! every file on the server to hand back one page (#518). A test below holds
//! the two orders to each other. The cursor on the wire is unchanged.
//!
//! **A message's links stay together.** Each source is limited by *group* — an
//! upload is a group of one, a message's links are a group of however many it
//! has — and the merge stops on a group boundary. Otherwise a page could end
//! halfway through a message's links and the next page's cursor would step over
//! the rest of them.

use linger_core::limits::{MAX_LINKS_PER_MESSAGE, MAX_MEDIA_EXCERPT_CHARS};
use linger_core::media;
use linger_core::wire::{LinkPreview, MediaItem, MediaKind};
use linger_core::{AttachmentId, MessageId, RoomId, UserId};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::config::Config;
use crate::error::ApiError;
use crate::links;

/// What `GET /media` was asked for, already validated.
#[derive(Debug, Clone)]
pub struct Query {
    /// Who is asking. **Not optional and not defaulted**, so a caller cannot
    /// build one of these without saying whose collection it is (SPEC §4.13) —
    /// which is why this struct no longer derives `Default`.
    pub viewer: UserId,
    pub kind: Option<MediaKind>,
    pub author: Option<UserId>,
    pub before: Option<Cursor>,
    /// Unix ms, inclusive.
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub limit: u32,
}

/// A decoded `before=` value.
#[derive(Debug, Clone)]
pub struct Cursor {
    pub created_at: i64,
    /// The id's 16 bytes, as stored, so SQL can compare and look it up as
    /// the column it is.
    pub id: [u8; 16],
}

impl Cursor {
    /// Cursors are handed out by this module and handed back verbatim, so a
    /// malformed one is a client bug rather than a request to interpret.
    pub fn parse(raw: &str) -> Result<Self, ApiError> {
        let mut parts = raw.split(':');
        let created_at = parts
            .next()
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(|| ApiError::validation("That's not a media cursor."))?;
        let mut id = [0u8; 16];
        parts
            .next()
            .and_then(|value| hex::decode_to_slice(value, &mut id).ok())
            .ok_or_else(|| ApiError::validation("That's not a media cursor."))?;
        Ok(Self { created_at, id })
    }
}

fn cursor_of(created_at: i64, id: &str) -> String {
    format!("{created_at}:{id}")
}

/// One page of the collection.
pub async fn page(
    db: &SqlitePool,
    config: &Config,
    query: &Query,
) -> Result<Vec<MediaItem>, ApiError> {
    // Where the cursor sits decides what the sources are allowed to return: an
    // unstarred cursor means everything starred is already behind us, so no
    // starred item may come back at all.
    let past_starred = match &query.before {
        None => false,
        Some(cursor) => !is_starred(db, cursor).await?,
    };

    let mut groups: Vec<Group> = Vec::new();
    if wants_attachments(query.kind) {
        groups.extend(attachment_groups(db, config, query, past_starred).await?);
    }
    if matches!(query.kind, None | Some(MediaKind::Link)) {
        groups.extend(link_groups(db, query).await?);
    }
    if matches!(query.kind, None | Some(MediaKind::Pin)) {
        groups.extend(pin_groups(db, query).await?);
    }

    // Starred first, then newest first, then by id so two things shared in the
    // same millisecond have a stable order.
    groups.sort_by(|a, b| {
        b.starred
            .cmp(&a.starred)
            .then(b.created_at.cmp(&a.created_at))
            .then(b.id.cmp(&a.id))
    });

    let mut items = Vec::new();
    for group in groups {
        if items.len() >= query.limit as usize {
            break;
        }
        items.extend(group.items);
    }
    Ok(items)
}

/// One thing that must not be split across a page boundary.
struct Group {
    starred: bool,
    created_at: i64,
    id: [u8; 16],
    items: Vec<MediaItem>,
}

fn wants_attachments(kind: Option<MediaKind>) -> bool {
    matches!(
        kind,
        None | Some(MediaKind::Image | MediaKind::Video | MediaKind::Audio | MediaKind::File)
    )
}

/// Whether the item a cursor points at is a starred upload. Anything that is
/// not an upload cannot be starred, so a miss is simply "no".
async fn is_starred(db: &SqlitePool, cursor: &Cursor) -> Result<bool, ApiError> {
    let found: Option<(Option<i64>,)> = sqlx::query_as(IS_STARRED_SQL)
        .bind(cursor.id.to_vec())
        .fetch_optional(db)
        .await?;
    Ok(matches!(found, Some((Some(_),))))
}

/// The id is bound as the 16 bytes it is stored as. Comparing `hex(id)` to a
/// string instead gives the same answer by reading every file's row (#518).
pub(crate) const IS_STARRED_SQL: &str = "SELECT starred_at FROM attachments WHERE id = ?";

/// `created_at`/`id` comparison against the cursor, as SQL. Three binds.
fn cursor_sql(table: &str) -> String {
    format!("({table}.created_at < ? OR ({table}.created_at = ? AND {table}.id < ?))")
}

fn mime_list(kind: MediaKind) -> Vec<&'static str> {
    match kind {
        MediaKind::Image => media::IMAGE_MIME.to_vec(),
        MediaKind::Video => media::VIDEO_MIME.to_vec(),
        MediaKind::Audio => media::AUDIO_MIME.to_vec(),
        MediaKind::File => media::FILE_MIME.to_vec(),
        // Neither is an upload type, and `wants_attachments` keeps them out.
        MediaKind::Link | MediaKind::Pin => Vec::new(),
    }
}

fn kind_of(mime: &str) -> MediaKind {
    match media::kind_of(mime) {
        "image" => MediaKind::Image,
        "video" => MediaKind::Video,
        "audio" => MediaKind::Audio,
        _ => MediaKind::File,
    }
}

fn excerpt(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(links::shorten(trimmed, MAX_MEDIA_EXCERPT_CHARS))
}

/// The uploads query for one page.
///
/// It reads files in the collection's own order (starred first, then newest)
/// off `idx_attachments_media_order` (migration 0017), and stops at the
/// page's limit, looking up each file's message as it goes. `CROSS JOIN` is SQLite's
/// way of saying "in this order": there are far fewer files than messages and
/// the order is the files', so starting from the messages means reading every
/// one of them to sort a year of files for one page, which is what happened
/// before #518.
pub(crate) fn attachment_sql(query: &Query, past_starred: bool) -> String {
    // An upload that is not on a message has not been shared with anybody yet,
    // and a message that was deleted took what it was carrying out of the room.
    let mut sql = format!(
        "SELECT a.*, m.room_id AS msg_room_id, m.body AS msg_body
         FROM attachments a CROSS JOIN messages m ON m.id = a.message_id
         WHERE a.state = 'complete' AND m.deleted_at IS NULL
           AND {visible}",
        visible = crate::repo::rooms::visible_rooms("m"),
    );
    if query.author.is_some() {
        sql.push_str(" AND a.uploader_id = ?");
    }
    if let Some(kind) = query.kind {
        let mimes = mime_list(kind);
        let placeholders = vec!["?"; mimes.len()].join(",");
        sql.push_str(&format!(" AND a.mime IN ({placeholders})"));
    }
    if query.since.is_some() {
        sql.push_str(" AND a.created_at >= ?");
    }
    if query.until.is_some() {
        sql.push_str(" AND a.created_at <= ?");
    }
    if query.before.is_some() {
        let compare = cursor_sql("a");
        if past_starred {
            sql.push_str(&format!(" AND a.starred_at IS NULL AND {compare}"));
        } else {
            // Still among the starred: step through the rest of them, and
            // everything unstarred is still ahead.
            sql.push_str(&format!(
                " AND ((a.starred_at IS NOT NULL AND {compare}) OR a.starred_at IS NULL)"
            ));
        }
    }
    sql.push_str(" ORDER BY (a.starred_at IS NOT NULL) DESC, a.created_at DESC, a.id DESC LIMIT ?");
    sql
}

async fn attachment_groups(
    db: &SqlitePool,
    config: &Config,
    query: &Query,
    past_starred: bool,
) -> Result<Vec<Group>, ApiError> {
    let sql = attachment_sql(query, past_starred);
    let mut request = sqlx::query(&sql);
    // The viewer is bound first because the clause is first. Every query in
    // this module puts it there, so there is one order to remember.
    request = request.bind(query.viewer.to_vec());
    if let Some(author) = query.author {
        request = request.bind(author.to_vec());
    }
    if let Some(kind) = query.kind {
        for mime in mime_list(kind) {
            request = request.bind(mime);
        }
    }
    if let Some(since) = query.since {
        request = request.bind(since);
    }
    if let Some(until) = query.until {
        request = request.bind(until);
    }
    if let Some(cursor) = &query.before {
        request = request
            .bind(cursor.created_at)
            .bind(cursor.created_at)
            .bind(cursor.id.to_vec());
    }
    request = request.bind(i64::from(query.limit));

    let rows = request.fetch_all(db).await?;
    rows.iter()
        .map(|row| attachment_group(row, config))
        .collect()
}

fn attachment_group(row: &SqliteRow, config: &Config) -> Result<Group, ApiError> {
    let attachment = crate::repo::attachments::row_to_attachment(row, config)?;
    let message_id =
        MessageId::from_slice(&row.get::<Vec<u8>, _>("message_id")).map_err(anyhow::Error::from)?;
    let room_id =
        RoomId::from_slice(&row.get::<Vec<u8>, _>("msg_room_id")).map_err(anyhow::Error::from)?;
    let body: String = row.get("msg_body");
    let id = *attachment.id.as_bytes();
    let item = MediaItem {
        kind: kind_of(&attachment.mime),
        cursor: cursor_of(attachment.created_at, &attachment.id.to_string()),
        author_id: attachment.uploader_id,
        created_at: attachment.created_at,
        message_id: Some(message_id),
        room_id: Some(room_id),
        starred_at: attachment.starred_at,
        excerpt: excerpt(&body),
        link: None,
        attachment: Some(attachment),
    };
    Ok(Group {
        starred: item.starred_at.is_some(),
        created_at: item.created_at,
        id,
        items: vec![item],
    })
}

/// The links query for one page.
///
/// The inner `SELECT` picks the messages this page covers; the outer one takes
/// every link on each of them. That is what keeps a message's links together
/// when the page ends. The inner one starts from the links (`CROSS JOIN`, as
/// in [`attachment_sql`]): about one message in a hundred has one, and
/// starting from the messages read all of them (#518).
pub(crate) fn link_sql(query: &Query) -> String {
    // First, so it is bound first — and inside `filters` rather than beside it,
    // because `filters` is what gets re-aliased into the inner query. A DM's
    // links have to be excluded from both halves or the outer query happily
    // draws links belonging to messages the inner one already refused.
    let mut filters = format!(
        "m.deleted_at IS NULL AND {}",
        crate::repo::rooms::visible_rooms("m")
    );
    if query.author.is_some() {
        filters.push_str(" AND m.author_id = ?");
    }
    if query.since.is_some() {
        filters.push_str(" AND m.created_at >= ?");
    }
    if query.until.is_some() {
        filters.push_str(" AND m.created_at <= ?");
    }
    if query.before.is_some() {
        filters.push_str(&format!(" AND {}", cursor_sql("m")));
    }

    format!(
        "SELECT l.url, l.position, m.id AS message_id, m.room_id, m.author_id, m.body,
                m.created_at, p.state AS preview_state, p.title, p.icon
         FROM message_links l
         JOIN messages m ON m.id = l.message_id
         LEFT JOIN link_previews p ON p.url = l.url
         WHERE {filters} AND m.id IN (
             SELECT m2.id FROM message_links l2 CROSS JOIN messages m2 ON m2.id = l2.message_id
             WHERE {inner}
             GROUP BY m2.id
             ORDER BY m2.created_at DESC, m2.id DESC
             LIMIT ?
         )
         ORDER BY m.created_at DESC, m.id DESC, l.position ASC",
        filters = filters,
        inner = filters.replace("m.", "m2."),
    )
}

/// Links, grouped by the message they were typed in.
async fn link_groups(db: &SqlitePool, query: &Query) -> Result<Vec<Group>, ApiError> {
    let sql = link_sql(query);
    let mut request = sqlx::query(&sql);
    // The filters appear twice — once outside, once in the subquery — so every
    // bind is made twice, in the same order.
    for _ in 0..2 {
        request = request.bind(query.viewer.to_vec());
        if let Some(author) = query.author {
            request = request.bind(author.to_vec());
        }
        if let Some(since) = query.since {
            request = request.bind(since);
        }
        if let Some(until) = query.until {
            request = request.bind(until);
        }
        if let Some(cursor) = &query.before {
            request = request
                .bind(cursor.created_at)
                .bind(cursor.created_at)
                .bind(cursor.id.to_vec());
        }
    }
    request = request.bind(i64::from(query.limit));

    let rows = request.fetch_all(db).await?;
    let mut groups: Vec<Group> = Vec::new();
    for row in &rows {
        let message_id = MessageId::from_slice(&row.get::<Vec<u8>, _>("message_id"))
            .map_err(anyhow::Error::from)?;
        let created_at: i64 = row.get("created_at");
        let url: String = row.get("url");
        let position: i64 = row.get("position");
        let title: Option<String> = row.get("title");
        let state: Option<String> = row.get("preview_state");
        let item = MediaItem {
            kind: MediaKind::Link,
            cursor: format!(
                "{}:{position}",
                cursor_of(created_at, &message_id.to_string())
            ),
            author_id: UserId::from_slice(&row.get::<Vec<u8>, _>("author_id"))
                .map_err(anyhow::Error::from)?,
            created_at,
            message_id: Some(message_id),
            room_id: Some(
                RoomId::from_slice(&row.get::<Vec<u8>, _>("room_id"))
                    .map_err(anyhow::Error::from)?,
            ),
            starred_at: None,
            excerpt: excerpt(&row.get::<String, _>("body")),
            attachment: None,
            link: Some(LinkPreview {
                domain: links::domain_of(&url),
                // A preview that was never fetched, or that failed, is a card
                // with a domain on it. Nothing is missing from the grid.
                title: if state.as_deref() == Some("ok") {
                    title
                } else {
                    None
                },
                icon: if state.as_deref() == Some("ok") {
                    row.get("icon")
                } else {
                    None
                },
                url,
            }),
        };
        match groups.last_mut() {
            Some(group)
                if group.items.first().and_then(|first| first.message_id) == Some(message_id) =>
            {
                group.items.push(item);
            }
            _ => groups.push(Group {
                starred: false,
                created_at,
                id: *message_id.as_bytes(),
                items: vec![item],
            }),
        }
    }
    // A message can only ever hold this many, and the extractor enforces it —
    // this is the belt to that braces, so one pathological row set cannot make
    // a page unbounded.
    for group in &mut groups {
        group.items.truncate(MAX_LINKS_PER_MESSAGE);
    }
    Ok(groups)
}

async fn pin_groups(db: &SqlitePool, query: &Query) -> Result<Vec<Group>, ApiError> {
    let mut sql = format!(
        "SELECT m.id, m.room_id, m.author_id, m.body, m.created_at
         FROM messages m
         WHERE m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
           AND {visible}",
        visible = crate::repo::rooms::visible_rooms("m"),
    );
    if query.author.is_some() {
        sql.push_str(" AND m.author_id = ?");
    }
    if query.since.is_some() {
        sql.push_str(" AND m.created_at >= ?");
    }
    if query.until.is_some() {
        sql.push_str(" AND m.created_at <= ?");
    }
    if query.before.is_some() {
        sql.push_str(&format!(" AND {}", cursor_sql("m")));
    }
    sql.push_str(" ORDER BY m.created_at DESC, m.id DESC LIMIT ?");

    let mut request = sqlx::query(&sql);
    request = request.bind(query.viewer.to_vec());
    if let Some(author) = query.author {
        request = request.bind(author.to_vec());
    }
    if let Some(since) = query.since {
        request = request.bind(since);
    }
    if let Some(until) = query.until {
        request = request.bind(until);
    }
    if let Some(cursor) = &query.before {
        request = request
            .bind(cursor.created_at)
            .bind(cursor.created_at)
            .bind(cursor.id.to_vec());
    }
    request = request.bind(i64::from(query.limit));

    let rows = request.fetch_all(db).await?;
    rows.iter()
        .map(|row| {
            let message_id =
                MessageId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?;
            let created_at: i64 = row.get("created_at");
            Ok(Group {
                starred: false,
                created_at,
                id: *message_id.as_bytes(),
                items: vec![MediaItem {
                    kind: MediaKind::Pin,
                    cursor: cursor_of(created_at, &message_id.to_string()),
                    author_id: UserId::from_slice(&row.get::<Vec<u8>, _>("author_id"))
                        .map_err(anyhow::Error::from)?,
                    created_at,
                    message_id: Some(message_id),
                    room_id: Some(
                        RoomId::from_slice(&row.get::<Vec<u8>, _>("room_id"))
                            .map_err(anyhow::Error::from)?,
                    ),
                    starred_at: None,
                    excerpt: excerpt(&row.get::<String, _>("body")),
                    attachment: None,
                    link: None,
                }],
            })
        })
        .collect()
}

/// Star or unstar an upload. Starred items sort first and never expire
/// (SPEC §4.4) — the expiry sweep that reads this arrives with T-505.
///
/// `viewer` is not a permission — anybody can star anything they can see, and
/// there is no per-person star. It is the visibility check: without it, a
/// stranger holding an attachment id could star a file from a DM they are not
/// in, and the answer (`true` or `false`) would tell them whether that id is
/// real. That is a smaller leak than reading the conversation and it is the
/// same leak, one bit at a time.
pub async fn set_star(
    db: &SqlitePool,
    id: AttachmentId,
    viewer: UserId,
    starred_at: Option<i64>,
) -> Result<bool, ApiError> {
    let result = sqlx::query(&format!(
        "UPDATE attachments SET starred_at = ?
         WHERE id = ? AND state = 'complete' AND message_id IS NOT NULL
           AND message_id IN (
             SELECT m.id FROM messages m WHERE {visible}
           )",
        visible = crate::repo::rooms::visible_rooms("m"),
    ))
    .bind(starred_at)
    .bind(id.to_vec())
    .bind(viewer.to_vec())
    .execute(db)
    .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_survives_the_round_trip() {
        let id = MessageId::new();
        let raw = cursor_of(1_724_000_000_000, &id.to_string());
        let parsed = Cursor::parse(&raw).unwrap();
        assert_eq!(parsed.created_at, 1_724_000_000_000);
        assert_eq!(&parsed.id, id.as_bytes());
    }

    #[test]
    fn a_link_cursor_carries_a_position_and_before_ignores_it() {
        let id = MessageId::new();
        let raw = format!("{}:2", cursor_of(17, &id.to_string()));
        let parsed = Cursor::parse(&raw).unwrap();
        assert_eq!(parsed.created_at, 17);
        assert_eq!(&parsed.id, id.as_bytes());
    }

    /// SQL orders and pages ids as the bytes they are stored as, where it used
    /// to use `hex(id)` (#518). Nobody can see the difference only if the two
    /// are the same order, which this holds them to: ids that differ in each
    /// byte position, at the digits where hex turns from `9` to `A`, a burst of
    /// real ones minted together, and random ones.
    #[tokio::test]
    async fn ids_sort_and_page_the_same_as_bytes_as_they_did_as_hex() {
        let db = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE t (id BLOB NOT NULL)")
            .execute(&db)
            .await
            .unwrap();
        let mut ids: Vec<[u8; 16]> = Vec::new();
        for position in 0..16 {
            for byte in [
                0x00, 0x09, 0x0a, 0x0f, 0x10, 0x90, 0x99, 0x9a, 0xa0, 0xa9, 0xf0, 0xff,
            ] {
                let mut id = [0x55; 16];
                id[position] = byte;
                ids.push(id);
            }
        }
        ids.extend((0..300).map(|_| *AttachmentId::new().as_bytes()));
        ids.extend((0..300).map(|_| rand::random::<[u8; 16]>()));
        ids.sort_unstable();
        ids.dedup();
        for id in &ids {
            sqlx::query("INSERT INTO t (id) VALUES (?)")
                .bind(id.to_vec())
                .execute(&db)
                .await
                .unwrap();
        }

        let column = |sql: &'static str| {
            let db = db.clone();
            async move {
                sqlx::query_scalar::<_, Vec<u8>>(sql)
                    .fetch_all(&db)
                    .await
                    .unwrap()
            }
        };
        let by_hex = column("SELECT id FROM t ORDER BY hex(id) DESC").await;
        let by_bytes = column("SELECT id FROM t ORDER BY id DESC").await;
        assert_eq!(by_hex, by_bytes, "SQLite orders hex and bytes differently");

        // `page` merges its three sources by the same ids, in Rust.
        let mut merged = ids.clone();
        merged.sort_by(|a, b| b.cmp(a));
        let merged: Vec<Vec<u8>> = merged.iter().map(|id| id.to_vec()).collect();
        assert_eq!(merged, by_bytes, "the merge orders ids differently");

        // And a cursor at any of them picks out the same rows either way.
        for id in ids.iter().step_by(7) {
            let (as_hex,): (i64,) = sqlx::query_as("SELECT count(*) FROM t WHERE hex(id) < ?")
                .bind(hex::encode_upper(id))
                .fetch_one(&db)
                .await
                .unwrap();
            let (as_bytes,): (i64,) = sqlx::query_as("SELECT count(*) FROM t WHERE id < ?")
                .bind(id.to_vec())
                .fetch_one(&db)
                .await
                .unwrap();
            assert_eq!(
                as_hex,
                as_bytes,
                "a cursor at {} pages differently",
                hex::encode(id)
            );
        }
    }

    #[test]
    fn nonsense_cursors_are_refused_rather_than_guessed_at() {
        for raw in ["", "abc", "17", "17:nothex", "17:beef"] {
            assert!(Cursor::parse(raw).is_err(), "{raw} should be refused");
        }
    }
}
