//! The phones that asked for notifications, and what each wants to hear
//! about (SPEC §4.15, PROTOCOL §5, #830).
//!
//! One row per sign-in (`refresh_tokens.family_id`), so a phone is gone the
//! moment the sign-in that registered it ends: signing out, a new password,
//! removal, the relay saying the phone's address is dead, or thirty days
//! without opening the app. Every read that picks phones to notify also
//! checks that sign-in is still live, so one that ended between those
//! moments and the cleanup is never sent anything.

use linger_core::wire::{PushDevice, PushRoom, PushRoomChoice, PushSettings};
use linger_core::{MessageId, PushDeviceId, RoomId, UserId};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::ApiError;

/// The live sign-in a refresh token belongs to, if it is this person's: the
/// family it was issued in, which rotating it keeps (`auth.rs`).
pub async fn live_family(
    db: &SqlitePool,
    user_id: UserId,
    refresh_token: &str,
    now: i64,
) -> Result<Option<Vec<u8>>, ApiError> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT family_id FROM refresh_tokens
         WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(crate::auth::token_hash(refresh_token))
    .bind(user_id.to_vec())
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(family,)| family))
}

/// What a phone gave the server to encrypt to and send through.
pub struct Keys<'a> {
    pub sealed_token: &'a str,
    pub public_key: &'a [u8],
    pub auth_secret: &'a [u8; 16],
}

/// Register this sign-in's phone, or replace what it registered before: one
/// phone per sign-in, keeping its id, so a phone asking again (new keys, a
/// reinstall that kept the sign-in) never leaves a second copy behind.
pub async fn register(
    conn: &mut SqliteConnection,
    user_id: UserId,
    family: &[u8],
    keys: &Keys<'_>,
    settings: &PushSettings,
    now: i64,
) -> Result<PushDeviceId, ApiError> {
    let fresh = PushDeviceId::new();
    // The `WHERE` can't refuse anything a caller of this sends, since the
    // family was checked to be this person's: it's here so that no mistake
    // elsewhere could hand one person's phone row to another.
    let id: Option<(Vec<u8>,)> = sqlx::query_as(
        "INSERT INTO push_devices (id, user_id, family_id, sealed_token, public_key, auth_secret,
                                   mentions, dms, knocks, follows, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (family_id) DO UPDATE SET
           sealed_token = excluded.sealed_token, public_key = excluded.public_key,
           auth_secret = excluded.auth_secret, mentions = excluded.mentions, dms = excluded.dms,
           knocks = excluded.knocks, follows = excluded.follows, updated_at = excluded.updated_at
         WHERE push_devices.user_id = excluded.user_id
         RETURNING id",
    )
    .bind(fresh.to_vec())
    .bind(user_id.to_vec())
    .bind(family)
    .bind(keys.sealed_token)
    .bind(keys.public_key)
    .bind(keys.auth_secret.as_slice())
    .bind(settings.mentions)
    .bind(settings.dms)
    .bind(settings.knocks)
    .bind(settings.follows)
    .bind(now)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((id,)) = id else {
        return Err(ApiError::conflict("That sign-in isn't yours."));
    };
    let id = PushDeviceId::from_slice(&id).map_err(anyhow::Error::from)?;
    replace_rooms(conn, id, &settings.rooms).await?;
    Ok(id)
}

/// The phone's rooms, as the settings now say. A room it already had keeps
/// when it was last told about it, so changing one room's choice doesn't
/// start every other room's quiet over.
async fn replace_rooms(
    conn: &mut SqliteConnection,
    id: PushDeviceId,
    rooms: &[PushRoom],
) -> Result<(), ApiError> {
    let kept: Vec<Vec<u8>> = rooms.iter().map(|room| room.room_id.to_vec()).collect();
    let rows = sqlx::query("SELECT room_id FROM push_rooms WHERE device_id = ?")
        .bind(id.to_vec())
        .fetch_all(&mut *conn)
        .await?;
    for row in rows {
        let room: Vec<u8> = row.try_get("room_id")?;
        if !kept.contains(&room) {
            sqlx::query("DELETE FROM push_rooms WHERE device_id = ? AND room_id = ?")
                .bind(id.to_vec())
                .bind(room)
                .execute(&mut *conn)
                .await?;
        }
    }
    for room in rooms {
        sqlx::query(
            "INSERT INTO push_rooms (device_id, room_id, choice) VALUES (?, ?, ?)
             ON CONFLICT (device_id, room_id) DO UPDATE SET choice = excluded.choice",
        )
        .bind(id.to_vec())
        .bind(room.room_id.to_vec())
        .bind(choice_text(room.choice))
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

fn choice_text(choice: PushRoomChoice) -> &'static str {
    match choice {
        PushRoomChoice::Wakes => "wakes",
        PushRoomChoice::Every => "every",
    }
}

fn choice_from(text: &str) -> Option<PushRoomChoice> {
    match text {
        "wakes" => Some(PushRoomChoice::Wakes),
        "every" => Some(PushRoomChoice::Every),
        _ => None,
    }
}

/// One of this person's phones, as they see it, or `None` when it isn't
/// theirs or isn't there.
pub async fn get(
    db: &SqlitePool,
    user_id: UserId,
    id: PushDeviceId,
) -> Result<Option<PushDevice>, ApiError> {
    let row = sqlx::query(
        "SELECT mentions, dms, knocks, follows FROM push_devices WHERE id = ? AND user_id = ?",
    )
    .bind(id.to_vec())
    .bind(user_id.to_vec())
    .fetch_optional(db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let rooms =
        sqlx::query("SELECT room_id, choice FROM push_rooms WHERE device_id = ? ORDER BY room_id")
            .bind(id.to_vec())
            .fetch_all(db)
            .await?
            .iter()
            .filter_map(|row| {
                let room: Vec<u8> = row.try_get("room_id").ok()?;
                let choice: String = row.try_get("choice").ok()?;
                Some(PushRoom {
                    room_id: RoomId::from_slice(&room).ok()?,
                    choice: choice_from(&choice)?,
                })
            })
            .collect();
    Ok(Some(PushDevice {
        id,
        settings: PushSettings {
            mentions: row.try_get("mentions")?,
            dms: row.try_get("dms")?,
            knocks: row.try_get("knocks")?,
            follows: row.try_get("follows")?,
            rooms,
        },
    }))
}

/// Change one of this person's phones: its switches, its sealed address,
/// or both. `false` when it isn't theirs or isn't there.
pub async fn update(
    conn: &mut SqliteConnection,
    user_id: UserId,
    id: PushDeviceId,
    sealed_token: Option<&str>,
    settings: Option<&PushSettings>,
    now: i64,
) -> Result<bool, ApiError> {
    let found = sqlx::query(
        "UPDATE push_devices SET updated_at = ?, sealed_token = COALESCE(?, sealed_token)
         WHERE id = ? AND user_id = ?",
    )
    .bind(now)
    .bind(sealed_token)
    .bind(id.to_vec())
    .bind(user_id.to_vec())
    .execute(&mut *conn)
    .await?
    .rows_affected()
        == 1;
    if !found {
        return Ok(false);
    }
    if let Some(settings) = settings {
        sqlx::query(
            "UPDATE push_devices SET mentions = ?, dms = ?, knocks = ?, follows = ? WHERE id = ?",
        )
        .bind(settings.mentions)
        .bind(settings.dms)
        .bind(settings.knocks)
        .bind(settings.follows)
        .bind(id.to_vec())
        .execute(&mut *conn)
        .await?;
        replace_rooms(conn, id, &settings.rooms).await?;
    }
    Ok(true)
}

/// Forget one of this person's phones: "Nothing" on that phone. `false`
/// when it isn't theirs or isn't there.
pub async fn delete(db: &SqlitePool, user_id: UserId, id: PushDeviceId) -> Result<bool, ApiError> {
    let gone = sqlx::query("DELETE FROM push_devices WHERE id = ? AND user_id = ?")
        .bind(id.to_vec())
        .bind(user_id.to_vec())
        .execute(db)
        .await?
        .rows_affected();
    Ok(gone == 1)
}

/// Forget a phone the relay says is gone: Apple or Google no longer know its
/// address, because the app was removed or the phone reset.
pub async fn forget(db: &SqlitePool, id: PushDeviceId) -> Result<(), ApiError> {
    sqlx::query("DELETE FROM push_devices WHERE id = ?")
        .bind(id.to_vec())
        .execute(db)
        .await?;
    Ok(())
}

/// Forget the phone of every sign-in that has ended: revoked, or past its
/// thirty days. Run with the other sweeps (`expiry.rs`); sending already
/// skips these, so this is about not keeping what isn't needed.
pub async fn forget_ended(db: &SqlitePool, now: i64) -> Result<u64, ApiError> {
    let gone = sqlx::query(
        "DELETE FROM push_devices WHERE NOT EXISTS (
           SELECT 1 FROM refresh_tokens t
           WHERE t.family_id = push_devices.family_id AND t.revoked_at IS NULL AND t.expires_at > ?)",
    )
    .bind(now)
    .execute(db)
    .await?
    .rows_affected();
    Ok(gone)
}

/// Forget every phone. A server whose host turned push off keeps nobody's
/// sealed address or keys (`LINGER_PUSH=off`).
pub async fn forget_all(db: &SqlitePool) -> Result<u64, ApiError> {
    Ok(sqlx::query("DELETE FROM push_devices")
        .execute(db)
        .await?
        .rows_affected())
}

/// A phone that may be told about something, with what it needs to be
/// encrypted to, sent to, and judged by.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: PushDeviceId,
    pub user_id: UserId,
    pub username: String,
    pub sealed_token: String,
    pub public_key: Vec<u8>,
    pub auth_secret: [u8; 16],
    pub mentions: bool,
    pub dms: bool,
    pub follows: bool,
    /// Its owner asked to hear when this author posts, here or everywhere.
    pub follows_author: bool,
    /// What it chose for this room, if anything.
    pub room: Option<PushRoomChoice>,
}

/// Every phone that may hear about a message by `author` in `room_id`:
/// somebody else's, on a live sign-in, whose owner can see the room (any
/// room, or a DM they're in), is still a member, and hasn't blocked the
/// author or been blocked by them. Which of them actually do is
/// `push::reason`'s call, from the switches this carries.
pub async fn for_message(
    db: &SqlitePool,
    author: UserId,
    room_id: RoomId,
    dm: bool,
    now: i64,
) -> Result<Vec<Candidate>, ApiError> {
    let rows = sqlx::query(
        "SELECT d.id, d.user_id, u.username, d.sealed_token, d.public_key, d.auth_secret,
                d.mentions, d.dms, d.follows, pr.choice,
                EXISTS (SELECT 1 FROM notify_rules n
                        WHERE n.user_id = d.user_id AND n.target_user_id = ?1
                          AND (n.room_id IS NULL OR n.room_id = ?2)) AS follows_author
         FROM push_devices d
         JOIN users u ON u.id = d.user_id AND u.deactivated_at IS NULL AND u.deleted_at IS NULL
         LEFT JOIN push_rooms pr ON pr.device_id = d.id AND pr.room_id = ?2
         WHERE d.user_id != ?1
           AND EXISTS (SELECT 1 FROM refresh_tokens t
                       WHERE t.family_id = d.family_id AND t.revoked_at IS NULL AND t.expires_at > ?3)
           AND NOT EXISTS (SELECT 1 FROM blocks b
                           WHERE (b.user_id = d.user_id AND b.blocked_id = ?1)
                              OR (b.user_id = ?1 AND b.blocked_id = d.user_id))
           AND (?4 = 0 OR EXISTS (SELECT 1 FROM room_members m
                                  WHERE m.room_id = ?2 AND m.user_id = d.user_id))",
    )
    .bind(author.to_vec())
    .bind(room_id.to_vec())
    .bind(now)
    .bind(dm)
    .fetch_all(db)
    .await?;
    rows.iter().map(candidate).collect()
}

/// The phones of the person being knocked on that hear knocks: live, and
/// with no block between the two of them.
pub async fn for_knock(
    db: &SqlitePool,
    from: UserId,
    to: UserId,
    now: i64,
) -> Result<Vec<Candidate>, ApiError> {
    let rows = sqlx::query(
        "SELECT d.id, d.user_id, u.username, d.sealed_token, d.public_key, d.auth_secret,
                d.mentions, d.dms, d.follows, NULL AS choice, 0 AS follows_author
         FROM push_devices d
         JOIN users u ON u.id = d.user_id AND u.deactivated_at IS NULL AND u.deleted_at IS NULL
         WHERE d.user_id = ?2 AND d.knocks = 1
           AND EXISTS (SELECT 1 FROM refresh_tokens t
                       WHERE t.family_id = d.family_id AND t.revoked_at IS NULL AND t.expires_at > ?3)
           AND NOT EXISTS (SELECT 1 FROM blocks b
                           WHERE (b.user_id = ?2 AND b.blocked_id = ?1)
                              OR (b.user_id = ?1 AND b.blocked_id = ?2))",
    )
    .bind(from.to_vec())
    .bind(to.to_vec())
    .bind(now)
    .fetch_all(db)
    .await?;
    rows.iter().map(candidate).collect()
}

fn candidate(row: &sqlx::sqlite::SqliteRow) -> Result<Candidate, ApiError> {
    let id: Vec<u8> = row.try_get("id")?;
    let user: Vec<u8> = row.try_get("user_id")?;
    let auth: Vec<u8> = row.try_get("auth_secret")?;
    let choice: Option<String> = row.try_get("choice")?;
    Ok(Candidate {
        id: PushDeviceId::from_slice(&id).map_err(anyhow::Error::from)?,
        user_id: UserId::from_slice(&user).map_err(anyhow::Error::from)?,
        username: row.try_get("username")?,
        sealed_token: row.try_get("sealed_token")?,
        public_key: row.try_get("public_key")?,
        auth_secret: auth
            .try_into()
            .map_err(|_| anyhow::anyhow!("a stored auth secret isn't 16 bytes"))?,
        mentions: row.try_get("mentions")?,
        dms: row.try_get("dms")?,
        follows: row.try_get("follows")?,
        follows_author: row.try_get("follows_author")?,
        room: choice.as_deref().and_then(choice_from),
    })
}

/// Claim "every message"'s turn for one phone in one room (#830): it takes
/// the turn, and is told, unless it was told about this room in the last
/// `quiet_ms` and hasn't read up to what it was told about since. One
/// statement on the writer, so two messages arriving together can't both
/// take it.
pub async fn claim_every(
    db: &SqlitePool,
    device: PushDeviceId,
    user_id: UserId,
    room_id: RoomId,
    message: MessageId,
    now: i64,
    quiet_ms: i64,
) -> Result<bool, ApiError> {
    let taken = sqlx::query(
        "UPDATE push_rooms SET notified_at = ?1, notified_id = ?2
         WHERE device_id = ?3 AND room_id = ?4 AND choice = 'every'
           AND (notified_at IS NULL OR notified_at <= ?1 - ?5
                OR notified_id <= (SELECT last_read_id FROM read_markers
                                   WHERE user_id = ?6 AND room_id = ?4))",
    )
    .bind(now)
    .bind(message.to_vec())
    .bind(device.to_vec())
    .bind(room_id.to_vec())
    .bind(quiet_ms)
    .bind(user_id.to_vec())
    .execute(db)
    .await?
    .rows_affected();
    Ok(taken == 1)
}

/// When the newest message before `message` in this room was posted, not
/// counting the lines the server writes that call nobody (a MOTD, a voice
/// join, a poll closing, somebody leaving, a screen share): what "when it
/// wakes up" measures the quiet by.
pub async fn previous_at(
    db: &SqlitePool,
    room_id: RoomId,
    message: MessageId,
) -> Result<Option<i64>, ApiError> {
    let at: Option<i64> = sqlx::query_scalar(
        "SELECT created_at FROM messages
         WHERE room_id = ? AND id < ?
           AND motd = 0 AND voice_join = 0 AND poll_closed IS NULL AND dm_left = 0
           AND screen_share = 0
         ORDER BY id DESC LIMIT 1",
    )
    .bind(room_id.to_vec())
    .bind(message.to_vec())
    .fetch_optional(db)
    .await?;
    Ok(at)
}
