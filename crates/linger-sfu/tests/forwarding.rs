//! The forwarding server, end to end on this machine: stand-in clients built
//! on `str0m` join, answer the server's offers, and hear each other through
//! it. Nothing here says anything about a real network (AGENTS "Where you will
//! be wrong"); it proves the negotiation and the forwarding.

use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use linger_sfu::{Offer, Sfu, BIG_ROOM, BIG_ROOM_BITS, SMALL_AGAIN, SMALL_ROOM_BITS};
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
    /// What the latest offer said to send voice at (#431).
    bits: Option<u32>,
    /// The next voice packet it sends is lost on the way.
    lose_next_voice: bool,
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
            bits: None,
            lose_next_voice: false,
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
        self.bits = Some(offer.bits);
        answer.to_sdp_string()
    }

    /// One turn: send what it wants to, read what arrived, move time on.
    fn turn(&mut self) {
        loop {
            match self.rtc.poll_output().expect("output") {
                Output::Transmit(transmit) => {
                    if self.lose_next_voice && is_rtp(&transmit.contents) {
                        self.lose_next_voice = false;
                        continue;
                    }
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

/// RTP, as opposed to RTCP, STUN or DTLS sharing the socket (RFC 5761, 7983):
/// version 2, and a second byte that isn't one of RTCP's packet types.
fn is_rtp(packet: &[u8]) -> bool {
    packet.len() > 1 && packet[0] & 0xC0 == 0x80 && !(192..=223).contains(&packet[1])
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

/// A room filling at once, as a raid does: no offer names an m-line twice
/// (#197). `str0m` draws each new mid at random and used to check it only
/// against the agreed ones, so a newcomer's first offer, an m-line for
/// everybody there, could repeat one: the app refused it as reordered, and
/// that person heard nobody. Every offer is checked as it goes out.
#[test]
fn a_room_filling_at_once_never_names_an_m_line_twice() {
    let (sfu, offers) = start();
    let names: Vec<String> = (0..40).map(|n| format!("p{n:02}")).collect();
    let mut clients: Vec<Client> = names.iter().map(|_| Client::new()).collect();
    for name in &names {
        sfu.join(name, "raid");
    }
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        while let Ok(offer) = offers.try_recv() {
            let mids: Vec<&str> = offer
                .sdp
                .lines()
                .filter_map(|line| line.strip_prefix("a=mid:"))
                .collect();
            let distinct: std::collections::HashSet<&str> = mids.iter().copied().collect();
            assert_eq!(
                distinct.len(),
                mids.len(),
                "an offer named an m-line twice: {mids:?}"
            );
            let at = names
                .iter()
                .position(|name| *name == offer.session)
                .expect("an offer for somebody in the room");
            let answer = clients[at].answer(&offer);
            sfu.answer(&offer.session, &answer);
        }
        for client in &mut clients {
            client.turn();
        }
        if clients
            .iter()
            .all(|client| client.connected && client.tracks.len() == names.len() - 1)
        {
            break;
        }
        assert!(Instant::now() < until, "the room never settled");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Answer offers until everybody in `room` has an m-line for each of the
/// others, and say what each was last told to send at.
fn settle(sfu: &Sfu, offers: &Receiver<Offer>, room: &mut [(String, Client)]) -> Vec<u32> {
    let until = Instant::now() + Duration::from_secs(60);
    loop {
        while let Ok(offer) = offers.try_recv() {
            if let Some((_, client)) = room.iter_mut().find(|(name, _)| *name == offer.session) {
                let answer = client.answer(&offer);
                sfu.answer(&offer.session, &answer);
            }
        }
        if room
            .iter()
            .all(|(_, client)| client.tracks.len() == room.len() - 1)
        {
            return room
                .iter()
                .map(|(_, client)| client.bits.expect("an offer"))
                .collect();
        }
        assert!(Instant::now() < until, "the room never settled");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// A room sends voice at the better quality until it holds twenty-one, then
/// steps down, and steps back up only once it is down to sixteen (#431), and
/// everybody in it is told on the offer their join or leave brought.
#[test]
fn a_room_steps_its_quality_down_at_twenty_one_and_back_up_at_sixteen() {
    let (sfu, offers) = start();
    let mut room: Vec<(String, Client)> = Vec::new();
    let join = |room: &mut Vec<(String, Client)>| {
        let name = format!("p{:02}", room.len());
        sfu.join(&name, "raid");
        room.push((name, Client::new()));
    };
    let leave = |room: &mut Vec<(String, Client)>| {
        let (name, _) = room.pop().expect("somebody to leave");
        sfu.leave(&name);
    };

    for _ in 0..BIG_ROOM - 1 {
        join(&mut room);
    }
    let all = |bits: u32, n: usize| vec![bits; n];
    assert_eq!(
        settle(&sfu, &offers, &mut room),
        all(SMALL_ROOM_BITS, BIG_ROOM - 1),
        "twenty send at the better quality"
    );

    join(&mut room);
    assert_eq!(
        settle(&sfu, &offers, &mut room),
        all(BIG_ROOM_BITS, BIG_ROOM),
        "the twenty-first steps everybody down"
    );

    while room.len() > SMALL_AGAIN + 1 {
        leave(&mut room);
    }
    assert_eq!(
        settle(&sfu, &offers, &mut room),
        all(BIG_ROOM_BITS, SMALL_AGAIN + 1),
        "down to seventeen, the room stays where it was"
    );

    leave(&mut room);
    assert_eq!(
        settle(&sfu, &offers, &mut room),
        all(SMALL_ROOM_BITS, SMALL_AGAIN),
        "at sixteen it steps back up"
    );

    join(&mut room);
    assert_eq!(
        settle(&sfu, &offers, &mut room),
        all(SMALL_ROOM_BITS, SMALL_AGAIN + 1),
        "and seventeen again doesn't step it down"
    );
}

#[test]
fn a_packet_lost_on_the_way_in_doesnt_hold_up_the_voice_after_it() {
    let (sfu, offers) = start();
    let mut a = Client::new();
    let mut b = Client::new();
    sfu.join("a", "room");
    sfu.join("b", "room");
    let talking = drive(
        &sfu,
        &offers,
        &mut [("a", &mut a), ("b", &mut b)],
        |clients| clients[1].1.heard.iter().any(|from| from == "a"),
    );
    assert!(talking, "b never heard a");
    // What's in flight lands, with nobody talking.
    let until = Instant::now() + Duration::from_millis(200);
    while Instant::now() < until {
        a.turn();
        b.turn();
        std::thread::sleep(Duration::from_millis(2));
    }

    // One packet lost on a's way in, then ten more, a frame's 20 ms apart.
    // `str0m` held a voice back after a gap until fifteen more had arrived
    // (300 ms) by default, so b heard none of these while a said them (#438).
    a.lose_next_voice = true;
    a.speak();
    let before = b.heard.len();
    for _ in 0..10 {
        let next = Instant::now() + Duration::from_millis(20);
        a.speak();
        while Instant::now() < next {
            a.turn();
            b.turn();
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    let until = Instant::now() + Duration::from_millis(40);
    while Instant::now() < until {
        a.turn();
        b.turn();
        std::thread::sleep(Duration::from_millis(2));
    }
    let heard = b.heard[before..].iter().filter(|from| *from == "a").count();
    assert!(
        heard >= 5,
        "b heard {heard} of the ten frames a said after the lost one, while a said them"
    );
    assert!(
        !a.lose_next_voice,
        "a never sent the packet that was to be lost"
    );
}
