//! What a session keeps for its app to resume from (PROTOCOL §8, "Resume").
//!
//! Every frame it sent in the last two minutes (`RESUME_WINDOW_MS`) while a
//! socket is attached, and every frame since while none is, up to
//! `Config::resume_frames`. Until #678 it was the newest 500 frames and
//! nothing else. A busy call could send 500 inside the window, and then a
//! resume replayed what was left, the app found the hole and started over:
//! safe, but it came back out of voice.
//!
//! A replay is whole or it isn't given. `after` says `None` once any frame the
//! app hasn't had is gone, and the session then ends rather than resume
//! (`spawn_session`).

use std::collections::VecDeque;
use std::time::Duration;

use linger_core::limits::RESUME_WINDOW_MS;
use tokio::time::Instant;

use super::frame::EventJson;

const WINDOW: Duration = Duration::from_millis(RESUME_WINDOW_MS);

pub(super) struct Replay {
    /// Each frame's number, when it was sent, and its event.
    frames: VecDeque<(u64, Instant, EventJson)>,
    /// The most frames kept, whatever their age.
    most: usize,
    /// The newest number let go of, 0 until one is. An app that hasn't had it
    /// can't be replayed whole.
    let_go: u64,
}

impl Replay {
    pub(super) fn new(most: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            most: most.max(1),
            let_go: 0,
        }
    }

    /// Keep frame `seq`, sent at `now`, and let go of what no resume can need.
    ///
    /// While a socket is `attached`, a frame older than the window goes: its
    /// app had it long before, unless its socket was dead for the whole window
    /// without anybody noticing, and the socket's liveness timeout (two and a
    /// half heartbeats) notices sooner. While none is attached, nothing goes
    /// for its age. The session ends when the window does, and until then
    /// everything sent since the drop is what the resume needs. Past the most,
    /// the oldest go either way.
    pub(super) fn keep(&mut self, seq: u64, json: EventJson, now: Instant, attached: bool) {
        self.frames.push_back((seq, now, json));
        while let Some((oldest, at, _)) = self.frames.front() {
            let too_many = self.frames.len() > self.most;
            let too_old = attached && now.duration_since(*at) > WINDOW;
            if !(too_many || too_old) {
                break;
            }
            self.let_go = *oldest;
            self.frames.pop_front();
        }
    }

    /// Every frame after `resume_from`, numbered as it was sent, or `None`
    /// when one of them has been let go of, so no replay can be whole.
    pub(super) fn after(&self, resume_from: u64) -> Option<Vec<String>> {
        (self.let_go <= resume_from).then(|| {
            self.frames
                .iter()
                .filter(|(seq, ..)| *seq > resume_from)
                .map(|(seq, _, json)| json.sequenced(*seq))
                .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use linger_core::gateway::ServerEvent;

    fn event() -> EventJson {
        EventJson::of(&ServerEvent::ReportsChanged {}).expect("an event serializes")
    }

    /// The numbers of a replay's frames, in the order it gives them.
    fn numbers(replay: &[String]) -> Vec<u64> {
        replay
            .iter()
            .map(|frame| {
                let frame: serde_json::Value =
                    serde_json::from_str(frame).expect("a frame is JSON");
                frame["s"]
                    .as_u64()
                    .expect("a replayed frame has its number")
            })
            .collect()
    }

    /// The count that ran out in a busy call (#678): far more than 500 frames
    /// inside the window are all there for the resume, in order.
    #[test]
    fn everything_inside_the_window_is_replayed_however_much_it_is() {
        let start = Instant::now();
        let mut kept = Replay::new(5_000);
        for seq in 1..=2_000 {
            let at = start + WINDOW * u32::try_from(seq).unwrap() / 2_000;
            kept.keep(seq, event(), at, seq <= 100);
        }
        let replay = kept
            .after(40)
            .expect("nothing the app missed was let go of");
        assert_eq!(numbers(&replay), (41..=2_000).collect::<Vec<_>>());
    }

    /// While a socket is attached, a frame goes once it is older than the
    /// window, and a resume from before it isn't whole.
    #[test]
    fn an_attached_session_lets_go_of_what_is_older_than_the_window() {
        let start = Instant::now();
        let mut kept = Replay::new(5_000);
        kept.keep(1, event(), start, true);
        kept.keep(2, event(), start + WINDOW, true);
        assert_eq!(
            kept.after(0).as_deref().map(numbers),
            Some(vec![1, 2]),
            "a frame exactly the window old is kept"
        );
        kept.keep(3, event(), start + WINDOW + Duration::from_secs(1), true);
        assert_eq!(
            kept.after(0),
            None,
            "frame 1 went, so a replay from 0 has a hole"
        );
        assert_eq!(kept.after(1).as_deref().map(numbers), Some(vec![2, 3]));
    }

    /// While nothing is attached, the session ends when its window does, and
    /// until then everything since the drop is kept, whatever its age.
    #[test]
    fn a_detached_session_lets_go_of_nothing_for_its_age() {
        let start = Instant::now();
        let mut kept = Replay::new(5_000);
        kept.keep(1, event(), start, false);
        kept.keep(2, event(), start + WINDOW * 3, false);
        assert_eq!(kept.after(0).as_deref().map(numbers), Some(vec![1, 2]));
    }

    /// Past the most, the oldest go even inside the window, and a resume from
    /// before the newest that went is refused rather than replayed in part.
    #[test]
    fn past_the_most_the_oldest_go_and_a_resume_from_before_them_is_refused() {
        let start = Instant::now();
        let mut kept = Replay::new(3);
        for seq in 1..=5 {
            kept.keep(seq, event(), start, false);
        }
        assert_eq!(kept.after(0), None);
        assert_eq!(kept.after(1), None);
        assert_eq!(kept.after(2).as_deref().map(numbers), Some(vec![3, 4, 5]));
        assert_eq!(kept.after(5).as_deref().map(numbers), Some(vec![]));
    }
}
