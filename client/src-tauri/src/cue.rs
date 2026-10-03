//! The check every one of Linger's own sounds passes before it's played,
//! from any window and on any platform: the desktop's speakers (`sounds.rs`)
//! and the phone's own player (`phone_sound.rs`).

/// The rate the page renders sounds at (`lib/chimes.ts`): 48 kHz, mono, the
/// same as voice (`voice::audio::SAMPLE_RATE`, which a test holds it to).
pub const RATE: u32 = 48_000;

/// The longest sound the shell plays: two seconds. Every cue is under one;
/// anything longer isn't one of Linger's sounds.
pub const MAX_SAMPLES: usize = 2 * RATE as usize;

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

#[cfg(all(test, desktop))]
mod tests {
    #[test]
    fn sounds_are_rendered_at_voices_rate() {
        assert_eq!(super::RATE, crate::voice::audio::SAMPLE_RATE);
    }
}
