//! Voice messages (#401): a clip you record of yourself, hear back, and
//! choose to send. Voice rooms are never recorded (SPEC §4.14); this is the
//! other thing, started and stopped by your own hand, and nothing of it leaves
//! the computer unless you press Send.
//!
//! The microphone is opened the way voice opens it (`voice::device`), in the
//! device's own format, turned into 20 ms frames of mono 48 kHz, and each
//! frame is encoded as Opus as it comes. Stopping hands the packets to the
//! window that asked, which puts them in a WebM file (`client/src/lib/webm.ts`)
//! to play back and, if you choose, send. While it records, that window hears
//! how loud you are (`clip:level`), for the lines that move with your voice.
//!
//! One recording at a time, in the window that started it. Closing that
//! window throws it away (`forget`).

use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::voice::audio::{Source, FRAME_MS};
use crate::voice::codec::Encoder;
use crate::voice::level;

/// The longest a voice message runs: five minutes. Recording stops there by
/// itself (`clip:full`), and the clip is kept to hear back and send.
pub const LONGEST_MS: u32 = 5 * 60 * 1000;
const LONGEST_FRAMES: usize = (LONGEST_MS / FRAME_MS) as usize;

/// How loud you are goes to the window every other frame, 25 times a second:
/// plenty for lines that move with a voice, at half the messages.
const LEVEL_EVERY: usize = 2;

/// What's being recorded, if anything.
#[derive(Default)]
pub struct Clips(Mutex<Option<Recording>>);

struct Recording {
    /// The window that started it, and the only one told about it.
    window: String,
    stop: oneshot::Sender<()>,
    done: JoinHandle<Result<Clip, String>>,
}

/// A recording: Opus packets of 20 ms each, and how many samples at the
/// start the decoder drops (the encoder's lookahead).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Clip {
    pub pre_skip: u16,
    pub packets: Vec<Vec<u8>>,
}

impl Clip {
    /// As the window reads it (`readClip` in `client/src/lib/webm.ts`): the
    /// lookahead in two bytes, then each packet as its length in two bytes and
    /// its bytes, little-endian. Raw bytes rather than JSON: five minutes is
    /// about a megabyte. A packet is never longer than 1500 bytes
    /// (`codec::MAX_PACKET`), so two bytes always hold its length.
    #[must_use]
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(2 + self.packets.iter().map(|p| p.len() + 2).sum::<usize>());
        out.extend_from_slice(&self.pre_skip.to_le_bytes());
        for packet in &self.packets {
            let length = u16::try_from(packet.len()).unwrap_or(u16::MAX);
            out.extend_from_slice(&length.to_le_bytes());
            out.extend_from_slice(&packet[..usize::from(length)]);
        }
        out
    }
}

/// Why a recording stopped by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// It reached [`LONGEST_MS`].
    Full,
    /// The microphone went away and didn't come back.
    Lost,
}

/// Record from `source` until `stop` fires, the clip is full, or the source
/// ends. `level` hears how loud each stretch was, from 0 to 1, and `ended`
/// hears why it stopped by itself, if it did. Kept apart from the microphone
/// so the tests can feed it a tone.
pub async fn record(
    source: &dyn Source,
    mut stop: oneshot::Receiver<()>,
    level: impl Fn(f32),
    ended: impl FnOnce(Ended),
) -> Result<Clip, String> {
    let mut encoder = Encoder::for_clip().map_err(|error| error.to_string())?;
    let pre_skip = encoder.lookahead().map_err(|error| error.to_string())?;
    let mut clip = Clip {
        pre_skip,
        packets: Vec::new(),
    };
    let mut loudest = 0.0_f32;
    loop {
        let frame = tokio::select! {
            biased;
            _ = &mut stop => return Ok(clip),
            frame = source.frame() => frame,
        };
        let Some(frame) = frame else {
            ended(Ended::Lost);
            return Ok(clip);
        };
        clip.packets
            .push(encoder.encode(&frame).map_err(|error| error.to_string())?);
        loudest = loudest.max(loudness(&frame));
        if clip.packets.len().is_multiple_of(LEVEL_EVERY) {
            level(loudest);
            loudest = 0.0;
        }
        if clip.packets.len() >= LONGEST_FRAMES {
            ended(Ended::Full);
            return Ok(clip);
        }
    }
}

/// How loud a frame is, from 0 to 1, as the ear hears it rather than as the
/// samples measure it: the square root lifts a quiet voice off the floor.
fn loudness(frame: &[i16]) -> f32 {
    (level::rms(frame) / f32::from(i16::MAX)).sqrt().min(1.0)
}

/// Start recording a voice message (#401) from the chosen microphone, or the
/// default one for `None`. Refused while another is being recorded.
#[tauri::command]
pub async fn clip_start(
    app: AppHandle,
    window: Window,
    input: Option<String>,
) -> Result<(), String> {
    if lock(&app.state::<Clips>()).is_some() {
        return Err(ALREADY.into());
    }
    let microphone = tokio::task::spawn_blocking(move || {
        crate::voice::device::Microphone::open(input.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let label = window.label().to_string();
    let (stop, stopped) = oneshot::channel();
    let heard = (app.clone(), label.clone());
    let told = (app.clone(), label.clone());
    let done = tokio::spawn(async move {
        record(
            &microphone,
            stopped,
            move |loud| {
                let _ = heard.0.emit_to(heard.1.as_str(), "clip:level", loud);
            },
            move |why| {
                let event = match why {
                    Ended::Full => "clip:full",
                    Ended::Lost => "clip:lost",
                };
                let _ = told.0.emit_to(told.1.as_str(), event, ());
            },
        )
        .await
    });
    let clips = app.state::<Clips>();
    let mut held = lock(&clips);
    if held.is_some() {
        // Another window started one while this microphone was opening.
        done.abort();
        return Err(ALREADY.into());
    }
    *held = Some(Recording {
        window: label,
        stop,
        done,
    });
    Ok(())
}

const ALREADY: &str = "A voice message is already being recorded.";

/// Stop recording and hand the clip back (`Clip::to_bytes`). One that already
/// stopped by itself (full, or the microphone gone) is handed back the same
/// way.
#[tauri::command]
pub async fn clip_stop(app: AppHandle) -> Result<Response, String> {
    let recording = lock(&app.state::<Clips>()).take();
    let Some(recording) = recording else {
        return Err("Nothing is being recorded.".into());
    };
    let _ = recording.stop.send(());
    let clip = recording.done.await.map_err(|error| error.to_string())??;
    Ok(Response::new(clip.to_bytes()))
}

/// Stop recording and throw it away.
#[tauri::command]
pub async fn clip_cancel(app: AppHandle) {
    let recording = lock(&app.state::<Clips>()).take();
    if let Some(recording) = recording {
        let _ = recording.stop.send(());
        recording.done.abort();
    }
}

/// A window has gone: a recording it started goes with it, unheard.
pub fn forget(app: &AppHandle, label: &str) {
    let clips = app.state::<Clips>();
    let mut held = lock(&clips);
    if held
        .as_ref()
        .is_some_and(|recording| recording.window == label)
    {
        if let Some(recording) = held.take() {
            let _ = recording.stop.send(());
            recording.done.abort();
        }
    }
}

fn lock(clips: &Clips) -> MutexGuard<'_, Option<Recording>> {
    clips.0.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use super::*;
    use crate::voice::audio::FRAME_SAMPLES;
    use crate::voice::codec::Decoder;

    /// A microphone with no clock: a 440 Hz tone as fast as it's asked for,
    /// and nothing after `frames` frames, as a microphone that's unplugged
    /// gives. Without a clock, five minutes takes a moment.
    struct Instant {
        frames: usize,
        given: AtomicUsize,
    }

    impl Instant {
        fn for_frames(frames: usize) -> Self {
            Self {
                frames,
                given: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl Source for Instant {
        async fn frame(&self) -> Option<Vec<i16>> {
            let at = self.given.fetch_add(1, Ordering::Relaxed);
            if at >= self.frames {
                return None;
            }
            tokio::task::yield_now().await;
            Some(
                (0..FRAME_SAMPLES)
                    .map(|n| {
                        #[allow(clippy::cast_precision_loss)]
                        let t = (at * FRAME_SAMPLES + n) as f32 / 48_000.0;
                        #[allow(clippy::cast_possible_truncation)]
                        let value = (t * 440.0 * std::f32::consts::TAU).sin() * 8000.0;
                        value as i16
                    })
                    .collect(),
            )
        }
    }

    /// Never answers, so only the stop button ends the recording.
    struct Forever;

    #[async_trait]
    impl Source for Forever {
        async fn frame(&self) -> Option<Vec<i16>> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn a_recording_is_one_opus_packet_per_frame_and_plays_back() {
        let (_stop, stopped) = oneshot::channel();
        let ended = Arc::new(Mutex::new(None));
        let why = Arc::clone(&ended);
        let clip = record(
            &Instant::for_frames(50),
            stopped,
            |_| {},
            move |e| {
                *why.lock().unwrap() = Some(e);
            },
        )
        .await
        .unwrap();
        assert_eq!(clip.packets.len(), 50, "one second, fifty packets");
        assert!(clip.pre_skip > 0, "the encoder's lookahead is known");
        // The microphone ran out: that's the clip, and it says why.
        assert_eq!(*ended.lock().unwrap(), Some(Ended::Lost));
        let mut decoder = Decoder::new().unwrap();
        let heard: Vec<i16> = clip
            .packets
            .iter()
            .flat_map(|packet| decoder.decode(packet).unwrap())
            .collect();
        assert_eq!(heard.len(), 50 * FRAME_SAMPLES);
        assert!(heard.iter().any(|s| s.abs() > 1000), "the tone is in it");
    }

    #[tokio::test]
    async fn stopping_hands_back_what_was_recorded() {
        let (stop, stopped) = oneshot::channel();
        let _ = stop.send(());
        let clip = record(&Forever, stopped, |_| {}, |_| panic!("it was stopped"))
            .await
            .unwrap();
        assert!(clip.packets.is_empty());
    }

    #[tokio::test]
    async fn it_stops_by_itself_at_five_minutes() {
        let (_stop, stopped) = oneshot::channel();
        let ended = Arc::new(Mutex::new(None));
        let why = Arc::clone(&ended);
        let clip = record(
            &Instant::for_frames(LONGEST_FRAMES + 100),
            stopped,
            |_| {},
            move |e| {
                *why.lock().unwrap() = Some(e);
            },
        )
        .await
        .unwrap();
        assert_eq!(clip.packets.len(), LONGEST_FRAMES);
        assert_eq!(LONGEST_FRAMES, 15_000);
        assert_eq!(*ended.lock().unwrap(), Some(Ended::Full));
    }

    #[tokio::test]
    async fn how_loud_you_are_is_told_every_other_frame_from_nothing_to_one() {
        let (_stop, stopped) = oneshot::channel();
        let levels = Arc::new(Mutex::new(Vec::new()));
        let heard = Arc::clone(&levels);
        record(
            &Instant::for_frames(20),
            stopped,
            move |loud| heard.lock().unwrap().push(loud),
            |_| {},
        )
        .await
        .unwrap();
        let levels = levels.lock().unwrap();
        assert_eq!(levels.len(), 10);
        assert!(
            levels.iter().all(|loud| (0.2..=1.0).contains(loud)),
            "{levels:?}"
        );
        assert_eq!(loudness(&vec![0; FRAME_SAMPLES]), 0.0);
        assert!((loudness(&vec![i16::MAX; FRAME_SAMPLES]) - 1.0).abs() < 1e-6);
    }

    /// The recording the browser tests hear back
    /// (`client/tests/fixtures/next/voice-clip.bin`): one second of the tone,
    /// as `clip_stop` hands it over. `cargo test -- --ignored` writes it again.
    #[tokio::test]
    #[ignore = "writes the browser tests' recording"]
    async fn write_the_browser_tests_recording() {
        let (_stop, stopped) = oneshot::channel();
        let clip = record(&Instant::for_frames(50), stopped, |_| {}, |_| {})
            .await
            .unwrap();
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/next/voice-clip.bin"
        );
        std::fs::write(path, clip.to_bytes()).unwrap();
    }

    #[test]
    fn the_window_reads_the_lookahead_then_each_packet_by_its_length() {
        let clip = Clip {
            pre_skip: 312,
            packets: vec![vec![9, 8], vec![7]],
        };
        assert_eq!(clip.to_bytes(), vec![0x38, 0x01, 2, 0, 9, 8, 1, 0, 7]);
        assert_eq!(Clip::default().to_bytes(), vec![0, 0]);
    }
}
