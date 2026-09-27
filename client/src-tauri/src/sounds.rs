//! Linger's own sounds, out of the speakers picked in Settings (#250).
//!
//! The chimes, knocks and voice sounds are still made in the page
//! (`lib/chimes.ts` renders each one to samples at the sound volume); what
//! changed is where they are played. The webview can only play to the
//! system's default output: WebKitGTK has no `setSinkId`, and WebView2's
//! device names come from a different API than the picker's. So the page
//! hands the samples to the shell, and the shell plays them where voice
//! plays:
//!
//! - **in a call**, into the call's own speaker, over the voices
//!   (`Engine::cue`), which is also why deafen doesn't silence them;
//! - **otherwise**, on a speaker of our own, opened on the picked device for
//!   the sound and kept open for [`KEEP_OPEN`] after the last one, so a burst
//!   of sounds doesn't open the device over and over.
//!
//! A picked device that isn't there, or won't open, falls back to the
//! default, as it does for voice (`device.rs`).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::voice::audio::SAMPLE_RATE;
use crate::voice::device::{DeviceError, Speaker};

/// How long a sound's own speaker stays open after the last sound. Long
/// enough for the next sound of a burst (a knock and the chime after it),
/// short enough that Linger isn't holding a sound device for nothing.
pub const KEEP_OPEN: Duration = Duration::from_secs(10);

/// The longest sound the shell plays: two seconds. Every cue is under one;
/// anything longer isn't one of Linger's sounds.
pub const MAX_SAMPLES: usize = 2 * SAMPLE_RATE as usize;

/// The loudest a sound may peak: 0.8 of full scale, the same ceiling the
/// sound volume is designed to (`chime-onset.spec.ts`). The chat and Settings
/// windows can play sounds too, and they render other people's messages; a
/// page that went wrong must not be able to blast noise through this.
pub const MAX_PEAK: i16 = 26_214;

/// A sound as the page sent it, made safe to play: `None` when it is empty
/// or too long, and scaled down whole (never clipped) when it peaks above
/// [`MAX_PEAK`].
#[must_use]
pub fn checked(mut samples: Vec<i16>) -> Option<Vec<i16>> {
    if samples.is_empty() || samples.len() > MAX_SAMPLES {
        return None;
    }
    let peak = samples
        .iter()
        .map(|sample| i32::from(*sample).abs())
        .max()
        .unwrap_or(0);
    if peak > i32::from(MAX_PEAK) {
        let scale = f64::from(MAX_PEAK) / f64::from(peak);
        for sample in &mut samples {
            #[allow(clippy::cast_possible_truncation)]
            let scaled = (f64::from(*sample) * scale).round() as i16;
            *sample = scaled;
        }
    }
    Some(samples)
}

/// Somewhere a sound can be played: a real speaker, or a stand-in in the
/// tests.
pub trait Output: Send + Sync + 'static {
    fn cue(&self, samples: &[i16]);
}

impl Output for Speaker {
    fn cue(&self, samples: &[i16]) {
        Speaker::cue(self, samples);
    }
}

type Opener = Box<dyn Fn(Option<&str>) -> Result<Arc<dyn Output>, DeviceError> + Send + Sync>;

/// The sounds' own speaker, for when there is no call to play them in.
pub struct Sounds {
    open: Opener,
    held: Mutex<Option<Held>>,
}

struct Held {
    output: Arc<dyn Output>,
    /// The device it was opened for, by name, or `None` for the default.
    name: Option<String>,
    last: Instant,
}

impl Default for Sounds {
    fn default() -> Self {
        Self::with_opener(Box::new(|name| {
            Speaker::open(name).map(|speaker| Arc::new(speaker) as Arc<dyn Output>)
        }))
    }
}

impl Sounds {
    /// With something other than the real speakers to open, for the tests.
    #[must_use]
    pub fn with_opener(open: Opener) -> Self {
        Self {
            open,
            held: Mutex::new(None),
        }
    }

    /// Play a sound on `output` (by name, or `None` for the default).
    ///
    /// Blocks while a speaker is opened, which is tens of milliseconds, so it
    /// is called off the reactor. A speaker already open for another device
    /// is closed and one opened for this one: switching it in place would
    /// drop this very sound, since a reopened stream starts empty.
    pub fn play(&self, samples: &[i16], output: Option<&str>) -> Result<(), DeviceError> {
        let mut held = lock(&self.held);
        if held
            .as_ref()
            .is_some_and(|held| held.name.as_deref() != output)
        {
            *held = None;
        }
        let now = Instant::now();
        match held.as_mut() {
            Some(held) => {
                held.output.cue(samples);
                held.last = now;
            }
            None => {
                let opened = (self.open)(output)?;
                opened.cue(samples);
                *held = Some(Held {
                    output: opened,
                    name: output.map(str::to_owned),
                    last: now,
                });
            }
        }
        Ok(())
    }

    /// Close the speaker if nothing has played on it for `idle`. True when it
    /// closed.
    pub fn close_idle(&self, idle: Duration) -> bool {
        let mut held = lock(&self.held);
        if held
            .as_ref()
            .is_some_and(|held| held.last.elapsed() >= idle)
        {
            *held = None;
            return true;
        }
        false
    }

    /// Whether a speaker is open for sounds right now.
    #[must_use]
    pub fn is_open(&self) -> bool {
        lock(&self.held).is_some()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in speaker that remembers what it played.
    #[derive(Default)]
    struct Heard(Mutex<Vec<Vec<i16>>>);

    impl Output for Heard {
        fn cue(&self, samples: &[i16]) {
            self.0.lock().unwrap().push(samples.to_vec());
        }
    }

    /// Every device opened, by name, and the stand-in handed out for it.
    type Opened = Arc<Mutex<Vec<(Option<String>, Arc<Heard>)>>>;

    /// Sounds whose speakers are stand-ins, and a record of what was opened.
    fn rig() -> (Sounds, Opened) {
        let opened: Opened = Arc::default();
        let record = Arc::clone(&opened);
        let sounds = Sounds::with_opener(Box::new(move |name| {
            let heard = Arc::new(Heard::default());
            record
                .lock()
                .unwrap()
                .push((name.map(str::to_owned), Arc::clone(&heard)));
            Ok(heard as Arc<dyn Output>)
        }));
        (sounds, opened)
    }

    #[test]
    fn a_sound_plays_on_the_device_picked() {
        let (sounds, opened) = rig();
        sounds.play(&[1, 2, 3], Some("Headphones")).unwrap();
        let opened = opened.lock().unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!(opened[0].0.as_deref(), Some("Headphones"));
        assert_eq!(*opened[0].1 .0.lock().unwrap(), vec![vec![1, 2, 3]]);
    }

    #[test]
    fn a_burst_uses_one_speaker_and_a_new_pick_opens_another() {
        let (sounds, opened) = rig();
        sounds.play(&[1], None).unwrap();
        sounds.play(&[2], None).unwrap();
        assert_eq!(opened.lock().unwrap().len(), 1, "opened again for a burst");
        // Settings picked other speakers: the next sound comes out of them.
        sounds.play(&[3], Some("USB Audio")).unwrap();
        let opened = opened.lock().unwrap();
        assert_eq!(opened.len(), 2);
        assert_eq!(opened[1].0.as_deref(), Some("USB Audio"));
        assert_eq!(*opened[0].1 .0.lock().unwrap(), vec![vec![1], vec![2]]);
        assert_eq!(*opened[1].1 .0.lock().unwrap(), vec![vec![3]]);
    }

    #[test]
    fn the_speaker_closes_once_nothing_has_played_for_a_while() {
        let (sounds, _) = rig();
        sounds.play(&[1], None).unwrap();
        assert!(
            !sounds.close_idle(Duration::from_secs(60)),
            "closed too soon"
        );
        assert!(sounds.is_open());
        std::thread::sleep(Duration::from_millis(20));
        assert!(sounds.close_idle(Duration::from_millis(10)));
        assert!(!sounds.is_open());
    }

    #[test]
    fn no_speaker_to_open_is_an_answer_not_a_panic() {
        let sounds = Sounds::with_opener(Box::new(|_| Err(DeviceError::NoDevice("output"))));
        assert!(sounds.play(&[1], None).is_err());
        assert!(!sounds.is_open());
    }

    /// On the real speakers: a sound on the default and on every output
    /// listed, then closed. Plays silence, so it can run without anybody
    /// hearing it; what it proves is that each device opens for a sound, or
    /// falls back to the default, without an error reaching the page.
    #[test]
    #[ignore = "needs real output devices"]
    fn sounds_play_on_every_real_output() {
        let sounds = Sounds::default();
        let outputs = crate::voice::device::list().expect("enumerate").outputs;
        for name in std::iter::once(None).chain(outputs.iter().map(|name| Some(name.as_str()))) {
            sounds
                .play(&vec![0; 4_800], name)
                .unwrap_or_else(|error| panic!("{name:?}: {error}"));
            std::thread::sleep(Duration::from_millis(120));
        }
        assert!(sounds.close_idle(Duration::ZERO));
    }

    #[test]
    fn a_sound_is_checked_before_it_plays() {
        assert_eq!(checked(Vec::new()), None, "empty");
        assert_eq!(checked(vec![0; MAX_SAMPLES + 1]), None, "too long");
        assert_eq!(
            checked(vec![100, -200]),
            Some(vec![100, -200]),
            "quiet ones untouched"
        );
        // Too loud: scaled down whole to the ceiling, its shape kept.
        let loud = checked(vec![i16::MAX, i16::MIN, 0, -16_384]).unwrap();
        let peak = loud.iter().map(|s| i32::from(*s).abs()).max().unwrap();
        assert_eq!(peak, i32::from(MAX_PEAK));
        assert_eq!(loud[2], 0);
        assert!(loud[3] < 0 && loud[3] > -16_384);
    }
}
