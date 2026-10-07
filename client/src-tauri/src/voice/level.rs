//! Is anybody talking? (SPEC §4.14, T-1404)
//!
//! The voice surface marks who is speaking, and "speaking" has to be decided
//! somewhere with the samples in hand — which is here, in Rust, not in the
//! WebView. This is the smallest honest version: a level, a threshold, and a
//! little hangover so a breath between words does not flicker the mark off
//! and on. It is not voice activity detection in the M13 sense (that has to
//! gate the *encoder* so silence costs nothing); it is a light on a panel.
//!
//! Pure, and tested as such: a gate is fed a level and a moment and says
//! whether anything changed. The engine turns "changed" into one event and
//! nothing into no event, so a quiet room sends no frames to the window at all.

use std::time::{Duration, Instant};

/// Below this the frame is silence for our purposes. RMS over `i16`, so 500
/// is about −36 dBFS: a quiet room on a laptop microphone sits well under it,
/// a voice at conversational level sits well over it.
pub const THRESHOLD: f32 = 500.0;

/// How long after the last loud frame the mark stays on. A word has gaps in
/// it, and 300 ms is longer than any of them and shorter than a pause.
pub const HANGOVER: Duration = Duration::from_millis(300);

/// Root mean square of one frame. Zero for an empty one.
#[must_use]
pub fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|s| f64::from(*s).powi(2)).sum();
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let mean = (sum / samples.len() as f64).sqrt() as f32;
    mean
}

/// How loud a frame is, as the audio level each voice packet carries (RFC
/// 6464): decibels below the loudest a sample can be, 0 the loudest and 127
/// silence. The forwarding server passes on a room's six loudest voices by it
/// (#197), so a dozen people cheering at once can't overload it.
#[must_use]
pub fn dbov(rms: f32) -> u8 {
    if rms <= 0.0 {
        return 127;
    }
    let below = -20.0 * (rms / f32::from(i16::MAX)).log10();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let level = below.round().clamp(0.0, 127.0) as u8;
    level
}

/// One speaker's on/off state, with hysteresis in time.
#[derive(Debug, Default)]
pub struct Gate {
    on: bool,
    last_loud: Option<Instant>,
}

impl Gate {
    /// Feed one frame's level. `Some(state)` when the answer changed, `None`
    /// when it did not — so a caller can emit exactly one event per change.
    pub fn update(&mut self, level: f32, now: Instant) -> Option<bool> {
        if level >= THRESHOLD {
            self.last_loud = Some(now);
            if self.on {
                return None;
            }
            self.on = true;
            return Some(true);
        }
        if !self.on {
            return None;
        }
        let quiet_for = self
            .last_loud
            .map_or(HANGOVER, |at| now.saturating_duration_since(at));
        if quiet_for < HANGOVER {
            return None;
        }
        self.on = false;
        Some(false)
    }

    /// Whether the mark is on right now.
    #[must_use]
    pub fn is_on(&self) -> bool {
        self.on
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_has_no_level_and_a_tone_does() {
        assert_eq!(rms(&[]), 0.0);
        assert_eq!(rms(&[0; 960]), 0.0);
        let loud: Vec<i16> = (0..960)
            .map(|n| if n % 2 == 0 { 8000 } else { -8000 })
            .collect();
        assert!((rms(&loud) - 8000.0).abs() < 1.0);
    }

    #[test]
    fn a_frame_s_level_is_decibels_below_the_loudest() {
        assert_eq!(dbov(0.0), 127);
        assert_eq!(dbov(f32::from(i16::MAX)), 0);
        // Half as loud is about 6 dB down; a tenth, 20.
        assert_eq!(dbov(f32::from(i16::MAX) / 2.0), 6);
        assert_eq!(dbov(f32::from(i16::MAX) / 10.0), 20);
        // The talking threshold sits about 36 dB down, a quiet hiss far lower.
        assert_eq!(dbov(THRESHOLD), 36);
        assert_eq!(dbov(0.5), 96);
    }

    #[test]
    fn a_loud_frame_turns_the_mark_on_once() {
        let mut gate = Gate::default();
        let t0 = Instant::now();
        assert_eq!(gate.update(THRESHOLD * 2.0, t0), Some(true));
        assert_eq!(
            gate.update(THRESHOLD * 2.0, t0 + Duration::from_millis(20)),
            None
        );
        assert!(gate.is_on());
    }

    #[test]
    fn a_gap_inside_a_word_does_not_flicker() {
        let mut gate = Gate::default();
        let t0 = Instant::now();
        gate.update(THRESHOLD * 2.0, t0);
        // 100 ms of quiet: still talking as far as the mark is concerned.
        for n in 1..=5 {
            assert_eq!(gate.update(0.0, t0 + Duration::from_millis(20 * n)), None);
        }
        assert!(gate.is_on());
    }

    #[test]
    fn a_real_pause_turns_the_mark_off_once() {
        let mut gate = Gate::default();
        let t0 = Instant::now();
        gate.update(THRESHOLD * 2.0, t0);
        assert_eq!(gate.update(0.0, t0 + HANGOVER), Some(false));
        assert_eq!(gate.update(0.0, t0 + HANGOVER * 2), None);
        assert!(!gate.is_on());
    }

    #[test]
    fn quiet_from_the_start_says_nothing() {
        let mut gate = Gate::default();
        let t0 = Instant::now();
        assert_eq!(gate.update(0.0, t0), None);
        assert_eq!(
            gate.update(THRESHOLD / 2.0, t0 + Duration::from_secs(1)),
            None
        );
    }
}
