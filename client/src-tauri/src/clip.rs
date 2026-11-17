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
pub struct Clips(Mutex<Books>);

#[derive(Default)]
struct Books {
    /// The next recording's number: how a recording tells itself from a
    /// later one.
    next: u64,
    recording: Option<Recording>,
    /// Cancels that came before their start was booked, by window and the
    /// page's number for the start (#920). Commands can be handled in
    /// another order than they were sent, so a start called off this way is
    /// refused when it comes. A few at most: each is used once, and a
    /// window that closes takes its own.
    called_off: Vec<(String, u32)>,
    /// The starts heard lately, by window and the page's number, booked or
    /// refused: a cancel for one of these has nothing to wait for (#920).
    seen: Vec<(String, u32)>,
}

/// The most cancels kept for starts not yet heard; the oldest go first.
const MOST_CALLED_OFF: usize = 8;
/// The most starts remembered as heard.
const MOST_SEEN: usize = 32;

struct Recording {
    id: u64,
    /// The window that started it, and the only one told about it.
    window: String,
    /// The page's number for this start, which its cancel names (#920).
    start: u32,
    /// There once its microphone is open. Before that the recording is only
    /// a name on the books.
    started: Option<Started>,
}

struct Started {
    stop: oneshot::Sender<()>,
    done: JoinHandle<Result<Clip, String>>,
}

impl Started {
    /// Stop it and throw it away, unheard.
    fn discard(self) {
        let _ = self.stop.send(());
        self.done.abort();
    }
}

impl Clips {
    /// Put a recording on the books for `window`, before anything is waited
    /// for: opening a microphone takes a moment, and a window closed in that
    /// moment has to find its recording here to take it away (`forget`,
    /// #913). Refused while another is being recorded, or opened.
    /// A start its window called off before it got here is refused.
    fn begin(&self, window: &str, start: u32) -> Result<u64, &'static str> {
        let mut books = self.lock();
        if books.seen.len() == MOST_SEEN {
            books.seen.remove(0);
        }
        books.seen.push((window.to_owned(), start));
        if let Some(at) = books
            .called_off
            .iter()
            .position(|(by, which)| by == window && *which == start)
        {
            books.called_off.remove(at);
            return Err(CALLED_OFF);
        }
        if books.recording.is_some() {
            return Err(ALREADY);
        }
        books.next += 1;
        let id = books.next;
        books.recording = Some(Recording {
            id,
            window: window.to_owned(),
            start,
            started: None,
        });
        Ok(id)
    }

    /// Call off the start `window` numbered `start`: taken off the books if
    /// it's there, and remembered if it hasn't come yet. Never another start,
    /// so a later recording is safe from an earlier one's cancel (#920).
    ///
    /// Remembered only while the shell hasn't heard that start: one heard
    /// and gone (refused, failed, stopped) has nothing left to call off.
    fn call_off(&self, window: &str, start: u32) -> Option<Recording> {
        let mut books = self.lock();
        let named = (window.to_owned(), start);
        match books.recording.as_ref() {
            Some(recording) if recording.window == window && recording.start == start => {
                books.recording.take()
            }
            _ if books.seen.contains(&named) => None,
            _ => {
                if books.called_off.len() == MOST_CALLED_OFF {
                    books.called_off.remove(0);
                }
                books.called_off.push(named);
                None
            }
        }
    }

    /// A window has gone: its recording, and everything kept for it.
    fn forget_window(&self, window: &str) -> Option<Recording> {
        let taken = self.take_from(window);
        let mut books = self.lock();
        books.called_off.retain(|(by, _)| by != window);
        books.seen.retain(|(by, _)| by != window);
        taken
    }

    /// Recording `id` has its microphone open and is under way. When it was
    /// taken off the books meanwhile (its window closed, or it was stopped),
    /// it's thrown away here instead, and that's said.
    fn started(&self, id: u64, started: Started) -> bool {
        let mut books = self.lock();
        if let Some(recording) = books
            .recording
            .as_mut()
            .filter(|recording| recording.id == id && recording.started.is_none())
        {
            recording.started = Some(started);
            return true;
        }
        started.discard();
        false
    }

    /// Recording `id` never got going (its microphone wouldn't open): off
    /// the books, unless a later one is there now.
    fn failed(&self, id: u64) {
        let mut books = self.lock();
        if books
            .recording
            .as_ref()
            .is_some_and(|recording| recording.id == id)
        {
            books.recording = None;
        }
    }

    /// Take whatever is on the books, opening or under way.
    #[cfg(test)]
    fn take(&self) -> Option<Recording> {
        self.lock().recording.take()
    }

    /// Take the recording `window` started, if that's the one on the books.
    fn take_from(&self, window: &str) -> Option<Recording> {
        let mut books = self.lock();
        if books
            .recording
            .as_ref()
            .is_some_and(|recording| recording.window == window)
        {
            books.recording.take()
        } else {
            None
        }
    }

    fn lock(&self) -> MutexGuard<'_, Books> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
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
    /// about 2.4 MB. A packet is never longer than 1500 bytes
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
        loudest = loudest.max(level::loudness(&frame));
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

/// Start recording a voice message (#401) from the chosen microphone, or the
/// default one for `None`. Refused while another is being recorded.
#[tauri::command]
pub async fn clip_start(
    app: AppHandle,
    window: Window,
    input: Option<String>,
    start: u32,
) -> Result<(), String> {
    let label = window.label().to_string();
    let id = app.state::<Clips>().begin(&label, start)?;
    // Off the books again however this ends before it's under way: an error,
    // or this command being dropped while it waits.
    let mut booked = Booked {
        app: app.clone(),
        id,
        under_way: false,
    };
    let opened = tokio::task::spawn_blocking(move || {
        crate::voice::device::Microphone::open(input.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|opened| opened.map_err(|error| error.to_string()));
    let microphone = opened?;
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
    if app.state::<Clips>().started(id, Started { stop, done }) {
        booked.under_way = true;
        Ok(())
    } else {
        // Its window closed, or it was stopped, while the microphone opened.
        Err(CALLED_OFF.into())
    }
}

/// A recording on the books that isn't under way yet: dropped before it is,
/// it comes off them, so nothing is left to refuse the next one.
struct Booked {
    app: AppHandle,
    id: u64,
    under_way: bool,
}

impl Drop for Booked {
    fn drop(&mut self) {
        if !self.under_way {
            self.app.state::<Clips>().failed(self.id);
        }
    }
}

const ALREADY: &str = "A voice message is already being recorded.";
const CALLED_OFF: &str = "The voice message was called off while the microphone opened.";

/// Stop recording and hand the clip back (`Clip::to_bytes`). One that already
/// stopped by itself (full, or the microphone gone) is handed back the same
/// way.
#[tauri::command]
pub async fn clip_stop(app: AppHandle, window: Window) -> Result<Response, String> {
    // This window's own: one window never stops another's. One still opening
    // its microphone is taken off the books, and `clip_start` throws it away
    // once the microphone opens.
    let recording = app.state::<Clips>().take_from(window.label());
    let started = match recording {
        None => return Err("Nothing is being recorded.".into()),
        Some(Recording { started: None, .. }) => return Err(CALLED_OFF.into()),
        Some(Recording {
            started: Some(started),
            ..
        }) => started,
    };
    let _ = started.stop.send(());
    let clip = started.done.await.map_err(|error| error.to_string())??;
    Ok(Response::new(clip.to_bytes()))
}

/// Stop recording and throw it away: the start the page numbered `start`,
/// and no other (#920).
#[tauri::command]
pub async fn clip_cancel(app: AppHandle, window: Window, start: u32) {
    let recording = app.state::<Clips>().call_off(window.label(), start);
    if let Some(started) = recording.and_then(|recording| recording.started) {
        started.discard();
    }
}

/// A window has gone: a recording it started goes with it, unheard, and so
/// do the cancels it sent for starts that never came.
///
/// One whose microphone is still opening is taken off the books, and
/// `clip_start` throws it away once the microphone opens (#913).
pub fn forget(app: &AppHandle, label: &str) {
    let recording = app.state::<Clips>().forget_window(label);
    if let Some(started) = recording.and_then(|recording| recording.started) {
        started.discard();
    }
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

    /// A recording is on the books before its microphone opens (#913), so
    /// a window that closes in that moment takes it away: nothing records
    /// afterwards, and the next voice message starts.
    #[tokio::test]
    async fn a_window_closed_while_the_microphone_opens_takes_its_recording_with_it() {
        let clips = Clips::default();
        let id = clips.begin("main", 1).expect("the first recording");
        // Another window can't start one while this microphone opens, and
        // its closing takes nothing that isn't its own.
        assert_eq!(clips.begin("chat", 5).err(), Some(ALREADY));
        assert!(clips.take_from("chat").is_none());
        assert!(
            clips.take_from("main").is_some(),
            "the window's closing found nothing"
        );
        // The microphone is open now, and too late: what would have recorded
        // is stopped, not started.
        // The task never finishes by itself; it's thrown away when what it
        // holds is dropped, which says so at once rather than after a wait.
        let (stop, _stopped) = oneshot::channel();
        let (alive, gone) = oneshot::channel::<()>();
        let done = tokio::spawn(async move {
            let _alive = alive;
            std::future::pending::<()>().await;
            Ok(Clip::default())
        });
        assert!(!clips.started(id, Started { stop, done }));
        let ended = tokio::time::timeout(std::time::Duration::from_secs(5), gone).await;
        assert!(matches!(ended, Ok(Err(_))), "it recorded anyway");
        // And the next voice message starts, as if nothing had happened.
        assert!(clips.begin("main", 2).is_ok());
    }

    /// A microphone that won't open leaves nothing on the books, and an
    /// earlier recording that ends late doesn't take a later one with it.
    #[tokio::test]
    async fn each_recording_ends_only_itself() {
        let clips = Clips::default();
        let first = clips.begin("main", 3).expect("the first recording");
        clips.failed(first);
        let second = clips
            .begin("main", 6)
            .expect("free again after a failed microphone");
        clips.failed(first);
        assert_eq!(
            clips.begin("main", 4).err(),
            Some(ALREADY),
            "the first's failure ended the second"
        );
        // The first's microphone opening this late is thrown away, and the
        // second carries on.
        let (stop, _stopped) = oneshot::channel();
        let done = tokio::spawn(async { Ok(Clip::default()) });
        assert!(!clips.started(first, Started { stop, done }));
        let (stop, _stopped) = oneshot::channel();
        let done = tokio::spawn(async { Ok(Clip::default()) });
        assert!(clips.started(second, Started { stop, done }));
        assert!(clips
            .take()
            .is_some_and(|recording| recording.started.is_some()));
    }
    /// A cancel that's handled before its start booked is remembered, and
    /// that start is refused when it comes; nothing else is (#920).
    #[test]
    fn a_cancel_before_its_start_refuses_that_start_only() {
        let clips = Clips::default();
        assert!(clips.call_off("main", 7).is_none());
        assert_eq!(clips.begin("main", 7).err(), Some(CALLED_OFF));
        // Used once: the same number again, and other windows', go ahead.
        assert!(clips.begin("chat", 7).is_ok());
        assert!(clips.take_from("chat").is_some());
        assert!(clips.begin("main", 8).is_ok());
    }

    /// A cancel takes only the start it names: an earlier start's cancel,
    /// arriving late, leaves a later recording alone (#920).
    #[test]
    fn a_late_cancel_never_takes_a_later_start() {
        let clips = Clips::default();
        clips.begin("main", 1).expect("the first");
        assert!(clips.call_off("main", 1).is_some());
        clips.begin("main", 2).expect("the second");
        // The first's cancel again, late, and another window's.
        assert!(clips.call_off("main", 1).is_none());
        assert!(clips.call_off("chat", 2).is_none());
        assert!(
            clips.take().is_some_and(|recording| recording.start == 2),
            "the second was taken by another start's cancel"
        );
    }

    /// The cancels kept for starts not yet come are few, and a window that
    /// closes takes its own with it.
    #[test]
    fn cancels_kept_are_few_and_go_with_their_window() {
        let clips = Clips::default();
        for start in 0..20 {
            clips.call_off("main", start);
        }
        assert_eq!(clips.lock().called_off.len(), MOST_CALLED_OFF);
        // The oldest went first.
        assert!(clips.begin("main", 0).is_ok());
        assert!(clips.forget_window("main").is_some());
        assert!(
            clips.lock().called_off.is_empty(),
            "the window's going kept its cancels"
        );
        clips.call_off("chat", 3);
        assert!(clips.forget_window("main").is_none());
        assert_eq!(clips.lock().called_off.len(), 1);
    }

    /// Commands can be handled in any order: start(A), cancel(A), start(B)
    /// sent, B heard first. A's cancel still waits for A, through B's
    /// failing or being stopped, and A is refused when it comes (#920).
    #[test]
    fn a_cancel_waits_for_its_start_whatever_comes_between() {
        let clips = Clips::default();
        let b = clips.begin("main", 2).expect("B first");
        assert!(clips.call_off("main", 1).is_none());
        clips.failed(b);
        assert_eq!(
            clips.begin("main", 1).err(),
            Some(CALLED_OFF),
            "A went ahead after B failed"
        );
        // And through a stop of a later recording (clip_stop takes it).
        assert!(clips.call_off("main", 3).is_none());
        clips.begin("main", 4).expect("the next");
        assert!(clips.take_from("main").is_some());
        assert_eq!(
            clips.begin("main", 3).err(),
            Some(CALLED_OFF),
            "a Stop forgot the cancel"
        );
    }

    /// A cancel for a start heard and gone isn't kept: nothing is waiting.
    #[test]
    fn a_cancel_for_a_start_come_and_gone_is_not_kept() {
        let clips = Clips::default();
        let a = clips.begin("main", 5).expect("A");
        clips.failed(a);
        assert!(clips.call_off("main", 5).is_none());
        assert!(clips.lock().called_off.is_empty());
    }
}
