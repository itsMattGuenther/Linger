//! Screen sharing (SPEC §4.20, PROTOCOL §8 "Screen sharing", #360).
//!
//! A share and each of its watchers have a screen socket of their own at
//! `/api/v1/screen`, apart from the gateway. Its first text message is a
//! [`ScreenHello`]; then binary messages carry frames, each a
//! [`SCREEN_FRAME_HEADER_BYTES`]-byte header and one encoded frame, and text
//! messages carry what the server asks of the sharer ([`ScreenShareSays`]) and
//! tells a watcher ([`ScreenWatchSays`]), and what a watcher asks
//! ([`ScreenWatchAsks`]).
//!
//! Nothing here can carry the name of a window or an application (hard rule
//! 2): the operating system's picker chooses what is shared, and its choice
//! reaches the app as pictures alone.

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
    },
    /// Watch the share of `target`, a session in the same room's voice.
    Watch {
        token: String,
        session_id: String,
        target: String,
        /// The formats this app can play.
        #[serde(deserialize_with = "known_codecs")]
        decode: Vec<ScreenCodec>,
    },
}

/// What the server asks of a sharing app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ScreenShareSays {
    /// Make exactly these formats from now on. Empty is nothing: nobody is
    /// watching.
    Want { codecs: Vec<ScreenCodec> },
    /// Make the next frame of this format a key frame.
    Keyframe { codec: ScreenCodec },
}

/// What the server tells a watching app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum ScreenWatchSays {
    /// What this socket shows now. A `target` with no `codec` is a share this
    /// app can't play; no `target` is the share having ended.
    Showing {
        target: Option<String>,
        codec: Option<ScreenCodec>,
    },
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
}

/// The version every frame's first byte carries.
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
        })
        .expect("json");
        assert_eq!(want, serde_json::json!({"op": "want", "codecs": ["vp8"]}));
        let showing = serde_json::to_value(ScreenWatchSays::Showing {
            target: None,
            codec: None,
        })
        .expect("json");
        assert_eq!(
            showing,
            serde_json::json!({"op": "showing", "target": null, "codec": null})
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
}
