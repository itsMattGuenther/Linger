//! Screen sharing (SPEC §4.20, PROTOCOL §8 "Screen sharing", #360).
//!
//! A share and each of its watchers have a screen socket of their own at
//! `/api/v1/screen`, apart from the gateway. Its first text message is a
//! [`ScreenHello`]; then binary messages carry frames, each a
//! [`SCREEN_FRAME_HEADER_BYTES`]-byte header and one encoded frame, and the
//! computer's sound when the share carries it (#736), each a header of the
//! same size ([`ScreenSoundHead`]) and one Opus packet. Text messages carry
//! what the server asks of the sharer ([`ScreenShareSays`]) and tells a
//! watcher ([`ScreenWatchSays`]), and what a watcher asks
//! ([`ScreenWatchAsks`]).
//!
//! Nothing here can carry the name of a window or an application (hard rule
//! 2): the operating system's picker chooses what is shared, and its choice
//! reaches the app as pictures alone. The sound is the computer's, less
//! Linger's own, as sound alone: nothing says which app made it.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// A video format a screen travels in. The apps make and play them with
/// WebCodecs; the server never opens one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ScreenCodec {
    /// VP8: what every engine Linger runs in can play.
    Vp8,
    /// H.264 in Annex B, its parameter sets on every key frame: what a
    /// graphics card makes cheaply, and what phones play in hardware.
    Avc1,
}

impl ScreenCodec {
    /// The format's number in a frame's header (PROTOCOL §8).
    #[must_use]
    pub fn byte(self) -> u8 {
        match self {
            Self::Vp8 => 1,
            Self::Avc1 => 2,
        }
    }

    /// The format a header's number names, if it names one.
    #[must_use]
    pub fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            1 => Some(Self::Vp8),
            2 => Some(Self::Avc1),
            _ => None,
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "vp8" => Some(Self::Vp8),
            "avc1" => Some(Self::Avc1),
            _ => None,
        }
    }
}

/// A list of formats, read leniently: a name this server doesn't know is
/// left out rather than failing the message, so an app that learns a new
/// format can still talk to an older server in the ones it shares.
fn known_codecs<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<ScreenCodec>, D::Error> {
    let names: Vec<String> = Vec::deserialize(deserializer)?;
    let mut codecs: Vec<ScreenCodec> = Vec::new();
    for codec in names.iter().filter_map(|name| ScreenCodec::from_name(name)) {
        if !codecs.contains(&codec) {
            codecs.push(codec);
        }
    }
    Ok(codecs)
}

fn known_codecs_maybe<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<ScreenCodec>>, D::Error> {
    known_codecs(deserializer).map(Some)
}

/// A session sharing its screen, as `voice.state` tells the room.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScreenShare {
    /// Frames a second it was started at: 30 or 60.
    #[ts(type = "30 | 60")]
    pub fps: u8,
}

/// The first message on a screen socket: who it is and what it is for.
/// `token` is an access token and `session_id` the gateway session it
/// belongs to, which must hold a voice seat.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ScreenHello {
    /// Start sharing, or share again at a new speed.
    Share {
        token: String,
        session_id: String,
        #[ts(type = "30 | 60")]
        fps: u8,
        /// The formats this app can make, best first.
        #[serde(deserialize_with = "known_codecs")]
        encode: Vec<ScreenCodec>,
        /// This share carries the computer's sound too (#736). Left out, or
        /// false, by an app from before it and by a share without: the
        /// server then drops any sound packet the share sends.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sound: Option<bool>,
    },
    /// Watch the share of `target`, a session in the same room's voice.
    Watch {
        token: String,
        session_id: String,
        target: String,
        /// The formats this app can play.
        #[serde(deserialize_with = "known_codecs")]
        decode: Vec<ScreenCodec>,
        /// Send this watcher the share's sound, when it has some (#736). An
        /// app from before it leaves it out and is sent none, so it is never
        /// sent a message it can't read.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sound: Option<bool>,
    },
}

/// What the server asks of a sharing app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ScreenShareSays {
    /// Make exactly these formats from now on. Empty is nothing: nobody is
    /// watching. `sound: true` is "send the sound too": the share said it
    /// carries some and somebody watching it has asked for it (#736). Left
    /// out otherwise, and by a server from before it, which passes no sound
    /// on, so an app sends none to it.
    Want {
        codecs: Vec<ScreenCodec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sound: Option<bool>,
    },
    /// Make the next frame of this format a key frame.
    Keyframe { codec: ScreenCodec },
    /// Still here, every `SCREEN_ALIVE_MS`: an app that hears nothing for
    /// a while takes the line as dropped and connects again.
    Alive,
}

/// What the server tells a watching app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ScreenWatchSays {
    /// What this socket shows now. A `target` with no `codec` is a share this
    /// app can't play; no `target` is the share having ended. `sound: true`
    /// says the share carries the computer's sound (#736), whether or not
    /// this watcher asked for it; left out otherwise.
    Showing {
        target: Option<String>,
        codec: Option<ScreenCodec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        sound: Option<bool>,
    },
    /// Still here, every `SCREEN_ALIVE_MS`, as for a share.
    Alive,
    /// This watcher's line couldn't keep up, and it was skipped forward to
    /// the next key frame: its picture was behind. Its own, nobody else's,
    /// and the share's never.
    Behind,
}

/// What a watching app can ask, once it is watching.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ScreenWatchAsks {
    /// Watch another share on this socket.
    Watch {
        target: String,
        #[serde(default, deserialize_with = "known_codecs_maybe")]
        #[ts(optional)]
        decode: Option<Vec<ScreenCodec>>,
    },
    /// This app's player lost its place: send a fresh key frame.
    Keyframe,
    /// Send the share's sound from now on, or stop (#736): the watcher's own
    /// sound button. A server from before it ignores it, and sends none.
    Sound { on: bool },
}

/// The version every frame's first byte carries. A sound packet's first
/// byte is [`SCREEN_SOUND_KIND`] instead, so a server or an app that knows
/// only frames drops it as a frame of a version it doesn't know.
pub const SCREEN_FRAME_VERSION: u8 = 1;

/// A frame's header: version, format, flags, a zero, then the moment it was
/// captured in microseconds, big-endian (PROTOCOL §8).
pub const SCREEN_FRAME_HEADER_BYTES: usize = 12;

/// The flag on a key frame.
pub const SCREEN_FRAME_KEY: u8 = 1;

/// What the server reads of a frame: its format, and whether it is a key
/// frame. The rest it passes on as it came.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenFrameHead {
    pub codec: ScreenCodec,
    pub key: bool,
}

impl ScreenFrameHead {
    /// Read a frame's header, if it is one: long enough to have one and some
    /// picture after it, this version, a format the server knows.
    #[must_use]
    pub fn read(frame: &[u8]) -> Option<Self> {
        if frame.len() <= SCREEN_FRAME_HEADER_BYTES || frame[0] != SCREEN_FRAME_VERSION {
            return None;
        }
        Some(Self {
            codec: ScreenCodec::from_byte(frame[1])?,
            key: frame[2] & SCREEN_FRAME_KEY != 0,
        })
    }

    /// The header for a frame of this format, captured at `micros`.
    #[must_use]
    pub fn write(self, micros: u64) -> [u8; SCREEN_FRAME_HEADER_BYTES] {
        let mut head = [0u8; SCREEN_FRAME_HEADER_BYTES];
        head[0] = SCREEN_FRAME_VERSION;
        head[1] = self.codec.byte();
        head[2] = if self.key { SCREEN_FRAME_KEY } else { 0 };
        head[4..].copy_from_slice(&micros.to_be_bytes());
        head
    }
}

/// A sound packet's first byte (#736): what tells it from a frame, whose
/// first byte is [`SCREEN_FRAME_VERSION`].
pub const SCREEN_SOUND_KIND: u8 = 2;

/// A sound packet's format, its second byte: Opus, 48 kHz, two channels,
/// one packet of 20 ms.
pub const SCREEN_SOUND_OPUS: u8 = 1;

/// What the server reads of a sound packet (#736): that it is one, in a
/// format it knows, and when it was captured. Its header is the size of a
/// frame's, [`SCREEN_FRAME_HEADER_BYTES`]: kind, format, a zero for flags, a
/// zero, then the moment it was captured in microseconds, big-endian, on the
/// same clock as the share's frames, so a watcher can line the two up. The
/// Opus packet follows, which the server passes on as it came.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenSoundHead {
    pub micros: u64,
}

impl ScreenSoundHead {
    /// Read a sound packet's header, if it is one: long enough to have one
    /// and some sound after it, this kind, a format the server knows.
    #[must_use]
    pub fn read(packet: &[u8]) -> Option<Self> {
        if packet.len() <= SCREEN_FRAME_HEADER_BYTES
            || packet[0] != SCREEN_SOUND_KIND
            || packet[1] != SCREEN_SOUND_OPUS
        {
            return None;
        }
        let mut micros = [0u8; 8];
        micros.copy_from_slice(&packet[4..SCREEN_FRAME_HEADER_BYTES]);
        Some(Self {
            micros: u64::from_be_bytes(micros),
        })
    }

    /// The header for a sound packet captured at `micros`.
    #[must_use]
    pub fn write(self) -> [u8; SCREEN_FRAME_HEADER_BYTES] {
        let mut head = [0u8; SCREEN_FRAME_HEADER_BYTES];
        head[0] = SCREEN_SOUND_KIND;
        head[1] = SCREEN_SOUND_OPUS;
        head[4..].copy_from_slice(&self.micros.to_be_bytes());
        head
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hello_reads_formats_leniently_and_in_order() {
        let hello: ScreenHello = serde_json::from_value(serde_json::json!({
            "op": "share", "token": "t", "session_id": "s", "fps": 60,
            "encode": ["av1", "avc1", "vp8", "avc1"]
        }))
        .expect("a share hello");
        let ScreenHello::Share { fps, encode, .. } = hello else {
            panic!("a share hello");
        };
        assert_eq!(fps, 60);
        // A format this server doesn't know is left out, and a repeat once.
        assert_eq!(encode, vec![ScreenCodec::Avc1, ScreenCodec::Vp8]);
        let ask: ScreenWatchAsks =
            serde_json::from_value(serde_json::json!({"op": "watch", "target": "x"}))
                .expect("a watch with no formats");
        assert!(matches!(ask, ScreenWatchAsks::Watch { decode: None, .. }));
    }

    #[test]
    fn what_the_server_says_travels_as_named_messages() {
        let want = serde_json::to_value(ScreenShareSays::Want {
            codecs: vec![ScreenCodec::Vp8],
            sound: None,
        })
        .expect("json");
        assert_eq!(want, serde_json::json!({"op": "want", "codecs": ["vp8"]}));
        let showing = serde_json::to_value(ScreenWatchSays::Showing {
            target: None,
            codec: None,
            sound: None,
        })
        .expect("json");
        assert_eq!(
            showing,
            serde_json::json!({"op": "showing", "target": null, "codec": null})
        );
        assert_eq!(
            serde_json::to_value(ScreenShareSays::Alive).expect("json"),
            serde_json::json!({"op": "alive"})
        );
        assert_eq!(
            serde_json::to_value(ScreenWatchSays::Alive).expect("json"),
            serde_json::json!({"op": "alive"})
        );
        assert_eq!(
            serde_json::to_value(ScreenWatchSays::Behind).expect("json"),
            serde_json::json!({"op": "behind"})
        );
    }

    #[test]
    fn a_frame_header_round_trips_and_a_bad_one_is_refused() {
        let head = ScreenFrameHead {
            codec: ScreenCodec::Avc1,
            key: true,
        };
        let mut frame = head.write(1_234_567).to_vec();
        frame.extend_from_slice(b"picture");
        assert_eq!(ScreenFrameHead::read(&frame), Some(head));
        assert_eq!(&frame[4..12], &1_234_567u64.to_be_bytes());
        // A header with no picture after it, another version, an unknown format.
        assert_eq!(
            ScreenFrameHead::read(&frame[..SCREEN_FRAME_HEADER_BYTES]),
            None
        );
        let mut other = frame.clone();
        other[0] = 2;
        assert_eq!(ScreenFrameHead::read(&other), None);
        other = frame.clone();
        other[1] = 9;
        assert_eq!(ScreenFrameHead::read(&other), None);
    }

    #[test]
    fn a_sound_packet_round_trips_and_no_frame_reader_takes_it() {
        let head = ScreenSoundHead { micros: 9_876_543 };
        let mut packet = head.write().to_vec();
        packet.extend_from_slice(b"opus");
        assert_eq!(ScreenSoundHead::read(&packet), Some(head));
        assert_eq!(&packet[4..12], &9_876_543u64.to_be_bytes());
        // A server or an app that knows only frames drops it: its first byte
        // is a version no frame has.
        assert_eq!(ScreenFrameHead::read(&packet), None);
        // And a frame is never read as sound.
        let mut frame = ScreenFrameHead {
            codec: ScreenCodec::Vp8,
            key: true,
        }
        .write(5)
        .to_vec();
        frame.extend_from_slice(b"picture");
        assert_eq!(ScreenSoundHead::read(&frame), None);
        // A header with no sound after it, or a format it doesn't know.
        assert_eq!(
            ScreenSoundHead::read(&packet[..SCREEN_FRAME_HEADER_BYTES]),
            None
        );
        packet[1] = 9;
        assert_eq!(ScreenSoundHead::read(&packet), None);
    }

    #[test]
    fn sound_is_asked_for_and_said_only_when_it_is_on() {
        // A hello from before sound reads as no sound.
        let hello: ScreenHello = serde_json::from_value(serde_json::json!({
            "op": "watch", "token": "t", "session_id": "s", "target": "x", "decode": ["vp8"]
        }))
        .expect("a watch hello");
        assert!(matches!(hello, ScreenHello::Watch { sound: None, .. }));
        let hello: ScreenHello = serde_json::from_value(serde_json::json!({
            "op": "share", "token": "t", "session_id": "s", "fps": 30, "encode": ["vp8"], "sound": true
        }))
        .expect("a share hello");
        assert!(matches!(
            hello,
            ScreenHello::Share {
                sound: Some(true),
                ..
            }
        ));
        // `want` says sound only when it's wanted, so it reads as before.
        assert_eq!(
            serde_json::to_value(ScreenShareSays::Want {
                codecs: vec![],
                sound: Some(true),
            })
            .expect("json"),
            serde_json::json!({"op": "want", "codecs": [], "sound": true})
        );
        let ask: ScreenWatchAsks =
            serde_json::from_value(serde_json::json!({"op": "sound", "on": false}))
                .expect("a sound ask");
        assert!(matches!(ask, ScreenWatchAsks::Sound { on: false }));
    }
}
