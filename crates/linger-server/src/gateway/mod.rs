//! The gateway (PROTOCOL §8): WS at `/api/v1/gateway`.
//!
//! Shape: one broadcast bus of [`Fanout`]s — an event plus who it is for; a
//! *session task* per session that assigns per-session sequence numbers, keeps
//! the 500-frame resume ring, and forwards to whichever socket is currently
//! attached. The session task outlives its socket by up to 120s
//! (`RESUME_WINDOW_MS`) so a reconnecting client can replay what it missed —
//! no gaps, no duplicates.
//!
//! Each event is turned into JSON once, however many sessions it reaches, and
//! that one string is what every session's ring holds (`frame`, #519).
//!
//! Presence lives in memory only, on purpose (ARCHITECTURE §5): restart ⇒
//! everyone offline until they reconnect.

mod frame;
mod screen_socket;
pub mod screens;
mod socket;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use dashmap::mapref::entry::{Entry, OccupiedEntry};
use dashmap::{DashMap, DashSet};
use linger_core::gateway::{
    ServerEvent, ServerFrame, VoiceControls, VoicePeer, VoiceRoomState, VoiceTrack,
};
use linger_core::limits::{MAX_VOICE_PEERS, RESUME_BUFFER_FRAMES, RESUME_WINDOW_MS};
use linger_core::wire::{PresenceEntry, PresenceState};
use linger_core::{RoomId, UserId};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::Instant;

use frame::EventJson;
pub use screen_socket::screen_route;
pub use socket::{tell_back_everywhere, ws_route};

/// Everything the fan-out layer holds. Lives in `AppState` as `Arc<Gateway>`;
/// REST handlers publish mutation events through [`Gateway::publish`].
pub struct Gateway {
    bus: broadcast::Sender<Arc<Fanout>>,
    sessions: DashMap<String, SessionHandle>,
    /// What everybody is told about where each person is: their sessions'
    /// own say (`session_presence`) merged into one (`merge`, #653). Only
    /// a person with a session open has an entry.
    presence: DashMap<UserId, PresenceEntry>,
    /// What each of a person's sessions says about where they are, by
    /// person and then by session (#653): a phone and a computer each speak
    /// for themselves, and neither overwrites the other.
    ///
    /// Every change to a person's presence takes their entry here first and
    /// holds it while `presence` is worked out again, so two of their
    /// devices speaking at once can't leave it merged from a mix of old and
    /// new. Nothing takes this while holding `presence` or `focus_told`.
    /// A person is offline once their last session's record goes.
    session_presence: DashMap<UserId, HashMap<String, SessionPresence>>,
    /// Numbers moves and aways as they happen, so `merge` can tell which
    /// session moved, or went away, most recently.
    presence_order: AtomicU64,
    /// Numbers each drop of a session's last socket as it happens (#654), so
    /// the end of one drop's grace period can't act on a later one.
    drops: AtomicU64,
    /// People whose newest `presence.update` is held back by `RATE_PRESENCE`
    /// until their turn (#497). One waiting task each, however many changes
    /// pile up behind it: the turn tells whatever is newest by then.
    presence_held: DashSet<UserId>,
    /// The room each person was last told to be in, by `room.leave` and
    /// `room.enter` (#527). Where somebody is changes in `presence` at once;
    /// telling everybody can wait for their turn under `RATE_ROOM_FOCUS`, and
    /// this is what the turn compares with. One entry per person who has
    /// moved since they connected, gone when their last connection closes.
    focus_told: DashMap<UserId, Option<RoomId>>,
    /// People whose move is held back by `RATE_ROOM_FOCUS` until their turn
    /// (#527), as `presence_held` is for presence.
    focus_held: DashSet<UserId>,
    /// Each session's newest `voice.join` or `voice.leave` held back by
    /// `RATE_VOICE_SEAT` until its turn (#527).
    voice_held: DashMap<String, HeldVoice>,
    /// Who is in each DM (SPEC §4.13). Public rooms are not in here — their
    /// members are everybody, and a room absent from this map is treated as
    /// public, which is the one place this design has to be careful.
    ///
    /// It is in memory because the fan-out is not async: presence and room
    /// focus are decided while a socket is being torn down, with no database
    /// handle and no place to await one. So it is loaded once at startup by
    /// [`Gateway::reload_dms`], and every path that can change a DM's
    /// membership updates it — creating a DM ([`Gateway::note_dm`]), removing
    /// or restoring a member (`reload_dms` again), and somebody leaving a
    /// group DM ([`Gateway::left_dm`], #565). There are exactly four, and
    /// there is no fifth, because nobody can be added to a DM once it is made
    /// (PROTOCOL §3.1).
    ///
    /// **The startup load is not allowed to fail quietly.** `main` refuses to
    /// start the server if it does, because the failure mode of an empty map is
    /// every DM on the server looking like a public room.
    dm_members: DashMap<RoomId, Arc<[UserId]>>,
    /// Which voice room each session is in, if any (SPEC §4.14).
    ///
    /// Keyed by session rather than by person: each client has its own
    /// connection to the forwarding server, and one person on a laptop and a
    /// desktop is two of them. In
    /// memory and nowhere else — voice is entirely a fact about who is
    /// connected right now, so a restart ending every call is correct rather
    /// than a gap, in the same way presence is (ARCHITECTURE §5).
    voice: DashMap<String, VoiceSeat>,
    /// Numbers each seat as it is taken, so a seat held now can be told apart
    /// from one the same session left and took again (#473).
    seats: AtomicU64,
    /// The voice forwarding server, when this server runs one (#197). Set
    /// once at startup by [`Gateway::start_forwarding`]. Without it this
    /// server carries no voice at all: the mesh it used to fall back on is
    /// gone (#306).
    forwarding: OnceLock<linger_sfu::Sfu>,
    /// Who shares a screen and who watches whom (#360, SPEC §4.20). Every
    /// share and watch lives inside a voice seat: leaving voice ends both.
    pub(crate) screens: screens::Screens,
    /// `LINGER_SCREENS` (#360): off, nobody shares and the app offers no Share.
    screens_allowed: std::sync::atomic::AtomicBool,
}

/// One session's own say in where its person is (#653). Somebody on a phone
/// and a computer has two, and what everybody is told is worked out from
/// both (`merge`).
#[derive(Debug, Clone)]
struct SessionPresence {
    /// The room this session has open, by its `room.focus`.
    room_id: Option<RoomId>,
    /// What its `presence.update`s say: `Around`, `Idle` or `Away`, and
    /// never anything else. Being in a room is `room_id`, and offline is
    /// having no session at all.
    state: PresenceState,
    /// Its away message, while `state` is `Away`.
    away_message: Option<String>,
    /// When it last moved rooms, from `Gateway::presence_order`: a larger
    /// number is later.
    moved_at: u64,
    /// When it last went away or changed its away message, the same way.
    away_at: u64,
    /// How many sockets it has open: one, but for the moment a resume takes
    /// it over while the server still holds the socket it replaces (#451).
    /// The record goes when the last of them closes with a goodbye, or when
    /// the grace period after it drops without one ends (#654).
    sockets: u32,
    /// Which drop's grace period it is in (#654), from `Gateway::drops`:
    /// its last socket went without a goodbye, and the record stays, counted
    /// as it was, until `grace_over` with this number. A resume in the
    /// meantime keeps it; only a later drop replaces it.
    dropped: Option<u64>,
    /// It resumed inside its grace period, and its app hasn't spoken since
    /// (#654). An app starts again from around in no room on every `resumed`
    /// and sends only where it differs (`client/src/lib/watchPresence.ts`),
    /// so what it said before the drop stands until it speaks
    /// (`speaks_again`) or the grace period ends, whichever is first.
    held_over: bool,
}

impl SessionPresence {
    /// A session as its first socket opens: around, in no room, as one
    /// person's first connection always was.
    fn arrived() -> Self {
        Self {
            room_id: None,
            state: PresenceState::Around,
            away_message: None,
            moved_at: 0,
            away_at: 0,
            sockets: 0,
            dropped: None,
            held_over: false,
        }
    }

    /// Its app speaks for it again after a resume (#654): from here it is
    /// what the app says, starting where the app starts, around and in no
    /// room. Answers whether it was held over until now.
    fn speaks_again(&mut self) -> bool {
        if !self.held_over {
            return false;
        }
        *self = Self {
            sockets: self.sockets,
            dropped: self.dropped,
            ..Self::arrived()
        };
        true
    }
}

/// What a change to one session did to what everybody is told about its
/// person (#653), which is how the change is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Merged {
    /// Nothing anybody is told changed: nobody hears anything.
    Same,
    /// Their presence changed, in the same room or none: a `presence.update`.
    Changed,
    /// The room they're in changed: told as a move (`tell_focus`), which
    /// ends with the `presence.update`.
    Moved,
}

/// What everybody is told about somebody, from what each of their sessions
/// says (#653). `None` when they have no session, which is offline.
///
/// The rules make several devices look like one, and one device leaves its
/// room before it goes away and holds away against every clock
/// (`client/src/lib/presence.ts`). In order:
/// 1. Away on any session is away, in no room, with the away message set
///    most recently.
/// 2. Otherwise, in a room on any session is in that room: the one moved
///    into most recently.
/// 3. Otherwise, around on any session is around.
/// 4. Otherwise every session is idle, and so are they.
fn merge<'a>(
    user_id: UserId,
    sessions: impl IntoIterator<Item = &'a SessionPresence>,
) -> Option<PresenceEntry> {
    let sessions: Vec<&SessionPresence> = sessions.into_iter().collect();
    if sessions.is_empty() {
        return None;
    }
    let entry = |state, room_id, away_message| PresenceEntry {
        user_id,
        state,
        room_id,
        away_message,
    };
    let away = sessions
        .iter()
        .filter(|session| session.state == PresenceState::Away)
        .max_by_key(|session| session.away_at);
    if let Some(away) = away {
        return Some(entry(PresenceState::Away, None, away.away_message.clone()));
    }
    let room = sessions
        .iter()
        .filter(|session| session.room_id.is_some())
        .max_by_key(|session| session.moved_at);
    if let Some(room) = room {
        return Some(entry(PresenceState::InRoom, room.room_id, None));
    }
    if sessions
        .iter()
        .any(|session| session.state == PresenceState::Around)
    {
        return Some(entry(PresenceState::Around, None, None));
    }
    Some(entry(PresenceState::Idle, None, None))
}

/// Whether two entries tell everybody the same thing. `PresenceEntry` is a
/// wire type, and comparing is only the gateway's business.
fn same_presence(a: &PresenceEntry, b: &PresenceEntry) -> bool {
    a.user_id == b.user_id
        && a.state == b.state
        && a.room_id == b.room_id
        && a.away_message == b.away_message
}

/// One session's place in a voice room. Every seat's voice goes through the
/// forwarding server (#197).
struct VoiceSeat {
    room_id: RoomId,
    user_id: UserId,
    controls: Option<VoiceControls>,
    /// Which seat this is (`Gateway::seats`). A repeated join that only
    /// changes controls keeps it; moving or rejoining takes a new one.
    number: u64,
}

/// What a session asked of voice: a seat in a room (`voice.join`), as it
/// asked for it. `None` in its place is `voice.leave`.
#[derive(Debug, Clone, Copy)]
struct WantedSeat {
    room_id: RoomId,
    controls: Option<VoiceControls>,
    can_forward: bool,
}

/// A session's newest `voice.join` or `voice.leave`, held back by
/// `RATE_VOICE_SEAT` until its turn (#527).
///
/// Unlike presence, a seat isn't taken until the turn: taking it is the
/// expensive part, the forwarding server offering everybody in the room a
/// fresh connection. So the turn takes the newest, once. What it can't do is
/// pretend the requests in between never happened: an app that left, or went
/// to another room, has closed its connection and waits for a fresh offer,
/// even if the newest puts it back in the seat it had (`churned`).
#[derive(Debug)]
struct HeldVoice {
    wanted: Option<WantedSeat>,
    /// The room the newest request named, or `None` for a leave.
    last_room: Option<RoomId>,
    /// The app started its connection again while this was held.
    churned: bool,
}

impl HeldVoice {
    fn new(seated: Option<RoomId>, wanted: Option<WantedSeat>) -> Self {
        let mut held = Self {
            wanted: None,
            last_room: seated,
            churned: false,
        };
        held.newest(wanted);
        held
    }

    /// A newer request arrived: it's the one the turn takes.
    fn newest(&mut self, wanted: Option<WantedSeat>) {
        let room = wanted.map(|seat| seat.room_id);
        // A leave closes the app's connection, and so does a join anywhere
        // but where it already is. Changing only mute or deafen doesn't.
        if room.is_none() || room != self.last_room {
            self.churned = true;
        }
        self.last_room = room;
        self.wanted = wanted;
    }
}

/// What a `voice.join` did (PROTOCOL §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceJoined {
    /// Nothing: this server carries no voice, the app can't forward, or the
    /// room is full.
    Refused,
    /// The session already had its seat in that room; at most its controls
    /// changed.
    Again,
    /// A new seat, numbered: somebody arrived, or moved here (#473).
    Seated(u64),
}

/// One event on the bus, plus who it is for.
///
/// Every session subscribes to the same broadcast channel, so an event meant
/// for one person still passes every session task on its way past. `to` is what
/// those tasks check.
///
/// Addressing lives here rather than on the event because the event is the wire
/// type (PROTOCOL §8) and a `knock` frame must not tell its receiver who it was
/// addressed to — they already know, and the sender's copy would be a field
/// carrying nothing but a way to get the fan-out wrong.
struct Fanout {
    event: ServerEvent,
    to: Option<UserId>,
    /// Narrower than `to`: one session, not one person. The forwarding
    /// server's offers are the only thing that uses it.
    to_session: Option<String>,
    /// Which room this frame is about, if any. Worked out from the event by
    /// `room_of` for every frame that names a room, and passed in for
    /// `reaction.update`, which names a message instead.
    room: Option<RoomId>,
    /// What everybody it reaches is told, made by the first session that
    /// needs it and shared by every other (#519). `None` inside when it
    /// couldn't be made into JSON, which no event does.
    told: OnceLock<Option<Told>>,
}

impl Fanout {
    fn new(
        event: ServerEvent,
        to: Option<UserId>,
        to_session: Option<String>,
        room: Option<RoomId>,
    ) -> Self {
        Self {
            event,
            to,
            to_session,
            room,
            told: OnceLock::new(),
        }
    }
}

/// A published frame as everybody it reaches is told it (#519).
struct Told {
    /// As JSON, without its `s`.
    json: EventJson,
    /// For a `presence.update`, the room it names once `outward` has had its
    /// say. Somebody who can't see that room gets their own copy without it.
    room: Option<RoomId>,
}

/// Which room a frame is about, if any (PROTOCOL §8, SPEC §4.13).
///
/// **This match has no wildcard arm, and that is the point.** A frame added
/// later does not compile until somebody has said whether it names a room, and
/// the compiler asking is the only version of that question anybody reliably
/// answers. The alternative — a `_ => None` that quietly means "everybody sees
/// this" — is how a DM leaks to the whole server in a change that was about
/// something else entirely.
fn room_of(event: &ServerEvent) -> Option<RoomId> {
    match event {
        ServerEvent::MessageCreate(m) | ServerEvent::MessageUpdate(m) => Some(m.room_id),
        ServerEvent::MessageDelete { room_id, .. }
        | ServerEvent::RoomOccupancy { room_id, .. }
        | ServerEvent::RoomEnter { room_id, .. }
        | ServerEvent::RoomLeave { room_id, .. }
        | ServerEvent::Typing { room_id, .. } => Some(*room_id),
        ServerEvent::RoomCreate(r) | ServerEvent::RoomUpdate(r) => Some(r.id),

        // Who is in voice is a fact about a room, so it reaches that room's
        // members and nobody else — a DM's voice room is as private as the DM
        // (SPEC §4.13, §4.14).
        ServerEvent::VoiceState { room_id, .. } => Some(*room_id),

        // A reaction names a message, not a room — so it is published with the
        // room it belongs to already resolved, on the `Fanout` rather than in
        // the frame. See `publish_in`.
        ServerEvent::ReactionUpdate { .. } => None,

        // Addressed to one session, which is narrower than any room check
        // could be: the forwarding server's offer to one client in voice
        // (#197), and the host taking that client out of voice (#423).
        ServerEvent::VoiceOffer { .. } | ServerEvent::VoiceRemoved { .. } => None,

        // The server's emoji are everybody's on it (#359): no room.
        ServerEvent::EmojiUpdate { .. } => None,

        // About a person, not a place.
        ServerEvent::PresenceUpdate(_)
        | ServerEvent::UserUpdate(_)
        | ServerEvent::UserRemove { .. }
        | ServerEvent::Knock { .. } => None,

        // Addressed to one person's sessions (PROTOCOL §5, "Report and
        // block"): the blocker's own, or the host's. Neither names a room.
        ServerEvent::BlockUpdate { .. } | ServerEvent::ReportsChanged {} => None,

        // Addressed to the sessions of whoever left a group DM (#565). It
        // names the DM, but they're no longer in it, so the room check would
        // drop it: it goes by address (`publish_to`) instead.
        ServerEvent::DmRemove { .. } => None,

        // Addressed to the reader's own sessions (#647). It names a room they
        // can see, but the room's other members must never learn where
        // somebody has read to, so it goes by address (`publish_to`), never
        // to the room.
        ServerEvent::ReadUpdate { .. } => None,

        // Session control. These never reach the bus — they are written
        // straight to one socket — but they are variants of the same enum, so
        // the match has to name them.
        ServerEvent::Hello { .. }
        | ServerEvent::Ready(_)
        | ServerEvent::Resumed { .. }
        | ServerEvent::InvalidSession { .. }
        | ServerEvent::HeartbeatAck => None,
    }
}

struct SessionHandle {
    user_id: UserId,
    ctl: mpsc::Sender<Ctl>,
}

enum Ctl {
    Attach {
        sink: mpsc::Sender<String>,
        /// Fired to make the attached socket's reader loop give up. The socket
        /// is the only thing that can end itself otherwise, and it spends its
        /// life parked on the next client frame, which a removed member is
        /// never going to send.
        closer: oneshot::Sender<()>,
        /// Last sequence number the client saw; replay starts after it.
        resume_from: u64,
        /// Resume attaches get a `resumed` frame before the replay.
        is_resume: bool,
    },
    /// The socket whose sink is `from` has gone. Only the socket attached
    /// right now detaches the session (#451): one that a resume has already
    /// replaced ends too, and its cleanup must leave the new socket alone.
    Detach { from: mpsc::Sender<String> },
    /// This session's user is off the server (T-413), or every sign-in they
    /// had has ended (#496). Say so, hang up, stop.
    Close,
}

impl Default for Gateway {
    fn default() -> Self {
        Self::new()
    }
}

impl Gateway {
    #[must_use]
    pub fn new() -> Self {
        let (bus, _) = broadcast::channel(1024);
        Self {
            bus,
            sessions: DashMap::new(),
            presence: DashMap::new(),
            session_presence: DashMap::new(),
            presence_order: AtomicU64::new(0),
            drops: AtomicU64::new(0),
            presence_held: DashSet::new(),
            focus_told: DashMap::new(),
            focus_held: DashSet::new(),
            voice_held: DashMap::new(),
            dm_members: DashMap::new(),
            voice: DashMap::new(),
            screens: screens::Screens::default(),
            screens_allowed: std::sync::atomic::AtomicBool::new(true),
            seats: AtomicU64::new(0),
            forwarding: OnceLock::new(),
        }
    }

    /// Start forwarding voice (#197): bind `bind` for UDP, and tell clients to
    /// reach it at `public`. Every offer it makes goes to its session over
    /// this gateway, as a `voice.offer`.
    ///
    /// # Errors
    ///
    /// When the socket can't be bound, which `main` treats as fatal: a server
    /// configured to forward voice that silently doesn't is a call nobody can
    /// hear.
    pub fn start_forwarding(
        self: &Arc<Self>,
        bind: std::net::SocketAddr,
        public: std::net::SocketAddr,
    ) -> std::io::Result<std::net::SocketAddr> {
        let gateway = Arc::downgrade(self);
        let sfu = linger_sfu::Sfu::start(bind, public, move |offer: linger_sfu::Offer| {
            let Some(gateway) = gateway.upgrade() else {
                return;
            };
            let tracks = offer
                .tracks
                .into_iter()
                .map(|track| VoiceTrack {
                    mid: track.mid,
                    session_id: track.session,
                })
                .collect();
            gateway.publish_to_session(
                &offer.session,
                ServerEvent::VoiceOffer {
                    sdp: offer.sdp,
                    tracks,
                    bitrate: Some(offer.bits),
                },
            );
        })?;
        let address = sfu.address();
        let _ = self.forwarding.set(sfu);
        Ok(address)
    }

    /// Whether this server forwards voice, which is whether it carries voice
    /// at all (#306).
    #[must_use]
    pub fn forwards_voice(&self) -> bool {
        self.forwarding.get().is_some()
    }

    /// Whether this server passes shared screens on (#360): it carries voice,
    /// which every share and watch lives inside, and its host hasn't turned
    /// screens off (`LINGER_SCREENS=off`).
    #[must_use]
    pub fn passes_screens(&self) -> bool {
        self.forwards_voice() && self.screens_allowed.load(Ordering::Relaxed)
    }

    /// Set from `LINGER_SCREENS` at startup.
    pub fn allow_screens(&self, on: bool) {
        self.screens_allowed.store(on, Ordering::Relaxed);
    }

    /// Fan an event out, to whoever the event says it is for.
    ///
    /// Which room the frame is about is worked out from the frame itself
    /// (`room_of`), so a caller cannot publish a DM's message to the whole
    /// server by forgetting an argument — there is no argument to forget.
    pub fn publish(&self, event: ServerEvent) {
        let room = room_of(&event);
        // No receivers just means nobody is connected; that is fine.
        let _ = self
            .bus
            .send(Arc::new(Fanout::new(event, None, None, room)));
    }

    /// Fan out a frame that belongs to a room without naming it.
    ///
    /// `reaction.update` is the only one: it names a message, and the room that
    /// message is in is what decides who may see the reaction. The caller has
    /// the message in hand and so has the room; the frame does not carry it,
    /// because a client that receives the frame already holds the message.
    pub fn publish_in(&self, room_id: RoomId, event: ServerEvent) {
        let _ = self
            .bus
            .send(Arc::new(Fanout::new(event, None, None, Some(room_id))));
    }

    /// Reload who is in every DM, from the database.
    ///
    /// Called at startup and after anything that changes membership. Cheap,
    /// because a DM holds at most `MAX_DM_MEMBERS`: even hundreds of DMs are a
    /// few thousand rows. Doing it wholesale rather than incrementally means
    /// there is no "update the index" step for a future change to forget.
    pub async fn reload_dms(&self, db: &sqlx::SqlitePool) -> Result<(), crate::error::ApiError> {
        let loaded = crate::repo::rooms::all_dm_members(db).await?;
        let fresh: Vec<RoomId> = loaded.iter().map(|(id, _)| *id).collect();
        for (id, members) in loaded {
            self.dm_members.insert(id, members.into());
        }
        // A DM that is gone from the database must not linger here holding an
        // audience. Nothing deletes a DM today; this is so that when something
        // does, this map is not the thing that was forgotten.
        self.dm_members.retain(|id, _| fresh.contains(id));
        Ok(())
    }

    /// Note a DM the moment it is made, before its `room.create` goes out.
    ///
    /// Ordering matters: the frame announcing a DM is itself a frame about that
    /// DM, so the audience has to be known before it is published or the
    /// announcement is the leak.
    pub fn note_dm(&self, room_id: RoomId, members: Vec<UserId>) {
        self.dm_members.insert(room_id, members.into());
    }

    /// Somebody left a group DM (#565): take them out of its audience, before
    /// anything about it is published again, so the line saying they left and
    /// every frame after it never reach them.
    ///
    /// It takes one person out of what the map holds rather than reloading
    /// the DM's members from the database, so two people leaving at the same
    /// moment can't put each other back: a reload that read before the other
    /// leave committed, and landed after it, would. The entry stays when the
    /// last person leaves, with nobody in it, because a room missing from the
    /// map is a public one.
    pub fn left_dm(&self, room_id: RoomId, user_id: UserId) {
        if let Some(mut members) = self.dm_members.get_mut(&room_id) {
            let staying: Vec<UserId> = members
                .iter()
                .copied()
                .filter(|id| *id != user_id)
                .collect();
            *members = staying.into();
        }
    }

    /// May this person see this room at all?
    ///
    /// A room the map has never heard of is public — that is the ordinary case
    /// and covers every room on every server that has no DMs. What makes it
    /// safe is that the map is authoritative for DMs: it is loaded before the
    /// server accepts a connection, and a DM is written into it before the
    /// frame announcing it is published.
    fn can_see_room(&self, receiver: UserId, room_id: RoomId) -> bool {
        match self.dm_members.get(&room_id) {
            Some(members) => members.value().contains(&receiver),
            None => true,
        }
    }

    /// Fan an event out to one *session* and no other — not even the same
    /// person's other clients (SPEC §4.14).
    ///
    /// Narrower than [`Self::publish_to`], and voice is the only thing that
    /// needs it: a peer connection is between two clients, so an answer meant
    /// for the laptop is meaningless on the desktop.
    pub fn publish_to_session(&self, session_id: &str, event: ServerEvent) {
        let _ = self.bus.send(Arc::new(Fanout::new(
            event,
            None,
            Some(session_id.to_string()),
            None,
        )));
    }

    /// Fan an event out to one person's sessions and nobody else's (T-1101).
    ///
    /// All of them, not one: somebody signed in on a laptop and a desktop is
    /// one person, and a knock that landed on whichever machine happened to
    /// connect first would be a knock they never saw.
    pub fn publish_to(&self, user_id: UserId, event: ServerEvent) {
        let _ = self
            .bus
            .send(Arc::new(Fanout::new(event, Some(user_id), None, None)));
    }

    /// Hang up on every session this person has open: they were removed
    /// (T-413), or they changed their password (#496).
    ///
    /// Either is only real once the socket is gone. The token check at
    /// identify happens once, at the start, so an already-open socket keeps
    /// receiving every message on the server until somebody closes it — and
    /// waiting for the 15-minute access token to lapse is not closing it.
    pub async fn close_sessions_for(&self, user_id: UserId) {
        // Collected first: holding a `DashMap` iterator across an await is how
        // a map like this deadlocks against the session task removing itself.
        let open: Vec<mpsc::Sender<Ctl>> = self
            .sessions
            .iter()
            .filter(|e| e.value().user_id == user_id)
            .map(|e| e.value().ctl.clone())
            .collect();
        for ctl in open {
            let _ = ctl.send(Ctl::Close).await;
        }
    }

    // --- voice (SPEC §4.14, PROTOCOL §8, T-1401) ---------------------------

    /// Who is in voice in a room, in a stable order (by session id).
    ///
    /// Everybody is marked `forwarded`, because everybody is: apps 0.4.1 to
    /// 0.4.3 read the mark to know it, and would wait for a mesh without it.
    #[must_use]
    fn voice_peers(&self, room_id: RoomId) -> Vec<VoicePeer> {
        let mut peers: Vec<VoicePeer> = self
            .voice
            .iter()
            .filter(|seat| seat.value().room_id == room_id)
            .map(|seat| {
                let (screen, watching) = self.screens.peer(seat.key());
                VoicePeer {
                    session_id: seat.key().clone(),
                    user_id: seat.value().user_id,
                    controls: seat.value().controls,
                    forwarded: Some(true),
                    screen,
                    watching,
                }
            })
            .collect();
        peers.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        peers
    }

    /// Seed a fresh connection without exposing private rooms or starting voice.
    pub fn voice_snapshot(&self, receiver: UserId) -> Vec<VoiceRoomState> {
        let rooms: std::collections::BTreeSet<RoomId> = self
            .voice
            .iter()
            .map(|seat| seat.value().room_id)
            .filter(|room| self.can_see_room(receiver, *room))
            .collect();
        rooms
            .into_iter()
            .map(|room_id| VoiceRoomState {
                room_id,
                peers: self.voice_peers(room_id),
            })
            .collect()
    }

    /// Tell a room's members who is in voice there. The whole list, every time
    /// (PROTOCOL §8) — a client that missed one is right again after the next.
    fn announce_voice(&self, room_id: RoomId) {
        self.publish(ServerEvent::VoiceState {
            room_id,
            peers: self.voice_peers(room_id),
        });
    }

    /// Put a session into a room's voice, taking it out of wherever it was.
    ///
    /// Answers `Refused`, and changes nothing, when it can't be done: this
    /// server carries no voice (`LINGER_VOICE_ADDRESS` isn't set), the app
    /// didn't say it can forward (one from before 0.4.1, which spoke only the
    /// mesh, gone since #306), or the room is full. The caller has already
    /// checked that this person can see the room.
    pub fn voice_join(
        &self,
        session_id: &str,
        user_id: UserId,
        room_id: RoomId,
        controls: Option<VoiceControls>,
        can_forward: bool,
    ) -> VoiceJoined {
        let Some(sfu) = self.forwarding.get() else {
            return VoiceJoined::Refused;
        };
        if !can_forward {
            return VoiceJoined::Refused;
        }
        let controls = controls.map(VoiceControls::normalized);
        if let Some(mut seat) = self.voice.get_mut(session_id) {
            if seat.value().room_id == room_id {
                // A repeated join is how controls change (PROTOCOL §8).
                let changed = controls.is_some() && controls != seat.controls;
                if changed {
                    seat.controls = controls;
                }
                drop(seat);
                if changed {
                    self.announce_voice(room_id);
                }
                return VoiceJoined::Again;
            }
        }
        // Counted before the seat is taken, and only for a room this session is
        // not already in — otherwise re-joining the room you are in could be
        // refused by your own seat.
        if self.voice_peers(room_id).len() >= MAX_VOICE_PEERS {
            return VoiceJoined::Refused;
        }
        let left = self.voice_leave(session_id);
        let number = self.seats.fetch_add(1, Ordering::Relaxed) + 1;
        self.voice.insert(
            session_id.to_string(),
            VoiceSeat {
                room_id,
                user_id,
                controls,
                number,
            },
        );
        sfu.join(session_id, &room_id.to_string());
        if let Some(previous) = left {
            self.announce_voice(previous);
        }
        self.announce_voice(room_id);
        VoiceJoined::Seated(number)
    }

    /// The room `session_id`'s voice seat is in, when it has one and it is
    /// `user_id`'s: what a screen socket must belong to (#360).
    #[must_use]
    pub fn screen_seat(&self, session_id: &str, user_id: UserId) -> Option<RoomId> {
        self.voice
            .get(session_id)
            .filter(|seat| seat.user_id == user_id)
            .map(|seat| seat.room_id)
    }

    /// Tell a room who shares and watches now (#360): its `voice.state`,
    /// which carries both.
    pub(crate) fn announce_screens(&self, room_id: RoomId) {
        self.announce_voice(room_id);
    }

    /// The room a session's seat is in, if it has one.
    fn seat_room(&self, session_id: &str) -> Option<RoomId> {
        self.voice.get(session_id).map(|seat| seat.room_id)
    }

    /// Whether a session still holds the seat it took (#473): the same seat,
    /// in the same room, never left in between. Leaving and joining again, or
    /// moving away and back, is a different seat.
    #[must_use]
    pub fn holds_seat(&self, session_id: &str, room_id: RoomId, number: u64) -> bool {
        self.voice
            .get(session_id)
            .is_some_and(|seat| seat.room_id == room_id && seat.number == number)
    }

    /// A session's answer to the forwarding server's latest offer (#197).
    /// Ignored from a session that isn't in voice, like any voice frame that
    /// doesn't fit.
    pub fn voice_answer(&self, session_id: &str, sdp: &str) {
        if let (true, Some(sfu)) = (self.voice.contains_key(session_id), self.forwarding.get()) {
            sfu.answer(session_id, sdp);
        }
    }

    /// Start a session's connection to the forwarding server afresh (#197),
    /// when its client says the last one failed. Its seat, and what the room
    /// sees, don't change; it gets a new offer.
    pub fn voice_restart(&self, session_id: &str) {
        let Some(room_id) = self.voice.get(session_id).map(|seat| seat.room_id) else {
            return;
        };
        if let Some(sfu) = self.forwarding.get() {
            sfu.join(session_id, &room_id.to_string());
        }
    }

    /// Take a session out of voice. Answers which room it left, if any.
    ///
    /// **Does not announce.** Callers that are only leaving announce it
    /// themselves; `voice_join` needs to move the seat before announcing
    /// either room, or a client can see itself in two rooms at once.
    fn voice_leave(&self, session_id: &str) -> Option<RoomId> {
        let (_, seat) = self.voice.remove(session_id)?;
        if let Some(sfu) = self.forwarding.get() {
            sfu.leave(session_id);
        }
        // A share and a watch live inside the seat (#360): leaving voice,
        // moving rooms or the session ending closes both sockets. The room's
        // announcement, the caller's, says so to everybody.
        self.screens.leave(session_id);
        Some(seat.room_id)
    }

    /// Leave voice and tell the room. The ordinary way out.
    pub fn voice_part(&self, session_id: &str) {
        if let Some(room_id) = self.voice_leave(session_id) {
            self.announce_voice(room_id);
        }
    }

    /// The host taking somebody out of a room's voice (#423): every seat this
    /// person has there (a laptop and a desktop are two), each session told
    /// why first (`voice.removed`), then the room told once. Answers whether
    /// they were in that room's voice at all.
    ///
    /// Leaving is the room's `voice.state`, so an app from before
    /// `voice.removed` drops the unknown frame, sees its seat gone, and
    /// leaves the same; with no seat, its restarts are ignored
    /// (`voice_restart`). They can join again whenever they like.
    pub fn voice_take_out(&self, room_id: RoomId, user_id: UserId) -> bool {
        // Collected first: removing from a `DashMap` while iterating it
        // deadlocks.
        let seats: Vec<String> = self
            .voice
            .iter()
            .filter(|seat| seat.value().user_id == user_id && seat.value().room_id == room_id)
            .map(|seat| seat.key().clone())
            .collect();
        if seats.is_empty() {
            return false;
        }
        for session in &seats {
            self.publish_to_session(session, ServerEvent::VoiceRemoved { room_id });
            self.voice_leave(session);
        }
        self.announce_voice(room_id);
        true
    }

    /// Presence snapshot for `ready`, as this person is allowed to see it.
    ///
    /// **Redacted the same way a live `presence.update` is** (SPEC §4.13):
    /// somebody standing in a DM the receiver cannot see comes back without the
    /// room. This is easy to miss and was: the live path goes through
    /// `visible_to` and the snapshot does not, so for a while the frames were
    /// right and the first frame of the session was not — a client connecting
    /// while somebody was in a DM was handed that DM's id.
    ///
    /// The room is dropped rather than the person, for the same reason as
    /// everywhere else: they *are* around, and hiding them would say something
    /// false rather than saying less.
    #[must_use]
    pub fn presence_snapshot(&self, receiver: UserId) -> Vec<PresenceEntry> {
        self.presence
            .iter()
            .map(|e| {
                let mut entry = self.outward(e.value().clone());
                if let Some(room_id) = entry.room_id {
                    if !self.can_see_room(receiver, room_id) {
                        entry.room_id = None;
                    }
                }
                entry
            })
            .collect()
    }

    /// Whether a room is a DM.
    fn is_dm(&self, room_id: RoomId) -> bool {
        self.dm_members.contains_key(&room_id)
    }

    /// What anybody is told about where a person is (SPEC §4.13, Matt
    /// 2026-09-26): being in a DM is being **around**, to everybody, the DM's
    /// own people included. Nobody learns that somebody is DMing, let alone
    /// with whom. The server still knows, for the things that need it.
    fn outward(&self, mut entry: PresenceEntry) -> PresenceEntry {
        if entry.room_id.is_some_and(|room_id| self.is_dm(room_id)) {
            entry.room_id = None;
            if entry.state == PresenceState::InRoom {
                entry.state = PresenceState::Around;
            }
        }
        entry
    }

    /// Who is in a room right now.
    #[must_use]
    pub fn occupancy(&self, room_id: RoomId) -> Vec<UserId> {
        self.presence
            .iter()
            .filter(|e| e.value().room_id == Some(room_id))
            .map(|e| *e.key())
            .collect()
    }

    /// The next number in `presence_order`.
    fn next_presence_order(&self) -> u64 {
        self.presence_order.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Work a person's presence out again from what their sessions say
    /// (#653), and keep it when it changed. Called holding their entry in
    /// `session_presence`, which is what `sessions` is. Answers what
    /// changed, and so how it is told; a person with no session left is the
    /// caller's to take offline.
    fn remerge(&self, user_id: UserId, sessions: &HashMap<String, SessionPresence>) -> Merged {
        let Some(merged) = merge(user_id, sessions.values()) else {
            return Merged::Same;
        };
        let before = self.presence.get(&user_id).map(|e| e.value().clone());
        let answer = match &before {
            Some(before) if same_presence(before, &merged) => return Merged::Same,
            Some(before) if before.room_id != merged.room_id => Merged::Moved,
            _ => Merged::Changed,
        };
        self.presence.insert(user_id, merged);
        answer
    }

    /// Apply a client `presence.update` to the session that sent it, and
    /// only to that one (#653), answering what it changed of what
    /// everybody is told. Saying the same thing again tells nobody anything
    /// new, so nobody is told it (#497), and nor does a change another of
    /// their sessions outranks: idle here while the phone is in a room.
    ///
    /// A state other than idle or away counts as around: where somebody is
    /// comes from `room.focus`, and offline from their last session closing.
    /// The away message is kept only with away, and loses the characters
    /// that turn text around, as a saved one does (#488): it's drawn beside
    /// the person's name. It is compared as it is held: compared as sent,
    /// one carrying an override would never equal the stored one, and every
    /// repeat would count as a change and spend the person's `RATE_PRESENCE`.
    fn update_presence(
        &self,
        user_id: UserId,
        session_id: &str,
        state: PresenceState,
        away_message: Option<String>,
    ) -> Merged {
        let state = match state {
            PresenceState::Away | PresenceState::Idle => state,
            PresenceState::Around | PresenceState::InRoom | PresenceState::Offline => {
                PresenceState::Around
            }
        };
        let away_message = away_message
            .filter(|_| state == PresenceState::Away)
            .as_deref()
            .map(crate::validate::without_direction_overrides);
        let Some(mut sessions) = self.session_presence.get_mut(&user_id) else {
            return Merged::Same;
        };
        let Some(own) = sessions.get_mut(session_id) else {
            return Merged::Same;
        };
        let restarted = own.speaks_again();
        if !restarted && own.state == state && own.away_message == away_message {
            return Merged::Same;
        }
        if state == PresenceState::Away {
            own.away_at = self.next_presence_order();
        }
        own.state = state;
        own.away_message = away_message;
        self.remerge(user_id, &sessions)
    }

    /// Tell everybody somebody's presence as it is now.
    ///
    /// A change held back by `RATE_PRESENCE` is told this way when its turn
    /// comes, as the newest of everything that arrived meanwhile (#497). When
    /// they have gone offline in between there is nothing to tell:
    /// `session_gone` already said so.
    ///
    /// **Published while the entry is still held.** Copying it and letting go
    /// first leaves a gap in which their last connection can close (or a
    /// `room.focus` tell something newer), and this older copy would then go
    /// out after it: somebody who just left looking online again. Holding the
    /// read guard makes that remove or insert wait until this is on the bus.
    /// It can't deadlock: `publish` only works out the room and sends, and
    /// nothing on that path reads `presence`.
    fn tell_presence(&self, user_id: UserId) {
        if let Some(entry) = self.presence.get(&user_id) {
            self.publish(ServerEvent::PresenceUpdate(entry.value().clone()));
        }
    }

    /// Move one of somebody's sessions to a room, or out of every room
    /// (`None`), answering what that changed of what everybody is told. Only
    /// in memory: a `ready` from now on has it, and `tell_focus` tells
    /// everybody else.
    ///
    /// It moves that session and no other (#653). Moving is the person
    /// being there, so a session that was idle is around again; one that
    /// is away stays away, and a phone opening a room can't undo the away
    /// set on the computer. Away ends when the session that set it says so,
    /// or goes, or with I'm back on any of them (`back_everywhere`).
    fn move_to(&self, user_id: UserId, session_id: &str, room_id: Option<RoomId>) -> Merged {
        let Some(mut sessions) = self.session_presence.get_mut(&user_id) else {
            return Merged::Same;
        };
        let Some(own) = sessions.get_mut(session_id) else {
            return Merged::Same;
        };
        let restarted = own.speaks_again();
        if !restarted && own.room_id == room_id {
            return Merged::Same;
        }
        own.room_id = room_id;
        own.moved_at = self.next_presence_order();
        if own.state == PresenceState::Idle {
            own.state = PresenceState::Around;
        }
        self.remerge(user_id, &sessions)
    }

    /// Somebody cleared the away saved on their status (`PATCH /me`, #653):
    /// away ends on every one of their sessions, not only the one that set
    /// it. I'm back on the phone has no away of its own to undo, and without
    /// this the computer would keep everybody seeing away. Each away session
    /// is around again, in whatever room it has open, and the answer is what
    /// that changed of what everybody is told.
    ///
    /// With one device, its own `around` frame follows and changes nothing,
    /// so nobody is told twice.
    fn back_everywhere(&self, user_id: UserId) -> Merged {
        let Some(mut sessions) = self.session_presence.get_mut(&user_id) else {
            return Merged::Same;
        };
        let mut came_back = false;
        for own in sessions.values_mut() {
            if own.state == PresenceState::Away {
                own.state = PresenceState::Around;
                own.away_message = None;
                came_back = true;
            }
        }
        if !came_back {
            return Merged::Same;
        }
        self.remerge(user_id, &sessions)
    }

    /// Tell everybody where somebody is now, against where they were last
    /// told to be, in protocol order: leave → enter → occupancy → presence.
    ///
    /// However many moves came in between, this tells one: from the room
    /// they were last told about to the room they're in (#527). Moving away
    /// and back again tells nobody they left.
    ///
    /// One teller at a time per person: the `focus_told` entry is held
    /// throughout, so a held turn and a closing connection can't interleave
    /// their frames. The presence goes out while it is held too, for the
    /// reason `tell_presence` gives.
    fn tell_focus(&self, user_id: UserId, entrance_sound: Option<String>) {
        let mut told = self.focus_told.entry(user_id).or_insert(None);
        let Some(now) = self.presence.get(&user_id).map(|e| e.value().room_id) else {
            // Offline in between: `session_gone` told everybody.
            drop(told);
            self.focus_told.remove(&user_id);
            return;
        };
        let before = *told;
        if before != now {
            // Standing in a DM is nobody's business (see `outward`): no
            // leave, enter or occupancy is said about one, even to its own
            // people.
            if let Some(prev) = before.filter(|room| !self.is_dm(*room)) {
                self.publish(ServerEvent::RoomLeave {
                    room_id: prev,
                    user_id,
                });
                self.publish(ServerEvent::RoomOccupancy {
                    room_id: prev,
                    user_ids: self.occupancy(prev),
                });
            }
            if let Some(new) = now.filter(|room| !self.is_dm(*room)) {
                self.publish(ServerEvent::RoomEnter {
                    room_id: new,
                    user_id,
                    entrance_sound,
                });
                self.publish(ServerEvent::RoomOccupancy {
                    room_id: new,
                    user_ids: self.occupancy(new),
                });
            }
            *told = now;
        }
        if let Some(entry) = self.presence.get(&user_id) {
            self.publish(ServerEvent::PresenceUpdate(entry.value().clone()));
        }
    }

    /// A socket came up on this session. A session's first socket gives it
    /// a record of its own, around and in no room (#653); a person's first
    /// session makes them visible. A resume inside the grace period after a
    /// drop finds the record it left, and keeps it, held over until its app
    /// speaks again (#654): nothing anybody is told changes.
    ///
    /// Told at once when it changes what everybody is told, as a first
    /// connection always was. It can only be their state, never their room:
    /// the newcomer is in none. Told while their entry is held, so nothing
    /// else about them can go out between the change and the telling.
    fn connection_opened(&self, user_id: UserId, session_id: &str) {
        let mut sessions = self.session_presence.entry(user_id).or_default();
        let own = sessions
            .entry(session_id.to_string())
            .or_insert_with(SessionPresence::arrived);
        if own.sockets == 0 && own.dropped.is_some() {
            own.held_over = true;
        }
        own.sockets += 1;
        if self.remerge(user_id, &sessions) != Merged::Same {
            if let Some(entry) = self.presence.get(&user_id) {
                self.publish(ServerEvent::PresenceUpdate(entry.value().clone()));
            }
        }
    }

    /// A socket went away with a goodbye, or its session hung up on it,
    /// answering what that changed of what everybody is told for the caller
    /// to tell. When it was its session's last socket, the session's record
    /// goes at once (`session_gone`).
    fn connection_closed(&self, user_id: UserId, session_id: &str) -> Merged {
        let Entry::Occupied(mut person) = self.session_presence.entry(user_id) else {
            return Merged::Same;
        };
        let Some(own) = person.get_mut().get_mut(session_id) else {
            return Merged::Same;
        };
        own.sockets = own.sockets.saturating_sub(1);
        if own.sockets > 0 {
            return Merged::Same;
        }
        self.session_gone(user_id, session_id, person)
    }

    /// A socket went without a goodbye: the network, not the person (#654).
    /// When it was its session's last, the record stays as it was, still
    /// counted, and nobody is told anything. The answer is then the drop's
    /// number, for the caller to hand `grace_over` once the grace period
    /// ends. A socket a resume has already replaced (#451) wasn't the last,
    /// and starts no grace period.
    fn connection_dropped(&self, user_id: UserId, session_id: &str) -> Option<u64> {
        let mut sessions = self.session_presence.get_mut(&user_id)?;
        let own = sessions.get_mut(session_id)?;
        own.sockets = own.sockets.saturating_sub(1);
        if own.sockets > 0 {
            return None;
        }
        let number = self.drops.fetch_add(1, Ordering::Relaxed) + 1;
        own.dropped = Some(number);
        Some(number)
    }

    /// The grace period after drop `number` is over (#654), answering what
    /// that changed of what everybody is told for the caller to tell.
    ///
    /// A session that never came back goes now (`session_gone`), and is told
    /// as one closed with a goodbye is. One that resumed and whose app has
    /// said nothing since is what its app starts from, around in no room:
    /// the app had nothing to say because that is where it is. One that
    /// resumed and has spoken changes nothing. After a later drop, or once
    /// the record is gone, this drop's turn has passed and nothing happens.
    fn grace_over(&self, user_id: UserId, session_id: &str, number: u64) -> Merged {
        let Entry::Occupied(mut person) = self.session_presence.entry(user_id) else {
            return Merged::Same;
        };
        let Some(own) = person.get_mut().get_mut(session_id) else {
            return Merged::Same;
        };
        if own.dropped != Some(number) {
            return Merged::Same;
        }
        own.dropped = None;
        if own.sockets == 0 {
            return self.session_gone(user_id, session_id, person);
        }
        if !own.speaks_again() {
            return Merged::Same;
        }
        self.remerge(user_id, person.get())
    }

    /// A session has no socket left, so what it said goes with it (#653):
    /// its room, its idle, its away. Somebody with other sessions is worked
    /// out again from those, for the caller to tell. Their last session
    /// going takes them offline, out of any room, and that is told here and
    /// now, whatever their turn.
    ///
    /// The one place a session's record ends: at once after a goodbye, and
    /// at the end of the grace period after a drop it didn't come back from
    /// (#654).
    fn session_gone(
        &self,
        user_id: UserId,
        session_id: &str,
        mut person: OccupiedEntry<'_, UserId, HashMap<String, SessionPresence>>,
    ) -> Merged {
        person.get_mut().remove(session_id);
        if !person.get().is_empty() {
            return self.remerge(user_id, person.get());
        }
        // Out of their room, told at once whatever their turn: the room they
        // were last told to be in, if a move was still held.
        let moved = self.presence.get_mut(&user_id).is_some_and(|mut entry| {
            let moved = entry.room_id.is_some();
            if moved {
                entry.room_id = None;
                entry.state = PresenceState::Around;
            }
            moved
        });
        let told_somewhere = self
            .focus_told
            .get(&user_id)
            .is_some_and(|room| room.is_some());
        if moved || told_somewhere {
            self.tell_focus(user_id, None);
        }
        self.focus_told.remove(&user_id);
        self.presence.remove(&user_id);
        self.publish(ServerEvent::PresenceUpdate(offline_entry(user_id)));
        person.remove();
        Merged::Same
    }

    /// PROTOCOL §8 fan-out rules: what this person gets, if anything, as
    /// JSON without its `s`.
    ///
    /// Nearly always the one copy everybody it reaches shares (`told`, #519).
    /// The exception is `presence.update`, which is *redacted* for somebody
    /// who cannot see the room its subject is in, rather than withheld.
    /// Withholding it would make that person look offline to everybody they
    /// are not currently talking to, which is both wrong and a slower way of
    /// leaking the same thing (SPEC §4.13).
    ///
    /// Four rules, in order:
    /// 0. A session-addressed frame reaches that one client and no other, not
    ///    even the same person's.
    /// 1. An addressed frame reaches the person it names and nobody else.
    /// 2. A frame about a room reaches that room's members. For a public room
    ///    that is everybody, so this changes nothing except for DMs.
    /// 3. `room.enter` narrows further, to clients standing in that room.
    /// 4. `presence.update` naming a room the receiver cannot see loses the
    ///    room and keeps the person.
    fn visible_to(&self, receiver: UserId, session_id: &str, fanout: &Fanout) -> Option<EventJson> {
        if let Some(target) = &fanout.to_session {
            return (target == session_id)
                .then(|| self.told(fanout).map(|told| told.json.clone()))
                .flatten();
        }
        if let Some(target) = fanout.to {
            return (target == receiver)
                .then(|| self.told(fanout).map(|told| told.json.clone()))
                .flatten();
        }

        if let Some(room_id) = fanout.room {
            if !self.can_see_room(receiver, room_id) {
                return None;
            }
        }

        if let ServerEvent::RoomEnter { room_id, .. } = &fanout.event {
            let standing_there = self
                .presence
                .get(&receiver)
                .is_some_and(|e| e.value().room_id == Some(*room_id));
            if !standing_there {
                return None;
            }
        }

        let told = self.told(fanout)?;
        if let (Some(room_id), ServerEvent::PresenceUpdate(entry)) = (told.room, &fanout.event) {
            if !self.can_see_room(receiver, room_id) {
                let mut redacted = self.outward(entry.clone());
                redacted.room_id = None;
                return EventJson::of(&ServerEvent::PresenceUpdate(redacted)).ok();
            }
        }
        Some(told.json.clone())
    }

    /// What everybody a frame reaches is told, made once (#519): the first
    /// session to need it makes it, and every other reuses it. Making it
    /// once also means everybody is told the same thing, even if a DM's
    /// membership changes while the frame is on its way round.
    ///
    /// A `presence.update` goes out as `outward` has it, which is the same
    /// for everybody: being in a DM is being around, to all.
    fn told<'a>(&self, fanout: &'a Fanout) -> Option<&'a Told> {
        fanout
            .told
            .get_or_init(|| match &fanout.event {
                ServerEvent::PresenceUpdate(entry) => {
                    let entry = self.outward(entry.clone());
                    let room = entry.room_id;
                    EventJson::of(&ServerEvent::PresenceUpdate(entry))
                        .ok()
                        .map(|json| Told { json, room })
                }
                event => EventJson::of(event)
                    .ok()
                    .map(|json| Told { json, room: None }),
            })
            .as_ref()
    }
}

fn offline_entry(user_id: UserId) -> PresenceEntry {
    PresenceEntry {
        user_id,
        state: PresenceState::Offline,
        room_id: None,
        away_message: None,
    }
}

/// Done once a session detached since `detached_at` has waited out the
/// resume window, and never while a socket is attached. A timer only while
/// detached, rather than a sweep every five seconds for the session's whole
/// life, so an attached session, nearly every one, never wakes for it (#522).
async fn resume_window_closes(detached_at: Option<Instant>) {
    match detached_at {
        Some(since) => {
            tokio::time::sleep_until(since + Duration::from_millis(RESUME_WINDOW_MS)).await;
        }
        None => std::future::pending().await,
    }
}

/// Spawn a session task; returns its control handle. See module docs for shape.
fn spawn_session(gateway: Arc<Gateway>, session_id: String, user_id: UserId) -> mpsc::Sender<Ctl> {
    let (ctl_tx, mut ctl_rx) = mpsc::channel::<Ctl>(16);
    let mut bus_rx = gateway.bus.subscribe();

    tokio::spawn(async move {
        let mut seq: u64 = 0;
        // Every entry is the same string every other session holds for that
        // event (#519); its `s` is spliced in as it's sent.
        let mut ring: VecDeque<(u64, EventJson)> = VecDeque::with_capacity(RESUME_BUFFER_FRAMES);
        let mut sink: Option<mpsc::Sender<String>> = None;
        // Held alongside the sink and replaced with it: it belongs to whichever
        // socket is attached right now, not to the session.
        let mut closer: Option<oneshot::Sender<()>> = None;
        // Starts "detached": if the handshake never attaches, the resume
        // window runs out and the session ends.
        let mut detached_at: Option<Instant> = Some(Instant::now());

        loop {
            tokio::select! {
                event = bus_rx.recv() => match event {
                    Ok(event) => {
                        let Some(json) = gateway.visible_to(user_id, &session_id, &event) else {
                            continue;
                        };
                        seq += 1;
                        if ring.len() == RESUME_BUFFER_FRAMES {
                            ring.pop_front();
                        }
                        let frame = json.sequenced(seq);
                        ring.push_back((seq, json));
                        if let Some(tx) = &sink {
                            // A full queue means a dead or pathologically slow
                            // socket; detach and let resume recover it.
                            if tx.try_send(frame).is_err() {
                                sink = None;
                                closer = None;
                                detached_at = Some(Instant::now());
                            }
                        }
                    }
                    // Lagged: we dropped bus frames, so the ring has a hole and
                    // resume would silently skip events. Integrity over uptime:
                    // kill the session; the client re-identifies and refetches.
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                ctl = ctl_rx.recv() => match ctl {
                    Some(Ctl::Attach { sink: new_sink, closer: new_closer, resume_from, is_resume }) => {
                        let replay: Vec<String> = ring
                            .iter()
                            .filter(|(s, _)| *s > resume_from)
                            .map(|(s, json)| json.sequenced(*s))
                            .collect();
                        if is_resume {
                            let resumed = ServerFrame::control(ServerEvent::Resumed {
                                replayed: replay.len() as u64,
                            });
                            if let Ok(json) = serde_json::to_string(&resumed) {
                                let _ = new_sink.send(json).await;
                            }
                        }
                        let mut ok = true;
                        for json in replay {
                            if new_sink.send(json).await.is_err() {
                                ok = false;
                                break;
                            }
                        }
                        if ok {
                            sink = Some(new_sink);
                            closer = Some(new_closer);
                            detached_at = None;
                        }
                    }
                    Some(Ctl::Detach { from }) => {
                        if sink.as_ref().is_some_and(|attached| attached.same_channel(&from)) {
                            sink = None;
                            closer = None;
                            detached_at = Some(Instant::now());
                        }
                    }
                    Some(Ctl::Close) => {
                        // "unauthenticated" rather than a word of its own: it is
                        // what this token now is, and it is the one reason the
                        // client already answers by asking for a fresh token —
                        // which the server refuses, which signs them out. (The
                        // device a password was changed on holds a fresh pair
                        // already, and is straight back in: #496.) A reason
                        // nobody handles would leave them reconnecting into a
                        // locked door forever.
                        if let Some(tx) = &sink {
                            let frame = ServerFrame::control(ServerEvent::InvalidSession {
                                reason: "unauthenticated".into(),
                            });
                            if let Ok(json) = serde_json::to_string(&frame) {
                                let _ = tx.send(json).await;
                            }
                        }
                        // Queued behind that frame, so it goes out before the
                        // socket's writer runs dry and stops.
                        if let Some(closer) = closer.take() {
                            let _ = closer.send(());
                        }
                        break;
                    }
                    None => break,
                },
                () = resume_window_closes(detached_at) => break,
            }
        }
        gateway.sessions.remove(&session_id);
        // A held join must not seat a session that's gone (#527).
        gateway.voice_held.remove(&session_id);
        // A session that is really gone leaves voice, and the people it was
        // talking to are told. This is *here* rather than on socket close on
        // purpose: a dropped socket has 120 seconds to come back, and a client
        // that resumes is the same client with the same peers still connected
        // to it. Hanging up on a reconnect would be the half-connected state
        // this task exists to avoid.
        gateway.voice_part(&session_id);
    });

    ctl_tx
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_millis(RESUME_WINDOW_MS);

    /// A socket for the session: its frames and its closer, both kept open.
    struct Socket {
        sink: mpsc::Sender<String>,
        _frames: mpsc::Receiver<String>,
        _closed: oneshot::Receiver<()>,
    }

    async fn attach(ctl: &mpsc::Sender<Ctl>, is_resume: bool) -> Socket {
        let (sink, frames) = mpsc::channel(16);
        let (closer, closed) = oneshot::channel();
        ctl.send(Ctl::Attach {
            sink: sink.clone(),
            closer,
            resume_from: 0,
            is_resume,
        })
        .await
        .expect("the session is running");
        Socket {
            sink,
            _frames: frames,
            _closed: closed,
        }
    }

    /// A session that never gets a socket ends when the resume window
    /// does, as one whose socket went does (PROTOCOL §8).
    #[tokio::test(start_paused = true)]
    async fn a_session_nobody_attaches_to_ends_with_the_resume_window() {
        let gateway = Arc::new(Gateway::new());
        let ctl = spawn_session(Arc::clone(&gateway), "s".into(), UserId::new());
        tokio::time::sleep(WINDOW - Duration::from_secs(1)).await;
        assert!(
            !ctl.is_closed(),
            "the session ended before its window ran out"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(ctl.is_closed(), "the session outlived its window");
    }

    /// The window counts only while a session is detached, from when it
    /// detached (#522): an attached session never ends on a timer, and one
    /// that resumed gets a whole window again when its socket goes.
    #[tokio::test(start_paused = true)]
    async fn the_resume_window_counts_only_while_detached() {
        let gateway = Arc::new(Gateway::new());
        let ctl = spawn_session(Arc::clone(&gateway), "s".into(), UserId::new());
        let socket = attach(&ctl, false).await;
        tokio::time::sleep(WINDOW * 5).await;
        assert!(!ctl.is_closed(), "an attached session ended");

        // Its socket goes, and the app comes back before the window runs out.
        ctl.send(Ctl::Detach { from: socket.sink })
            .await
            .expect("the session is running");
        tokio::time::sleep(WINDOW - Duration::from_secs(20)).await;
        let socket = attach(&ctl, true).await;
        tokio::time::sleep(WINDOW * 5).await;
        assert!(!ctl.is_closed(), "a resumed session ended");

        // Gone again: a whole window from now, and not a moment more.
        ctl.send(Ctl::Detach { from: socket.sink })
            .await
            .expect("the session is running");
        tokio::time::sleep(WINDOW - Duration::from_secs(1)).await;
        assert!(
            !ctl.is_closed(),
            "the session ended before its window ran out"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(ctl.is_closed(), "the session outlived its window");
    }

    // --- one person on several devices (#653) -------------------------------

    /// A session's record as the merge sees it.
    fn said(state: PresenceState, room_id: Option<RoomId>, moved_at: u64) -> SessionPresence {
        SessionPresence {
            room_id,
            state,
            moved_at,
            ..SessionPresence::arrived()
        }
    }

    fn away(message: &str, away_at: u64) -> SessionPresence {
        SessionPresence {
            state: PresenceState::Away,
            away_message: Some(message.to_string()),
            away_at,
            ..SessionPresence::arrived()
        }
    }

    fn merged(
        sessions: &[SessionPresence],
    ) -> Option<(PresenceState, Option<RoomId>, Option<String>)> {
        merge(UserId::new(), sessions).map(|entry| (entry.state, entry.room_id, entry.away_message))
    }

    #[test]
    fn nobody_left_is_offline() {
        assert_eq!(merged(&[]), None);
    }

    #[test]
    fn one_session_is_what_it_says() {
        use PresenceState::{Around, Idle, InRoom};
        let room = RoomId::new();
        assert_eq!(merged(&[said(Around, None, 0)]), Some((Around, None, None)));
        assert_eq!(merged(&[said(Idle, None, 0)]), Some((Idle, None, None)));
        assert_eq!(
            merged(&[said(Around, Some(room), 1)]),
            Some((InRoom, Some(room), None))
        );
        assert_eq!(
            merged(&[away("lunch", 1)]),
            Some((PresenceState::Away, None, Some("lunch".into())))
        );
    }

    /// Rule 1: away on any session is away, in no room, whatever the others
    /// say, with the away message set most recently.
    #[test]
    fn away_on_any_session_is_away_in_no_room() {
        let room = RoomId::new();
        let in_room = said(PresenceState::Around, Some(room), 5);
        assert_eq!(
            merged(&[in_room.clone(), away("lunch", 1)]),
            Some((PresenceState::Away, None, Some("lunch".into())))
        );
        // A session that went away without leaving its room first is away
        // too, and in no room.
        let mut away_in_room = away("lunch", 1);
        away_in_room.room_id = Some(room);
        assert_eq!(
            merged(&[away_in_room]),
            Some((PresenceState::Away, None, Some("lunch".into())))
        );
        assert_eq!(
            merged(&[away("lunch", 1), in_room, away("gym", 2)]),
            Some((PresenceState::Away, None, Some("gym".into())))
        );
        assert_eq!(
            merged(&[away("gym", 2), away("lunch", 3)]),
            Some((PresenceState::Away, None, Some("lunch".into())))
        );
    }

    /// Rule 2: otherwise in a room on any session is in a room, the one moved
    /// into most recently, and it beats around and idle on the others.
    #[test]
    fn a_room_on_any_session_is_in_the_room_moved_into_last() {
        use PresenceState::{Around, Idle, InRoom};
        let (first, second) = (RoomId::new(), RoomId::new());
        assert_eq!(
            merged(&[said(Idle, None, 9), said(Around, Some(first), 1)]),
            Some((InRoom, Some(first), None))
        );
        assert_eq!(
            merged(&[said(Around, Some(first), 1), said(Around, Some(second), 2)]),
            Some((InRoom, Some(second), None))
        );
        assert_eq!(
            merged(&[said(Around, Some(first), 3), said(Around, Some(second), 2)]),
            Some((InRoom, Some(first), None))
        );
        // Leaving a room is a move too, but it moves nobody into one.
        assert_eq!(
            merged(&[said(Around, Some(first), 1), said(Around, None, 4)]),
            Some((InRoom, Some(first), None))
        );
    }

    /// Rules 3 and 4: in no room anywhere, around on any session is around,
    /// and idle only when every session is.
    #[test]
    fn idle_only_when_every_session_is() {
        use PresenceState::{Around, Idle};
        assert_eq!(
            merged(&[said(Idle, None, 0), said(Around, None, 0)]),
            Some((Around, None, None))
        );
        assert_eq!(
            merged(&[said(Idle, None, 0), said(Idle, None, 0)]),
            Some((Idle, None, None))
        );
    }

    /// What everybody is told about somebody now, if anything.
    fn told(
        gateway: &Gateway,
        user_id: UserId,
    ) -> Option<(PresenceState, Option<RoomId>, Option<String>)> {
        gateway
            .presence
            .get(&user_id)
            .map(|entry| (entry.state, entry.room_id, entry.away_message.clone()))
    }

    /// Each session speaks for itself (#653): idle, around and a room from a
    /// device that never said away can't undo the away the other set. Away
    /// ends when the session that set it says around, and the room the other
    /// has open is where they are then.
    #[test]
    fn away_ends_only_by_the_session_that_set_it() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "computer");
        gateway.connection_opened(user, "phone");
        let away = Some("out".to_string());
        assert_eq!(
            gateway.update_presence(user, "computer", PresenceState::Away, away.clone()),
            Merged::Changed
        );
        assert_eq!(gateway.move_to(user, "phone", Some(room)), Merged::Same);
        assert_eq!(
            gateway.update_presence(user, "phone", PresenceState::Idle, None),
            Merged::Same
        );
        assert_eq!(
            gateway.update_presence(user, "phone", PresenceState::Around, None),
            Merged::Same
        );
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::Away, None, away))
        );

        assert_eq!(
            gateway.update_presence(user, "computer", PresenceState::Around, None),
            Merged::Moved
        );
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
    }

    /// The session that set away going takes its away with it (#653), and
    /// the room the other device has open is where they are.
    #[test]
    fn away_ends_when_the_session_that_set_it_goes() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "computer");
        gateway.connection_opened(user, "phone");
        gateway.update_presence(user, "computer", PresenceState::Away, Some("out".into()));
        gateway.move_to(user, "phone", Some(room));
        assert_eq!(gateway.connection_closed(user, "computer"), Merged::Moved);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
    }

    /// Moving is somebody being there: a session that was idle is around
    /// again, as one device always was.
    #[test]
    fn moving_ends_that_sessions_idle() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "computer");
        gateway.update_presence(user, "computer", PresenceState::Idle, None);
        assert_eq!(gateway.move_to(user, "computer", Some(room)), Merged::Moved);
        assert_eq!(gateway.move_to(user, "computer", None), Merged::Moved);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::Around, None, None))
        );
    }

    /// A resume can take a session over while the server still holds the
    /// socket it replaces (#451). The record lasts until the session's last
    /// socket goes, and the person until their last session's record does.
    #[test]
    fn a_session_lasts_until_its_last_socket_closes() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "phone");
        gateway.move_to(user, "phone", Some(room));
        gateway.connection_opened(user, "phone");
        assert_eq!(gateway.connection_closed(user, "phone"), Merged::Same);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
        assert_eq!(gateway.connection_closed(user, "phone"), Merged::Same);
        assert_eq!(told(&gateway, user), None, "offline once it's gone");
        assert!(gateway.session_presence.get(&user).is_none());
    }

    /// Clearing the away saved on the status ends away on every session
    /// (#653), each in whatever room it has open, and changes nothing for
    /// somebody who wasn't away.
    #[test]
    fn coming_back_ends_away_on_every_session() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "computer");
        gateway.connection_opened(user, "phone");
        assert_eq!(gateway.back_everywhere(user), Merged::Same);
        gateway.update_presence(user, "computer", PresenceState::Away, Some("out".into()));
        gateway.update_presence(user, "phone", PresenceState::Away, Some("out".into()));
        gateway.move_to(user, "phone", Some(room));
        assert_eq!(gateway.back_everywhere(user), Merged::Moved);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
        // The device's own `around` afterwards changes nothing.
        assert_eq!(
            gateway.update_presence(user, "computer", PresenceState::Around, None),
            Merged::Same
        );
    }

    // --- a short drop (#654) ------------------------------------------------

    /// A socket dropping without a goodbye leaves its session's record, still
    /// counted, until the grace period ends; then the person is offline.
    #[test]
    fn a_drop_keeps_the_record_until_its_grace_period_ends() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "phone");
        gateway.move_to(user, "phone", Some(room));
        let number = gateway
            .connection_dropped(user, "phone")
            .expect("it was the session's last socket");
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
        assert_eq!(gateway.grace_over(user, "phone", number), Merged::Same);
        assert_eq!(told(&gateway, user), None, "offline once it's over");
        assert!(gateway.session_presence.get(&user).is_none());
    }

    /// Resumed inside the grace period: the app saying where it was again
    /// changes nothing, and nor does the grace period ending.
    #[test]
    fn a_resume_inside_the_grace_period_changes_nothing() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let away = Some("lunch".to_string());
        gateway.connection_opened(user, "phone");
        gateway.update_presence(user, "phone", PresenceState::Away, away.clone());
        let number = gateway.connection_dropped(user, "phone").expect("last");
        gateway.connection_opened(user, "phone");
        assert_eq!(
            gateway.update_presence(user, "phone", PresenceState::Away, away.clone()),
            Merged::Same
        );
        assert_eq!(gateway.grace_over(user, "phone", number), Merged::Same);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::Away, None, away))
        );
    }

    /// The app starts again from around in no room on a resume, and says
    /// only where it differs. Idle before the drop and back at the keyboard
    /// by the resume, it says nothing, so the end of the grace period is
    /// what makes it around.
    #[test]
    fn an_app_that_says_nothing_after_a_resume_is_around_when_its_grace_period_ends() {
        let gateway = Gateway::new();
        let user = UserId::new();
        gateway.connection_opened(user, "computer");
        gateway.update_presence(user, "computer", PresenceState::Idle, None);
        let number = gateway.connection_dropped(user, "computer").expect("last");
        gateway.connection_opened(user, "computer");
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::Idle, None, None)),
            "what it said stands until it speaks"
        );
        assert_eq!(
            gateway.grace_over(user, "computer", number),
            Merged::Changed
        );
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::Around, None, None))
        );
    }

    /// The first thing the app says after a resume starts its record again
    /// from where the app starts: idle before the drop, and opening the same
    /// room again, it is around in that room, not idle in it.
    #[test]
    fn the_first_frame_after_a_resume_starts_the_record_again() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "computer");
        gateway.move_to(user, "computer", Some(room));
        gateway.update_presence(user, "computer", PresenceState::Idle, None);
        let number = gateway.connection_dropped(user, "computer").expect("last");
        gateway.connection_opened(user, "computer");
        assert_eq!(gateway.move_to(user, "computer", Some(room)), Merged::Same);
        let state = gateway
            .session_presence
            .get(&user)
            .and_then(|sessions| sessions.get("computer").map(|own| own.state));
        assert_eq!(state, Some(PresenceState::Around));
        assert_eq!(gateway.grace_over(user, "computer", number), Merged::Same);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
    }

    /// Dropped, resumed and dropped again: the second drop's grace period is
    /// the one that counts, and the first one's end does nothing.
    #[test]
    fn only_the_newest_drop_ends_the_record() {
        let gateway = Gateway::new();
        let user = UserId::new();
        gateway.connection_opened(user, "phone");
        let first = gateway.connection_dropped(user, "phone").expect("last");
        gateway.connection_opened(user, "phone");
        let second = gateway.connection_dropped(user, "phone").expect("last");
        assert_ne!(first, second);
        assert_eq!(gateway.grace_over(user, "phone", first), Merged::Same);
        assert!(
            told(&gateway, user).is_some(),
            "the first drop's end took them offline"
        );
        assert_eq!(gateway.grace_over(user, "phone", second), Merged::Same);
        assert_eq!(told(&gateway, user), None);
    }

    /// A socket a resume already replaced (#451) closing without a goodbye
    /// wasn't its session's last, and starts no grace period.
    #[test]
    fn a_replaced_socket_dropping_starts_no_grace_period() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "phone");
        gateway.move_to(user, "phone", Some(room));
        gateway.connection_opened(user, "phone");
        assert_eq!(gateway.connection_dropped(user, "phone"), None);
        let dropped = gateway
            .session_presence
            .get(&user)
            .and_then(|sessions| sessions.get("phone").map(|own| own.dropped));
        assert_eq!(dropped, Some(None));
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
    }

    /// A device that drops and never comes back leaves the person's other
    /// device saying where they are, once the grace period ends.
    #[test]
    fn a_device_that_never_comes_back_leaves_the_other() {
        let gateway = Gateway::new();
        let user = UserId::new();
        let room = RoomId::new();
        gateway.connection_opened(user, "computer");
        gateway.connection_opened(user, "phone");
        gateway.move_to(user, "phone", Some(room));
        let number = gateway.connection_dropped(user, "phone").expect("last");
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::InRoom, Some(room), None))
        );
        assert_eq!(gateway.grace_over(user, "phone", number), Merged::Moved);
        assert_eq!(
            told(&gateway, user),
            Some((PresenceState::Around, None, None))
        );
    }
}
