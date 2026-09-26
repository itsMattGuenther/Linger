//! Gateway frames (PROTOCOL §8). JSON over WSS at `/api/v1/gateway`.
//!
//! Frames are `{ op, d, s? }`. `s` is a monotonically increasing sequence number,
//! present on server→client frames only — it is what makes resume replay possible.
//! Clients must ignore unknown `op` values and unknown fields (PROTOCOL §9), which
//! is why `ServerEvent`/`ClientEvent` may gain variants within v1 but never lose any.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::id::{MessageId, RoomId, UserId};
use crate::wire::{Message, PresenceEntry, PresenceState, Room, User};

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/// A client frame is just `{ op, d }` — no sequence number in this direction.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "op", content = "d", rename_all = "snake_case")]
#[ts(export)]
pub enum ClientFrame {
    Identify {
        token: String,
        /// e.g. "linger-desktop/0.1.0"
        client: String,
    },
    Resume {
        session_id: String,
        token: String,
        /// Last sequence number the client saw.
        #[ts(type = "number")]
        s: u64,
    },
    Heartbeat {
        /// Last sequence number seen, for the server's replay bookkeeping.
        #[ts(type = "number | null")]
        s: Option<u64>,
    },
    /// What a person is telling the server about themselves: in a room, around,
    /// idle, away — and an away message if they set one. Nothing about what
    /// application they have open (`docs/decisions.md`, 2026-08-28).
    #[serde(rename = "presence.update")]
    PresenceUpdate {
        state: PresenceState,
        away_message: Option<String>,
    },
    /// Fired when the client focuses a room. `room_id: None` means the user
    /// left the room (unfocused, backgrounded, or idle).
    #[serde(rename = "room.focus")]
    RoomFocus { room_id: Option<RoomId> },
    #[serde(rename = "typing.start")]
    TypingStart { room_id: RoomId },
    /// Turn your microphone on in a room you are already in (SPEC §4.14).
    /// Joining voice somewhere else leaves wherever you were.
    #[serde(rename = "voice.join")]
    VoiceJoin {
        room_id: RoomId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        controls: Option<VoiceControls>,
        /// This client can take its voice through the server's forwarding
        /// (#197) rather than the mesh. Absent from older clients, which the
        /// server keeps on the mesh.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        forwarding: Option<bool>,
    },
    /// No room id: you are in voice in at most one room, so there is only one
    /// thing this could mean.
    #[serde(rename = "voice.leave")]
    VoiceLeave,
    /// One WebRTC message for one peer.
    ///
    /// `payload` is an offer, an answer or an ICE candidate, and the server
    /// does not parse it — it forwards it to `to` and that is the whole of its
    /// involvement in voice (PROTOCOL §8).
    #[serde(rename = "voice.signal")]
    VoiceSignal {
        /// The peer's session id, from `voice.state`.
        to: String,
        kind: VoiceSignalKind,
        payload: String,
    },
    /// The answer to the server's latest `voice.offer` (#197). With
    /// forwarding, the server makes every offer and the client only answers,
    /// so two offers can never cross.
    #[serde(rename = "voice.answer")]
    VoiceAnswer { sdp: String },
    /// Start this session's connection to the forwarding server afresh (#197):
    /// the client's connection failed, but it is still in voice. The server
    /// answers with a new `voice.offer`; nobody else sees a leave or a join.
    #[serde(rename = "voice.restart")]
    VoiceRestart,
}

/// What a `voice.signal` is carrying. The server routes on the frame and never
/// looks inside `payload`, so this exists for the receiving client's benefit —
/// it says which of the three things to do with the string without parsing it
/// to find out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum VoiceSignalKind {
    Offer,
    Answer,
    Candidate,
}

/// One client in a voice room (SPEC §4.14).
///
/// Keyed by session rather than by person: a peer connection is between two
/// *clients*, and somebody signed in on a laptop and a desktop is two of them.
/// `user_id` is there so a client can draw a name against a peer without
/// looking anything up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoicePeer {
    pub session_id: String,
    pub user_id: UserId,
    /// Absent on legacy clients/servers: unknown, never evidence of a live mic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub controls: Option<VoiceControls>,
    /// Their voice goes through the server's forwarding (#197), not the mesh.
    /// A mesh client can't reach them, and doesn't try.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub forwarded: Option<bool>,
}

/// One receiving m-line in a `voice.offer`, and whose voice it carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceTrack {
    pub mid: String,
    pub session_id: String,
}

/// Self-reported voice controls, visible only to the room's members.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceControls {
    pub muted: bool,
    pub deafened: bool,
}

impl VoiceControls {
    /// Deafen must never advertise an open microphone, even from a bad client.
    #[must_use]
    pub fn normalized(self) -> Self {
        Self {
            muted: self.muted || self.deafened,
            ..self
        }
    }
}

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

/// An occupied room's voice roster at sign-in, filtered by room membership.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct VoiceRoomState {
    pub room_id: RoomId,
    pub peers: Vec<VoicePeer>,
}

/// Payload of `ready`: everything a client needs to render without further fetches.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReadyData {
    pub session_id: String,
    pub user: User,
    pub users: Vec<User>,
    /// The server's rooms — the same list for everybody.
    pub rooms: Vec<Room>,
    /// The DMs *this person* is in, which is a different list for everybody
    /// (SPEC §4.13). Separate from `rooms` rather than mixed into it, so a
    /// surface that draws the server's rooms cannot draw somebody's DM by
    /// forgetting a filter — it never had one to forget.
    pub dms: Vec<Room>,
    pub presence: Vec<PresenceEntry>,
    /// Older servers omit this; no microphone is opened by a snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub voice: Option<Vec<VoiceRoomState>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "op", content = "d", rename_all = "snake_case")]
#[ts(export)]
pub enum ServerEvent {
    Hello {
        #[ts(type = "number")]
        heartbeat_interval_ms: u64,
    },
    Ready(ReadyData),
    Resumed {
        /// Number of frames replayed after the resume.
        #[ts(type = "number")]
        replayed: u64,
    },
    InvalidSession {
        reason: String,
    },
    HeartbeatAck,
    #[serde(rename = "message.create")]
    MessageCreate(Message),
    #[serde(rename = "message.update")]
    MessageUpdate(Message),
    #[serde(rename = "message.delete")]
    MessageDelete {
        id: MessageId,
        room_id: RoomId,
    },
    /// `count` is present for accessibility labels; the client renders weight.
    #[serde(rename = "reaction.update")]
    ReactionUpdate {
        message_id: MessageId,
        key: String,
        count: u32,
        user_ids: Vec<UserId>,
    },
    #[serde(rename = "presence.update")]
    PresenceUpdate(PresenceEntry),
    #[serde(rename = "room.occupancy")]
    RoomOccupancy {
        room_id: RoomId,
        user_ids: Vec<UserId>,
    },
    /// Sent only to clients in that room; the receiver applies its own
    /// mute rules and quiet hours before playing anything (SPEC §4.1).
    #[serde(rename = "room.enter")]
    RoomEnter {
        room_id: RoomId,
        user_id: UserId,
        entrance_sound: Option<String>,
    },
    #[serde(rename = "room.leave")]
    RoomLeave {
        room_id: RoomId,
        user_id: UserId,
    },
    /// The current state of this person, whether or not the client already had
    /// them. It carries a whole `User`, and the client's fold appends when the
    /// id is unknown — so this is also how somebody who was not on the roster a
    /// moment ago arrives on it: somebody who just registered (T-415), or a
    /// member restored after removal (T-413).
    #[serde(rename = "user.update")]
    UserUpdate(User),
    /// This person is off the server (T-413). The mirror of `user.update`, and
    /// it names an id rather than carrying a `User`, because there is no state
    /// left to describe: the wire `User` has no `deactivated_at` field and is
    /// not going to grow one to carry a tombstone.
    #[serde(rename = "user.remove")]
    UserRemove {
        user_id: UserId,
    },
    #[serde(rename = "room.create")]
    RoomCreate(Room),
    #[serde(rename = "room.update")]
    RoomUpdate(Room),
    Typing {
        room_id: RoomId,
        user_id: UserId,
    },
    /// Who is in voice in a room (SPEC §4.14) — **the whole list, every time**.
    ///
    /// A snapshot rather than a delta, because a client that missed one still
    /// ends up right after the next one: getting this twice is harmless and
    /// missing one is not. It names a room, so it reaches that room's members
    /// and nobody else — a DM's voice room is as private as the DM (§4.13).
    #[serde(rename = "voice.state")]
    VoiceState {
        room_id: RoomId,
        peers: Vec<VoicePeer>,
    },
    /// One peer's WebRTC message, on its way to one other peer.
    ///
    /// Addressed to a single session, like `knock` is addressed to a single
    /// person — and unlike `knock`, the sender is named, because answering it
    /// is the entire point.
    #[serde(rename = "voice.signal")]
    VoiceSignal {
        from: String,
        kind: VoiceSignalKind,
        payload: String,
    },
    /// The server's offer for this session's one connection to its voice
    /// forwarding (#197): an m-line to send the microphone on, and one per
    /// other person in the room. `tracks` says whose voice each receiving
    /// m-line carries; the one it doesn't name is the microphone's. Sent again,
    /// whole, whenever somebody joins or leaves.
    #[serde(rename = "voice.offer")]
    VoiceOffer {
        sdp: String,
        tracks: Vec<VoiceTrack>,
    },
    /// A nudge from one person to one person (SPEC §4.9, T-1101).
    ///
    /// Sent to the target's sessions and nobody else's — the only frame on the
    /// gateway with an audience of one. It carries who knocked and nothing
    /// else: no message, no id, nothing to reply to. The receiver draws a card
    /// that fades on its own, and nothing is stored at either end.
    Knock {
        from_user_id: UserId,
    },
}

/// A server frame: an event plus its sequence number. `hello`, `heartbeat_ack`,
/// and pre-`ready` traffic carry no `s`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ServerFrame {
    #[serde(flatten)]
    #[ts(flatten)]
    pub event: ServerEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub s: Option<u64>,
}

impl ServerFrame {
    /// A frame that participates in resume replay (has a sequence number).
    #[must_use]
    pub fn sequenced(event: ServerEvent, s: u64) -> Self {
        Self { event, s: Some(s) }
    }

    /// A control frame outside the replay stream.
    #[must_use]
    pub fn control(event: ServerEvent) -> Self {
        Self { event, s: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_voice_controls_are_unknown_and_new_fields_are_additive() {
        let room_id = RoomId::new();
        let legacy = serde_json::json!({"op":"voice.join", "d":{"room_id":room_id}});
        assert!(matches!(
            serde_json::from_value::<ClientFrame>(legacy).unwrap(),
            ClientFrame::VoiceJoin { controls: None, .. }
        ));
        let peer: VoicePeer = serde_json::from_value(
            serde_json::json!({"session_id":"old", "user_id":UserId::new()}),
        )
        .unwrap();
        assert_eq!(peer.controls, None);
        assert!(serde_json::to_value(peer)
            .unwrap()
            .get("controls")
            .is_none());
        #[derive(Deserialize)]
        struct LegacyJoin {
            room_id: RoomId,
        }
        let modern = ClientFrame::VoiceJoin {
            room_id,
            controls: Some(VoiceControls {
                muted: true,
                deafened: true,
            }),
            forwarding: Some(true),
        };
        let wire = serde_json::to_value(modern).unwrap();
        let decoded: LegacyJoin = serde_json::from_value(wire["d"].clone()).unwrap();
        assert_eq!(decoded.room_id, room_id);
        // An older client never says it can forward, and an older server
        // never says anybody is forwarded: both read as the mesh.
        assert!(matches!(
            serde_json::from_value::<ClientFrame>(
                serde_json::json!({"op":"voice.join", "d":{"room_id":room_id}})
            )
            .unwrap(),
            ClientFrame::VoiceJoin {
                forwarding: None,
                ..
            }
        ));
        assert_eq!(peer_forwarded_default(), None);
    }

    fn peer_forwarded_default() -> Option<bool> {
        let peer: VoicePeer = serde_json::from_value(
            serde_json::json!({"session_id":"old", "user_id":UserId::new()}),
        )
        .unwrap();
        peer.forwarded
    }

    #[test]
    fn a_voice_offer_and_answer_travel_as_named_frames() {
        let offer = ServerFrame::control(ServerEvent::VoiceOffer {
            sdp: "v=0".into(),
            tracks: vec![VoiceTrack {
                mid: "1".into(),
                session_id: "s-eli".into(),
            }],
        });
        let wire = serde_json::to_value(&offer).unwrap();
        assert_eq!(wire["op"], "voice.offer");
        assert_eq!(wire["d"]["tracks"][0]["session_id"], "s-eli");
        let answer: ClientFrame =
            serde_json::from_value(serde_json::json!({"op":"voice.answer","d":{"sdp":"v=0"}}))
                .unwrap();
        assert!(matches!(answer, ClientFrame::VoiceAnswer { sdp } if sdp == "v=0"));
    }

    #[test]
    fn client_heartbeat_matches_protocol() {
        let f = ClientFrame::Heartbeat { s: Some(41) };
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["op"], "heartbeat");
        assert_eq!(json["d"]["s"], 41);
    }

    #[test]
    fn dotted_op_names_survive_round_trip() {
        let f = ClientFrame::RoomFocus { room_id: None };
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains(r#""op":"room.focus""#));
        let back: ClientFrame = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, ClientFrame::RoomFocus { room_id: None }));
    }

    #[test]
    fn server_frame_flattens_op_d_s() {
        let f = ServerFrame::sequenced(
            ServerEvent::RoomLeave {
                room_id: RoomId::new(),
                user_id: UserId::new(),
            },
            7,
        );
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["op"], "room.leave");
        assert_eq!(json["s"], 7);
        assert!(json["d"]["room_id"].is_string());

        let hello = ServerFrame::control(ServerEvent::Hello {
            heartbeat_interval_ms: 30_000,
        });
        let json = serde_json::to_value(&hello).unwrap();
        assert_eq!(json["op"], "hello");
        assert!(
            json.get("s").is_none(),
            "control frames must omit s entirely"
        );
    }

    #[test]
    fn server_frame_deserializes_from_wire_shape() {
        let raw = r#"{"op":"typing","d":{"room_id":"018f6f4a7b2c7d3e9f0a1b2c3d4e5f60","user_id":"018f6f4a7b2c7d3e9f0a1b2c3d4e5f61"},"s":12}"#;
        let f: ServerFrame = serde_json::from_str(raw).unwrap();
        assert_eq!(f.s, Some(12));
        assert!(matches!(f.event, ServerEvent::Typing { .. }));
    }
}
