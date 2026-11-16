//! The microphone, cleaned up before anything is sent (SPEC §4.14, #904).
//!
//! A microphone as the computer hands it over is whatever the hardware and
//! the system's input volume make it: often a fraction as loud as a voice
//! should be, with the room's fan under it. Until this, the desktop app sent
//! exactly that, while the phone app, whose voice runs on the web engine's
//! WebRTC, sent a microphone that had been levelled and cleaned
//! (`lib/pageVoice.ts`, `MICROPHONE`). People on a computer were too quiet
//! to hear, and the most a listener could turn them up was twice (#904).
//!
//! This is the same clean-up a browser gives a call, from `sonora`, a Rust
//! port of WebRTC's audio processing, so it needs nothing installed and
//! builds wherever the app does:
//!
//! - a **high-pass filter**, for rumble under the voice;
//! - **noise suppression**, for what stays the same while nobody talks: a
//!   fan, a hum, hiss;
//! - **automatic levelling**: a gain that follows the voice, slowly, towards
//!   a normal speaking level, moved only by speech, so a quiet room isn't
//!   turned up into hiss and digital silence stays silence;
//! - a **limiter** after it, so a levelled voice can't clip.
//!
//! Two switches choose them ([`Cleanup`]), both on unless the person turned
//! them off in Settings: somebody whose own hardware levels and gates their
//! microphone wants it sent as it is. With both off nothing here touches a
//! sample.
//!
//! It runs where frames are read (`device::Microphone`), not in the audio
//! callback: twenty milliseconds of microphone take it well under a tenth of
//! a millisecond.

use std::sync::atomic::{AtomicBool, Ordering};

use sonora::config::{AdaptiveDigital, GainController2, HighPassFilter, NoiseSuppression};
use sonora::{AudioProcessing, Config, StreamConfig};

use super::audio::{CHANNELS, SAMPLE_RATE};

/// What the clean-up works in: ten milliseconds, half of one of our frames.
const PIECE: usize = SAMPLE_RATE as usize / 100;

/// Which parts of the clean-up are on. Settings' two switches, kept on this
/// computer by the page (`lib/voice.ts`) and told to the shell by
/// `voice_clean_up`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub struct Cleanup {
    /// Bring the voice to a normal speaking level, with a limiter after it.
    pub level: bool,
    /// Take out steady background noise.
    pub noise: bool,
}

impl Cleanup {
    /// Everything on: what a person who never opened Settings gets.
    pub const ALL: Self = Self {
        level: true,
        noise: true,
    };

    /// Nothing on: the microphone as the computer hands it over.
    pub const NONE: Self = Self {
        level: false,
        noise: false,
    };

    fn any(self) -> bool {
        self.level || self.noise
    }

    fn config(self) -> Config {
        Config {
            // Rumble goes whenever anything is cleaned: it's what both of
            // the others would otherwise work on.
            high_pass_filter: Some(HighPassFilter::default()),
            noise_suppression: self.noise.then(NoiseSuppression::default),
            gain_controller2: self.level.then(|| GainController2 {
                adaptive_digital: Some(AdaptiveDigital {
                    initial_gain_db: INITIAL_GAIN_DB,
                    ..AdaptiveDigital::default()
                }),
                ..GainController2::default()
            }),
            ..Config::default()
        }
    }
}

impl Default for Cleanup {
    fn default() -> Self {
        Self::ALL
    }
}

/// The gain levelling starts from, before it has heard anybody. WebRTC's own
/// start is 15 dB: right at once for a microphone 20 dB quiet, and 7 dB too
/// loud, into the limiter, for a normal one's first two seconds. From 0 dB a
/// normal one is right at once and the quiet one takes seven seconds of
/// speech to come up. Measured from 8 dB (#904): the normal one is 4 dB over
/// for its first second, and the quiet one starts 7 dB up and is within a
/// decibel of its level after four seconds of speech.
const INITIAL_GAIN_DB: f32 = 8.0;

/// What's chosen in Settings, for every microphone this app opens: a call's
/// and a voice message's are the same microphone.
static LEVEL: AtomicBool = AtomicBool::new(true);
static NOISE: AtomicBool = AtomicBool::new(true);

/// Settings' choice, from the page. Takes effect on the next frame of any
/// microphone that's open.
pub fn choose(cleanup: Cleanup) {
    LEVEL.store(cleanup.level, Ordering::Relaxed);
    NOISE.store(cleanup.noise, Ordering::Relaxed);
}

/// What Settings last chose, or everything on.
#[must_use]
pub fn chosen() -> Cleanup {
    Cleanup {
        level: LEVEL.load(Ordering::Relaxed),
        noise: NOISE.load(Ordering::Relaxed),
    }
}

/// One microphone's clean-up: what it has learned about the voice and the
/// room so far, and the switches it was built for.
pub struct Cleaner {
    cleanup: Cleanup,
    /// `None` while nothing is on, so a raw microphone costs nothing.
    processing: Option<AudioProcessing>,
    /// Said once, not fifty times a second.
    failed: bool,
}

impl Cleaner {
    #[must_use]
    pub fn new(cleanup: Cleanup) -> Self {
        Self {
            cleanup,
            processing: cleanup.any().then(|| build(cleanup)),
            failed: false,
        }
    }

    /// Follow Settings. A change starts the clean-up afresh: its parts are
    /// built together, and a moment of relearning the level is all it costs.
    pub fn follow(&mut self, cleanup: Cleanup) {
        if cleanup != self.cleanup {
            *self = Self::new(cleanup);
        }
    }

    /// Another microphone is under this now (#249): what was learned about
    /// the last one's level and noise is forgotten.
    pub fn restart(&mut self) {
        *self = Self::new(self.cleanup);
    }

    /// Clean one frame in place: mono at [`SAMPLE_RATE`], a whole number of
    /// ten-millisecond pieces, as every frame from a microphone is. Anything
    /// left over at the end is passed as it came, as is every sample if the
    /// clean-up fails: a voice sent raw is better than one not sent.
    pub fn clean(&mut self, frame: &mut [i16]) {
        let Some(processing) = self.processing.as_mut() else {
            return;
        };
        let mut raw = [0i16; PIECE];
        for piece in frame.chunks_exact_mut(PIECE) {
            raw.copy_from_slice(piece);
            if let Err(error) = processing.process_capture_i16(&raw, piece) {
                piece.copy_from_slice(&raw);
                if !self.failed {
                    eprintln!("voice: microphone clean-up: {error}");
                    self.failed = true;
                }
            }
        }
    }
}

fn build(cleanup: Cleanup) -> AudioProcessing {
    let stream = StreamConfig::new(SAMPLE_RATE, CHANNELS);
    AudioProcessing::builder()
        .config(cleanup.config())
        .capture_config(stream)
        .render_config(stream)
        .build()
}

/// Sounds made for the tests, here and in `device.rs`: nothing recorded is
/// kept in the repository. The voice is voice-like enough that the
/// levelling, which only moves for speech, takes it for somebody talking.
#[cfg(test)]
pub(crate) mod sounds {
    use super::SAMPLE_RATE;

    /// Held by a test that changes Settings' choice, or reads it through a
    /// microphone: the choice is one for the whole app, and tests run at the
    /// same time.
    pub(crate) static CHOICE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Somebody talking, `db` decibels down from a well-recorded voice
    /// (about −21 dBFS, peaks at −6): a pitched buzz whose pitch wanders,
    /// shaped by three formants that move from vowel to vowel, in syllables
    /// with gaps between them and a longer pause now and then.
    pub(crate) fn voice(seconds: f32, db: f32) -> Vec<i16> {
        const VOWELS: [[f32; 3]; 5] = [
            [730.0, 1090.0, 2440.0],
            [270.0, 2290.0, 3010.0],
            [300.0, 870.0, 2240.0],
            [530.0, 1840.0, 2480.0],
            [570.0, 840.0, 2410.0],
        ];
        const WIDTHS: [f32; 3] = [90.0, 110.0, 160.0];
        const WEIGHTS: [f32; 3] = [1.0, 0.6, 0.3];
        let rate = SAMPLE_RATE as f32;
        let tau = std::f32::consts::TAU;
        let mut phase = [0.0f32; 40];
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let count = (seconds * rate) as usize;
        let mut out = Vec::with_capacity(count);
        for n in 0..count {
            #[allow(clippy::cast_precision_loss)]
            let t = n as f32 / rate;
            let syllable = t * 3.3;
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let k = syllable as usize;
            #[allow(clippy::cast_precision_loss)]
            let within = syllable - k as f32;
            let envelope = if within < 0.75 && k % 7 != 6 {
                (std::f32::consts::PI * within / 0.75).sin().powi(2)
            } else {
                0.0
            };
            let pitch = 120.0 * (1.0 + 0.08 * (tau * 0.9 * t).sin() + 0.03 * (tau * 5.1 * t).sin());
            let vowel = VOWELS[k % VOWELS.len()];
            let mut sample = 0.0f32;
            for (h, phase) in phase.iter_mut().enumerate().skip(1) {
                #[allow(clippy::cast_precision_loss)]
                let harmonic = h as f32;
                let frequency = pitch * harmonic;
                if frequency > 7000.0 {
                    break;
                }
                *phase = (*phase + tau * frequency / rate) % tau;
                let mut weight = 0.02;
                for i in 0..3 {
                    weight += WEIGHTS[i] / (1.0 + ((frequency - vowel[i]) / WIDTHS[i]).powi(2));
                }
                sample += weight / harmonic.sqrt() * phase.sin();
            }
            out.push(envelope * sample);
        }
        let peak = out.iter().fold(0.0f32, |most, s| most.max(s.abs()));
        let scale = 0.5 * 10f32.powf(db / 20.0) / peak * f32::from(i16::MAX);
        #[allow(clippy::cast_possible_truncation)]
        let samples = out
            .iter()
            .map(|s| (s * scale).clamp(-32768.0, 32767.0) as i16)
            .collect();
        samples
    }

    /// Steady hiss, as a fan or a noisy input makes: the same every run.
    pub(crate) fn hiss(seconds: f32, dbfs: f32) -> Vec<i16> {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let count = (seconds * SAMPLE_RATE as f32) as usize;
        // Uniform noise between −1 and 1 has an RMS of 1/√3.
        let amplitude = 10f32.powf(dbfs / 20.0) * 3f32.sqrt() * f32::from(i16::MAX);
        let mut state = 0x2545_f491u32;
        (0..count)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                #[allow(clippy::cast_precision_loss)]
                let unit = (state >> 8) as f32 / (1u32 << 23) as f32 - 1.0;
                #[allow(clippy::cast_possible_truncation)]
                let sample = (unit * amplitude) as i16;
                sample
            })
            .collect()
    }

    /// How loud samples are, in dBFS: 0 the loudest there is.
    pub(crate) fn dbfs(samples: &[i16]) -> f32 {
        let rms = crate::voice::level::rms(samples);
        if rms <= 0.0 {
            return -120.0;
        }
        20.0 * (rms / f32::from(i16::MAX)).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::sounds::{dbfs, hiss, voice};
    use super::*;
    use crate::voice::audio::FRAME_SAMPLES;

    /// A sound through a cleaner, a frame at a time, as a microphone's is.
    fn through(cleaner: &mut Cleaner, sound: &[i16]) -> Vec<i16> {
        let mut out = sound.to_vec();
        for frame in out.chunks_mut(FRAME_SAMPLES) {
            cleaner.clean(frame);
        }
        out
    }

    /// The last `seconds` of a sound: after the levelling has settled.
    fn end(sound: &[i16], seconds: usize) -> &[i16] {
        &sound[sound.len() - seconds * SAMPLE_RATE as usize..]
    }

    /// #904: a microphone 20 dB quiet, and one 30 dB quiet, both come out
    /// at a speaking level, not where they went in.
    #[test]
    fn a_quiet_voice_comes_out_at_a_speaking_level() {
        for (down, least_gain) in [(-20.0, 12.0), (-30.0, 20.0)] {
            let said = voice(12.0, down);
            let heard = through(&mut Cleaner::new(Cleanup::ALL), &said);
            let (before, after) = (dbfs(end(&said, 4)), dbfs(end(&heard, 4)));
            assert!(
                (-30.0..=-18.0).contains(&after),
                "a voice at {before:.1} dBFS came out at {after:.1} dBFS, not a speaking level"
            );
            assert!(
                after - before >= least_gain,
                "a voice {down} dB down gained only {:.1} dB",
                after - before
            );
        }
    }

    /// A microphone that was fine is still about as loud as it was.
    #[test]
    fn a_normal_voice_stays_about_where_it_was() {
        let said = voice(8.0, 0.0);
        let heard = through(&mut Cleaner::new(Cleanup::ALL), &said);
        let moved = dbfs(end(&heard, 4)) - dbfs(end(&said, 4));
        assert!(moved.abs() <= 3.0, "a normal voice moved by {moved:.1} dB");
    }

    /// A voice louder than the samples can hold once levelled is held under
    /// the top by the limiter, not flattened against it.
    #[test]
    fn a_loud_voice_is_limited_not_clipped() {
        let said = voice(6.0, 5.0);
        let heard = through(&mut Cleaner::new(Cleanup::ALL), &said);
        let flat = heard
            .windows(3)
            .filter(|run| run.iter().all(|s| s.unsigned_abs() >= 32_767))
            .count();
        assert_eq!(flat, 0, "{flat} runs of samples flat against the top");
    }

    /// A noise gate's silence, or a muted input's, stays exactly silence:
    /// levelling moves for speech only (Matt's own microphone, 2026-10-03).
    #[test]
    fn silence_stays_silence() {
        let heard = through(
            &mut Cleaner::new(Cleanup::ALL),
            &vec![0i16; 5 * SAMPLE_RATE as usize],
        );
        assert!(
            heard.iter().all(|s| *s == 0),
            "silence came out as something"
        );
    }

    /// A quiet room with nobody talking isn't turned up into hiss.
    #[test]
    fn a_quiet_room_is_not_turned_up() {
        let room = hiss(10.0, -60.0);
        let heard = through(&mut Cleaner::new(Cleanup::ALL), &room);
        let moved = dbfs(end(&heard, 4)) - dbfs(end(&room, 4));
        assert!(moved <= 3.0, "a quiet room got {moved:.1} dB louder");
    }

    /// Noise suppression by itself takes steady noise down, and moves no
    /// level: the levelling switch is off.
    #[test]
    fn noise_suppression_takes_steady_noise_down() {
        let room = hiss(10.0, -40.0);
        let only_noise = Cleanup {
            level: false,
            noise: true,
        };
        let heard = through(&mut Cleaner::new(only_noise), &room);
        let moved = dbfs(end(&heard, 4)) - dbfs(end(&room, 4));
        assert!(
            moved <= -6.0,
            "steady noise moved by {moved:.1} dB, not down by 6 or more"
        );

        let said = voice(8.0, -20.0);
        let voiced = through(&mut Cleaner::new(only_noise), &said);
        let moved = dbfs(end(&voiced, 4)) - dbfs(end(&said, 4));
        assert!(
            moved.abs() <= 3.0,
            "with levelling off, a voice moved by {moved:.1} dB"
        );
    }

    /// Both switches off is the microphone as it came, to the sample: for
    /// somebody whose own hardware does all this.
    #[test]
    fn with_both_off_nothing_is_touched() {
        let said = voice(2.0, -20.0);
        let heard = through(&mut Cleaner::new(Cleanup::NONE), &said);
        assert_eq!(heard, said);
    }

    /// Settings changed in a call: the next frames follow it, both ways.
    #[test]
    fn a_cleaner_follows_settings() {
        let said = voice(8.0, -20.0);
        let mut cleaner = Cleaner::new(Cleanup::NONE);
        cleaner.follow(Cleanup::ALL);
        let heard = through(&mut cleaner, &said);
        assert!(
            dbfs(end(&heard, 4)) - dbfs(end(&said, 4)) >= 12.0,
            "switched on, it levelled nothing"
        );
        cleaner.follow(Cleanup::NONE);
        assert_eq!(
            through(&mut cleaner, &said),
            said,
            "switched off, it still changed samples"
        );
    }

    /// What levelling learned on one microphone isn't used on the next: the
    /// gain goes back to where it starts.
    #[test]
    fn a_restart_forgets_the_level_it_learned() {
        let said = voice(10.0, -30.0);
        let mut cleaner = Cleaner::new(Cleanup::ALL);
        let settled = through(&mut cleaner, &said);
        let learned = dbfs(end(&settled, 2)) - dbfs(end(&said, 2));
        cleaner.restart();
        let first = &said[..SAMPLE_RATE as usize];
        let again = through(&mut cleaner, first);
        let afresh = dbfs(&again) - dbfs(first);
        assert!(
            learned - afresh >= 8.0,
            "after a restart the gain was {afresh:.1} dB, against {learned:.1} dB learned"
        );
    }

    /// A frame that isn't whole pieces has its end passed as it came.
    #[test]
    fn what_is_left_over_passes_as_it_came() {
        let said = voice(1.0, -20.0);
        let mut frame = said[..FRAME_SAMPLES + 100].to_vec();
        Cleaner::new(Cleanup::ALL).clean(&mut frame);
        assert_eq!(
            frame[FRAME_SAMPLES..],
            said[FRAME_SAMPLES..FRAME_SAMPLES + 100]
        );
        assert_ne!(frame[..FRAME_SAMPLES], said[..FRAME_SAMPLES]);
    }

    /// Settings' choice reaches every microphone, and starts with everything
    /// on. Put back at the end: other tests read it.
    #[test]
    fn what_settings_chose_is_what_microphones_read() {
        let _settings = super::sounds::CHOICE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let was = chosen();
        choose(Cleanup {
            level: false,
            noise: true,
        });
        assert_eq!(
            chosen(),
            Cleanup {
                level: false,
                noise: true
            }
        );
        choose(was);
        assert_eq!(Cleanup::default(), Cleanup::ALL);
    }
}
