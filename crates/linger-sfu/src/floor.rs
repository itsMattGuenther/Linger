//! Who a room hears (#197): at most the six loudest voices at once.
//!
//! The forwarding server's work is talkers × listeners: every voice it passes
//! on is encrypted again for everyone else in the room. On the raid's server,
//! one shared core, fifty people with eight talking took about 90% of it
//! (2026-10-05), and a boss going down, with a dozen people cheering at
//! once, would ask for more than it has. So a room passes on at most
//! [`LOUDEST`] voices at a time, as large voice apps do: a cheer of twelve
//! still sounds like a crowd, and the server's work stops growing at six.
//!
//! Each voice has a **seat** while it's passed on. The rules keep a seat still
//! while its person is talking:
//!
//! - A free seat goes to the first voice that needs one.
//! - With every seat taken, a newcomer takes the seat of the quietest holder
//!   only when it is clearly louder ([`MARGIN`]), so two voices of about the
//!   same level don't trade places packet by packet. A holder that has gone
//!   quiet for a moment ([`QUIET`]) counts as silent here, so a voice in the
//!   middle of a word keeps its seat but one that stopped gives it up.
//! - A seat whose holder has sent nothing for [`HOLD`] is free again.
//!
//! Loudness is the audio level each app puts on its packets (RFC 6464, the
//! `ssrc-audio-level` header extension, negotiated in every offer). An app that
//! doesn't send one, from before 0.4.9, counts as the quietest there is: it
//! still gets a free seat, but anybody who says how loud they are comes first.
//!
//! **Silence is never passed on.** A packet of [`SILENCE_MAX`] bytes or fewer
//! is Opus saying nothing: apps from 0.4.9 don't send them (#430), and apps
//! from before send fifty a second while muted or quiet. Passing those on was
//! what let ten old apps take a raid's server to its limit (2026-10-05); now
//! they cost the server only the reading. Real speech is far longer: at the
//! least an app sends, 16 kbit/s, a 20 ms packet is 40 bytes.

use std::time::{Duration, Instant};

/// The most voices a room passes on at once.
pub const LOUDEST: usize = 6;

/// How long a seat outlasts its holder's silence: longer than the pause
/// between two sentences, shorter than anybody would notice waiting for it.
pub const HOLD: Duration = Duration::from_millis(500);

/// How long without a packet before a holder counts as silent when somebody
/// louder wants the seat: longer than the gaps inside a word, which Opus's
/// discontinuous transmission can leave unsent (#430).
pub const QUIET: Duration = Duration::from_millis(200);

/// How much louder than the quietest holder a newcomer must be to take its
/// seat, in decibels.
pub const MARGIN: f32 = 6.0;

/// The longest packet that is only silence, in bytes.
pub const SILENCE_MAX: usize = 3;

/// The level of a voice that doesn't say: the quietest there is, in RFC 6464's
/// negative decibels.
const UNKNOWN: f32 = -127.0;

/// How much of a voice's loudness is its newest packet: smoothing over about
/// four packets (80 ms), so one loud syllable doesn't take a seat but a
/// shout does.
const NEWEST: f32 = 0.3;

#[derive(Debug)]
struct Talker {
    session: String,
    /// Smoothed level, in negative decibels: 0 is the loudest, −127 silence.
    loudness: f32,
    heard: Instant,
    seated: bool,
}

impl Talker {
    /// How loud it is now, for a newcomer wanting its seat: silent once it
    /// has sent nothing for [`QUIET`].
    fn now_loud(&self, now: Instant) -> f32 {
        if now.saturating_duration_since(self.heard) >= QUIET {
            UNKNOWN
        } else {
            self.loudness
        }
    }
}

/// One room's seats.
#[derive(Debug, Default)]
pub struct Floor {
    talkers: Vec<Talker>,
}

impl Floor {
    /// Whether to pass on a packet from `session`: `level` is the audio level
    /// it carried (negative decibels; `None` from an app that doesn't say),
    /// `bytes` its length.
    pub fn hear(&mut self, session: &str, level: Option<i8>, bytes: usize, now: Instant) -> bool {
        if bytes <= SILENCE_MAX {
            return false;
        }
        // Seats left by voices that stopped, and the voices themselves once
        // nobody needs to remember them.
        for talker in &mut self.talkers {
            if talker.seated && now.saturating_duration_since(talker.heard) >= HOLD {
                talker.seated = false;
            }
        }
        self.talkers.retain(|t| {
            t.session == session || t.seated || now.saturating_duration_since(t.heard) < HOLD
        });

        let level = level.map_or(UNKNOWN, f32::from);
        let at = match self.talkers.iter().position(|t| t.session == session) {
            Some(at) => {
                let talker = &mut self.talkers[at];
                talker.loudness = if now.saturating_duration_since(talker.heard) >= HOLD {
                    level
                } else {
                    talker.loudness * (1.0 - NEWEST) + level * NEWEST
                };
                talker.heard = now;
                at
            }
            None => {
                self.talkers.push(Talker {
                    session: session.to_owned(),
                    loudness: level,
                    heard: now,
                    seated: false,
                });
                self.talkers.len() - 1
            }
        };
        if self.talkers[at].seated {
            return true;
        }

        if self.seats() < LOUDEST {
            self.talkers[at].seated = true;
            return true;
        }
        let quietest = self
            .talkers
            .iter()
            .enumerate()
            .filter(|(_, t)| t.seated)
            .min_by(|(_, a), (_, b)| a.now_loud(now).total_cmp(&b.now_loud(now)))
            .map(|(seat, t)| (seat, t.now_loud(now)));
        match quietest {
            Some((seat, loudness)) if self.talkers[at].loudness >= loudness + MARGIN => {
                self.talkers[seat].seated = false;
                self.talkers[at].seated = true;
                true
            }
            _ => false,
        }
    }

    /// `session` left the room: its seat is free.
    pub fn forget(&mut self, session: &str) {
        self.talkers.retain(|t| t.session != session);
    }

    /// Nobody to remember: the room can go.
    pub fn is_empty(&self) -> bool {
        self.talkers.is_empty()
    }

    /// How many seats are held.
    pub fn seats(&self) -> usize {
        self.talkers.iter().filter(|t| t.seated).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOICE: usize = 160;
    const FRAME: Duration = Duration::from_millis(20);

    /// `count` people all talking at `level`, one packet each at `now`.
    fn round(floor: &mut Floor, people: &[(&str, i8)], now: Instant) -> Vec<String> {
        people
            .iter()
            .filter(|(who, level)| floor.hear(who, Some(*level), VOICE, now))
            .map(|(who, _)| (*who).to_owned())
            .collect()
    }

    #[test]
    fn up_to_six_voices_all_go_through() {
        let mut floor = Floor::default();
        let six: Vec<(&str, i8)> = vec![
            ("a", -30),
            ("b", -40),
            ("c", -50),
            ("d", -35),
            ("e", -45),
            ("f", -60),
        ];
        assert_eq!(round(&mut floor, &six, Instant::now()).len(), 6);
    }

    #[test]
    fn a_seventh_voice_no_louder_than_the_rest_waits() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let six: Vec<(&str, i8)> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|s| (*s, -40))
            .collect();
        for n in 0..10 {
            round(&mut floor, &six, t0 + FRAME * n);
            assert!(!floor.hear("g", Some(-38), VOICE, t0 + FRAME * n));
        }
    }

    #[test]
    fn a_clearly_louder_voice_takes_the_quietest_seat() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let six: Vec<(&str, i8)> = vec![
            ("a", -30),
            ("b", -30),
            ("c", -30),
            ("d", -30),
            ("e", -30),
            ("quiet", -60),
        ];
        round(&mut floor, &six, t0);
        // The raid leader shouting over a cheer.
        assert!(floor.hear("lead", Some(-10), VOICE, t0 + FRAME));
        let next = round(&mut floor, &six, t0 + FRAME * 2);
        assert!(!next.contains(&"quiet".to_owned()));
        assert_eq!(next.len(), 5);
    }

    #[test]
    fn a_voice_in_the_middle_of_a_word_keeps_its_seat() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let six: Vec<(&str, i8)> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|s| (*s, -40))
            .collect();
        round(&mut floor, &six, t0);
        // "a" pauses for a beat inside a word; the others go on.
        let five = &six[1..];
        round(&mut floor, five, t0 + FRAME * 3);
        // A slightly louder newcomer isn't enough to take a seat from anyone.
        assert!(!floor.hear("g", Some(-36), VOICE, t0 + FRAME * 4));
        assert!(floor.hear("a", Some(-40), VOICE, t0 + FRAME * 5));
    }

    #[test]
    fn a_voice_that_stopped_gives_its_seat_to_anyone_louder() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let six: Vec<(&str, i8)> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|s| (*s, -40))
            .collect();
        round(&mut floor, &six, t0);
        // "a" stops; past QUIET it counts as silent, so a quiet newcomer gets in.
        let later = t0 + QUIET + FRAME;
        round(&mut floor, &six[1..], later);
        assert!(floor.hear("g", Some(-70), VOICE, later));
    }

    #[test]
    fn a_seat_left_for_hold_is_free_for_anybody() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let six: Vec<(&str, i8)> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|s| (*s, -40))
            .collect();
        round(&mut floor, &six, t0);
        // Everybody but "a" keeps talking until HOLD has passed.
        let mut at = t0;
        while at < t0 + HOLD {
            at += FRAME;
            round(&mut floor, &six[1..], at);
        }
        // The seat is free: a newcomer no louder than anyone takes it.
        assert!(floor.hear("g", Some(-40), VOICE, at));
        // And "a", back, now waits like anyone else.
        assert!(!floor.hear("a", Some(-40), VOICE, at + FRAME));
    }

    #[test]
    fn an_app_that_says_no_level_comes_after_one_that_does() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        for who in ["o1", "o2", "o3", "o4", "o5", "o6"] {
            assert!(floor.hear(who, None, VOICE, t0));
        }
        // Anybody who says how loud they are, even quietly, comes first.
        assert!(floor.hear("new", Some(-80), VOICE, t0 + FRAME));
    }

    #[test]
    fn silence_is_never_passed_on_and_never_takes_a_seat() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        // Old apps, muted: fifty packets a second of three bytes each.
        for n in 0..50 {
            for who in ["m1", "m2", "m3", "m4", "m5", "m6", "m7"] {
                assert!(!floor.hear(who, None, SILENCE_MAX, t0 + FRAME * n));
            }
        }
        assert!(floor.is_empty());
        assert!(floor.hear("talker", Some(-30), SILENCE_MAX + 1, t0 + FRAME * 50));
    }

    #[test]
    fn somebody_leaving_frees_their_seat() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let six: Vec<(&str, i8)> = ["a", "b", "c", "d", "e", "f"]
            .iter()
            .map(|s| (*s, -40))
            .collect();
        round(&mut floor, &six, t0);
        assert!(!floor.hear("g", Some(-40), VOICE, t0));
        floor.forget("c");
        assert!(floor.hear("g", Some(-40), VOICE, t0 + FRAME));
    }

    #[test]
    fn twelve_cheering_never_hold_more_than_six_seats() {
        let mut floor = Floor::default();
        let t0 = Instant::now();
        let crowd: Vec<(String, i8)> = (0..12_i8)
            .map(|n| (format!("p{n}"), -20 - (n % 5) * 3))
            .collect();
        let crowd: Vec<(&str, i8)> = crowd
            .iter()
            .map(|(who, level)| (who.as_str(), *level))
            .collect();
        for n in 0..100 {
            let passed = round(&mut floor, &crowd, t0 + FRAME * n);
            assert!(floor.seats() <= LOUDEST, "frame {n}");
            // A seat changing hands can let one extra packet through in the
            // moment it does; once the room settles, six voices and no more.
            if n >= 5 {
                assert_eq!(passed.len(), LOUDEST, "frame {n}: {passed:?}");
            }
        }
    }
}
