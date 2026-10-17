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

/// The longest packet Opus's discontinuous transmission (DTX) hands back for
/// a moment of silence: a byte or two that only says "still quiet" (#197).
/// Live voice doesn't send these, as WebRTC and Discord don't: in a room of
/// fifty, the people not talking send almost nothing, where every app used to
/// send fifty packets a second of silence, for the server to copy to everyone.
pub const SILENCE_MAX: usize = 2;

/// Whether a packet from the live-voice encoder is DTX's "still quiet",
/// to be left unsent (#197).
#[must_use]
pub fn is_silence(packet: &[u8]) -> bool {
    packet.len() <= SILENCE_MAX
}

/// How many bits a second a voice message is encoded at (#401).
pub const CLIP_BITS_PER_SECOND: i32 = 64_000;

/// The least and the most bits a second live voice is sent at, whatever a
/// server asks (#431). A voice is still clear at the least; past the most, a
/// mono voice gains nothing anybody can hear, and the host's upload pays.
pub const LIVE_BITS: (i32, i32) = (16_000, 128_000);

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
        // Silence becomes a byte or two (`is_silence`), sent by nobody. Opus
        // eases into it over its first fifth of a second, so a word never
        // ends in a click, and sends a quiet "still here" every 400 ms.
        inner.set_dtx(true)?;
        Ok(Self(inner))
    }

    /// Tuned for a voice message (#401): the same voice settings, at 64
    /// kbit/s, what Discord gives a voice by default, and about 2.4 MB for the
    /// longest clip. A message is heard again and kept, so it's worth more
    /// bits than a live call, and nothing of the loss repair a live call
    /// needs, since a recording never crosses a network packet by packet.
    /// Voice rooms send at the room's quality instead (`set_bits`, #431).
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

    /// Send at `bits` a second from the next frame on, as the room's
    /// `voice.offer` said (#431), kept within `LIVE_BITS`. `None`, from a
    /// server from before that, is Opus's own choice, about 51 kbit/s. Opus
    /// changes rate between one packet and the next with nothing to
    /// renegotiate, so a room changing quality is heard by nobody.
    pub fn set_bits(&mut self, bits: Option<u32>) -> Result<(), opus::Error> {
        self.0.set_bitrate(bits.map_or(opus::Bitrate::Auto, |bits| {
            let (least, most) = LIVE_BITS;
            opus::Bitrate::Bits(i32::try_from(bits).unwrap_or(most).clamp(least, most))
        }))
    }

    /// Whether the last frame was silence to Opus's DTX: a "still here" it
    /// sends now and then while quiet, or one it didn't encode at all (#197).
    /// Neither is sent, as Discord sends nothing once you stop talking: the
    /// frames Opus eases out with before it decides are sent, so a word still
    /// ends cleanly.
    pub fn was_silence(&mut self) -> bool {
        self.0.get_in_dtx().unwrap_or(false)
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

    /// The frame for a packet that never arrived, rebuilt from `next`, the
    /// one that came after it (#655).
    ///
    /// In-band FEC (`Encoder::new`) puts a rougher copy of every frame in the
    /// packet after it, in Opus's speech layer, and libopus reads that copy
    /// out when `next` is decoded with `fec` set. Where `next` holds none (a
    /// quiet frame, which Opus doesn't copy), libopus conceals instead. The
    /// output must be exactly one frame long: that is how libopus knows how
    /// much is missing. `next` itself still has to be decoded after this.
    pub fn rebuild(&mut self, next: &[u8]) -> Result<Vec<i16>, opus::Error> {
        let mut out = vec![0i16; FRAME_SAMPLES];
        let n = self.0.decode(next, &mut out, true)?;
        out.truncate(n);
        Ok(out)
    }
}

#[cfg(test)]
pub(crate) mod tests {
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

    /// A second of silence after talking settles into packets that aren't
    /// sent (#197), all but a "still here" now and then; talking again is
    /// sent at once, and decodes.
    #[test]
    fn silence_goes_unsent_and_talking_comes_back_at_once() {
        let mut encoder = Encoder::new().expect("encoder");
        let mut decoder = Decoder::new().expect("decoder");
        for n in 0..10 {
            let packet = encoder.encode(&tone(n)).expect("encode");
            assert!(!is_silence(&packet), "talking was taken for silence");
        }
        let quiet = vec![0i16; FRAME_SAMPLES];
        let sent = (0..100)
            .filter(|_| {
                let packet = encoder.encode(&quiet).expect("encode");
                !is_silence(&packet) && !encoder.was_silence()
            })
            .count();
        // Opus eases into it over its first frames, and then nothing at all:
        // not even its "still here" every 400 ms.
        assert!(
            sent <= 15,
            "two seconds of silence sent {sent} packets of 100"
        );
        let back = encoder.encode(&tone(60)).expect("encode");
        assert!(!is_silence(&back), "talking again was held back");
        assert_eq!(decoder.decode(&back).expect("decode").len(), FRAME_SAMPLES);
    }

    /// A room's quality is what the encoder sends at (#431), within bounds a
    /// server can't push it past, and a server that says nothing leaves it
    /// to Opus.
    #[test]
    fn the_room_s_quality_is_what_live_voice_is_sent_at() {
        let mut encoder = Encoder::new().expect("encoder");
        let own = encoder.0.get_bitrate().expect("bitrate");
        for (asked, sent) in [
            (96_000, 96_000),
            (128_000, 128_000),
            (510_000, LIVE_BITS.1),
            (u32::MAX, LIVE_BITS.1),
            (6_000, LIVE_BITS.0),
        ] {
            encoder.set_bits(Some(asked)).expect("set");
            assert_eq!(
                encoder.0.get_bitrate().expect("bitrate"),
                opus::Bitrate::Bits(sent),
                "asked for {asked}"
            );
        }
        encoder.set_bits(None).expect("set");
        assert_eq!(encoder.0.get_bitrate().expect("bitrate"), own);
    }

    /// The better qualities cost what they should while talking, and still
    /// send nothing while quiet (#431): Opus encodes them differently from
    /// its own rate, and its silence has to hold in both ways.
    #[test]
    fn at_every_room_s_quality_talking_is_sent_and_silence_isn_t() {
        let quiet = vec![0i16; FRAME_SAMPLES];
        for bits in [None, Some(96_000), Some(128_000)] {
            let mut encoder = Encoder::new().expect("encoder");
            encoder.set_bits(bits).expect("set");
            let mut decoder = Decoder::new().expect("decoder");
            let mut talked = 0;
            let mut last = Vec::new();
            for n in 0..50 {
                let packet = encoder.encode(&noisy(n)).expect("encode");
                assert!(
                    !is_silence(&packet),
                    "{bits:?}: talking was taken for silence"
                );
                talked += packet.len();
                last = decoder.decode(&packet).expect("decode");
            }
            assert!(rms(&last) > 1000.0, "{bits:?}: the voice was lost");
            // A second of talking, in bits, against what was asked.
            let rate = talked * 8;
            if let Some(bits) = bits {
                let bits = usize::try_from(bits).expect("bits");
                assert!(
                    rate > bits * 3 / 4 && rate < bits * 5 / 4,
                    "{bits} asked, {rate} sent"
                );
            }
            let sent = (0..100)
                .filter(|_| {
                    let packet = encoder.encode(&quiet).expect("encode");
                    !is_silence(&packet) && !encoder.was_silence()
                })
                .count();
            assert!(
                sent <= 15,
                "{bits:?}: two seconds of silence sent {sent} of 100"
            );
        }
    }

    /// Something closer to a voice than a tone: one with noise through it,
    /// which a codec can't squeeze below what it's asked to spend.
    fn noisy(n: usize) -> Vec<i16> {
        let mut seed = u32::try_from(n).expect("n").wrapping_mul(2_654_435_761) | 1;
        tone(n)
            .into_iter()
            .map(|s| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                #[allow(clippy::cast_possible_truncation, clippy::cast_possible_wrap)]
                let hiss = (seed >> 20) as i16 - 2048;
                s.saturating_add(hiss)
            })
            .collect()
    }

    /// Voice messages keep every frame: a recording isn't a call.
    #[test]
    fn a_voice_message_keeps_its_silences() {
        let mut encoder = Encoder::for_clip().expect("encoder");
        let quiet = vec![0i16; FRAME_SAMPLES];
        for _ in 0..50 {
            assert!(!is_silence(&encoder.encode(&quiet).expect("encode")));
        }
    }

    /// `frames` of something Opus takes for a voice (#655), where a tone
    /// isn't enough: a buzz of harmonics whose pitch wanders around 160 Hz,
    /// shaped by two moving resonances as a mouth shapes it, rising and
    /// falling four times a second like syllables, with breath through it.
    /// The same every time.
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    pub(crate) fn speech(frames: usize) -> Vec<i16> {
        use std::f64::consts::{PI, TAU};
        let rate = f64::from(SAMPLE_RATE);
        let mut seed: u32 = 0x9e37_79b9;
        let mut phase = 0.0f64;
        let raw: Vec<f64> = (0..frames * FRAME_SAMPLES)
            .map(|i| {
                let t = i as f64 / rate;
                let pitch = 160.0 + 48.0 * (TAU * 0.6 * t).sin() + 16.0 * (TAU * 2.3 * t).sin();
                phase += TAU * pitch / rate;
                let low = 600.0 + 200.0 * (TAU * 1.1 * t).sin();
                let high = 1600.0 + 500.0 * (TAU * 0.8 * t + 1.0).sin();
                let mut buzz = 0.0;
                let mut h = 1.0;
                while h * pitch < 4000.0 {
                    let f = h * pitch;
                    let shape = 1.0 / h
                        + 1.5 * (-((f - low) / 200.0).powi(2)).exp()
                        + (-((f - high) / 300.0).powi(2)).exp();
                    buzz += shape * (h * phase).sin();
                    h += 1.0;
                }
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let breath = (f64::from(seed) / f64::from(u32::MAX) - 0.5) * 0.6;
                let syllable = 0.15 + 0.85 * (PI * 4.0 * t).sin().powi(2);
                (buzz + breath) * syllable
            })
            .collect();
        let peak = raw.iter().fold(0.0f64, |most, v| most.max(v.abs()));
        raw.iter().map(|v| (v / peak * 16000.0) as i16).collect()
    }

    fn energy(samples: &[i16]) -> f64 {
        samples.iter().map(|s| f64::from(*s).powi(2)).sum()
    }

    /// How far `heard` is from `meant`, as the energy of the difference.
    fn error(meant: &[i16], heard: &[i16]) -> f64 {
        meant
            .iter()
            .zip(heard)
            .map(|(m, h)| (f64::from(*m) - f64::from(*h)).powi(2))
            .sum()
    }

    /// Signal against error, in dB: higher is closer.
    fn db(signal: f64, error: f64) -> f64 {
        10.0 * (signal / error.max(1.0)).log10()
    }

    /// A lost packet rebuilt from the copy the next one carries (#655)
    /// comes out far closer to what was said than one guessed at, at Opus's
    /// own rate (a server from before #431) and at both a room's qualities.
    ///
    /// One frame is lost at a time, every sixth frame of three seconds of
    /// voice, each time with two fresh decoders that heard the same 200 ms
    /// before it: one conceals the lost frame, as the app did before, and
    /// one rebuilds it. Both are measured against the voice that went in,
    /// over the lost frame. Opus is lossy, so even a frame that arrived
    /// isn't the original; it is printed for comparison. Measured on
    /// 2026-10-16 (libopus 1.6.1), at Opus's own rate, 96 and 128 kbit/s:
    /// received 9.8, 10.1 and 10.2 dB, rebuilt 8.1, 8.9 and 9.1, guessed
    /// 0.2, 0.0 and 0.0. Rebuilt was closer in 17 of 22 trials each time and
    /// the same in the rest: a quiet frame has no copy, so it is concealed
    /// either way.
    #[test]
    fn a_lost_packet_is_rebuilt_far_closer_than_it_is_guessed() {
        const FRAMES: usize = 150;
        const HEARD_BEFORE: usize = 10;
        let voice = speech(FRAMES);
        for bits in [None, Some(96_000), Some(128_000)] {
            let mut encoder = Encoder::new().expect("encoder");
            encoder.set_bits(bits).expect("set");
            let lookahead = usize::from(encoder.lookahead().expect("lookahead"));
            let packets: Vec<Vec<u8>> = voice
                .chunks(FRAME_SAMPLES)
                .map(|frame| encoder.encode(frame).expect("encode"))
                .collect();
            assert!(
                !packets.iter().any(|packet| is_silence(packet)),
                "{bits:?}: the voice was taken for silence"
            );
            let mut decoder = Decoder::new().expect("decoder");
            let received: Vec<i16> = packets
                .iter()
                .flat_map(|packet| decoder.decode(packet).expect("decode"))
                .collect();
            // Opus hands a voice back late by about its lookahead: line what
            // comes out up with what went in where they match best.
            let (from, to) = (20 * FRAME_SAMPLES, (FRAMES - 1) * FRAME_SAMPLES);
            let closeness = |delay: usize| {
                let meant = &voice[from - delay..to - delay];
                db(energy(meant), error(meant, &received[from..to]))
            };
            let delay = (lookahead - 20..=lookahead + 20)
                .max_by(|a, b| closeness(*a).total_cmp(&closeness(*b)))
                .expect("a delay");
            let (mut said, mut arrived, mut rebuilt, mut guessed) = (0.0, 0.0, 0.0, 0.0);
            let (mut trials, mut closer) = (0, 0);
            for lost in (20..FRAMES - 1).step_by(6) {
                let meant = &voice[lost * FRAME_SAMPLES - delay..][..FRAME_SAMPLES];
                let mut guessing = Decoder::new().expect("decoder");
                let mut rebuilding = Decoder::new().expect("decoder");
                for packet in &packets[lost - HEARD_BEFORE..lost] {
                    guessing.decode(packet).expect("decode");
                    rebuilding.decode(packet).expect("decode");
                }
                let guess = guessing.conceal().expect("conceal");
                let rebuild = rebuilding.rebuild(&packets[lost + 1]).expect("rebuild");
                assert_eq!(rebuild.len(), FRAME_SAMPLES, "{bits:?}: wrong length");
                let (rebuild, guess) = (error(meant, &rebuild), error(meant, &guess));
                said += energy(meant);
                arrived += error(meant, &received[lost * FRAME_SAMPLES..][..FRAME_SAMPLES]);
                rebuilt += rebuild;
                guessed += guess;
                trials += 1;
                if rebuild < guess {
                    closer += 1;
                }
            }
            let (arrived, rebuilt, guessed) =
                (db(said, arrived), db(said, rebuilt), db(said, guessed));
            eprintln!(
                "{bits:?}: a lost frame received {arrived:.1} dB, rebuilt {rebuilt:.1} dB, \
                 guessed {guessed:.1} dB; rebuilt closer in {closer} of {trials}"
            );
            assert!(
                rebuilt > guessed + 5.0,
                "{bits:?}: rebuilt {rebuilt:.1} dB against guessed {guessed:.1} dB"
            );
            assert!(
                closer * 2 > trials,
                "{bits:?}: rebuilt closer in only {closer} of {trials}"
            );
        }
    }
}
