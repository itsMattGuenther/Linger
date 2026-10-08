//! REST wire types (PROTOCOL §§1–7). Timestamps are Unix milliseconds (i64).
//!
//! Everything here derives `ts_rs::TS` and is exported to `client/src/generated/`.
//! Optionality convention: protocol fields declared `T | null` are `Option<T>`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::id::{AttachmentId, EmojiId, ExportId, MessageId, ReportId, RoomId, UploadId, UserId};

// NOTE on 64-bit integers: ts-rs maps i64/u64 to `bigint`, but JSON.parse hands
// the frontend plain numbers. Every 64-bit value on this wire (Unix ms, byte
// sizes, sequence numbers) fits in the 2^53 safe-integer range, so such fields
// carry `#[ts(type = "number")]` (or `"number | null"`). Keep doing this for
// new fields — a stray `bigint` in the bindings is a defect.

// ---------------------------------------------------------------------------
// Errors (PROTOCOL §1)
// ---------------------------------------------------------------------------

/// Stable machine-readable error identifiers the client switches on.
/// Additive within v1: new codes may be appended, never removed or renamed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[ts(export)]
pub enum ErrorCode {
    Unauthenticated,
    Forbidden,
    NotFound,
    RateLimited,
    ValidationFailed,
    InviteInvalid,
    InviteExpired,
    QuotaExceeded,
    FileTooLarge,
    UnsupportedMedia,
    Conflict,
    Internal,
}

/// Body of every non-2xx response: `{ "error": { code, message, retry_after_ms } }`.
/// `message` is human-readable and safe to display — never leak internals into it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    #[ts(type = "number | null")]
    pub retry_after_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Styling (SPEC §4.5, PROTOCOL §5)
// ---------------------------------------------------------------------------

/// One of the 16 named palette keys in `crate::PALETTE`. The wire carries the
/// *name* (`"azure"`), never a color value — contrast safety is structural.
/// The server validates membership; client-side validation alone is a defect.
// Note: serde serializes single-field tuple structs as the inner value, so this
// travels as a bare string ("azure") with no attribute needed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ColorKey(pub String);

impl ColorKey {
    /// Membership check against the canonical palette.
    #[must_use]
    pub fn is_valid(&self) -> bool {
        crate::palette::is_valid_color_key(&self.0)
    }
}

/// A name fill: one palette color, or a gradient of any two. The gradient angle
/// is fixed at 92° and is deliberately not on the wire (SPEC §4.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export)]
pub enum Fill {
    Solid { color: ColorKey },
    Gradient { from: ColorKey, to: ColorKey },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum NameEffect {
    None,
    Shimmer,
    Glow,
}

/// How a user renders their own display name (and optionally their message font).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Style {
    /// Must be a member of `crate::FONTS`; server-validated.
    pub font_key: String,
    #[ts(type = "400 | 500 | 700")]
    pub weight: u16,
    pub italic: bool,
    pub fill: Fill,
    pub effect: NameEffect,
    /// Optional message-body font override from the same curated set. This is the
    /// *only* message styling that exists (SPEC §4.5) — no colors, no sizes.
    pub msg_font_key: Option<String>,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            font_key: "geist-sans".into(),
            weight: 500,
            italic: false,
            fill: Fill::Solid {
                color: ColorKey("slate".into()),
            },
            effect: NameEffect::None,
            msg_font_key: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Users and statuses (SPEC §4.6, PROTOCOL §5)
// ---------------------------------------------------------------------------

/// One of a status's short fields (SPEC §4.6, #270): a label the person chose,
/// from the app's suggestions or typed, and what they wrote beside it.
///
/// Both are checked by the server: the label is 1–24 characters and the value
/// 1–80, trimmed, with no control characters (`limits::MAX_STATUS_LABEL_CHARS`,
/// `MAX_STATUS_FIELD_CHARS`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StatusField {
    pub label: String,
    pub value: String,
}

/// The labels of the three fields a status had before labels were chosen
/// (#270), in the order a card shows them. A field whose label is exactly one
/// of these is also carried under its old key, so apps from before keep
/// reading and saving it (PROTOCOL §5).
pub const STATUS_LABEL_LISTENING: &str = "Listening to";
pub const STATUS_LABEL_READING: &str = "Reading";
pub const STATUS_LABEL_WORKING_ON: &str = "Working on";

/// A user's status: a small card, not a bio field. The away message supersedes
/// `line` when set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserStatus {
    pub line: Option<String>,
    /// The value of the field labelled exactly "Reading", for apps from
    /// before labelled fields (#270, PROTOCOL §5). Filled by the server.
    pub reading: Option<String>,
    /// The value of the field labelled exactly "Listening to" (#270).
    pub listening: Option<String>,
    /// The value of the field labelled exactly "Working on" (#270).
    pub working_on: Option<String>,
    /// Up to three labelled fields, in the order they show (SPEC §4.6, #270).
    ///
    /// A server that knows fields always sends a list, empty when there are
    /// none; an older server leaves it out. On the way in, a list is the whole
    /// set and `reading`, `listening` and `working_on` beside it are ignored.
    /// Null or missing is a save from an app that predates fields: the server
    /// applies its three classic values to the fields with those labels and
    /// keeps every other field (PROTOCOL §5).
    #[serde(default)]
    pub fields: Option<Vec<StatusField>>,
    /// Always null. A status has no picture any more (#269, PROTOCOL §5).
    ///
    /// Kept on the wire so an app from before the removal still reads and
    /// saves statuses: the server accepts an id here and ignores it, checking
    /// and storing nothing. Taking the field out is a later protocol change.
    pub image_id: Option<AttachmentId>,
    /// Always null, like `image_id` and for the same reason (#269).
    ///
    /// Server-owned like `away_since`: whatever a client sends is ignored.
    #[serde(default)]
    pub image_url: Option<String>,
    pub away_message: Option<String>,
    #[ts(type = "number | null")]
    pub away_since: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct User {
    pub id: UserId,
    pub username: String,
    pub display_name: String,
    pub is_host: bool,
    /// A co-host the host named (#424, PROTOCOL §5): everything the host can
    /// do in the app except make or clear co-hosts and act on the host.
    /// Never true for the host. A server from before co-hosts leaves it out,
    /// which reads as false.
    #[serde(default)]
    pub is_cohost: bool,
    pub style: Style,
    pub status: Option<UserStatus>,
    /// Bundled sound key, or object key for a custom upload.
    pub entrance_sound: Option<String>,
    #[ts(type = "number | null")]
    pub last_seen_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// Auth (PROTOCOL §2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RegisterRequest {
    pub invite_code: String,
    pub username: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    /// Access-token lifetime in seconds.
    #[ts(type = "number")]
    pub expires_in: u64,
    pub user: User,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RefreshRequest {
    pub refresh_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RefreshResponse {
    pub access_token: String,
    pub refresh_token: String,
    #[ts(type = "number")]
    pub expires_in: u64,
}

/// First-run setup (PROTOCOL §2.1): creates the host account and names the server.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetupRequest {
    pub token: String,
    pub server_name: String,
    pub username: String,
    pub display_name: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetupPreview {
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

/// `PATCH /me`: absent fields unchanged; `style`/`status` replace whole objects;
/// `entrance_sound: ""` clears the sound (PROTOCOL §5).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateMeRequest {
    pub display_name: Option<String>,
    pub style: Option<Style>,
    pub status: Option<UserStatus>,
    pub entrance_sound: Option<String>,
}

/// Unauthenticated invite preview (`GET /auth/invite/:code`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InvitePreview {
    pub valid: bool,
    pub server_name: Option<String>,
    #[ts(type = "number | null")]
    pub expires_at: Option<i64>,
}

// ---------------------------------------------------------------------------
// The server and its rooms (PROTOCOL §3)
// ---------------------------------------------------------------------------

/// `GET /health` (PROTOCOL §9): whether the server is up with its database
/// answering, and which release it runs. It needs no sign-in, so the app can
/// probe an address before anybody has an account, and it tells a host their
/// server is behind the newest release (#314). Every server since 0.2 answers
/// with exactly these two fields.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Health {
    pub ok: bool,
    /// The server's release, like `0.4.4`: the version its image was built as.
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerInfo {
    pub name: String,
    pub accent_key: Option<ColorKey>,
    pub icon_key: Option<String>,
    pub member_count: u32,
    #[ts(type = "number")]
    pub created_at: i64,
    /// Bytes of uploads this server is holding — everything stored plus
    /// everything mid-upload, because a slot already spoken for is not space
    /// anybody else can have. The status bar draws it (SPEC §5.6).
    #[ts(type = "number")]
    pub storage_used_bytes: u64,
    /// The ceiling those bytes are measured against (`LINGER_POOL_BYTES`).
    #[ts(type = "number")]
    pub storage_limit_bytes: u64,
    /// How many days a file stands before the server sweeps it, or `null` when
    /// this host turned expiry off. Starred and pinned files never expire, so
    /// this is the answer for everything else (SPEC §4.10).
    pub file_expiry_days: Option<u32>,
    /// Whether this server carries voice: its host set `LINGER_VOICE_ADDRESS`
    /// and voice goes through the server (#197). Without it nobody can join
    /// voice here, and the app says so before anybody tries (#306). Always
    /// sent; a server from before this field leaves it out, which the app
    /// reads as "maybe".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub voice: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateRoomRequest {
    pub slug: String,
    pub name: String,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateRoomRequest {
    pub name: Option<String>,
    pub topic: Option<String>,
    pub position: Option<i32>,
    /// A new message of the day, or `""` to clear it (#464). Left out, it stays
    /// as it is. Setting it also puts a line in the room (`Message::motd`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub motd: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateServerRequest {
    pub name: Option<String>,
    pub accent_key: Option<ColorKey>,
    pub icon_key: Option<String>,
}

/// A room, or a DM (SPEC §4.13).
///
/// One type rather than two, because a DM *is* a room in every way except who
/// it is fanned out to: same messages, same files, same reactions, same
/// presence. A second type would mean a second code path through every surface
/// that draws a conversation, and the second path is the one somebody forgets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum RoomKind {
    Room,
    Dm,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Room {
    pub id: RoomId,
    pub slug: String,
    pub name: String,
    pub topic: Option<String>,
    /// Which of the two this is. A client draws a `Dm` by who is in it, not by
    /// its `slug` or `name` — both are generated for a DM and mean nothing.
    pub kind: RoomKind,
    /// The people in a DM, and `None` for a room.
    ///
    /// `None` rather than "everybody, listed": a room's members are every
    /// account on the server, and putting that list here would be a copy of the
    /// roster that goes stale the moment somebody joins. The absence is the
    /// information.
    pub member_ids: Option<Vec<UserId>>,
    pub position: i32,
    #[ts(type = "number | null")]
    pub archived_at: Option<i64>,
    /// The client compares this to its read marker for the "left off here" line
    /// and the label-weight change. No count is ever computed server-side.
    ///
    /// A message-of-the-day line is never it (`Message::motd`): setting one
    /// doesn't make a room look new to anybody (#464).
    pub last_message_id: Option<MessageId>,
    /// The room's message of the day, when it has one (SPEC §4.1, #464).
    /// Left out when it has none, and by a server from before it, which a
    /// client reads the same way. A DM never has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub motd: Option<Motd>,
}

/// A room's message of the day (SPEC §4.1, #464): what's happening now, set by
/// the host or a co-host and shown whole under the room's header. It is not the
/// topic, which says what the room is about and rarely changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Motd {
    pub text: String,
    pub set_by: UserId,
    /// When it was set. A client keys "folded away on this device" by it, so
    /// a new message of the day opens again for everybody who folded the last.
    #[ts(type = "number")]
    pub set_at: i64,
}

/// Ask for a DM with these people (PROTOCOL §3.1).
///
/// `user_ids` is everybody *else*. The caller is always a member and never
/// names themselves — a request that did would have to decide what naming
/// yourself twice means, and there is no useful answer.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateDmRequest {
    pub user_ids: Vec<UserId>,
}

// ---------------------------------------------------------------------------
// Messages (PROTOCOL §4)
// ---------------------------------------------------------------------------

/// One reaction key's accumulation on a message. `count` exists for accessibility
/// labels and hover — the client renders *weight*, never the number (SPEC §4.8).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReactionGroup {
    pub key: String,
    pub count: u32,
    pub user_ids: Vec<UserId>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Message {
    pub id: MessageId,
    pub room_id: RoomId,
    pub author_id: UserId,
    /// Markdown source, unrendered. Empty string on tombstones.
    pub body: String,
    pub reply_to: Option<MessageId>,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<ReactionGroup>,
    #[ts(type = "number | null")]
    pub pinned_at: Option<i64>,
    #[ts(type = "number | null")]
    pub edited_at: Option<i64>,
    /// Tombstone marker: deleted messages are kept so reply chains survive.
    #[ts(type = "number | null")]
    pub deleted_at: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    /// `true` on the line the server writes when somebody sets the room's
    /// message of the day (#464), whose body is the message and whose author is
    /// who set it. Left out on every other message. An app that doesn't know
    /// the field shows it as an ordinary message from them.
    ///
    /// It never makes a room look new, never notifies, and can't be edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub motd: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateMessageRequest {
    pub body: String,
    pub reply_to: Option<MessageId>,
    pub attachment_ids: Option<Vec<AttachmentId>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EditMessageRequest {
    pub body: String,
}

/// `PUT /rooms/:id/read` body. There is no unread-count endpoint and one must
/// never be added (SPEC §4.2).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateReadMarkerRequest {
    pub last_read_id: MessageId,
}

/// `GET /read` response: room id → last read message id.
pub type ReadMap = HashMap<RoomId, MessageId>;

// ---------------------------------------------------------------------------
// Uploads and media (PROTOCOL §6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Attachment {
    pub id: AttachmentId,
    pub filename: String,
    pub mime: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Served from a separate origin (ARCHITECTURE §7) — uploads are hostile.
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    pub blurhash: Option<String>,
    pub poster_url: Option<String>,
    /// An image as it is drawn small, in a conversation or on a media tile
    /// (#382, PROTOCOL §6): a copy 960 px on its longest side, or `url`
    /// itself for a smaller image or an animated GIF. Absent for anything
    /// that isn't an image, from an older server, and for an image from
    /// before copies until the server has made its: draw `url`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_url: Option<String>,
    #[ts(type = "number | null")]
    pub starred_at: Option<i64>,
    pub uploader_id: UserId,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateUploadRequest {
    pub filename: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub mime: String,
}

/// One pre-signed part of a multipart upload.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UploadPart {
    pub number: u32,
    pub url: String,
}

/// Where and how the client PUTs bytes — directly to the object store, never
/// through the app server (ARCHITECTURE §8).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UploadSlot {
    pub upload_id: UploadId,
    pub attachment_id: AttachmentId,
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    #[ts(type = "number")]
    pub part_size_bytes: u64,
    pub parts: Option<Vec<UploadPart>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CompletedPart {
    pub number: u32,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CompleteUploadRequest {
    pub parts: Option<Vec<CompletedPart>>,
}

/// Which part of the media collection an item belongs to (SPEC §4.4).
///
/// The first four come from an upload's stored type (`media::kind_of`). The
/// last two are properties of a message rather than of a file: a `link` is a
/// URL somebody typed, a `pin` is a message the room decided to keep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MediaKind {
    Image,
    Video,
    Audio,
    File,
    Link,
    Pin,
}

/// The one line a link renders as (SPEC §5.6): favicon, title, domain. Not a
/// billboard, and never a remote fetch from the reader's machine — the server
/// fetches this once, for everybody, and `icon` arrives as a `data:` URI so
/// looking at a message cannot tell a website who read it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LinkPreview {
    pub url: String,
    /// Host, minus a leading `www.` — the third of the three things shown.
    pub domain: String,
    /// `None` when the fetch was refused, failed, or found no title. The card
    /// still draws: a domain on its own is an honest link card.
    pub title: Option<String>,
    /// A small `data:` URI, or `None`. Never a remote URL.
    pub icon: Option<String>,
}

/// What the media grid renders: one thing somebody shared, plus the moment it
/// came from, so every item links back to its message (SPEC §4.4).
///
/// Exactly one of `attachment` and `link` is set, decided by `kind`: a `pin`
/// carries neither and leans on `excerpt`. The flat shape is deliberate — the
/// grid sorts and filters over the fields every item has, and only reaches for
/// the payload once it knows which cell it is drawing.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MediaItem {
    pub kind: MediaKind,
    /// Paging cursor and React key: the attachment id for a file, the message
    /// id for a link or a pin. Opaque — hand it back as `before`.
    pub cursor: String,
    /// Who shared it. The uploader for a file, the message's author otherwise.
    pub author_id: UserId,
    #[ts(type = "number")]
    pub created_at: i64,
    pub message_id: Option<MessageId>,
    pub room_id: Option<RoomId>,
    /// Set iff `kind` is image | video | audio | file.
    pub attachment: Option<Attachment>,
    /// Set iff `kind` is link.
    pub link: Option<LinkPreview>,
    /// The message's text, shortened. Present for pins and links, and for a
    /// file posted with a caption.
    pub excerpt: Option<String>,
    /// Starred items sort first and never expire (SPEC §4.4). Only an
    /// attachment can be starred — a link or a pin has no object to keep.
    #[ts(type = "number | null")]
    pub starred_at: Option<i64>,
}

/// `POST /links/preview` body: the URLs a client is about to draw cards for.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LinkPreviewRequest {
    pub urls: Vec<String>,
}

// ---------------------------------------------------------------------------
// Search (SPEC §4.12, PROTOCOL §6)
// ---------------------------------------------------------------------------

/// One run of the snippet a hit shows, and whether it is what was searched for.
///
/// The snippet arrives already cut into pieces rather than as a string with
/// markers in it, because a marker is a character a message could contain. A
/// client draws the pieces in order and gives the matched ones whatever
/// emphasis the reader's presentation allows — there is nothing to parse and nothing
/// to escape.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SearchSnippetPart {
    pub text: String,
    pub matched: bool,
}

/// One message that matched (SPEC §4.12).
///
/// It is deliberately not a `Message`: a result list shows who, where, when and
/// a few words, and clicking one opens the room and goes to the message, which
/// is the moment the real thing is fetched. Sending the whole message here
/// would mean sending its attachments and reactions for every hit on a page
/// nobody has clicked yet.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SearchHit {
    pub message_id: MessageId,
    pub room_id: RoomId,
    pub author_id: UserId,
    #[ts(type = "number")]
    pub created_at: i64,
    /// Paging cursor: hand it back as `before`. Opaque — do not parse one,
    /// build one, or compare two.
    pub cursor: String,
    /// A few words either side of the match, in order. Empty for a message
    /// that matched only on the name of a file attached to it and said
    /// nothing, which is the one case where there is no text to show.
    pub snippet: Vec<SearchSnippetPart>,
    /// The filenames on the message, when the match was one of them. Lets a
    /// hit say *why* it is a hit when the words are not in the text.
    pub matched_filenames: Vec<String>,
}

// ---------------------------------------------------------------------------
// Presence (SPEC §4.3, PROTOCOL §8) — shared by REST `ready` and the gateway
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PresenceState {
    #[serde(rename = "in_room")]
    InRoom,
    Around,
    Idle,
    Away,
    Offline,
}

/// Where somebody is, and nothing about what they are doing.
///
/// There was an `activity` field here that carried a resolved foreground
/// application. It is gone (Matt, 2026-08-28 — `docs/decisions.md`): a status
/// is the place to say what you are doing, and it is the place because a person
/// chose to type it. Do not add this field back, and do not add one for a
/// window title — that was never in this type and never will be.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PresenceEntry {
    pub user_id: UserId,
    pub state: PresenceState,
    pub room_id: Option<RoomId>,
    pub away_message: Option<String>,
}

// ---------------------------------------------------------------------------
// Invites, notify rules, export (PROTOCOL §§5, 7)
// ---------------------------------------------------------------------------

/// A server's own emoji (SPEC §4.8, PROTOCOL §5 "Custom emoji", #359): a
/// picture the host or a co-host added, written `:name:` in a message and drawn
/// as the picture by every app on the server. The message keeps the text, so
/// search and export see `:name:`, and a removed emoji reads as its name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CustomEmoji {
    pub id: EmojiId,
    /// Between the colons: `[a-z0-9_]`, 2–32 characters, one per server.
    pub name: String,
    /// The picture, on the media origin like an attachment's (§6).
    pub url: String,
    pub animated: bool,
    pub created_by: UserId,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// `POST /emoji`: a finished upload of the caller's, not on a message, made
/// into an emoji called `name`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateEmojiRequest {
    pub name: String,
    pub attachment_id: AttachmentId,
}

/// `PATCH /emoji/:id`: a new name.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenameEmojiRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Invite {
    pub code: String,
    pub created_by: UserId,
    #[ts(type = "number | null")]
    pub expires_at: Option<i64>,
    pub max_uses: Option<u32>,
    pub uses: u32,
    #[ts(type = "number | null")]
    pub revoked_at: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateInviteRequest {
    pub expires_in_hours: Option<u32>,
    /// How many people can join with the invite. Left out, it is one: invites
    /// are single-use by default (ARCHITECTURE §7). `null` is no limit, which a
    /// host has to ask for. A number is that many.
    //
    // A plain `Option` reads a missing field and `null` as the same `None`,
    // which left no way to ask for no limit (#246). The outer `Option` is
    // whether the field was sent at all; the inner one is the limit.
    #[serde(
        default,
        deserialize_with = "sent",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub max_uses: Option<Option<u32>>,
}

/// Reads a field that was sent, `null` included, as `Some`. With
/// `#[serde(default)]`, a field that was not sent stays `None`.
fn sent<'de, D, T>(de: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(de).map(Some)
}

/// "Always notify me when [person] posts" — per person, per room (`room_id: None`
/// means all rooms). The notification setting people actually want (SPEC §4.2).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NotifyRule {
    pub target_user_id: UserId,
    pub room_id: Option<RoomId>,
}

// ---------------------------------------------------------------------------
// Report and block (SPEC §4.15, PROTOCOL §5, T-1605)
// ---------------------------------------------------------------------------

/// `POST /reports`: a message, or a person, for the host to look at. Exactly
/// one of `message_id` and `user_id`; a message names its author itself.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message_id: Option<MessageId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_id: Option<UserId>,
    /// For the host, up to `MAX_REPORT_NOTE_CHARS`. Blank is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// The message a report is about, as it was when it was reported: an edit or
/// a delete afterwards doesn't take away what the host was asked to see.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReportedMessage {
    pub id: MessageId,
    pub room_id: RoomId,
    /// Its words when it was reported.
    pub excerpt: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// One open report, as the host sees it (`GET /reports`). There is no count
/// of them anywhere (AGENTS rule 3).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Report {
    pub id: ReportId,
    pub reporter_id: UserId,
    /// Who it's about: the message's author, or the person named.
    pub user_id: UserId,
    pub message: Option<ReportedMessage>,
    pub note: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Export (SPEC §4.11, PROTOCOL §7)
// ---------------------------------------------------------------------------

/// Where an export has got to.
///
/// Building the archive is a background job, because a server with a year of
/// photos in it cannot answer inside one request. `queued` is the moment
/// between the row existing and the task picking it up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ExportState {
    Queued,
    Running,
    Complete,
    Failed,
}

/// The answer to `POST /export`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExportStarted {
    pub job_id: ExportId,
}

/// The answer to `GET /export/:job_id`.
///
/// `url` is on the media origin — the host uploads are served from — so an
/// archive is no more same-origin with the app than an upload is
/// (ARCHITECTURE §7). It appears only once there is something to download;
/// asking before then is not an error, it is `running`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExportJob {
    pub job_id: ExportId,
    pub state: ExportState,
    /// 0.0–1.0.
    pub progress: f32,
    pub url: Option<String>,
}

// ---------------------------------------------------------------------------
// Knock (SPEC §4.9, PROTOCOL §7)
// ---------------------------------------------------------------------------

/// The body of `POST /knock`: who you are nudging.
///
/// There is no message field and there is never going to be one. A knock that
/// carries words is a message, and a message is the thing SPEC §4.9 is trying
/// not to make you write.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct KnockRequest {
    pub target_user_id: UserId,
}

// ---------------------------------------------------------------------------
// Voice relay (SPEC §4.14, PROTOCOL §7, T-1403)
// ---------------------------------------------------------------------------

/// One STUN or TURN server a client should hand its peer connections.
///
/// The shape WebRTC's `RTCIceServer` has, and nothing more. `username` and
/// `credential` are set for TURN and absent for plain STUN; a TURN credential
/// is short-lived (see [`IceServers::ttl_secs`]) and computed, never stored,
/// so there is no account behind it to leak.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}

/// The answer to `GET /voice/ice`: what to put in a peer connection's ICE
/// configuration right now.
///
/// Empty when the host runs no relay. That is a real deployment — voice then
/// works between machines on one network and nowhere else — so the client
/// joins anyway rather than refusing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IceServers {
    pub servers: Vec<IceServer>,
    /// How long the TURN credentials in `servers` stay valid, in seconds.
    /// Zero when there are none. A client asks again on every join, so this
    /// only has to cover one call.
    pub ttl_secs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_envelope_matches_protocol_shape() {
        let env = ErrorEnvelope {
            error: ErrorBody {
                code: ErrorCode::InviteExpired,
                message: "That invite has expired.".into(),
                retry_after_ms: None,
            },
        };
        let json = serde_json::to_value(&env).unwrap();
        assert_eq!(json["error"]["code"], "INVITE_EXPIRED");
        assert!(json["error"]["retry_after_ms"].is_null());
    }

    #[test]
    fn fill_is_kind_tagged() {
        let solid: Fill = serde_json::from_str(r#"{"kind":"solid","color":"azure"}"#).unwrap();
        assert_eq!(
            solid,
            Fill::Solid {
                color: ColorKey("azure".into())
            }
        );

        let grad = Fill::Gradient {
            from: ColorKey("teal".into()),
            to: ColorKey("violet".into()),
        };
        let json = serde_json::to_value(&grad).unwrap();
        assert_eq!(json["kind"], "gradient");
        assert_eq!(json["from"], "teal");
    }

    #[test]
    fn default_style_is_valid_by_construction() {
        let style = Style::default();
        assert!(crate::is_valid_font_key(&style.font_key));
        if let Fill::Solid { color } = &style.fill {
            assert!(color.is_valid());
        } else {
            panic!("default fill must be solid");
        }
    }

    #[test]
    fn presence_states_serialize_lowercase() {
        assert_eq!(
            serde_json::to_string(&PresenceState::InRoom).unwrap(),
            "\"in_room\""
        );
        assert_eq!(
            serde_json::to_string(&PresenceState::Around).unwrap(),
            "\"around\""
        );
    }
}
