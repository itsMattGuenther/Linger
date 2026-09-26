//! The forwarding server, end to end on this machine: stand-in clients built
//! on `str0m` join, answer the server's offers, and hear each other through
//! it. Nothing here says anything about a real network (AGENTS "Where you will
//! be wrong"); it proves the negotiation and the forwarding.

use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use linger_sfu::{Offer, Sfu};
use str0m::change::SdpOffer;
use str0m::crypto::from_feature_flags;
use str0m::media::{MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

/// A stand-in client: a full-ICE `str0m` peer on its own socket.
struct Client {
    rtc: Rtc,
    socket: UdpSocket,
    /// The m-line it sends on: the one the latest offer didn't name.
    mic: Option<Mid>,
    /// Whose voice each receiving m-line carries, from the latest offer.
    tracks: Vec<(Mid, String)>,
    connected: bool,
    /// Voice heard, by the session it came from.
    heard: Vec<String>,
    sent: u64,
}

impl Client {
    fn new() -> Self {
        let socket = UdpSocket::bind("127.0.0.1:0").expect("a client socket");
        socket.set_nonblocking(true).expect("non-blocking");
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(from_feature_flags()))
            .clear_codecs()
            .enable_opus(true, false)
            .build(Instant::now());
        let local = socket.local_addr().expect("an address");
        rtc.add_local_candidate(Candidate::host(local, "udp").expect("a candidate"));
        Self {
            rtc,
            socket,
            mic: None,
            tracks: Vec::new(),
            connected: false,
            heard: Vec::new(),
            sent: 0,
        }
    }

    /// Answer an offer from the server, as the desktop engine does.
    fn answer(&mut self, offer: &Offer) -> String {
        let sdp = SdpOffer::from_sdp_string(&offer.sdp).expect("the server's SDP parses");
        let answer = self
            .rtc
            .sdp_api()
            .accept_offer(sdp)
            .expect("the offer is acceptable");
        self.tracks = offer
            .tracks
            .iter()
            .map(|track| (Mid::from(track.mid.as_str()), track.session.clone()))
            .collect();
        answer.to_sdp_string()
    }

    /// One turn: send what it wants to, read what arrived, move time on.
    fn turn(&mut self) {
        loop {
            match self.rtc.poll_output().expect("output") {
                Output::Transmit(transmit) => {
                    let _ = self
                        .socket
                        .send_to(&transmit.contents, transmit.destination);
                }
                Output::Timeout(_) => break,
                Output::Event(Event::Connected) => self.connected = true,
                Output::Event(Event::MediaAdded(added)) => {
                    // The one m-line it sends on is the one the server receives on.
                    if !self.tracks.iter().any(|(mid, _)| *mid == added.mid) {
                        self.mic = Some(added.mid);
                    }
                }
                Output::Event(Event::MediaData(data)) => {
                    if let Some((_, from)) = self.tracks.iter().find(|(mid, _)| *mid == data.mid) {
                        self.heard.push(from.clone());
                    }
                }
                Output::Event(_) => {}
            }
        }
        let mut buffer = vec![0u8; 2000];
        loop {
            match self.socket.recv_from(&mut buffer) {
                Ok((size, source)) => {
                    let destination = self.socket.local_addr().expect("an address");
                    if let Ok(contents) = buffer[..size].try_into() {
                        let _ = self.rtc.handle_input(Input::Receive(
                            Instant::now(),
                            Receive {
                                proto: Protocol::Udp,
                                source,
                                destination,
                                contents,
                            },
                        ));
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => panic!("client socket: {error}"),
            }
        }
        let _ = self.rtc.handle_input(Input::Timeout(Instant::now()));
    }

    /// A frame of "voice": the server never decodes it, so any bytes do.
    fn speak(&mut self) {
        let (Some(mic), true) = (self.mic, self.connected) else {
            return;
        };
        let Some(writer) = self.rtc.writer(mic) else {
            return;
        };
        let Some(pt) = writer.payload_params().next().map(|params| params.pt()) else {
            return;
        };
        self.sent += 1;
        let time = MediaTime::new(self.sent * 960, str0m::media::Frequency::FORTY_EIGHT_KHZ);
        let _ = writer.write(pt, Instant::now(), time, vec![0xF8, 0xFF, 0xFE]);
    }
}

fn start() -> (Sfu, Receiver<Offer>) {
    let (sender, offers) = mpsc::channel();
    let local: SocketAddr = "127.0.0.1:0".parse().expect("an address");
    let sfu = Sfu::start(local, local, move |offer: Offer| {
        let _ = sender.send(offer);
    })
    .expect("the forwarding server starts");
    (sfu, offers)
}

/// Run clients and hand each offer to its client, until `done` or a timeout.
fn drive(
    sfu: &Sfu,
    offers: &Receiver<Offer>,
    clients: &mut [(&str, &mut Client)],
    done: impl Fn(&[(&str, &mut Client)]) -> bool,
) -> bool {
    let until = Instant::now() + Duration::from_secs(10);
    while Instant::now() < until {
        while let Ok(offer) = offers.try_recv() {
            if let Some((_, client)) = clients.iter_mut().find(|(name, _)| *name == offer.session) {
                let answer = client.answer(&offer);
                sfu.answer(&offer.session, &answer);
            }
        }
        for (_, client) in clients.iter_mut() {
            client.turn();
            client.speak();
        }
        if done(clients) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

#[test]
fn two_people_in_a_room_hear_each_other_through_it() {
    let (sfu, offers) = start();
    let mut a = Client::new();
    let mut b = Client::new();
    sfu.join("a", "room");
    sfu.join("b", "room");
    let heard = drive(
        &sfu,
        &offers,
        &mut [("a", &mut a), ("b", &mut b)],
        |clients| {
            clients
                .iter()
                .all(|(name, client)| client.heard.iter().any(|from| from != name))
        },
    );
    assert!(heard, "a heard {:?}, b heard {:?}", a.heard, b.heard);
    assert!(
        a.heard.iter().all(|from| from == "b"),
        "a heard somebody who isn't b: {:?}",
        a.heard
    );
    assert!(
        b.heard.iter().all(|from| from == "a"),
        "b heard somebody who isn't a: {:?}",
        b.heard
    );
}

#[test]
fn voice_stays_in_its_room() {
    let (sfu, offers) = start();
    let mut a = Client::new();
    let mut b = Client::new();
    let mut c = Client::new();
    sfu.join("a", "one");
    sfu.join("b", "one");
    sfu.join("c", "two");
    let heard = drive(
        &sfu,
        &offers,
        &mut [("a", &mut a), ("b", &mut b), ("c", &mut c)],
        |clients| clients[0].1.heard.len() > 20 && clients[1].1.heard.len() > 20,
    );
    assert!(heard, "a and b never heard each other");
    assert!(
        c.heard.is_empty(),
        "c, in another room, heard {:?}",
        c.heard
    );
    assert!(
        c.tracks.is_empty(),
        "c was offered somebody else's voice: {:?}",
        c.tracks
    );
}

#[test]
fn somebody_leaving_is_taken_out_of_the_others_offers() {
    let (sfu, offers) = start();
    let mut a = Client::new();
    let mut b = Client::new();
    let mut c = Client::new();
    sfu.join("a", "room");
    sfu.join("b", "room");
    sfu.join("c", "room");
    assert!(drive(
        &sfu,
        &offers,
        &mut [("a", &mut a), ("b", &mut b), ("c", &mut c)],
        |clients| {
            clients
                .iter()
                .all(|(_, client)| client.tracks.len() == 2 && client.heard.len() > 5)
        }
    ));
    sfu.leave("c");
    let settled = drive(
        &sfu,
        &offers,
        &mut [("a", &mut a), ("b", &mut b)],
        |clients| {
            clients.iter().all(|(_, client)| {
                client.tracks.iter().all(|(_, from)| from != "c") && client.tracks.len() == 1
            })
        },
    );
    assert!(
        settled,
        "a still has {:?}, b still has {:?}",
        a.tracks, b.tracks
    );
}
