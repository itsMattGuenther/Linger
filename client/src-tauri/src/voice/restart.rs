//! When the connection to the forwarding server is started afresh (#656):
//! the rules, kept apart from the connection so they can be tested with
//! nothing but a clock.
//!
//! A network change (Wi-Fi to Ethernet, a VPN coming on, a hop between
//! access points) leaves the connection sending to and from an address that
//! no longer goes anywhere, and only a fresh connection finds the new way.
//! Three things say that has happened:
//!
//! * the connection has heard nothing for a while and stays that way: ICE
//!   calls it disconnected, and it is still disconnected
//!   [`DISCONNECTED_FOR`] later (a short gap comes back on its own, and is
//!   left to);
//! * the connection gave up (`Failed`);
//! * the gateway's own socket had to come back and resume while we're in
//!   voice, which is the plainest sign the network under both changed.
//!
//! **Restarts don't stack.** One is in flight from when it is asked for until
//! the server's new offer has been answered, and no other is asked for
//! meanwhile. One that gets no offer within [`RESTART_AFTER`] is taken as
//! lost (it went out on a gateway socket that was already dead, or the offer
//! couldn't be answered) and is asked for again. And two are never closer
//! together than [`RESTART_AFTER`], so a network that keeps dropping can't
//! have the app asking the server for a fresh connection over and over.

use std::time::{Duration, Instant};

/// How long the connection may stay disconnected before it is started
/// afresh. ICE calls it disconnected once it has heard nothing for its own
/// timeout (`ICE_DISCONNECTED_AFTER`, 3 s), and a lost packet or two on a
/// busy Wi-Fi can do that; this is the extra wait that tells a blip from a
/// network that went away. 5 s of nothing heard in all.
pub const DISCONNECTED_FOR: Duration = Duration::from_secs(2);

/// The least time between one restart and the next, and how long a restart
/// waits for the server's new offer before it is taken as lost. Long enough
/// not to hammer a server that is struggling: one restart every 3 s is well
/// inside what it lets a session ask (`RATE_VOICE_SIGNAL`).
pub const RESTART_AFTER: Duration = Duration::from_secs(3);

/// Something that bears on whether to restart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// The connection is up: heard from again, or a new one came up.
    Connected,
    /// The connection has heard nothing for ICE's disconnected timeout. It
    /// may yet come back by itself.
    Disconnected,
    /// The connection gave up, and won't come back by itself.
    Failed,
    /// An offer was answered on a new connection: the server's reply to a
    /// restart, or the first offer after joining.
    Answered,
    /// The gateway's socket came back and resumed its session while we're
    /// in voice.
    GatewayResumed,
    /// Nothing happened: the moment the last [`Plan`] asked to be woken at.
    Tick,
}

/// What to do after an [`Event`].
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// Start the connection afresh, now.
    pub restart: bool,
    /// When to look again, with [`Event::Tick`], if something is waiting on
    /// the clock.
    pub wake: Option<Instant>,
}

/// The restart rules for one call. A new call starts with a fresh one.
#[derive(Debug, Default)]
pub struct Restarts {
    /// Since when the connection has been disconnected, while it is.
    disconnected: Option<Instant>,
    /// When the restart still waiting for the server's offer was asked for.
    asked: Option<Instant>,
    /// When the last restart was asked for, answered or not.
    last: Option<Instant>,
    /// A restart is called for, and waits on the one in flight or the gap.
    wanted: bool,
}

impl Restarts {
    /// Take in what happened at `now`, and say what to do.
    pub fn on(&mut self, event: Event, now: Instant) -> Plan {
        match event {
            // Working again: nothing left to restart for.
            Event::Connected => {
                self.disconnected = None;
                self.wanted = false;
            }
            // Only the first of a run counts: the wait runs from when it
            // went quiet.
            Event::Disconnected => {
                self.disconnected.get_or_insert(now);
            }
            Event::Failed => {
                self.disconnected = None;
                self.wanted = true;
            }
            // The server answered: a fresh connection is on its way, and it
            // answers anything that wanted one meanwhile too. A disconnect
            // was the old connection's.
            Event::Answered => {
                self.asked = None;
                self.wanted = false;
                self.disconnected = None;
            }
            Event::GatewayResumed => self.wanted = true,
            Event::Tick => {}
        }
        self.plan(now)
    }

    fn plan(&mut self, now: Instant) -> Plan {
        if self.asked.is_some_and(|asked| now >= asked + RESTART_AFTER) {
            // No offer came for it: ask again.
            self.asked = None;
            self.wanted = true;
        }
        if self
            .disconnected
            .is_some_and(|since| now >= since + DISCONNECTED_FOR)
        {
            self.wanted = true;
        }
        if self.wanted && self.asked.is_none() {
            let earliest = self.last.map_or(now, |last| last + RESTART_AFTER);
            if now < earliest {
                return Plan {
                    restart: false,
                    wake: Some(earliest),
                };
            }
            self.wanted = false;
            self.disconnected = None;
            self.asked = Some(now);
            self.last = Some(now);
            return Plan {
                restart: true,
                wake: Some(now + RESTART_AFTER),
            };
        }
        let wake = [
            self.asked.map(|asked| asked + RESTART_AFTER),
            self.disconnected.map(|since| since + DISCONNECTED_FOR),
        ]
        .into_iter()
        .flatten()
        .min();
        Plan {
            restart: false,
            wake,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A call, and a clock that only moves when the test says.
    struct Call {
        rules: Restarts,
        start: Instant,
        /// When each restart was asked for, from the start.
        restarts: Vec<Duration>,
    }

    impl Call {
        fn new() -> Self {
            Self {
                rules: Restarts::default(),
                start: Instant::now(),
                restarts: Vec::new(),
            }
        }

        /// `event`, `at` this long into the call. Answers the plan.
        fn at(&mut self, at: Duration, event: Event) -> Plan {
            let plan = self.rules.on(event, self.start + at);
            if plan.restart {
                self.restarts.push(at);
            }
            plan
        }

        /// Let the clock run to `until`, waking whenever a plan asked to,
        /// as the engine's loop does.
        fn run_to(&mut self, until: Duration, mut plan: Plan) {
            while let Some(wake) = plan.wake {
                let at = wake - self.start;
                if at > until {
                    return;
                }
                plan = self.at(at, Event::Tick);
            }
        }
    }

    fn secs(s: f64) -> Duration {
        Duration::from_secs_f64(s)
    }

    /// A blip: quiet long enough for ICE to say disconnected, then heard
    /// from again before the wait is out. Left alone.
    #[test]
    fn a_short_disconnect_that_comes_back_is_not_restarted() {
        let mut call = Call::new();
        let plan = call.at(secs(10.0), Event::Disconnected);
        assert_eq!(plan.wake, Some(call.start + secs(10.0) + DISCONNECTED_FOR));
        let plan = call.at(secs(11.5), Event::Connected);
        call.run_to(secs(60.0), plan);
        assert!(call.restarts.is_empty(), "restarted: {:?}", call.restarts);
    }

    /// Disconnected and staying so: one restart, once the wait is out, and
    /// none after it once the server has answered.
    #[test]
    fn a_disconnect_that_lasts_is_restarted_once() {
        let mut call = Call::new();
        let plan = call.at(secs(10.0), Event::Disconnected);
        // More of the same changes nothing: the wait runs from the first.
        call.at(secs(11.0), Event::Disconnected);
        call.run_to(secs(12.5), plan);
        assert_eq!(call.restarts, vec![secs(12.0)]);
        let plan = call.at(secs(12.2), Event::Answered);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts, vec![secs(12.0)]);
    }

    #[test]
    fn a_failed_connection_is_restarted_at_once() {
        let mut call = Call::new();
        let plan = call.at(secs(10.0), Event::Failed);
        assert!(plan.restart);
        let plan = call.at(secs(10.2), Event::Answered);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts, vec![secs(10.0)]);
    }

    /// The gateway coming back is the plainest sign the network changed:
    /// a restart at once, even with the connection still saying it's up.
    #[test]
    fn the_gateway_resuming_restarts_at_once() {
        let mut call = Call::new();
        call.at(secs(1.0), Event::Answered);
        call.at(secs(2.0), Event::Connected);
        let plan = call.at(secs(30.0), Event::GatewayResumed);
        assert!(plan.restart);
        let plan = call.at(secs(30.1), Event::Answered);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts, vec![secs(30.0)]);
    }

    /// While a restart waits for the server's offer, nothing else asks for
    /// another, whatever comes in; the offer answers them all.
    #[test]
    fn nothing_else_restarts_while_one_is_in_flight() {
        let mut call = Call::new();
        let plan = call.at(secs(10.0), Event::Failed);
        assert!(plan.restart);
        assert!(!call.at(secs(10.5), Event::GatewayResumed).restart);
        assert!(!call.at(secs(11.0), Event::Failed).restart);
        assert!(!call.at(secs(11.5), Event::Disconnected).restart);
        let plan = call.at(secs(12.0), Event::Answered);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts, vec![secs(10.0)]);
    }

    /// A restart that got no offer went out on a socket that was already
    /// dead: it is asked for again, once the gap is out, and again after
    /// that until one is answered.
    #[test]
    fn a_restart_nobody_answered_is_asked_again() {
        let mut call = Call::new();
        let plan = call.at(secs(10.0), Event::Failed);
        call.run_to(secs(17.0), plan);
        assert_eq!(call.restarts, vec![secs(10.0), secs(13.0), secs(16.0)]);
        let plan = call.at(secs(16.1), Event::Answered);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts.len(), 3);
    }

    /// A network that keeps dropping: every sign of trouble wants a
    /// restart, and they still come no closer than the gap.
    #[test]
    fn restarts_are_never_closer_than_the_gap() {
        let mut call = Call::new();
        let mut plan = call.at(secs(0.0), Event::Failed);
        let mut t = 0.0;
        while t < 30.0 {
            t += 0.25;
            call.run_to(secs(t), plan);
            // The server answers each restart at once, and the new
            // connection fails at once.
            call.at(secs(t), Event::Answered);
            plan = call.at(secs(t), Event::Failed);
        }
        call.run_to(secs(30.0), plan);
        assert!(call.restarts.len() > 5, "{:?}", call.restarts);
        for pair in call.restarts.windows(2) {
            assert!(
                pair[1] - pair[0] >= RESTART_AFTER,
                "two restarts {:?} apart: {:?}",
                pair[1] - pair[0],
                call.restarts
            );
        }
    }

    /// Something that wants a restart too soon after the last waits for the
    /// gap, and a connection that comes up meanwhile means it isn't needed.
    #[test]
    fn a_restart_waiting_on_the_gap_is_dropped_if_the_connection_comes_back() {
        let mut call = Call::new();
        assert!(call.at(secs(10.0), Event::Failed).restart);
        call.at(secs(10.2), Event::Answered);
        let plan = call.at(secs(11.0), Event::GatewayResumed);
        assert_eq!(
            plan,
            Plan {
                restart: false,
                wake: Some(call.start + secs(10.0) + RESTART_AFTER),
            }
        );
        let plan = call.at(secs(12.0), Event::Connected);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts, vec![secs(10.0)]);

        // Without the connection coming back, it goes when the gap is out.
        let mut call = Call::new();
        call.at(secs(10.0), Event::Failed);
        call.at(secs(10.2), Event::Answered);
        let plan = call.at(secs(11.0), Event::GatewayResumed);
        call.run_to(secs(14.0), plan);
        assert_eq!(call.restarts, vec![secs(10.0), secs(13.0)]);
        let plan = call.at(secs(13.2), Event::Answered);
        call.run_to(secs(60.0), plan);
        assert_eq!(call.restarts, vec![secs(10.0), secs(13.0)]);
    }

    /// Nothing wrong, nothing to wake for.
    #[test]
    fn a_healthy_call_is_left_alone() {
        let mut call = Call::new();
        assert_eq!(
            call.at(secs(1.0), Event::Answered),
            Plan {
                restart: false,
                wake: None
            }
        );
        assert_eq!(
            call.at(secs(2.0), Event::Connected),
            Plan {
                restart: false,
                wake: None
            }
        );
    }
}
