//! Opus, in both directions (SPEC §4.14, T-1402).
//!
//! WebRTC audio *is* Opus: it is the one codec every implementation must
//! carry, and the one `voice::Engine` negotiates. There is no mature pure-Rust
//! encoder, so this wraps libopus — built from the vendored source by the
//! `opus` crate (which is why `cmake` is on the build box list), so a shipped
//! binary carries its own copy and nobody's machine needs a system libopus.
//!
//! One frame in is one packet out, and one packet in is one frame out. The
//! frame is `audio::FRAME_SAMPLES` of mono at `audio::SAMPLE_RATE`, which is
//! also what the RTP payload format for Opus (RFC 7587) puts in one packet, so
//! nothing here has to split or join anything.

use crate::voice::audio::{FRAME_SAMPLES, SAMPLE_RATE};

/// The most bytes one encoded frame is allowed to be. libopus caps a single
/// frame at 1275; the rest is headroom that costs nothing.
const MAX_PACKET: usize = 1500;

/// How many bits a second a voice message is encoded at (#401).
pub const CLIP_BITS_PER_SECOND: i32 = 64_000;

/// Turns frames of samples into Opus packets.
pub struct Encoder(opus::Encoder);

impl Encoder {
    /// Tuned for a voice, not for music: `Voip` biases libopus toward
    /// intelligibility at low bitrates. In-band FEC with a 10% loss hint costs
    /// a little bandwidth and lets the far end repair a single lost packet from
    /// the one after it — cheap insurance on exactly the networks AGENTS says
    /// this code will meet.
    pub fn new() -> Result<Self, opus::Error> {
        let mut inner =
            opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip)?;
        inner.set_inband_fec(true)?;
        inner.set_packet_loss_perc(10)?;
        Ok(Self(inner))
    }

    /// Tuned for a voice message (#401): the same voice settings, at 64
    /// kbit/s, what Discord gives a voice by default, and about 2.4 MB for the
    /// longest clip. A message is heard again and kept, so it's worth more
    /// bits than a live call, and nothing of the loss repair a live call
    /// needs, since a recording never crosses a network packet by packet.
    /// Voice rooms keep the encoder's own rate (`new`).
    pub fn for_clip() -> Result<Self, opus::Error> {
        let mut inner =
            opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip)?;
        inner.set_bitrate(opus::Bitrate::Bits(CLIP_BITS_PER_SECOND))?;
        Ok(Self(inner))
    }

    /// How many samples the encoder runs ahead: the decoder drops that many
    /// from the start of a recording (Opus's "pre-skip", RFC 7845).
    pub fn lookahead(&mut self) -> Result<u16, opus::Error> {
        let samples = self.0.get_lookahead()?;
        Ok(u16::try_from(samples).unwrap_or(0))
    }

    /// One frame, one packet.
    pub fn encode(&mut self, frame: &[i16]) -> Result<Vec<u8>, opus::Error> {
        self.0.encode_vec(frame, MAX_PACKET)
    }
}

/// Turns Opus packets back into frames of samples.
pub struct Decoder(opus::Decoder);

impl Decoder {
    pub fn new() -> Result<Self, opus::Error> {
        Ok(Self(opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono)?))
    }

    /// One packet, one frame.
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<i16>, opus::Error> {
        let mut out = vec![0i16; FRAME_SAMPLES];
        let n = self.0.decode(packet, &mut out, false)?;
        out.truncate(n);
        Ok(out)
    }

    /// A frame for a packet that never arrived.
    ///
    /// libopus guesses at it from what came before — packet loss concealment —
    /// which sounds like a brief smear rather than a click. A gap filled with
    /// zeros is the click, and it is also the wrong length for the far end's
    /// clock, which is how a call drifts out of sync one lost packet at a time.
    pub fn conceal(&mut self) -> Result<Vec<i16>, opus::Error> {
        let mut out = vec![0i16; FRAME_SAMPLES];
        let n = self.0.decode(&[], &mut out, false)?;
        out.truncate(n);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame of 440 Hz at a comfortable level, `n` frames in.
    fn tone(n: usize) -> Vec<i16> {
        let start = n * FRAME_SAMPLES;
        (0..FRAME_SAMPLES)
            .map(|i| {
                #[allow(clippy::cast_precision_loss)]
                let t = (start + i) as f32 / SAMPLE_RATE as f32;
                #[allow(clippy::cast_possible_truncation)]
                let v = (t * 440.0 * std::f32::consts::TAU).sin() * 8000.0;
                v as i16
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        let sum: f64 = samples.iter().map(|s| f64::from(*s).powi(2)).sum();
        #[allow(clippy::cast_precision_loss)]
        (sum / samples.len() as f64).sqrt()
    }

    fn zero_crossings(samples: &[i16]) -> usize {
        samples
            .windows(2)
            .filter(|w| (w[0] < 0) != (w[1] < 0))
            .count()
    }

    /// A voice message is encoded at 64 kbit/s (#401), and stays sound all
    /// the way: a clip encoder's tone comes back a tone too.
    #[test]
    fn a_voice_message_is_encoded_at_64_kbit_per_second() {
        let mut encoder = Encoder::for_clip().expect("encoder");
        assert_eq!(
            encoder.0.get_bitrate().expect("bitrate"),
            opus::Bitrate::Bits(64_000)
        );
        let mut decoder = Decoder::new().expect("decoder");
        let mut last = Vec::new();
        for n in 0..3 {
            last = decoder
                .decode(&encoder.encode(&tone(n)).expect("encode"))
                .expect("decode");
        }
        assert!(rms(&last) > 1000.0, "the tone was lost");
    }

    /// The proof that both halves agree: a tone goes in one side and a tone
    /// comes out the other. Opus is lossy and has a few milliseconds of
    /// lookahead, so the first frame comes back partly delayed; the third is
    /// steady state and is what is checked.
    #[test]
    fn a_tone_survives_the_round_trip() {
        let mut encoder = Encoder::new().expect("encoder");
        let mut decoder = Decoder::new().expect("decoder");
        let mut last = Vec::new();
        for n in 0..3 {
            let packet = encoder.encode(&tone(n)).expect("encode");
            assert!(packet.len() > 1, "a tone encoded to nothing");
            assert!(packet.len() <= MAX_PACKET);
            last = decoder.decode(&packet).expect("decode");
        }
        assert_eq!(
            last.len(),
            FRAME_SAMPLES,
            "a packet decoded to the wrong length"
        );
        assert!(
            rms(&last) > 3000.0,
            "the tone came back too quiet: rms {}",
            rms(&last)
        );
        // 440 Hz crosses zero 880 times a second, so about 17 or 18 in 20 ms.
        let crossings = zero_crossings(&last);
        assert!(
            (12..=24).contains(&crossings),
            "the tone came back at the wrong pitch: {crossings} crossings"
        );
    }

    /// Concealment has to produce a full frame, or a lost packet shortens the
    /// far end's timeline and every later packet lands early.
    #[test]
    fn a_lost_packet_is_concealed_at_full_length() {
        let mut encoder = Encoder::new().expect("encoder");
        let mut decoder = Decoder::new().expect("decoder");
        for n in 0..3 {
            let packet = encoder.encode(&tone(n)).expect("encode");
            decoder.decode(&packet).expect("decode");
        }
        let guess = decoder.conceal().expect("conceal");
        assert_eq!(guess.len(), FRAME_SAMPLES);
        assert!(
            guess.iter().any(|s| *s != 0),
            "concealment produced silence, which is a click and a drift"
        );
    }

    /// Silence has to encode too, because a muted microphone sends silence
    /// rather than nothing (see `audio::Source`).
    #[test]
    fn silence_encodes_to_a_small_packet() {
        let mut encoder = Encoder::new().expect("encoder");
        let packet = encoder.encode(&vec![0i16; FRAME_SAMPLES]).expect("encode");
        assert!(!packet.is_empty());
        assert!(packet.len() < 100, "silence took {} bytes", packet.len());
    }
}
