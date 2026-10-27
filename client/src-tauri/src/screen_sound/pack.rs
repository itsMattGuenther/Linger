//! A shared screen's sound in Opus packets, both ways (#736): the sharing
//! computer's sound cut into 20 ms packets as it is captured, and a
//! watcher's packets turned back into sound, a lost one guessed at rather
//! than left as a click.
//!
//! The same libopus voice uses (`voice/codec.rs`), tuned for what a screen
//! plays rather than for a voice: two channels, the music-and-everything
//! mode, about 128 kbit/s (PROTOCOL §8, "The computer's sound").
//!
//! Only Windows captures for now, so elsewhere the sending half is used by
//! its tests alone.
#![cfg_attr(not(windows), allow(dead_code))]

use crate::voice::audio::{FRAME_SAMPLES, SAMPLE_RATE};

/// Two channels: a video's or a game's sound is stereo.
pub const CHANNELS: usize = 2;

/// Interleaved samples in one 20 ms packet: 960 for each channel.
pub const PACKET_SAMPLES: usize = FRAME_SAMPLES * CHANNELS;

/// How long one packet is, in microseconds.
pub const PACKET_MICROS: u64 = 20_000;

/// What the share's sound is sent at (PROTOCOL §8): clear for music and a
/// film's sound, about what a video site sends, and little next to the
/// picture's 2.5 to 6 Mbit/s.
pub const BITS_PER_SECOND: i32 = 128_000;

/// The most bytes one packet can be. libopus caps a 20 ms packet at 1,275.
const MAX_PACKET: usize = 1_500;

/// How far the capture's clock may stray from where the samples so far put
/// it before it counts as a gap: past this, sound was lost, and what's
/// waiting is finished with silence so the next sound starts on time. Under
/// it the time stamps just follow the capture's clock.
const GAP_MICROS: u64 = 40_000;

/// One packet, ready to send: when its first sample was captured, and the
/// Opus packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub micros: u64,
    pub opus: Vec<u8>,
}

/// Cuts captured sound into 20 ms Opus packets, each stamped with when its
/// first sample was captured.
pub struct Packetizer {
    encoder: opus::Encoder,
    /// Interleaved samples not yet a whole packet.
    pending: Vec<i16>,
    /// When `pending`'s first sample was captured, in microseconds.
    at: u64,
}

fn micros_of(frames: usize) -> u64 {
    frames as u64 * 1_000_000 / u64::from(SAMPLE_RATE)
}

impl Packetizer {
    /// # Errors
    ///
    /// When libopus won't make an encoder.
    pub fn new() -> Result<Self, opus::Error> {
        let mut encoder = opus::Encoder::new(
            SAMPLE_RATE,
            opus::Channels::Stereo,
            opus::Application::Audio,
        )?;
        encoder.set_bitrate(opus::Bitrate::Bits(BITS_PER_SECOND))?;
        Ok(Self {
            encoder,
            pending: Vec::with_capacity(PACKET_SAMPLES * 2),
            at: 0,
        })
    }

    /// Interleaved stereo at 48 kHz whose first sample was captured at
    /// `micros`: answers every whole packet it completes. A stretch of
    /// perfect silence (nothing playing) is sent as nothing at all, as voice
    /// sends nothing while somebody is quiet.
    pub fn push(&mut self, micros: u64, samples: &[i16]) -> Vec<Packet> {
        let mut out = Vec::new();
        let samples = &samples[..samples.len() - samples.len() % CHANNELS];
        if self.pending.is_empty() {
            self.at = micros;
        } else {
            let waiting = micros_of(self.pending.len() / CHANNELS);
            let expected = self.at + waiting;
            if micros.abs_diff(expected) > GAP_MICROS {
                // Sound was lost between the two: what's waiting ends in
                // silence, and the new sound starts a packet of its own.
                self.pending.resize(PACKET_SAMPLES, 0);
                self.emit(&mut out);
                self.pending.clear();
                self.at = micros;
            } else {
                // The capture's clock and the sample count drift apart a
                // little; the stamps follow the clock.
                self.at = micros.saturating_sub(waiting);
            }
        }
        self.pending.extend_from_slice(samples);
        while self.pending.len() >= PACKET_SAMPLES {
            self.emit(&mut out);
        }
        out
    }

    fn emit(&mut self, out: &mut Vec<Packet>) {
        let frame: Vec<i16> = self.pending.drain(..PACKET_SAMPLES).collect();
        let micros = self.at;
        self.at += PACKET_MICROS;
        if frame.iter().all(|sample| *sample == 0) {
            return;
        }
        if let Ok(opus) = self.encoder.encode_vec(&frame, MAX_PACKET) {
            out.push(Packet { micros, opus });
        }
    }
}

/// A packet that comes this much before where the last one ended is late,
/// or the same one again: what it held has been played, or guessed at.
const LATE_MICROS: u64 = 10_000;

/// The longest gap guessed at rather than left as a pause: three packets.
/// Past it nothing was sent, which is a pause (the sharer's computer went
/// quiet), and the player starts again from the next sound.
const CONCEAL_MICROS: u64 = 60_000;

/// Turns a watcher's packets back into sound: interleaved stereo at 48 kHz.
pub struct Listener {
    decoder: opus::Decoder,
    /// Where the last packet ended, by the sharer's clock.
    next: Option<u64>,
}

impl Listener {
    /// # Errors
    ///
    /// When libopus won't make a decoder.
    pub fn new() -> Result<Self, opus::Error> {
        Ok(Self {
            decoder: opus::Decoder::new(SAMPLE_RATE, opus::Channels::Stereo)?,
            next: None,
        })
    }

    /// One packet captured at `micros`: the sound to play for it, and for
    /// the packet or two before it that never came. Nothing for one that
    /// came late.
    pub fn hear(&mut self, micros: u64, opus: &[u8]) -> Vec<i16> {
        let mut out = Vec::new();
        if let Some(next) = self.next {
            if micros + LATE_MICROS < next {
                return out;
            }
            let gap = micros.saturating_sub(next);
            if (PACKET_MICROS / 2..=CONCEAL_MICROS).contains(&gap) {
                for _ in 0..(gap + PACKET_MICROS / 2) / PACKET_MICROS {
                    self.decode(&[], &mut out);
                }
            }
        }
        let frames = self.decode(opus, &mut out);
        self.next = Some(micros + micros_of(frames.max(FRAME_SAMPLES)));
        out
    }

    /// Decode one packet onto `out`, or guess at a missing one for an empty
    /// `opus`. Answers how many samples each channel had.
    fn decode(&mut self, opus: &[u8], out: &mut Vec<i16>) -> usize {
        // The longest Opus packet is 120 ms; a guess is as long as the room
        // it's given, so one packet's worth.
        let room = if opus.is_empty() { 1 } else { 6 };
        let mut frame = vec![0i16; FRAME_SAMPLES * room * CHANNELS];
        match self.decoder.decode(opus, &mut frame, false) {
            Ok(frames) => {
                out.extend_from_slice(&frame[..frames * CHANNELS]);
                frames
            }
            Err(_) => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A second of a tone, left and right at different pitches, as the
    /// capture would hand it over: in pieces of 10 ms.
    fn tone(seconds: f32) -> Vec<i16> {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            clippy::cast_precision_loss
        )]
        let frames = (seconds * SAMPLE_RATE as f32) as usize;
        let mut samples = Vec::with_capacity(frames * CHANNELS);
        for n in 0..frames {
            #[allow(clippy::cast_precision_loss)]
            let t = n as f32 / SAMPLE_RATE as f32;
            #[allow(clippy::cast_possible_truncation)]
            {
                samples.push((f32::sin(t * 440.0 * std::f32::consts::TAU) * 8_000.0) as i16);
                samples.push((f32::sin(t * 660.0 * std::f32::consts::TAU) * 8_000.0) as i16);
            }
        }
        samples
    }

    fn loudness(samples: impl Iterator<Item = i16>) -> f64 {
        let (sum, count) = samples.fold((0f64, 0usize), |(sum, count), sample| {
            (sum + f64::from(sample).powi(2), count + 1)
        });
        #[allow(clippy::cast_precision_loss)]
        (sum / count.max(1) as f64).sqrt()
    }

    #[test]
    fn captured_sound_becomes_20_ms_packets_and_comes_back_out() {
        let mut packetizer = Packetizer::new().expect("an encoder");
        let sound = tone(1.0);
        let mut packets = Vec::new();
        // In pieces of 10 ms, as WASAPI hands them over, a little more each time.
        for (at, piece) in sound.chunks(480 * CHANNELS).enumerate() {
            packets.extend(packetizer.push(at as u64 * 10_000, piece));
        }
        // A second is fifty packets, each stamped 20 ms after the last.
        assert_eq!(packets.len(), 50);
        for (at, packet) in packets.iter().enumerate() {
            assert_eq!(packet.micros, at as u64 * PACKET_MICROS);
            assert!(packet.opus.len() <= 1_275);
        }
        // About 128 kbit/s.
        let bytes: usize = packets.iter().map(|packet| packet.opus.len()).sum();
        assert!((10_000..=20_000).contains(&bytes), "{bytes} bytes a second");

        let mut listener = Listener::new().expect("a decoder");
        let mut heard = Vec::new();
        for packet in &packets {
            heard.extend(listener.hear(packet.micros, &packet.opus));
        }
        assert_eq!(heard.len(), sound.len());
        // Each side comes back at about the loudness it went in, after the
        // codec's first few milliseconds.
        let skip = 960 * CHANNELS;
        for side in 0..CHANNELS {
            let went = loudness(sound.iter().skip(skip + side).step_by(CHANNELS).copied());
            let came = loudness(heard.iter().skip(skip + side).step_by(CHANNELS).copied());
            assert!(
                (came / went - 1.0).abs() < 0.2,
                "side {side}: {went} in, {came} out"
            );
        }
    }

    #[test]
    fn silence_sends_nothing_and_a_gap_starts_a_packet_on_time() {
        let mut packetizer = Packetizer::new().expect("an encoder");
        assert!(packetizer.push(0, &vec![0; PACKET_SAMPLES * 5]).is_empty());
        // Sound a second later, after the capture handed over nothing.
        let sound = tone(0.04);
        let packets = packetizer.push(1_000_000, &sound);
        assert_eq!(
            packets.iter().map(|p| p.micros).collect::<Vec<_>>(),
            vec![1_000_000, 1_020_000]
        );
        // Half a packet, then sound 300 ms on: the half is finished with
        // silence and sent, and the new sound starts its own packet.
        let mut packetizer = Packetizer::new().expect("an encoder");
        assert!(packetizer.push(0, &sound[..PACKET_SAMPLES / 2]).is_empty());
        let packets = packetizer.push(300_000, &sound);
        assert_eq!(
            packets.iter().map(|p| p.micros).collect::<Vec<_>>(),
            vec![0, 300_000, 320_000]
        );
    }

    #[test]
    fn a_lost_packet_is_guessed_at_and_a_late_one_is_dropped() {
        let mut packetizer = Packetizer::new().expect("an encoder");
        let packets = packetizer.push(0, &tone(0.2));
        assert_eq!(packets.len(), 10);
        let mut listener = Listener::new().expect("a decoder");
        let mut heard = 0;
        for (at, packet) in packets.iter().enumerate() {
            // The fourth never comes; the sixth comes again, late.
            if at == 3 {
                continue;
            }
            heard += listener.hear(packet.micros, &packet.opus).len();
            if at == 5 {
                assert!(listener
                    .hear(packets[4].micros, &packets[4].opus)
                    .is_empty());
            }
        }
        // Every packet's 20 ms is heard, the lost one's guessed at.
        assert_eq!(heard, 10 * PACKET_SAMPLES);
        // A pause longer than a few packets isn't filled in.
        let later = listener.hear(packets[9].micros + 1_000_000, &packets[0].opus);
        assert_eq!(later.len(), PACKET_SAMPLES);
    }
}
