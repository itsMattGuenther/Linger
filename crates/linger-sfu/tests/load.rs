//! A voice room at raid size, on this machine (#197): how hard the forwarding
//! server works with fifty people in one room, with everybody not talking on
//! an old app that sends silence, and with them on an app that sends nothing
//! (Opus DTX, as the desktop app does from 0.4.9). The server passes neither
//! silence nor more than its six loudest voices on, so the two should cost
//! about the same, and a room with more than six talking about what six do.
//!
//! Ignored in ordinary runs, since it takes the better part of a minute and
//! measures rather than checks. Run it by hand, built for release:
//!
//! ```text
//! cargo test -p linger-sfu --release --test load -- --ignored --nocapture
//! ```
//!
//! `LINGER_LOAD_PEOPLE` (50), `LINGER_LOAD_TALKERS` (3) and
//! `LINGER_LOAD_SECONDS` (10) change the room. The forwarding server's own CPU
//! is read from its thread (`linger-sfu`) in /proc, so this measures it on
//! Linux only. Stand-in clients on one machine say nothing about real networks
//! (AGENTS "Where you will be wrong"): this is the server's share of the work,
//! not proof a raid will sound right.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{SocketAddr, UdpSocket};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use linger_sfu::{Offer, Sfu, LOUDEST};
use str0m::change::SdpOffer;
use str0m::crypto::from_feature_flags;
use str0m::media::{Frequency, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};

/// A talking frame at the quality the room's offer asks for (#431): 20 ms
/// of it, fifty to a second.
fn talking_frame(bits: u32) -> usize {
    usize::try_from(bits / 8 / 50).expect("a frame's bytes")
}
/// A silent frame sent the old way: Opus's three bytes of silence.
const SILENT: usize = 3;

struct Client {
    name: String,
    rtc: Rtc,
    socket: UdpSocket,
    mic: Option<Mid>,
    tracks: Vec<(Mid, String)>,
    connected: bool,
    /// Packets heard, by whose voice they were.
    heard: HashMap<String, u64>,
    frames: u64,
    /// What the latest offer said to send at (#431).
    bits: u32,
    /// How loud it says it is when it talks, in negative decibels.
    level: i8,
}

impl Client {
    fn new(name: String, index: usize) -> Self {
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
            name,
            rtc,
            socket,
            mic: None,
            tracks: Vec::new(),
            connected: false,
            heard: HashMap::new(),
            frames: 0,
            bits: 0,
            level: -15 - 3 * i8::try_from(index.min(15)).unwrap_or(15),
        }
    }

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
        self.bits = offer.bits;
        answer.to_sdp_string()
    }

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
                    if !self.tracks.iter().any(|(mid, _)| *mid == added.mid) {
                        self.mic = Some(added.mid);
                    }
                }
                Output::Event(Event::MediaData(data)) => {
                    if let Some((_, from)) = self.tracks.iter().find(|(mid, _)| *mid == data.mid) {
                        *self.heard.entry(from.clone()).or_default() += 1;
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

    /// One 20 ms frame of time passing: sends `size` bytes, or nothing.
    fn frame(&mut self, size: Option<usize>) {
        self.frames += 1;
        let (Some(size), Some(mic), true) = (size, self.mic, self.connected) else {
            return;
        };
        let Some(writer) = self.rtc.writer(mic) else {
            return;
        };
        let Some(pt) = writer.payload_params().next().map(|params| params.pt()) else {
            return;
        };
        let time = MediaTime::new(self.frames * 960, Frequency::FORTY_EIGHT_KHZ);
        // How loud it is (RFC 6464), as the app says from 0.4.9: each talker
        // a little quieter than the last, so the six loudest are clear.
        let writer = if size > SILENT {
            writer.audio_level(self.level, true)
        } else {
            writer
        };
        let _ = writer.write(pt, Instant::now(), time, vec![0x0B; size]);
    }

    fn ready(&self, people: usize) -> bool {
        self.connected && self.mic.is_some() && self.tracks.len() == people - 1
    }
}

fn setting(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// The forwarding server thread's CPU time so far, from /proc.
fn sfu_cpu() -> Duration {
    let Ok(tasks) = std::fs::read_dir("/proc/self/task") else {
        return Duration::ZERO;
    };
    for task in tasks.flatten() {
        let path = task.path();
        let named = std::fs::read_to_string(path.join("comm")).unwrap_or_default();
        if named.trim() != "linger-sfu" {
            continue;
        }
        let stat = std::fs::read_to_string(path.join("stat")).unwrap_or_default();
        // The fields after the name in parentheses; utime and stime are the
        // 12th and 13th of them, in ticks of 1/100 s.
        let after = stat.rsplit_once(')').map_or("", |(_, rest)| rest);
        let fields: Vec<u64> = after
            .split_whitespace()
            .map(|field| field.parse().unwrap_or(0))
            .collect();
        let ticks = fields.get(11).copied().unwrap_or(0) + fields.get(12).copied().unwrap_or(0);
        return Duration::from_millis(ticks * 10);
    }
    Duration::ZERO
}

/// Everybody joins at once, as a raid does at the start of the night.
fn join(sfu: &Sfu, offers: &Receiver<Offer>, clients: &mut [Client]) -> (Duration, usize) {
    let people = clients.len();
    let started = Instant::now();
    for client in clients.iter() {
        sfu.join(&client.name, "raid");
    }
    let mut longest = 0;
    let until = started + Duration::from_secs(120);
    while Instant::now() < until {
        while let Ok(offer) = offers.try_recv() {
            if let Some(client) = clients
                .iter_mut()
                .find(|client| client.name == offer.session)
            {
                let answer = client.answer(&offer);
                longest = longest.max(answer.len());
                sfu.answer(&offer.session, &answer);
            }
        }
        for client in clients.iter_mut() {
            client.turn();
        }
        if clients.iter().all(|client| client.ready(people)) {
            return (started.elapsed(), longest);
        }
        thread::sleep(Duration::from_millis(2));
    }
    let ready = clients.iter().filter(|client| client.ready(people)).count();
    panic!("only {ready} of {people} were connected and hearing everybody after two minutes");
}

struct Run {
    sfu_cpu: Duration,
    talking_delivered: f64,
    packets_heard: u64,
}

/// `seconds` of a raid: the first `talkers` talk the whole time, everybody
/// else is silent, and sends silence every frame, or nothing (as the desktop
/// app now does: Opus DTX, and its "still here" left unsent too).
fn raid(
    clients: Vec<Client>,
    talkers: usize,
    seconds: u64,
    silence_sent: bool,
) -> (Vec<Client>, Run) {
    // Let whatever the last run left in flight drain first: an overloaded
    // run's backlog would land in this one's counts and CPU.
    let mut clients = clients;
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        for client in &mut clients {
            client.turn();
        }
        thread::sleep(Duration::from_millis(5));
    }
    let talking: Vec<String> = clients
        .iter()
        .take(talkers)
        .map(|client| client.name.clone())
        .collect();
    let workers = thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(2, 8);
    let chunk = clients.len().div_ceil(workers);
    let cpu_before = sfu_cpu();
    let frames = seconds * 50;
    let start = Instant::now() + Duration::from_millis(50);
    let mut handles = Vec::new();
    let mut rest = clients;
    while !rest.is_empty() {
        let mut mine: Vec<Client> = rest.drain(..chunk.min(rest.len())).collect();
        let talking = talking.clone();
        handles.push(thread::spawn(move || {
            for client in &mut mine {
                client.heard.clear();
            }
            for frame in 0..frames {
                let at = start + Duration::from_millis(frame * 20);
                // Turn often between frames, so what arrives is read.
                while Instant::now() < at {
                    for client in &mut mine {
                        client.turn();
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                for client in &mut mine {
                    let size = if talking.contains(&client.name) {
                        Some(talking_frame(client.bits))
                    } else if silence_sent {
                        Some(SILENT)
                    } else {
                        None
                    };
                    client.frame(size);
                    client.turn();
                }
            }
            // Let the last frames land.
            let until = Instant::now() + Duration::from_millis(300);
            while Instant::now() < until {
                for client in &mut mine {
                    client.turn();
                }
                thread::sleep(Duration::from_millis(2));
            }
            mine
        }));
    }
    let clients: Vec<Client> = handles
        .into_iter()
        .flat_map(|handle| handle.join().expect("a client thread"))
        .collect();
    let sfu_cpu = sfu_cpu().saturating_sub(cpu_before);
    // The worst delivery, to any listener, of the voices it should hear, as
    // a share of what they said: what somebody would hear missing. The
    // server passes on the six loudest (#197): the first six talkers, each
    // a little louder than the next. A listener among them hears the other
    // five.
    let said = frames as f64;
    let loudest = &talking[..talking.len().min(LOUDEST)];
    let talking_delivered = clients
        .iter()
        .flat_map(|client| {
            loudest
                .iter()
                .filter(move |talker| **talker != client.name)
                .map(move |talker| client.heard.get(talker).copied().unwrap_or(0) as f64 / said)
        })
        .fold(f64::INFINITY, f64::min);
    let packets_heard = clients
        .iter()
        .map(|client| client.heard.values().sum::<u64>())
        .sum();
    (
        clients,
        Run {
            sfu_cpu,
            talking_delivered,
            packets_heard,
        },
    )
}

#[test]
#[ignore = "measures for a minute; run by hand with --ignored --nocapture"]
fn a_raid_sized_room() {
    // The forwarding server's own warnings, such as an answer it couldn't
    // apply, show with the results.
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
    let people = setting("LINGER_LOAD_PEOPLE", 50);
    let talkers = setting("LINGER_LOAD_TALKERS", 3).min(people);
    let seconds = setting("LINGER_LOAD_SECONDS", 10) as u64;

    let (sender, offers) = mpsc::channel();
    let local: SocketAddr = "127.0.0.1:0".parse().expect("an address");
    let sfu = Sfu::start(local, local, move |offer: Offer| {
        let _ = sender.send(offer);
    })
    .expect("the forwarding server starts");

    let mut clients: Vec<Client> = (0..people)
        .map(|n| Client::new(format!("s-{n:02}"), n))
        .collect();
    let (joined_in, longest_answer) = join(&sfu, &offers, &mut clients);
    println!(
        "{people} people joined at once and heard everybody in {:.1} s; the longest answer was {} KB; talking at {} kbit/s",
        joined_in.as_secs_f64(),
        longest_answer / 1024,
        clients[0].bits / 1000
    );

    // Unsent first, so the old way's backlog can't spill into it.
    let (clients, new) = raid(clients, talkers, seconds, false);
    let (_clients, old) = raid(clients, talkers, seconds, true);
    for (label, run) in [
        ("everybody else on an old app, sending silence", &old),
        ("everybody else sending nothing", &new),
    ] {
        println!(
            "{label}: forwarding server CPU {:.0}% of one core; {:.0} packets a second delivered; the worst-heard of the six loudest reached {:.1}% of a listener",
            100.0 * run.sfu_cpu.as_secs_f64() / seconds as f64,
            run.packets_heard as f64 / seconds as f64,
            100.0 * run.talking_delivered
        );
    }
    assert!(
        longest_answer < linger_core_limit(),
        "an answer outgrew MAX_VOICE_PAYLOAD_BYTES"
    );
    assert!(
        new.talking_delivered > 0.95,
        "with silence unsent, a talker reached only {:.1}% of somebody",
        100.0 * new.talking_delivered
    );
}

/// `linger-core::limits::MAX_VOICE_PAYLOAD_BYTES`, which this crate doesn't
/// depend on: a stand-in's answer has to fit what the server accepts.
fn linger_core_limit() -> usize {
    128 * 1024
}
