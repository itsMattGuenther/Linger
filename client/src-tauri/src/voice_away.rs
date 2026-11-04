//! Voice on a phone when iOS lets go of Linger's window (#851).
//!
//! On a phone voice runs in the page (`pageVoice.ts`), and reaches each
//! server through `gateway_send`. iOS can let go of a background app's window
//! to save memory (`phone_scene.rs`), and the page goes with it, and voice
//! with the page. A voice seat belongs to the gateway session, which lives
//! here and carries on, so the server kept Linger in voice, silent, until the
//! page came back and connected afresh, maybe hours later.
//!
//! So the shell keeps track of where the page is in voice on each server,
//! from what the page sends and what the servers say, and when the window
//! goes it leaves voice on each, so the room sees it go at once. It keeps
//! where, for the page that comes back to say so, with one tap to join again
//! (`phone_voice_ended`). It never rejoins by itself: that would switch the
//! microphone on whenever Linger is next opened (Matt, 3 Nov).

use std::collections::BTreeMap;

use linger_core::gateway::{ClientFrame, ServerEvent};
use linger_core::RoomId;
use serde::Serialize;

/// Where voice ended because the window went: a server, and its room.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Ended {
    pub server: String,
    pub room_id: RoomId,
}

/// What a server said, as far as a voice seat cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Said {
    /// A fresh `ready`: a fresh session, whose seat is gone (PROTOCOL §8).
    FreshSession,
    /// `voice.removed`: the host took us out of this room's voice (#423).
    TakenOut(RoomId),
    Nothing,
}

impl Said {
    #[must_use]
    pub fn of(event: &ServerEvent) -> Self {
        match event {
            ServerEvent::Ready(_) => Self::FreshSession,
            ServerEvent::VoiceRemoved { room_id } => Self::TakenOut(*room_id),
            _ => Self::Nothing,
        }
    }
}

/// The room the page is in voice in on each server, and what ended while
/// the window was gone.
#[derive(Debug, Default)]
pub struct Seats {
    in_voice: BTreeMap<String, RoomId>,
    ended: BTreeMap<String, RoomId>,
}

impl Seats {
    /// A frame the page sent to `server`, which went: joining voice there
    /// (a mute or deafen is a join again, in the same room), or leaving it.
    pub fn sent(&mut self, server: &str, frame: &ClientFrame) {
        match frame {
            ClientFrame::VoiceJoin { room_id, .. } => {
                self.in_voice.insert(server.to_string(), *room_id);
            }
            ClientFrame::VoiceLeave => {
                self.in_voice.remove(server);
            }
            _ => {}
        }
    }

    /// What `server` said that ends a seat there (`Said::of`).
    pub fn heard(&mut self, server: &str, said: Said) {
        match said {
            Said::FreshSession => {
                self.in_voice.remove(server);
            }
            Said::TakenOut(room_id) => {
                if self.in_voice.get(server) == Some(&room_id) {
                    self.in_voice.remove(server);
                }
            }
            Said::Nothing => {}
        }
    }

    /// The connection to `server` was replaced or closed: its session, and
    /// any seat, went with it.
    pub fn disconnected(&mut self, server: &str) {
        self.in_voice.remove(server);
    }

    /// The window went: every server to leave voice on, now. Each is kept
    /// for the page that comes back. Only an iPhone's window goes this way.
    #[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
    pub fn window_gone(&mut self) -> Vec<String> {
        let gone = std::mem::take(&mut self.in_voice);
        let servers = gone.keys().cloned().collect();
        self.ended.extend(gone);
        servers
    }

    /// What ended while the window was gone, once: taking it clears it.
    pub fn take_ended(&mut self) -> Vec<Ended> {
        std::mem::take(&mut self.ended)
            .into_iter()
            .map(|(server, room_id)| Ended { server, room_id })
            .collect()
    }
}

/// The shell's one copy, behind a lock: the page's commands, the gateway's
/// frames and the window going each reach it from their own thread. Only
/// the phone app keeps one.
#[cfg(mobile)]
#[derive(Default)]
pub struct Held(pub std::sync::Mutex<Seats>);

#[cfg(mobile)]
impl Held {
    pub fn with<T>(&self, f: impl FnOnce(&mut Seats) -> T) -> Option<T> {
        self.0.lock().ok().map(|mut seats| f(&mut seats))
    }
}

/// iOS let go of the window, and the page and its voice with it: leave
/// voice on every server it was in, now, so the room sees Linger go, and keep
/// where for the page that comes back (`phone_scene.rs`).
#[cfg(target_os = "ios")]
pub fn window_gone(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(servers) = app.state::<Held>().with(Seats::window_gone) else {
        return;
    };
    let connections = app.state::<crate::Connections>();
    let left = servers
        .iter()
        .filter(|server| {
            connections.with(|held| {
                held.get(server.as_str())
                    .is_some_and(|handle| handle.send(ClientFrame::VoiceLeave))
            })
        })
        .count();
    if !servers.is_empty() {
        eprintln!(
            "linger: left voice on {left} of {} servers as iOS let go of the window",
            servers.len()
        );
    }
}

/// What ended while the window was gone, for the page that came back, once.
#[cfg(mobile)]
#[tauri::command]
pub fn phone_voice_ended(held: tauri::State<'_, Held>) -> Vec<Ended> {
    held.with(Seats::take_ended).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{Ended, Said, Seats};
    use linger_core::gateway::{ClientFrame, ServerEvent};
    use linger_core::RoomId;

    fn join(room_id: RoomId) -> ClientFrame {
        ClientFrame::VoiceJoin {
            room_id,
            controls: None,
            forwarding: Some(true),
        }
    }

    const A: &str = "https://a.example";
    const B: &str = "https://b.example";

    #[test]
    fn the_window_going_leaves_every_server_voice_was_in_and_says_where_once() {
        let (general, evenings) = (RoomId::new(), RoomId::new());
        let mut seats = Seats::default();
        seats.sent(A, &join(general));
        seats.sent(B, &join(evenings));
        assert_eq!(seats.window_gone(), vec![A.to_string(), B.to_string()]);
        assert_eq!(
            seats.window_gone(),
            Vec::<String>::new(),
            "nothing left to leave"
        );
        assert_eq!(
            seats.take_ended(),
            vec![
                Ended {
                    server: A.into(),
                    room_id: general
                },
                Ended {
                    server: B.into(),
                    room_id: evenings
                },
            ]
        );
        assert_eq!(seats.take_ended(), vec![], "taken once");
    }

    #[test]
    fn a_join_again_is_the_same_seat_and_a_leave_ends_it() {
        let (general, evenings) = (RoomId::new(), RoomId::new());
        let mut seats = Seats::default();
        seats.sent(A, &join(general));
        seats.sent(A, &join(general));
        seats.sent(A, &join(evenings));
        seats.sent(A, &ClientFrame::Heartbeat { s: Some(3) });
        assert_eq!(seats.window_gone(), vec![A.to_string()]);
        assert_eq!(seats.take_ended()[0].room_id, evenings);
        seats.sent(A, &join(general));
        seats.sent(A, &ClientFrame::VoiceLeave);
        assert_eq!(seats.window_gone(), Vec::<String>::new());
    }

    #[test]
    fn a_seat_the_server_ended_is_never_said_to_have_ended_away() {
        let (general, evenings) = (RoomId::new(), RoomId::new());
        let mut seats = Seats::default();
        seats.sent(A, &join(general));
        seats.heard(A, Said::TakenOut(general));
        seats.sent(B, &join(evenings));
        seats.heard(B, Said::FreshSession);
        assert_eq!(seats.window_gone(), Vec::<String>::new());
        assert_eq!(seats.take_ended(), vec![]);
    }

    #[test]
    fn taken_out_of_another_room_or_another_server_leaves_this_seat_alone() {
        let (general, evenings) = (RoomId::new(), RoomId::new());
        let mut seats = Seats::default();
        seats.sent(A, &join(evenings));
        seats.heard(A, Said::TakenOut(general));
        seats.heard(B, Said::FreshSession);
        seats.heard(A, Said::Nothing);
        assert_eq!(seats.window_gone(), vec![A.to_string()]);
    }

    #[test]
    fn a_connection_replaced_or_closed_takes_its_seat_with_it() {
        let mut seats = Seats::default();
        seats.sent(A, &join(RoomId::new()));
        seats.disconnected(A);
        assert_eq!(seats.window_gone(), Vec::<String>::new());
    }

    #[test]
    fn voice_removed_reads_as_taken_out_of_its_room() {
        let general = RoomId::new();
        assert_eq!(
            Said::of(&ServerEvent::VoiceRemoved { room_id: general }),
            Said::TakenOut(general)
        );
        assert_eq!(Said::of(&ServerEvent::HeartbeatAck), Said::Nothing);
    }
}
