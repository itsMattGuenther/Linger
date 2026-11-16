//! The microphone test in Settings (#907): talk for a few seconds, and hear
//! it back the way a call would send it.
//!
//! Since #904 the desktop app levels and cleans the microphone by itself, so
//! there is nothing for anybody to set up. What nobody can do in a call is
//! hear themselves as the others do, or tell whether "you're very quiet" is
//! at their end. So the test opens the microphone the way a call does
//! (`voice::device`, through the same clean-up), keeps what it hears for up
//! to [`LONGEST_MS`], and then plays it once on the Speakers picked in
//! Settings and says in a word what it heard ([`Heard`]). While it listens,
//! the window that started it is told how loud each moment was
//! (`mictest:level`), for a line that moves with the voice.
//!
//! **The sound never reaches a window, a file or a server.** The page gets a
//! level, a word and "done"; the samples stay here, are played once and are
//! dropped. That's why Settings may have this and not the voice message
//! recorder, which hands its recording to the page (`acl.rs`).
//!
//! Not during a call: what it plays would go out of the speakers and back
//! into the call's microphone as somebody talking over the room. It says so
//! instead ([`IN_VOICE`]).

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Window};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::voice::audio::{Source, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE};
use crate::voice::level;

/// The longest the test listens: eight seconds, a sentence or two. It stops
/// there by itself and plays what it has.
pub const LONGEST_MS: u32 = 8_000;
const LONGEST_FRAMES: usize = (LONGEST_MS / FRAME_MS) as usize;

// The recording plays on the sounds' own speaker, which is closed once
// nothing has been handed to it for `KEEP_OPEN` (`sounds.rs`). The longest
// recording has to be over by then, or its end would be cut off.
const _: () =
    assert!(LONGEST_MS as u128 + PLAYED_OUT.as_millis() < crate::sounds::KEEP_OPEN.as_millis());

/// How loud you are goes to the window every other frame, 25 times a second,
/// as a voice message's does (`clip.rs`).
const LEVEL_EVERY: usize = 2;

/// What the test heard, in a word, for the line Settings shows after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Heard {
    /// No sound anybody made: the wrong microphone, or one that's muted.
    Nothing,
    /// A sound, and too little of it to follow in a call.
    Quiet,
    /// A voice at a level a call carries.
    Voice,
}

/// Under this a 20 ms frame is nobody: about 60 dB below full scale, which
/// is a microphone's own hiss or less. RMS over `i16`, as
/// `level::THRESHOLD` is.
const NOBODY: f32 = 33.0;
/// Under this it's a voice too quiet to follow: about 40 dB below full
/// scale. Levelled, a voice sits near 26 below; this is one the levelling
/// couldn't bring up, or one sent as it came with the levelling off.
const TOO_QUIET: f32 = 330.0;
/// How many frames of it there have to be, anywhere in the recording: ten,
/// which is 200 ms, a short word. A click or a key is one or two, and isn't
/// somebody talking.
const ENOUGH: usize = 10;

/// What a recording holds: a voice when enough of its frames are at a
/// voice's level, something too quiet when enough are above a microphone's
/// hiss, and otherwise nothing. Where in the recording they come doesn't
/// matter, and nor does the silence between words.
#[must_use]
pub fn heard(samples: &[i16]) -> Heard {
    let (mut voiced, mut sounded) = (0, 0);
    for frame in samples.chunks(FRAME_SAMPLES) {
        let loud = level::rms(frame);
        voiced += usize::from(loud >= TOO_QUIET);
        sounded += usize::from(loud >= NOBODY);
    }
    if voiced >= ENOUGH {
        Heard::Voice
    } else if sounded >= ENOUGH {
        Heard::Quiet
    } else {
        Heard::Nothing
    }
}

/// Listen to `source` until `stop` fires, [`LONGEST_MS`] has passed, or the
/// source ends, and hand back what it gave. `level` hears how loud each
/// stretch was, from 0 to 1. Kept apart from the microphone so the tests can
/// feed it a tone.
pub async fn listen(
    source: &dyn Source,
    mut stop: oneshot::Receiver<()>,
    level: impl Fn(f32),
) -> Vec<i16> {
    let mut kept = Vec::with_capacity(LONGEST_FRAMES * FRAME_SAMPLES);
    let (mut frames, mut loudest) = (0_usize, 0.0_f32);
    while frames < LONGEST_FRAMES {
        let frame = tokio::select! {
            biased;
            _ = &mut stop => break,
            frame = source.frame() => frame,
        };
        let Some(frame) = frame else { break };
        loudest = loudest.max(level::loudness(&frame));
        kept.extend_from_slice(&frame);
        frames += 1;
        if frames.is_multiple_of(LEVEL_EVERY) {
            level(loudest);
            loudest = 0.0;
        }
    }
    kept
}

/// How long a recording takes to play, with a little over for the speakers
/// to open and empty.
#[must_use]
pub fn playing_for(samples: usize) -> Duration {
    Duration::from_millis(samples as u64 * 1000 / u64::from(SAMPLE_RATE)) + PLAYED_OUT
}

const PLAYED_OUT: Duration = Duration::from_millis(400);

/// The test under way, if one is.
#[derive(Default)]
pub struct MicTests(Mutex<Option<Running>>);

struct Running {
    /// The window that started it, and the only one told about it.
    window: String,
    /// Taken when listening is stopped by hand: what's left is the playing.
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

const ALREADY: &str = "A microphone test is already under way.";
/// Said in Settings as it is, when what it heard couldn't be played back.
const NO_SPEAKERS: &str = "Linger heard you, but couldn't play it back: the speakers wouldn't open. Check the Speakers picked above.";
/// Said in Settings as it is.
pub const IN_VOICE: &str = "You're in voice. Leave it to test your microphone: the test plays out loud, and the room would hear it.";

/// What comes after the listening.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Then {
    /// Say what was heard, and play it back.
    Play(Heard),
    /// Say what was heard, with nothing to play: silence isn't played, the
    /// line about it says enough.
    Say(Heard),
    /// Say nothing and play nothing: voice was joined while it listened,
    /// and playing now would put it into the room.
    Leave,
}

/// Decided once the listening is over, not before it: the eight seconds are
/// long enough to join a room in (the list window is right there), and
/// "not in voice" when Test was pressed says nothing about now.
#[must_use]
pub fn then(heard: Heard, in_voice: bool) -> Then {
    if in_voice {
        Then::Leave
    } else if heard == Heard::Nothing {
        Then::Say(heard)
    } else {
        Then::Play(heard)
    }
}

/// Start the test: listen to the chosen microphone (the default for `None`)
/// for up to [`LONGEST_MS`], then play it on `output`. The window hears
/// `mictest:level` while it listens; then `mictest:heard` with the verdict,
/// or `mictest:cut` with the reason when nothing will be played (voice was
/// joined meanwhile, or the speakers wouldn't open); and `mictest:done` when
/// the playing is over.
#[tauri::command]
pub async fn mic_test_start(
    app: AppHandle,
    window: Window,
    input: Option<String>,
    output: Option<String>,
) -> Result<(), String> {
    if lock(&app.state::<MicTests>()).is_some() {
        return Err(ALREADY.into());
    }
    if crate::voice_commands::in_voice(&app).await {
        return Err(IN_VOICE.into());
    }
    let microphone = tokio::task::spawn_blocking(move || {
        crate::voice::device::Microphone::open(input.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    let label = window.label().to_string();
    let (stop, stopped) = oneshot::channel();
    let tests = app.state::<MicTests>();
    // Held from here to the entry being kept, with nothing awaited between:
    // the task takes the entry out when it ends, and has to find it there
    // even when its microphone gives it nothing at all.
    let mut held = lock(&tests);
    if held.is_some() {
        // Another window started one while this microphone was opening.
        return Err(ALREADY.into());
    }
    let task = tokio::spawn(run(app.clone(), label.clone(), microphone, stopped, output));
    *held = Some(Running {
        window: label,
        stop: Some(stop),
        task,
    });
    Ok(())
}

/// The whole of one test, from the open microphone to "done".
async fn run(
    app: AppHandle,
    label: String,
    microphone: crate::voice::device::Microphone,
    stopped: oneshot::Receiver<()>,
    output: Option<String>,
) {
    let told = (app.clone(), label.clone());
    let samples = listen(&microphone, stopped, move |loud| {
        let _ = told.0.emit_to(told.1.as_str(), "mictest:level", loud);
    })
    .await;
    // The microphone is let go before anything plays: the test never hears
    // itself.
    drop(microphone);
    match then(heard(&samples), crate::voice_commands::in_voice(&app).await) {
        Then::Leave => {
            let _ = app.emit_to(label.as_str(), "mictest:cut", IN_VOICE);
        }
        Then::Say(verdict) => {
            let _ = app.emit_to(label.as_str(), "mictest:heard", verdict);
        }
        Then::Play(verdict) => {
            // Handed to the speakers first: "playing it back" is only said
            // once it is, and speakers that won't open are said instead.
            let wait = playing_for(samples.len());
            if crate::voice_commands::play_out_of_voice(&app, samples, output).await {
                let _ = app.emit_to(label.as_str(), "mictest:heard", verdict);
                tokio::time::sleep(wait).await;
            } else {
                let _ = app.emit_to(label.as_str(), "mictest:cut", NO_SPEAKERS);
            }
        }
    }
    lock(&app.state::<MicTests>()).take();
    let _ = app.emit_to(label.as_str(), "mictest:done", ());
}

/// Stop listening now and go on to playing it back. Once it's playing there
/// is nothing to stop: it's eight seconds at most.
#[tauri::command]
pub fn mic_test_stop(app: AppHandle) {
    if let Some(stop) = lock(&app.state::<MicTests>())
        .as_mut()
        .and_then(|running| running.stop.take())
    {
        let _ = stop.send(());
    }
}

/// A window has gone: a test it started goes with it, unplayed.
pub fn forget(app: &AppHandle, label: &str) {
    let tests = app.state::<MicTests>();
    let mut held = lock(&tests);
    if held.as_ref().is_some_and(|running| running.window == label) {
        if let Some(running) = held.take() {
            running.task.abort();
        }
    }
}

fn lock(tests: &MicTests) -> MutexGuard<'_, Option<Running>> {
    tests.0.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;

    use super::*;

    /// A microphone with no clock: a 440 Hz tone at `peak` as fast as it's
    /// asked for, and nothing after `frames` frames.
    struct Tone {
        peak: f32,
        frames: usize,
        given: AtomicUsize,
    }

    impl Tone {
        fn of(peak: f32, frames: usize) -> Self {
            Self {
                peak,
                frames,
                given: AtomicUsize::new(0),
            }
        }
    }

    fn tone(peak: f32, from: usize, samples: usize) -> Vec<i16> {
        (from..from + samples)
            .map(|n| {
                #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
                let value = ((n as f32 / 48_000.0) * 440.0 * std::f32::consts::TAU).sin() * peak;
                value as i16
            })
            .collect()
    }

    #[async_trait]
    impl Source for Tone {
        async fn frame(&self) -> Option<Vec<i16>> {
            let at = self.given.fetch_add(1, Ordering::Relaxed);
            if at >= self.frames {
                return None;
            }
            tokio::task::yield_now().await;
            Some(tone(self.peak, at * FRAME_SAMPLES, FRAME_SAMPLES))
        }
    }

    /// Never answers, so only the stop ends the listening.
    struct Forever;

    #[async_trait]
    impl Source for Forever {
        async fn frame(&self) -> Option<Vec<i16>> {
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn it_keeps_what_the_microphone_gave_and_says_how_loud() {
        let (_stop, stopped) = oneshot::channel();
        let levels = Arc::new(Mutex::new(Vec::new()));
        let told = Arc::clone(&levels);
        let kept = listen(&Tone::of(8000.0, 50), stopped, move |loud| {
            told.lock().unwrap().push(loud);
        })
        .await;
        // A second of it, sample for sample, and a level every other frame.
        assert_eq!(kept, tone(8000.0, 0, 50 * FRAME_SAMPLES));
        let levels = levels.lock().unwrap();
        assert_eq!(levels.len(), 25);
        assert!(levels.iter().all(|loud| (0.3..=1.0).contains(loud)));
    }

    #[tokio::test]
    async fn it_stops_by_itself_at_eight_seconds() {
        let (_stop, stopped) = oneshot::channel();
        let kept = listen(&Tone::of(8000.0, LONGEST_FRAMES * 3), stopped, |_| {}).await;
        assert_eq!(kept.len(), LONGEST_FRAMES * FRAME_SAMPLES);
        assert_eq!(kept.len(), 8 * 48_000);
    }

    #[tokio::test]
    async fn stopping_ends_the_listening_with_what_there_was() {
        let (stop, stopped) = oneshot::channel();
        stop.send(()).unwrap();
        assert!(listen(&Forever, stopped, |_| {}).await.is_empty());
    }

    /// Silence is nothing, a faint sound is quiet, a voice is a voice, and
    /// where in the recording it comes doesn't matter.
    #[test]
    fn enough_of_a_voice_anywhere_is_a_voice() {
        let second = 48_000;
        assert_eq!(heard(&[]), Heard::Nothing);
        assert_eq!(heard(&vec![0; 3 * second]), Heard::Nothing);
        // A microphone's own hiss, about 70 dB down.
        assert_eq!(heard(&tone(14.0, 0, 3 * second)), Heard::Nothing);
        // About 46 dB down: there, and nobody could follow it.
        assert_eq!(heard(&tone(230.0, 0, 3 * second)), Heard::Quiet);
        // About 23 dB down, where levelling puts a voice.
        assert_eq!(heard(&tone(3300.0, 0, 3 * second)), Heard::Voice);
        // Two seconds of nothing, a short word, and a second of nothing.
        let mut late = vec![0; 2 * second];
        late.extend(tone(3300.0, 0, second / 4));
        late.extend(vec![0; second]);
        assert_eq!(heard(&late), Heard::Voice);
        // Two words with a pause between, neither long enough alone.
        let mut words = tone(3300.0, 0, 6 * FRAME_SAMPLES);
        words.extend(vec![0; second]);
        words.extend(tone(3300.0, 0, 6 * FRAME_SAMPLES));
        assert_eq!(heard(&words), Heard::Voice);
    }

    /// A click or a key is loud for a moment and isn't somebody talking.
    #[test]
    fn a_click_is_not_a_voice() {
        for frames in [1, 2, ENOUGH - 1] {
            let mut click = vec![0; 48_000];
            click.extend(tone(20_000.0, 0, frames * FRAME_SAMPLES));
            click.extend(vec![0; 2 * 48_000]);
            assert_eq!(heard(&click), Heard::Nothing, "{frames} loud frames");
        }
        let mut word = vec![0; 48_000];
        word.extend(tone(20_000.0, 0, ENOUGH * FRAME_SAMPLES));
        assert_eq!(heard(&word), Heard::Voice);
    }

    /// Whether to play is decided after the listening: a room joined while
    /// it listened hears none of it, and silence isn't played at all.
    #[test]
    fn what_was_heard_is_played_unless_voice_was_joined_or_it_was_silence() {
        assert_eq!(then(Heard::Voice, false), Then::Play(Heard::Voice));
        assert_eq!(then(Heard::Quiet, false), Then::Play(Heard::Quiet));
        assert_eq!(then(Heard::Nothing, false), Then::Say(Heard::Nothing));
        for heard in [Heard::Voice, Heard::Quiet, Heard::Nothing] {
            assert_eq!(then(heard, true), Then::Leave);
        }
    }

    #[test]
    fn a_recording_plays_for_as_long_as_it_is_and_a_little_over() {
        assert_eq!(playing_for(0), PLAYED_OUT);
        assert_eq!(playing_for(3 * 48_000), Duration::from_secs(3) + PLAYED_OUT);
    }

    #[test]
    fn the_page_reads_the_verdict_as_a_word() {
        let words: Vec<String> = [Heard::Nothing, Heard::Quiet, Heard::Voice]
            .iter()
            .map(|heard| serde_json::to_string(heard).unwrap())
            .collect();
        assert_eq!(words, ["\"nothing\"", "\"quiet\"", "\"voice\""]);
    }
}
