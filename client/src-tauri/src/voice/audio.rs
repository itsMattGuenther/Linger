//! The two ends of the audio path: where sound comes from, and where it goes
//! (SPEC §4.14, ARCHITECTURE §2, T-1402).
//!
//! This is the seam between the engine and the hardware. The real ends are in
//! `device.rs` — a `cpal` microphone and a `cpal` speaker — and the ones here
//! are the stand-ins the tests use: silence, a tone, and a sink that drops
//! everything. The engine cannot tell them apart, which is the point.
//!
//! The seam is one 20 ms frame in each direction, which is not an invented
//! boundary: it is the frame size Opus and WebRTC both work in, so the
//! microphone fills the same buffer the encoder reads and nothing in between
//! has to think about it.
//!
//! Two things are deliberately *not* here:
//!
//! - **Device selection** is `device.rs`'s, along with hotplug and the OS
//!   default changing under a call (T-1405). All the seam has of it is
//!   `choose`, for a device picked in the middle of a call (#249).
//! - **Mixing several peers** happens on the playback side, inside the sink.
//!   [`Sink::play`] takes the peer it came from so the sink can keep one lane
//!   per person and sum them at the last moment.

use std::sync::Arc;

use async_trait::async_trait;

/// The sample rate everything in here runs at.
///
/// 48 kHz because that is what Opus encodes and what WebRTC negotiates; a
/// device that wants something else is resampled at the edge rather than
/// halfway through, so nothing between here and the network has to think about
/// it. (The resampling is T-1405's problem, and it is on that list because a
/// sample-rate mismatch is one of the three ways audio devices break.)
pub const SAMPLE_RATE: u32 = 48_000;

/// One channel. Voice is mono — a second channel doubles the bytes through the
/// server and carries nothing anybody can hear on a laptop microphone.
pub const CHANNELS: u16 = 1;

/// How much audio is in one frame, in milliseconds.
///
/// Twenty is Opus's default and WebRTC's usual: ten doubles the packet rate for
/// latency nobody notices, and forty saves nothing worth the delay it adds.
pub const FRAME_MS: u32 = 20;

/// Samples in one frame. 960 at 48 kHz.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * FRAME_MS as usize;

/// Where the sound going out comes from.
///
/// One frame per call, already at [`SAMPLE_RATE`] and [`CHANNELS`]. Returning
/// `None` means "nothing to send right now", which is not the same as silence:
/// a muted microphone should send silence so the far end's jitter buffer keeps
/// running, and a source that has stopped should send nothing at all.
#[async_trait]
pub trait Source: Send + Sync + 'static {
    async fn frame(&self) -> Option<Vec<i16>>;

    /// Carry on from another device, by name, or the default for `None`
    /// (#249). Frames keep coming from the same source; only the device under
    /// it changes. The stand-ins have no device and ignore it.
    fn choose(&self, _name: Option<&str>) {}

    /// The device picked by name, and why it wouldn't open, while this source
    /// is the default standing in for it (#398). `None` on the device asked
    /// for, or when the default was what was asked for. The stand-ins have no
    /// device, so theirs is always `None`.
    fn refused(&self) -> Option<Refused> {
        None
    }
}

/// A device picked by name that wouldn't open, so the default is in its
/// place. Said out loud: on its own it looks like "the microphone I picked
/// doesn't hear me", when Linger is listening to another one (#398).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    /// The device as it was picked, by name.
    pub name: String,
    /// Why it wouldn't open, in the system's words.
    pub why: String,
}

/// Where the sound coming in goes.
///
/// `peer` is the session it arrived from, because playback has to mix several
/// people and cannot do that without knowing who is who.
#[async_trait]
pub trait Sink: Send + Sync + 'static {
    async fn play(&self, peer: &str, samples: &[i16]);

    /// Gate all voice playback, discarding queued samples while deafened.
    /// A sink with no playback (such as `Discard`) need not implement this.
    async fn set_deafened(&self, _deafened: bool) {}

    /// The peer has gone; drop whatever was queued for them. A sink that keeps
    /// no state per peer can ignore this.
    async fn forget(&self, _peer: &str) {}

    /// How loud one peer plays *for you*, 1.0 being as sent. Local and only
    /// ever yours: SPEC §4.14 says nobody can turn anybody else down, and a
    /// gain that lives in your own sink cannot be anything but your own.
    async fn set_volume(&self, _peer: &str, _volume: f32) {}

    /// Carry on playing through another device, by name, or the default for
    /// `None` (#249). Everybody's volume stays as it was. The stand-ins have
    /// no device and ignore it.
    fn choose(&self, _name: Option<&str>) {}

    /// Play one of Linger's own sounds over the voices (#250): mono at
    /// [`SAMPLE_RATE`]. True when it was played; a sink with no device can't.
    fn cue(&self, _samples: &[i16]) -> bool {
        false
    }
}

/// The two ends, together. What [`crate::voice::Engine::join`] takes: a
/// microphone (or a stand-in) and somewhere for the far end's audio to go.
#[derive(Clone)]
pub struct Devices {
    pub source: Arc<dyn Source>,
    pub sink: Arc<dyn Sink>,
}

impl Devices {
    /// Silence in, nothing out. For tests of everything that is not audio.
    #[must_use]
    pub fn silent() -> Self {
        Self {
            source: Arc::new(Silence),
            sink: Arc::new(Discard),
        }
    }
}

/// A speaker that is not there. Every frame handed to it is dropped.
pub struct Discard;

#[async_trait]
impl Sink for Discard {
    async fn play(&self, _peer: &str, _samples: &[i16]) {}
}

/// A microphone that is not there.
///
/// It produces real frames of silence at the real rate, so the whole path —
/// packetise, encrypt, send, receive, decrypt, hand to the sink — runs and can
/// be measured. What it cannot prove is that anybody can hear anything, which
/// is why T-1402's acceptance criterion is four people and not a test.
pub struct Silence;

#[async_trait]
impl Source for Silence {
    async fn frame(&self) -> Option<Vec<i16>> {
        tokio::time::sleep(std::time::Duration::from_millis(u64::from(FRAME_MS))).await;
        Some(vec![0i16; FRAME_SAMPLES])
    }
}

/// A tone, for proving something arrived.
///
/// A sink cannot tell silence from a dead connection, so the tests send this
/// instead: it is a 440 Hz sine, and a frame of it that comes out the other end
/// is a frame that really crossed a peer connection.
pub struct Tone {
    at: std::sync::atomic::AtomicU64,
}

impl Default for Tone {
    fn default() -> Self {
        Self {
            at: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

#[async_trait]
impl Source for Tone {
    async fn frame(&self) -> Option<Vec<i16>> {
        use std::sync::atomic::Ordering;
        tokio::time::sleep(std::time::Duration::from_millis(u64::from(FRAME_MS))).await;
        let start = self.at.fetch_add(FRAME_SAMPLES as u64, Ordering::Relaxed);
        Some(
            (0..FRAME_SAMPLES)
                .map(|n| {
                    #[allow(clippy::cast_precision_loss)]
                    let t = (start + n as u64) as f32 / SAMPLE_RATE as f32;
                    #[allow(clippy::cast_possible_truncation)]
                    let value = (t * 440.0 * std::f32::consts::TAU).sin() * 8000.0;
                    value as i16
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_twenty_milliseconds_at_forty_eight_kilohertz() {
        assert_eq!(FRAME_SAMPLES, 960);
    }

    #[tokio::test]
    async fn silence_is_a_real_frame_of_nothing() {
        let frame = Silence.frame().await.expect("a frame");
        assert_eq!(frame.len(), FRAME_SAMPLES);
        assert!(frame.iter().all(|s| *s == 0));
    }

    /// The tone has to be something a sink can recognise, or it is no better
    /// than silence for proving a frame arrived.
    #[tokio::test]
    async fn the_tone_is_audible_and_keeps_going() {
        let tone = Tone::default();
        let first = tone.frame().await.expect("a frame");
        let second = tone.frame().await.expect("a frame");
        assert_eq!(first.len(), FRAME_SAMPLES);
        assert!(
            first.iter().any(|s| s.abs() > 1000),
            "the tone is inaudible"
        );
        assert_ne!(
            first, second,
            "the tone repeated, so its phase is not advancing"
        );
    }
}
