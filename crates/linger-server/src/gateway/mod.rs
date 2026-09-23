//! The gateway (PROTOCOL §8): WS at `/api/v1/gateway`.
//!
//! Shape: one broadcast bus of [`Fanout`]s — an event plus who it is for; a
//! *session task* per session that assigns per-session sequence numbers, keeps
//! the 500-frame resume ring, and forwards to whichever socket is currently
//! attached. The session task outlives its socket by up to 120s
//! (`RESUME_WINDOW_MS`) so a reconnecting client can replay what it missed —
//! no gaps, no duplicates.
//!
//! Presence lives in memory only, on purpose (ARCHITECTURE §5): restart ⇒
//! everyone offline until they reconnect.

mod socket;

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use linger_core::gateway::{ServerEvent, ServerFrame, VoiceControls, VoicePeer, VoiceRoomState};
use linger_core::limits::{MAX_VOICE_PEERS, RESUME_BUFFER_FRAMES, RESUME_WINDOW_MS};
use linger_core::wire::{PresenceEntry, PresenceState};
use linger_core::{RoomId, UserId};
use tokio::sync::{broadcast, mpsc, oneshot};

pub use socket::ws_route;

/// Everything the fan-out layer holds. Lives in `AppState` as `Arc<Gateway>`;
/// REST handlers publish mutation events through [`Gateway::publish`].
pub struct Gateway {
    bus: broadcast::Sender<Arc<Fanout>>,
    sessions: DashMap<String, SessionHandle>,
    presence: DashMap<UserId, PresenceEntry>,
    conn_count: DashMap<UserId, u32>,
    /// Who is in each DM (SPEC §4.13). Public rooms are not in here — their
    /// members are everybody, and a room absent from this map is treated as
    /// public, which is the one place this design has to be careful.
    ///
    /// It is in memory because the fan-out is not async: presence and room
    /// focus are decided while a socket is being torn down, with no database
    /// handle and no place to await one. So it is loaded once at startup by
    /// [`Gateway::reload_dms`], and every path that can change a DM's
    /// membership calls that again — creating a DM, and removing or restoring
    /// a member. There are exactly three, and there is no fourth, because
    /// membership is fixed when a DM is made (PROTOCOL §3.1).
    ///
    /// **The startup load is not allowed to fail quietly.** `main` refuses to
    /// start the server if it does, because the failure mode of an empty map is
    /// every DM on the server looking like a public room.
    dm_members: DashMap<RoomId, Arc<[UserId]>>,
    /// Which voice room each session is in, if any (SPEC §4.14).
    ///
    /// Keyed by session rather than by person: a peer connection is between two
    /// clients, and one person on a laptop and a desktop is two of them. In
    /// memory and nowhere else — voice is entirely a fact about who is
    /// connected right now, so a restart ending every call is correct rather
    /// than a gap, in the same way presence is (ARCHITECTURE §5).
    voice: DashMap<String, VoiceSeat>,
}

/// One session's place in a voice room.
struct VoiceSeat {
    room_id: RoomId,
    user_id: UserId,
    controls: Option<VoiceControls>,
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
    /// Narrower than `to`: one session, not one person. Voice signalling is the
    /// only thing that uses it.
    to_session: Option<String>,
    /// Which room this frame is about, if any. Worked out from the event by
    /// `room_of` for every frame that names a room, and passed in for
    /// `reaction.update`, which names a message instead.
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
        // could be: the routing already decided both peers are in the same
        // voice room, and this frame goes to exactly one of them.
        ServerEvent::VoiceSignal { .. } => None,

        // About a person, not a place.
        ServerEvent::PresenceUpdate(_)
        | ServerEvent::UserUpdate(_)
        | ServerEvent::UserRemove { .. }
        | ServerEvent::Knock { .. } => None,

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
    Detach,
    /// This session's user is off the server (T-413). Say so, hang up, stop.
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
            conn_count: DashMap::new(),
            dm_members: DashMap::new(),
            voice: DashMap::new(),
        }
    }

    /// Fan an event out, to whoever the event says it is for.
    ///
    /// Which room the frame is about is worked out from the frame itself
    /// (`room_of`), so a caller cannot publish a DM's message to the whole
    /// server by forgetting an argument — there is no argument to forget.
    pub fn publish(&self, event: ServerEvent) {
        let room = room_of(&event);
        // No receivers just means nobody is connected; that is fine.
        let _ = self.bus.send(Arc::new(Fanout {
            event,
            to: None,
            to_session: None,
            room,
        }));
    }

    /// Fan out a frame that belongs to a room without naming it.
    ///
    /// `reaction.update` is the only one: it names a message, and the room that
    /// message is in is what decides who may see the reaction. The caller has
    /// the message in hand and so has the room; the frame does not carry it,
    /// because a client that receives the frame already holds the message.
    pub fn publish_in(&self, room_id: RoomId, event: ServerEvent) {
        let _ = self.bus.send(Arc::new(Fanout {
            event,
            to: None,
            to_session: None,
            room: Some(room_id),
        }));
    }

    /// Reload who is in every DM, from the database.
    ///
    /// Called at startup and after anything that changes membership. Cheap at
    /// this scale — a handful of DMs with a handful of people each — and doing
    /// it wholesale rather than incrementally means there is no "update the
    /// index" step for a future change to forget.
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
        let _ = self.bus.send(Arc::new(Fanout {
            event,
            to: None,
            to_session: Some(session_id.to_string()),
            room: None,
        }));
    }

    /// Fan an event out to one person's sessions and nobody else's (T-1101).
    ///
    /// All of them, not one: somebody signed in on a laptop and a desktop is
    /// one person, and a knock that landed on whichever machine happened to
    /// connect first would be a knock they never saw.
    pub fn publish_to(&self, user_id: UserId, event: ServerEvent) {
        let _ = self.bus.send(Arc::new(Fanout {
            event,
            to: Some(user_id),
            to_session: None,
            room: None,
        }));
    }

    /// Hang up on every session this person has open (T-413).
    ///
    /// Removal is only real once the socket is gone. The token check at
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

    /// Who is in voice in a room, in a stable order.
    ///
    /// Sorted by session id, which is the same order both ends of a pair
    /// compare when they work out who offers — so a client can read the answer
    /// straight off the list rather than deriving it.
    #[must_use]
    fn voice_peers(&self, room_id: RoomId) -> Vec<VoicePeer> {
        let mut peers: Vec<VoicePeer> = self
            .voice
            .iter()
            .filter(|seat| seat.value().room_id == room_id)
            .map(|seat| VoicePeer {
                session_id: seat.key().clone(),
                user_id: seat.value().user_id,
                controls: seat.value().controls,
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
    /// Answers `false` when the room is full. The caller has already checked
    /// that this person can see the room; this only knows about seats.
    pub fn voice_join(
        &self,
        session_id: &str,
        user_id: UserId,
        room_id: RoomId,
        controls: Option<VoiceControls>,
    ) -> bool {
        let controls = controls.map(VoiceControls::normalized);
        if let Some(mut seat) = self.voice.get_mut(session_id) {
            if seat.value().room_id == room_id {
                let changed = controls.is_some() && controls != seat.controls;
                if changed {
                    seat.controls = controls;
                }
                drop(seat);
                if changed {
                    self.announce_voice(room_id);
                }
                return true;
            }
        }
        // Counted before the seat is taken, and only for a room this session is
        // not already in — otherwise re-joining the room you are in could be
        // refused by your own seat.
        if self.voice_peers(room_id).len() >= MAX_VOICE_PEERS {
            return false;
        }
        let left = self.voice_leave(session_id);
        self.voice.insert(
            session_id.to_string(),
            VoiceSeat {
                room_id,
                user_id,
                controls,
            },
        );
        if let Some(previous) = left {
            self.announce_voice(previous);
        }
        self.announce_voice(room_id);
        true
    }

    /// Take a session out of voice. Answers which room it left, if any.
    ///
    /// **Does not announce.** Callers that are only leaving announce it
    /// themselves; `voice_join` needs to move the seat before announcing
    /// either room, or a client can see itself in two rooms at once.
    fn voice_leave(&self, session_id: &str) -> Option<RoomId> {
        self.voice.remove(session_id).map(|(_, seat)| seat.room_id)
    }

    /// Leave voice and tell the room. The ordinary way out.
    pub fn voice_part(&self, session_id: &str) {
        if let Some(room_id) = self.voice_leave(session_id) {
            self.announce_voice(room_id);
        }
    }

    /// Where a session is in voice, and who it is.
    ///
    /// One lookup rather than two, because the routing check needs both and
    /// wants them from the same instant — a seat that moves between two reads
    /// is a signal delivered into the wrong room.
    #[must_use]
    pub fn voice_seat_of(&self, session_id: &str) -> Option<(RoomId, UserId)> {
        self.voice
            .get(session_id)
            .map(|seat| (seat.value().room_id, seat.value().user_id))
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
                let mut entry = e.value().clone();
                if let Some(room_id) = entry.room_id {
                    if !self.can_see_room(receiver, room_id) {
                        entry.room_id = None;
                    }
                }
                entry
            })
            .collect()
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

    /// Apply a client `presence.update`. Room membership only changes via
    /// `room.focus`, so it is carried over from the existing entry.
    fn apply_presence(
        &self,
        user_id: UserId,
        state: PresenceState,
        away_message: Option<String>,
    ) -> PresenceEntry {
        let prev = self.presence.get(&user_id).map(|e| e.value().clone());
        let room_id = prev.as_ref().and_then(|p| p.room_id);
        let entry = PresenceEntry {
            user_id,
            state,
            room_id,
            away_message,
        };
        self.presence.insert(user_id, entry.clone());
        entry
    }

    /// Apply a `room.focus` (or a `None` = left the room) and emit the resulting
    /// events, in protocol order: leave → enter → occupancy → presence.
    fn apply_room_focus(
        &self,
        user_id: UserId,
        room_id: Option<RoomId>,
        entrance_sound: Option<String>,
    ) {
        let prev_room = self.presence.get(&user_id).and_then(|e| e.value().room_id);
        if prev_room == room_id {
            return;
        }

        let entry = {
            let mut entry = self
                .presence
                .get(&user_id)
                .map(|e| e.value().clone())
                .unwrap_or_else(|| offline_entry(user_id));
            entry.room_id = room_id;
            entry.state = if room_id.is_some() {
                PresenceState::InRoom
            } else {
                PresenceState::Around
            };
            self.presence.insert(user_id, entry.clone());
            entry
        };

        if let Some(prev) = prev_room {
            self.publish(ServerEvent::RoomLeave {
                room_id: prev,
                user_id,
            });
            self.publish(ServerEvent::RoomOccupancy {
                room_id: prev,
                user_ids: self.occupancy(prev),
            });
        }
        if let Some(new) = room_id {
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
        self.publish(ServerEvent::PresenceUpdate(entry));
    }

    /// A connection came up for this user. First connection ⇒ visible presence.
    fn connection_opened(&self, user_id: UserId) {
        let mut count = self.conn_count.entry(user_id).or_insert(0);
        *count += 1;
        if *count == 1 {
            let entry = self.apply_presence(user_id, PresenceState::Around, None);
            self.publish(ServerEvent::PresenceUpdate(entry));
        }
    }

    /// A connection went away. Last connection ⇒ offline (leaving any room).
    fn connection_closed(&self, user_id: UserId) {
        let remaining = {
            let mut count = self.conn_count.entry(user_id).or_insert(1);
            *count = count.saturating_sub(1);
            *count
        };
        if remaining == 0 {
            self.conn_count.remove(&user_id);
            self.apply_room_focus(user_id, None, None);
            self.presence.remove(&user_id);
            self.publish(ServerEvent::PresenceUpdate(offline_entry(user_id)));
        }
    }

    /// PROTOCOL §8 fan-out rules: what this person gets, if anything.
    ///
    /// Returns the frame to send, which is not always the frame that was
    /// published — `presence.update` is *redacted* for somebody who cannot see
    /// the room its subject is in, rather than withheld. Withholding it would
    /// make that person look offline to everybody they are not currently
    /// talking to, which is both wrong and a slower way of leaking the same
    /// thing (SPEC §4.13).
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
    fn visible_to(
        &self,
        receiver: UserId,
        session_id: &str,
        fanout: &Fanout,
    ) -> Option<ServerEvent> {
        if let Some(target) = &fanout.to_session {
            return (target == session_id).then(|| fanout.event.clone());
        }
        if let Some(target) = fanout.to {
            return (target == receiver).then(|| fanout.event.clone());
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

        if let ServerEvent::PresenceUpdate(entry) = &fanout.event {
            if let Some(room_id) = entry.room_id {
                if !self.can_see_room(receiver, room_id) {
                    let mut redacted = entry.clone();
                    redacted.room_id = None;
                    return Some(ServerEvent::PresenceUpdate(redacted));
                }
            }
        }

        Some(fanout.event.clone())
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

/// Spawn a session task; returns its control handle. See module docs for shape.
fn spawn_session(gateway: Arc<Gateway>, session_id: String, user_id: UserId) -> mpsc::Sender<Ctl> {
    let (ctl_tx, mut ctl_rx) = mpsc::channel::<Ctl>(16);
    let mut bus_rx = gateway.bus.subscribe();

    tokio::spawn(async move {
        let mut seq: u64 = 0;
        let mut ring: VecDeque<(u64, String)> = VecDeque::with_capacity(RESUME_BUFFER_FRAMES);
        let mut sink: Option<mpsc::Sender<String>> = None;
        // Held alongside the sink and replaced with it: it belongs to whichever
        // socket is attached right now, not to the session.
        let mut closer: Option<oneshot::Sender<()>> = None;
        // Starts "detached": if the handshake never attaches, the sweep reaps us.
        let mut detached_at: Option<Instant> = Some(Instant::now());
        let mut sweep = tokio::time::interval(Duration::from_secs(5));

        loop {
            tokio::select! {
                event = bus_rx.recv() => match event {
                    Ok(event) => {
                        let Some(mine) = gateway.visible_to(user_id, &session_id, &event) else {
                            continue;
                        };
                        seq += 1;
                        let frame = ServerFrame::sequenced(mine, seq);
                        let Ok(json) = serde_json::to_string(&frame) else { continue };
                        if ring.len() == RESUME_BUFFER_FRAMES {
                            ring.pop_front();
                        }
                        ring.push_back((seq, json.clone()));
                        if let Some(tx) = &sink {
                            // A full queue means a dead or pathologically slow
                            // socket; detach and let resume recover it.
                            if tx.try_send(json).is_err() {
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
                            .map(|(_, j)| j.clone())
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
                    Some(Ctl::Detach) => {
                        sink = None;
                        closer = None;
                        detached_at = Some(Instant::now());
                    }
                    Some(Ctl::Close) => {
                        // "unauthenticated" rather than a word of its own: it is
                        // what this token now is, and it is the one reason the
                        // client already answers by asking for a fresh token —
                        // which the server refuses, which signs them out. A
                        // reason nobody handles would leave them reconnecting
                        // into a locked door forever.
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
                _ = sweep.tick() => {
                    let expired = detached_at
                        .is_some_and(|t| t.elapsed() >= Duration::from_millis(RESUME_WINDOW_MS));
                    if expired {
                        break;
                    }
                }
            }
        }
        gateway.sessions.remove(&session_id);
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
