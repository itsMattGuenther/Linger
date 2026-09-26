//! Who connects to whom, and who speaks first (SPEC §4.14, PROTOCOL §8).
//!
//! Pure functions over a peer list, with no `webrtc` types in sight. That is
//! deliberate: this is the part where the bugs that only appear on a bad
//! network live — a peer that was dropped and never rebuilt, two clients that
//! both offer, a reconnect that leaves one side waiting for an answer nobody is
//! going to send. Every one of those is a decision made from a list of session
//! ids, and a decision made from a list can be tested without a network.
//!
//! What is *not* here is anything that touches a socket. The engine takes these
//! answers and does the I/O.

use std::collections::BTreeSet;

use linger_core::gateway::VoicePeer;

/// What has to happen to make the mesh match what the server just said.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Peers to open a connection to, in a stable order.
    pub connect: Vec<String>,
    /// Peers whose connection should be torn down.
    pub drop: Vec<String>,
}

impl Plan {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.connect.is_empty() && self.drop.is_empty()
    }
}

/// Work out the difference between the mesh we hold and the one the server
/// describes.
///
/// `announced` is the whole list every time (PROTOCOL §8), which is what makes
/// this a comparison rather than an accumulation — a client that missed a
/// `voice.state` is right again after the next one, because this recomputes
/// from scratch instead of applying a delta to state that has drifted.
///
/// **We are never our own peer.** Our own session is in the announced list and
/// is filtered out here, in one place, rather than in each caller.
#[must_use]
pub fn plan(me: &str, held: &BTreeSet<String>, announced: &[VoicePeer]) -> Plan {
    let wanted: BTreeSet<String> = announced
        .iter()
        .map(|peer| peer.session_id.clone())
        .filter(|id| id != me)
        .collect();

    Plan {
        connect: wanted.difference(held).cloned().collect(),
        drop: held.difference(&wanted).cloned().collect(),
    }
}

/// Whether we are the one who sends the offer to this peer.
///
/// The lower session id offers. Both ends read the same `voice.state` and run
/// the same comparison, so exactly one offer is made and no pair ever sends two
/// at each other — which is *glare*, and it leaves both sides waiting for an
/// answer to an offer the other one already discarded.
///
/// The obvious alternative, "whoever joined later offers", needs an order both
/// sides agree on. A reconnect is exactly when they stop agreeing: the returning
/// client thinks it is the newcomer and the one that stayed thinks so too.
#[must_use]
pub fn we_offer(me: &str, them: &str) -> bool {
    me < them
}

/// Whether a room is at the ceiling (SPEC §4.14). The server refuses the ninth
/// join, so this is for saying so before asking rather than for enforcing it.
#[must_use]
pub fn is_full(announced: &[VoicePeer]) -> bool {
    announced.len() >= linger_core::limits::MAX_VOICE_PEERS
}

#[cfg(test)]
mod tests {
    use super::*;
    use linger_core::UserId;

    fn peers(ids: &[&str]) -> Vec<VoicePeer> {
        ids.iter()
            .map(|id| VoicePeer {
                session_id: (*id).to_string(),
                user_id: UserId::new(),
                controls: None,
                forwarded: None,
            })
            .collect()
    }

    fn held(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn the_first_state_connects_to_everybody_else() {
        let plan = plan("b", &held(&[]), &peers(&["a", "b", "c"]));
        assert_eq!(plan.connect, vec!["a", "c"]);
        assert!(plan.drop.is_empty());
    }

    #[test]
    fn we_are_never_our_own_peer() {
        let plan = plan("a", &held(&[]), &peers(&["a"]));
        assert!(plan.is_empty(), "a lone client tried to call itself");
    }

    #[test]
    fn somebody_arriving_is_one_new_connection_and_no_churn() {
        let plan = plan("a", &held(&["b"]), &peers(&["a", "b", "c"]));
        assert_eq!(plan.connect, vec!["c"]);
        assert!(
            plan.drop.is_empty(),
            "an arrival tore down a connection that was working"
        );
    }

    #[test]
    fn somebody_leaving_is_one_teardown() {
        let plan = plan("a", &held(&["b", "c"]), &peers(&["a", "b"]));
        assert!(plan.connect.is_empty());
        assert_eq!(plan.drop, vec!["c"]);
    }

    #[test]
    fn the_same_state_twice_is_nothing_to_do() {
        let state = peers(&["a", "b", "c"]);
        let plan = plan("a", &held(&["b", "c"]), &state);
        assert!(
            plan.is_empty(),
            "a repeated voice.state rebuilt connections that were fine"
        );
    }

    /// The case that matters after a reconnect: the returning client comes back
    /// with a *new* session id, so from everybody else's side one peer left and
    /// a different one arrived. Both halves have to happen or somebody is left
    /// talking to a session that is gone.
    #[test]
    fn a_peer_that_reconnected_is_dropped_and_rebuilt() {
        let plan = plan("a", &held(&["b-old"]), &peers(&["a", "b-new"]));
        assert_eq!(plan.connect, vec!["b-new"]);
        assert_eq!(plan.drop, vec!["b-old"]);
    }

    #[test]
    fn leaving_voice_drops_everything() {
        let plan = plan("a", &held(&["b", "c"]), &[]);
        assert!(plan.connect.is_empty());
        assert_eq!(plan.drop, vec!["b", "c"]);
    }

    #[test]
    fn exactly_one_side_of_every_pair_offers() {
        for (x, y) in [("a", "b"), ("b", "a"), ("aa", "ab"), ("01", "02")] {
            assert_ne!(
                we_offer(x, y),
                we_offer(y, x),
                "both or neither of {x} and {y} would offer"
            );
        }
    }

    /// Not a real case — the server hands out distinct ids — but the answer
    /// still has to be *an* answer rather than a panic.
    #[test]
    fn a_peer_with_our_own_id_does_not_offer() {
        assert!(!we_offer("a", "a"));
    }

    #[test]
    fn the_ceiling_is_the_products_ceiling() {
        let full: Vec<String> = (0..8).map(|n| format!("s{n}")).collect();
        let ids: Vec<&str> = full.iter().map(String::as_str).collect();
        assert!(is_full(&peers(&ids)));
        assert!(!is_full(&peers(&ids[..7])));
    }
}
