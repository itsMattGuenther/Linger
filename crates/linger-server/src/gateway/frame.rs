//! An event's JSON, made once and shared by everybody it goes to (#519).
//!
//! Every session numbers the frames it sends with its own sequence (`s`), so
//! the same event is a different frame for each of them. What differs is only
//! the number at the end: a `ServerFrame` is its event's two fields (`op`, then
//! `d` when it has one) with `s` flattened in after them. So the event is
//! turned into JSON once, kept as one shared string in every session's resume
//! ring, and each copy that goes out gets `,"s":N` spliced in before the
//! closing brace.
//!
//! The splice has to produce exactly the bytes `ServerFrame::sequenced` would.
//! If serde ever wrote the two differently, a frame would reach an app looking
//! like something it can't read, and a resume would replay it the same way.
//! The tests below hold that for every kind of event the gateway sends.

use std::fmt::Write as _;
use std::sync::Arc;

use linger_core::gateway::ServerEvent;

/// An event as JSON, without its sequence number. Cheap to clone: every
/// session it reaches holds the same string.
#[derive(Debug, Clone)]
pub(super) struct EventJson(Arc<str>);

impl EventJson {
    /// Serialize an event once, for everybody it goes to.
    pub(super) fn of(event: &ServerEvent) -> serde_json::Result<Self> {
        serde_json::to_string(event).map(|json| Self(json.into()))
    }

    /// The frame one session sends: these bytes are
    /// `serde_json::to_string(&ServerFrame::sequenced(event, s))`.
    pub(super) fn sequenced(&self, s: u64) -> String {
        // An event is always a JSON object (`{"op":…}`), so it ends in `}`,
        // which is one byte: slicing it off can't split a character.
        debug_assert!(self.0.ends_with('}'), "an event that isn't an object");
        let head = &self.0[..self.0.len() - 1];
        let mut frame = String::with_capacity(self.0.len() + 26);
        frame.push_str(head);
        // Writing to a String can't fail.
        let _ = write!(frame, ",\"s\":{s}}}");
        frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use linger_core::gateway::{
        ReadyData, ServerFrame, VoiceControls, VoicePeer, VoiceRoomState, VoiceTrack,
    };
    use linger_core::wire::{
        Attachment, ColorKey, CustomEmoji, Fill, Message, Motd, NameEffect, PresenceEntry,
        PresenceState, ReactionGroup, Room, RoomKind, StatusField, Style, User, UserStatus,
    };
    use linger_core::{AttachmentId, EmojiId, MessageId, RoomId, UserId};

    /// Words that are hard to get right in JSON: quotes, a backslash, braces
    /// (a `}` inside a string must not be mistaken for the end), control
    /// characters, and letters outside ASCII.
    const AWKWARD: &str = "say \"hi\" \\ {ok} }\n\t\u{1}é 🦆 \u{2028}";

    fn user(id: UserId) -> User {
        User {
            id,
            username: "jules".into(),
            display_name: AWKWARD.into(),
            is_host: false,
            is_cohost: true,
            style: Style {
                font_key: "geist-sans".into(),
                weight: 700,
                italic: true,
                fill: Fill::Gradient {
                    from: ColorKey("lamp".into()),
                    to: ColorKey("slate".into()),
                },
                effect: NameEffect::Shimmer,
                msg_font_key: Some("fraunces".into()),
            },
            status: Some(UserStatus {
                line: Some(AWKWARD.into()),
                fields: Some(vec![StatusField {
                    label: "Reading".into(),
                    value: AWKWARD.into(),
                }]),
                away_since: Some(1_700_000_000_000),
                ..UserStatus::default()
            }),
            entrance_sound: Some("door".into()),
            last_seen_at: None,
            time_zone: Some("America/Chicago".into()),
        }
    }

    fn room(id: RoomId, kind: RoomKind) -> Room {
        Room {
            id,
            slug: "general".into(),
            name: AWKWARD.into(),
            topic: Some(AWKWARD.into()),
            kind,
            member_ids: (kind == RoomKind::Dm).then(|| vec![UserId::new(), UserId::new()]),
            position: -3,
            archived_at: None,
            last_message_id: Some(MessageId::new()),
            motd: Some(Motd {
                text: AWKWARD.into(),
                set_by: UserId::new(),
                set_at: 1_700_000_000_000,
            }),
            reactions_off: Some(true),
            someone_left: None,
        }
    }

    fn message(room_id: RoomId) -> Message {
        let author = UserId::new();
        Message {
            id: MessageId::new(),
            room_id,
            author_id: author,
            body: AWKWARD.into(),
            reply_to: Some(MessageId::new()),
            attachments: vec![Attachment {
                id: AttachmentId::new(),
                filename: "lake \"trip\".jpg".into(),
                mime: "image/jpeg".into(),
                size_bytes: u64::MAX,
                url: "https://media.example/a?b=c&d=e".into(),
                width: Some(4032),
                height: Some(3024),
                duration_ms: None,
                blurhash: Some("LEHV6nWB2yk8pyo0adR*.7kCMdnj".into()),
                poster_url: None,
                display_url: Some("https://media.example/a/960".into()),
                starred_at: Some(0),
                uploader_id: author,
                created_at: i64::MIN,
            }],
            reactions: vec![ReactionGroup {
                key: "👍".into(),
                count: 2,
                user_ids: vec![author, UserId::new()],
            }],
            pinned_at: Some(1),
            edited_at: None,
            deleted_at: None,
            created_at: 1_700_000_000_000,
            motd: None,
            voice_join: Some(true),
            poll: None,
            poll_closed: None,
            left: None,
        }
    }

    fn presence(room_id: Option<RoomId>) -> PresenceEntry {
        PresenceEntry {
            user_id: UserId::new(),
            state: PresenceState::InRoom,
            room_id,
            away_message: Some(AWKWARD.into()),
        }
    }

    /// One of every event, with the awkward words wherever there are words.
    fn every_kind() -> Vec<ServerEvent> {
        let room_id = RoomId::new();
        let user_id = UserId::new();
        let peers = vec![VoicePeer {
            session_id: AWKWARD.into(),
            user_id,
            controls: Some(VoiceControls {
                muted: true,
                deafened: false,
            }),
            forwarded: Some(true),
        }];
        vec![
            ServerEvent::Hello {
                heartbeat_interval_ms: 30_000,
            },
            ServerEvent::Ready(ReadyData {
                session_id: "s".into(),
                user: user(user_id),
                users: vec![user(UserId::new())],
                rooms: vec![room(room_id, RoomKind::Room)],
                dms: vec![room(RoomId::new(), RoomKind::Dm)],
                presence: vec![presence(Some(room_id))],
                voice: Some(vec![VoiceRoomState {
                    room_id,
                    peers: peers.clone(),
                }]),
                emoji: None,
                reactions: Some(true),
                deleted_users: Some(vec![UserId::new()]),
            }),
            ServerEvent::Resumed { replayed: 0 },
            ServerEvent::InvalidSession {
                reason: AWKWARD.into(),
            },
            ServerEvent::HeartbeatAck,
            ServerEvent::MessageCreate(message(room_id)),
            ServerEvent::MessageUpdate(message(room_id)),
            ServerEvent::MessageDelete {
                id: MessageId::new(),
                room_id,
            },
            ServerEvent::ReactionUpdate {
                message_id: MessageId::new(),
                key: "emoji:abc".into(),
                count: 0,
                user_ids: vec![],
            },
            ServerEvent::PresenceUpdate(presence(None)),
            ServerEvent::RoomOccupancy {
                room_id,
                user_ids: vec![user_id, UserId::new()],
            },
            ServerEvent::RoomEnter {
                room_id,
                user_id,
                entrance_sound: None,
            },
            ServerEvent::RoomLeave { room_id, user_id },
            ServerEvent::UserUpdate(user(user_id)),
            ServerEvent::UserRemove {
                user_id,
                deleted: Some(true),
            },
            ServerEvent::RoomCreate(room(room_id, RoomKind::Dm)),
            ServerEvent::RoomUpdate(room(room_id, RoomKind::Room)),
            ServerEvent::DmRemove { room_id },
            ServerEvent::Typing { room_id, user_id },
            ServerEvent::VoiceState { room_id, peers },
            ServerEvent::VoiceOffer {
                sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n".into(),
                tracks: vec![VoiceTrack {
                    mid: "1".into(),
                    session_id: AWKWARD.into(),
                }],
                bitrate: Some(32_000),
            },
            ServerEvent::VoiceRemoved { room_id },
            ServerEvent::Knock {
                from_user_id: user_id,
            },
            ServerEvent::BlockUpdate {
                user_id,
                blocked: true,
            },
            ServerEvent::ReadUpdate {
                room_id,
                last_read_id: MessageId::new(),
            },
            ServerEvent::ReportsChanged {},
            ServerEvent::EmojiUpdate {
                emoji: vec![CustomEmoji {
                    id: EmojiId::new(),
                    name: "party_parrot".into(),
                    url: "https://media.example/e".into(),
                    animated: true,
                    created_by: user_id,
                    created_at: 1,
                }],
            },
        ]
    }

    /// Which kind of event this is, as a number. **No wildcard arm**: a new
    /// kind of event doesn't compile here until it has a number, and then
    /// `every_kind_is_covered` fails until `every_kind` has one of it.
    fn kind(event: &ServerEvent) -> usize {
        match event {
            ServerEvent::Hello { .. } => 0,
            ServerEvent::Ready(_) => 1,
            ServerEvent::Resumed { .. } => 2,
            ServerEvent::InvalidSession { .. } => 3,
            ServerEvent::HeartbeatAck => 4,
            ServerEvent::MessageCreate(_) => 5,
            ServerEvent::MessageUpdate(_) => 6,
            ServerEvent::MessageDelete { .. } => 7,
            ServerEvent::ReactionUpdate { .. } => 8,
            ServerEvent::PresenceUpdate(_) => 9,
            ServerEvent::RoomOccupancy { .. } => 10,
            ServerEvent::RoomEnter { .. } => 11,
            ServerEvent::RoomLeave { .. } => 12,
            ServerEvent::UserUpdate(_) => 13,
            ServerEvent::UserRemove { .. } => 14,
            ServerEvent::RoomCreate(_) => 15,
            ServerEvent::RoomUpdate(_) => 16,
            ServerEvent::DmRemove { .. } => 17,
            ServerEvent::Typing { .. } => 18,
            ServerEvent::VoiceState { .. } => 19,
            ServerEvent::VoiceOffer { .. } => 20,
            ServerEvent::VoiceRemoved { .. } => 21,
            ServerEvent::Knock { .. } => 22,
            ServerEvent::BlockUpdate { .. } => 23,
            ServerEvent::ReportsChanged {} => 24,
            ServerEvent::EmojiUpdate { .. } => 25,
            ServerEvent::ReadUpdate { .. } => 26,
        }
    }
    const KINDS: usize = 27;

    #[test]
    fn every_kind_is_covered() {
        let mut seen = [false; KINDS];
        for event in every_kind() {
            seen[kind(&event)] = true;
        }
        let missing: Vec<usize> = (0..KINDS).filter(|k| !seen[*k]).collect();
        assert!(missing.is_empty(), "no sample of kinds {missing:?}");
    }

    /// The splice is byte for byte what serializing the frame gives, for
    /// every kind of event and for numbers at both ends of the range.
    #[test]
    fn splicing_a_sequence_number_matches_serializing_the_frame() {
        for event in every_kind() {
            let shared = EventJson::of(&event).expect("serializes");
            for s in [0, 1, 9, 10, 499, 500, 123_456_789, u64::MAX] {
                let expected = serde_json::to_string(&ServerFrame::sequenced(event.clone(), s))
                    .expect("serializes");
                assert_eq!(shared.sequenced(s), expected, "kind {}", kind(&event));
            }
        }
    }

    /// And an app reads it back as the same frame, with its number.
    #[test]
    fn a_spliced_frame_reads_back_with_its_number() {
        for event in every_kind() {
            let wire = EventJson::of(&event).expect("serializes").sequenced(42);
            let back: ServerFrame = serde_json::from_str(&wire).expect("reads back");
            assert_eq!(back.s, Some(42));
            assert_eq!(kind(&back.event), kind(&event));
        }
    }
}
