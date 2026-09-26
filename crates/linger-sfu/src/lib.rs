//! Linger's voice forwarding server (#197): each person sends their voice
//! once, to the host's server, and the server passes it to everyone else in
//! the room. It replaces the mesh, where every laptop sent its microphone to
//! every other laptop, which stops working somewhere past ten people.
//!
//! **The server hears the audio it forwards.** Voice is still encrypted on the
//! wire (DTLS-SRTP), but each hop ends here, so a host could listen. SPEC
//! §4.14 says so; an encryption layer inside the audio is #200.
//!
//! How it fits together:
//!
//! - **One UDP socket for every voice connection**, so a host opens one port.
//!   `str0m` is sans-IO: it never touches a socket, and `accepts` says which
//!   connection an incoming packet belongs to.
//! - **The server drives every negotiation.** When somebody joins, the server
//!   offers them one m-line to send their microphone on and one to receive each
//!   person already there; the others get a new offer with one more m-line. The
//!   client only ever answers, so two offers can never cross. `Offer::tracks`
//!   says whose voice each receiving m-line carries.
//! - **Full ICE, with one host candidate**: the address clients reach the
//!   server at. The server never needs a client's candidates; it learns them
//!   from the connectivity checks that arrive, from wherever they come (a TURN
//!   relay included), and checks each connection itself from then on (#210).
//! - **Audio only, Opus only**, forwarded packet by packet with nothing decoded.
//!
//! Everything runs on one thread with a blocking socket, the shape `str0m`'s
//! own forwarding example uses. The rest of the server talks to it through a
//! channel and hears back through [`Notify`].

use std::io::{self, ErrorKind};
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use str0m::change::{SdpAnswer, SdpPendingOffer};
use str0m::crypto::{from_feature_flags, CryptoProvider};
use str0m::media::{Direction, MediaData, MediaKind, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

/// The longest the loop waits on the socket before looking at its commands
/// again, so a join or an answer never waits behind a quiet room.
const TICK: Duration = Duration::from_millis(20);

/// An offer for one session to answer: the SDP, and whose voice each of its
/// receiving m-lines carries. The m-line not in `tracks` is the one the
/// session sends its own microphone on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub session: String,
    pub sdp: String,
    pub tracks: Vec<Track>,
}

/// One receiving m-line and the session whose voice it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Track {
    pub mid: String,
    pub session: String,
}

/// How the forwarding server reaches a client: the gateway, in the real
/// server; a channel, in tests.
pub trait Notify: Send + 'static {
    fn offer(&self, offer: Offer);
}

impl<F: Fn(Offer) + Send + 'static> Notify for F {
    fn offer(&self, offer: Offer) {
        self(offer);
    }
}

enum Command {
    Join { session: String, room: String },
    Answer { session: String, sdp: String },
    Leave { session: String },
    Stop,
}

/// The running forwarding server. Dropping it stops the thread.
pub struct Sfu {
    commands: Sender<Command>,
    address: SocketAddr,
    thread: Option<JoinHandle<()>>,
}

impl Sfu {
    /// Bind `bind` and start forwarding. `public` is the address clients are
    /// told to reach it at: the host's public IP and the port forwarded to
    /// `bind`. A public port of 0 means "whatever port `bind` got", which is
    /// what tests use.
    ///
    /// # Errors
    ///
    /// When the socket can't be bound or the thread can't start.
    pub fn start(bind: SocketAddr, public: SocketAddr, notify: impl Notify) -> io::Result<Self> {
        let socket = UdpSocket::bind(bind)?;
        let local = socket.local_addr()?;
        let address = if public.port() == 0 {
            SocketAddr::new(public.ip(), local.port())
        } else {
            public
        };
        let (commands, receiver) = mpsc::channel();
        let crypto = Arc::new(from_feature_flags());
        let thread = thread::Builder::new()
            .name("linger-sfu".into())
            .spawn(move || run(&socket, address, &receiver, &notify, &crypto))?;
        Ok(Self {
            commands,
            address,
            thread: Some(thread),
        })
    }

    /// Where clients reach it.
    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    /// Put a session into a room's voice, leaving wherever it was. Joining
    /// again where it already is starts its connection afresh, which is how a
    /// client recovers one that failed.
    pub fn join(&self, session: &str, room: &str) {
        let _ = self.commands.send(Command::Join {
            session: session.to_owned(),
            room: room.to_owned(),
        });
    }

    /// A session's answer to its latest offer.
    pub fn answer(&self, session: &str, sdp: &str) {
        let _ = self.commands.send(Command::Answer {
            session: session.to_owned(),
            sdp: sdp.to_owned(),
        });
    }

    /// Take a session out of voice.
    pub fn leave(&self, session: &str) {
        let _ = self.commands.send(Command::Leave {
            session: session.to_owned(),
        });
    }
}

impl Drop for Sfu {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What one client's connection is doing with another client's voice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutState {
    /// Wanted, not yet offered.
    ToOpen,
    /// In an offer that hasn't been answered.
    Negotiating(Mid),
    /// Answered: voice goes out on it.
    Open(Mid),
    /// Its sender left; to be stopped in the next offer.
    ToStop(Mid),
    /// Stopped in an offer that hasn't been answered.
    NegotiatingStop(Mid),
}

#[derive(Debug)]
struct Out {
    /// The session whose voice this is.
    origin: String,
    state: OutState,
}

struct Client {
    session: String,
    room: String,
    rtc: Rtc,
    /// The m-line this client sends its microphone on, once offered.
    mic: Option<Mid>,
    /// The offer waiting for this client's answer. Only one at a time: what
    /// changes meanwhile waits for the next one.
    pending: Option<SdpPendingOffer>,
    outs: Vec<Out>,
}

impl Client {
    /// Offer whatever has changed, unless an offer is already out.
    fn negotiate(&mut self, notify: &dyn Notify) {
        if self.pending.is_some() {
            return;
        }
        let mut change = self.rtc.sdp_api();
        if self.mic.is_none() {
            self.mic =
                Some(change.add_media(MediaKind::Audio, Direction::RecvOnly, None, None, None));
        }
        for out in &mut self.outs {
            match out.state {
                OutState::ToOpen => {
                    let mid =
                        change.add_media(MediaKind::Audio, Direction::SendOnly, None, None, None);
                    out.state = OutState::Negotiating(mid);
                }
                OutState::ToStop(mid) => {
                    change.stop_media(mid);
                    out.state = OutState::NegotiatingStop(mid);
                }
                _ => {}
            }
        }
        if !change.has_changes() {
            return;
        }
        let Some((offer, pending)) = change.apply() else {
            return;
        };
        self.pending = Some(pending);
        let tracks = self
            .outs
            .iter()
            .filter_map(|out| match out.state {
                OutState::Negotiating(mid) | OutState::Open(mid) => Some(Track {
                    mid: mid.to_string(),
                    session: out.origin.clone(),
                }),
                _ => None,
            })
            .collect();
        notify.offer(Offer {
            session: self.session.clone(),
            sdp: offer.to_sdp_string(),
            tracks,
        });
    }

    /// Apply the answer to the offer that's out.
    fn accept(&mut self, sdp: &str) -> Result<(), String> {
        let Some(pending) = self.pending.take() else {
            return Err("an answer with no offer out".into());
        };
        let answer = SdpAnswer::from_sdp_string(sdp).map_err(|error| error.to_string())?;
        self.rtc
            .sdp_api()
            .accept_answer(pending, answer)
            .map_err(|error| error.to_string())?;
        for out in &mut self.outs {
            if let OutState::Negotiating(mid) = out.state {
                out.state = OutState::Open(mid);
            }
        }
        self.outs
            .retain(|out| !matches!(out.state, OutState::NegotiatingStop(_)));
        Ok(())
    }

    /// Stop passing on `origin`'s voice: it left.
    fn forget(&mut self, origin: &str) {
        self.outs.retain_mut(|out| {
            if out.origin != origin {
                return true;
            }
            match out.state {
                OutState::ToOpen => false,
                OutState::Negotiating(mid) | OutState::Open(mid) => {
                    out.state = OutState::ToStop(mid);
                    true
                }
                OutState::ToStop(_) | OutState::NegotiatingStop(_) => true,
            }
        });
    }

    /// The m-line `origin`'s voice goes out on, once answered.
    fn out_for(&self, origin: &str) -> Option<Mid> {
        self.outs.iter().find_map(|out| match out.state {
            OutState::Open(mid) if out.origin == origin => Some(mid),
            _ => None,
        })
    }
}

/// Every client, and what the loop needs to make new ones.
struct Hub<'a> {
    clients: Vec<Client>,
    address: SocketAddr,
    crypto: &'a Arc<CryptoProvider>,
    notify: &'a dyn Notify,
}

impl Hub<'_> {
    fn command(&mut self, command: Command) {
        match command {
            Command::Join { session, room } => self.join(session, room),
            Command::Answer { session, sdp } => {
                let notify = self.notify;
                if let Some(client) = self.clients.iter_mut().find(|c| c.session == session) {
                    match client.accept(&sdp) {
                        Ok(()) => client.negotiate(notify),
                        Err(error) => {
                            tracing::warn!(%session, %error, "voice: an answer that didn't apply")
                        }
                    }
                }
            }
            Command::Leave { session } => self.remove(&session),
            Command::Stop => {}
        }
    }

    fn join(&mut self, session: String, room: String) {
        self.remove(&session);
        // Full ICE, not ICE-lite (#210). An ICE-lite agent keeps a
        // connection only while the other side sends it STUN checks, and the
        // app's WebRTC stack sends those only when the line goes quiet: with
        // voice both ways, the server dropped everyone about 15 seconds in.
        // A full agent checks the app itself, every few seconds.
        let mut rtc = Rtc::builder()
            .set_ice_lite(false)
            .set_crypto_provider(Arc::clone(self.crypto))
            .clear_codecs()
            .enable_opus(true, false)
            .build(Instant::now());
        match Candidate::host(self.address, "udp") {
            Ok(candidate) => {
                rtc.add_local_candidate(candidate);
            }
            Err(error) => {
                tracing::warn!(%error, address = %self.address, "voice: no usable address to offer");
                return;
            }
        }
        let notify = self.notify;
        let mut outs = Vec::new();
        for other in self.clients.iter_mut().filter(|c| c.room == room) {
            outs.push(Out {
                origin: other.session.clone(),
                state: OutState::ToOpen,
            });
            other.outs.push(Out {
                origin: session.clone(),
                state: OutState::ToOpen,
            });
            other.negotiate(notify);
        }
        let mut client = Client {
            session,
            room,
            rtc,
            mic: None,
            pending: None,
            outs,
        };
        client.negotiate(notify);
        self.clients.push(client);
    }

    fn remove(&mut self, session: &str) {
        let Some(at) = self.clients.iter().position(|c| c.session == session) else {
            return;
        };
        let mut gone = self.clients.remove(at);
        gone.rtc.disconnect();
        let notify = self.notify;
        for other in self.clients.iter_mut().filter(|c| c.room == gone.room) {
            other.forget(session);
            other.negotiate(notify);
        }
    }

    /// Drop connections that ended on their own, and tell the room.
    fn sweep(&mut self) {
        let dead: Vec<String> = self
            .clients
            .iter()
            .filter(|c| !c.rtc.is_alive())
            .map(|c| c.session.clone())
            .collect();
        for session in dead {
            self.remove(&session);
        }
    }
}

fn run(
    socket: &UdpSocket,
    address: SocketAddr,
    commands: &Receiver<Command>,
    notify: &dyn Notify,
    crypto: &Arc<CryptoProvider>,
) {
    let mut hub = Hub {
        clients: Vec::new(),
        address,
        crypto,
        notify,
    };
    let mut buffer = vec![0u8; 2000];
    loop {
        loop {
            match commands.try_recv() {
                Ok(Command::Stop) | Err(TryRecvError::Disconnected) => return,
                Ok(command) => hub.command(command),
                Err(TryRecvError::Empty) => break,
            }
        }

        // Everything each connection wants to send, and the voice that came in.
        let mut next = Instant::now() + TICK;
        let mut heard: Vec<(String, String, MediaData)> = Vec::new();
        for client in &mut hub.clients {
            while client.rtc.is_alive() {
                match client.rtc.poll_output() {
                    Ok(Output::Transmit(transmit)) => {
                        if let Err(error) = socket.send_to(&transmit.contents, transmit.destination)
                        {
                            tracing::debug!(%error, "voice: a packet that didn't go");
                        }
                    }
                    Ok(Output::Timeout(at)) => {
                        next = next.min(at);
                        break;
                    }
                    Ok(Output::Event(Event::MediaData(data))) => {
                        if Some(data.mid) == client.mic {
                            heard.push((client.session.clone(), client.room.clone(), data));
                        }
                    }
                    Ok(Output::Event(_)) => {}
                    Err(error) => {
                        tracing::debug!(session = %client.session, %error, "voice: a connection ended");
                        client.rtc.disconnect();
                    }
                }
            }
        }
        hub.sweep();

        // Pass each voice on to everyone else in its room. What they now
        // have to send goes out on the next turn, straight away.
        if !heard.is_empty() {
            for (origin, room, data) in &heard {
                for client in hub
                    .clients
                    .iter_mut()
                    .filter(|c| &c.room == room && &c.session != origin)
                {
                    let Some(mid) = client.out_for(origin) else {
                        continue;
                    };
                    let Some(writer) = client.rtc.writer(mid) else {
                        continue;
                    };
                    let Some(pt) = writer.match_params(data.params) else {
                        continue;
                    };
                    if let Err(error) =
                        writer.write(pt, data.network_time, data.time, data.data.clone())
                    {
                        tracing::debug!(%error, "voice: couldn't pass a packet on");
                    }
                }
            }
            continue;
        }

        let wait = next
            .saturating_duration_since(Instant::now())
            .clamp(Duration::from_millis(1), TICK);
        if socket.set_read_timeout(Some(wait)).is_err() {
            return;
        }
        match socket.recv_from(&mut buffer) {
            Ok((size, source)) => {
                if let Ok(contents) = buffer[..size].try_into() {
                    let input = Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: address,
                            contents,
                        },
                    );
                    if let Some(client) = hub.clients.iter_mut().find(|c| c.rtc.accepts(&input)) {
                        if let Err(error) = client.rtc.handle_input(input) {
                            tracing::debug!(session = %client.session, %error, "voice: bad input");
                            client.rtc.disconnect();
                        }
                    }
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(error) => {
                tracing::warn!(%error, "voice: the forwarding socket failed");
                return;
            }
        }

        let now = Instant::now();
        for client in &mut hub.clients {
            if client.rtc.is_alive() {
                let _ = client.rtc.handle_input(Input::Timeout(now));
            }
        }
    }
}
