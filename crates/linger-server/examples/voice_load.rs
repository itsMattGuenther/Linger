//! A voice room at raid size against a real server, over the internet (#197).
//!
//! `crates/linger-sfu/tests/load.rs` measures the forwarding server's own work
//! with stand-in clients beside it on one machine. This is the other half: a
//! real `linger-server` somewhere else, reached the way the app reaches it —
//! sign-up and the gateway over HTTP, voice over UDP through whatever router
//! this machine sits behind. Everybody joins one room at once, a few talk, and
//! every listener counts what reached them and how long it took. Each talking
//! packet carries the moment it left, and both ends are this one process, so
//! the time is the whole trip: from here to the server, through it, and back.
//!
//! It sets the server up itself, so it needs a fresh one: a server with
//! `LINGER_VOICE_ADDRESS` set and no data, and the setup token from its log.
//!
//! ```text
//! LINGER_LOAD_SERVER=http://203.0.113.7:8420 LINGER_LOAD_SETUP=<token> \
//!   cargo run -p linger-server --release --example voice_load
//! ```
//!
//! `LINGER_LOAD_PEOPLE` (50), `LINGER_LOAD_TALKERS` (8) and
//! `LINGER_LOAD_SECONDS` (60) change the room. `LINGER_LOAD_OLD` (0) is how
//! many of the people not talking are on an app from before 0.4.9, which sends
//! silence every 20 ms instead of nothing. The server's CPU is read on the
//! server (`top`, `docker stats`) while this runs; nothing here can see it.
//! Everybody but the host signs up from this one address, and a server takes
//! 60 sign-ups from one address at once (`RATE_REGISTER_PER_IP`), so a room
//! of up to 61 fits; a bigger one needs a second machine.
//!
//! This machine has to keep up too: fifty people's worth of decrypting runs
//! here. A run whose numbers look wrong on a small machine is worth repeating
//! on a bigger one before blaming the server.

use std::io::ErrorKind;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use futures_util::{SinkExt, StreamExt};
use linger_sfu::LOUDEST;
use serde_json::{json, Value};
use str0m::change::SdpOffer;
use str0m::crypto::from_feature_flags;
use str0m::media::{Frequency, MediaTime, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// What an app from before 0.4.9 sends while nobody is talking: Opus's three
/// bytes of silence.
const SILENT: usize = 3;
/// A talking packet starts with when it was sent and who sent it.
const STAMP: usize = 10;
/// What Opus picks on its own, for a server that names no bitrate.
const OPUS_DEFAULT_BITS: u32 = 51_000;
/// Later than this, an app would have played around the packet's gap already.
const LATE: Duration = Duration::from_millis(150);
/// RTP, SRTP, UDP and IPv4 headers on every packet, for the bandwidth estimate.
const PACKET_OVERHEAD: usize = 12 + 10 + 8 + 20;

static EPOCH: OnceLock<Instant> = OnceLock::new();

/// Microseconds since this run started: the clock every packet is stamped
/// with, shared by every stand-in because they are all this process.
fn now_us() -> u64 {
    u64::try_from(EPOCH.get_or_init(Instant::now).elapsed().as_micros()).unwrap_or(u64::MAX)
}

fn setting(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// A `voice.offer` off the gateway, its tracks still named by session.
struct GatewayOffer {
    sdp: String,
    tracks: Vec<(String, String)>,
    bits: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Say {
    Talk,
    Silence,
}

struct Client {
    index: usize,
    name: String,
    rtc: Rtc,
    socket: UdpSocket,
    offers: Receiver<GatewayOffer>,
    answers: UnboundedSender<Value>,
    sessions: Arc<Vec<String>>,
    mic: Option<Mid>,
    /// Each receiving m-line, and whose voice (by index) it carries.
    tracks: Vec<(Mid, Option<usize>)>,
    connected: bool,
    bits: u32,
    offers_answered: u32,
    frames: u64,
    sent: u64,
    /// Talking packets heard, by who said them.
    heard: Vec<u64>,
    /// Each talking packet heard: when it was sent, in ms into the run, and
    /// how long it took, here to here, in µs.
    delays: Vec<(u32, u32)>,
    bytes_heard: u64,
    /// A packet whose stamp named somebody other than its m-line's voice.
    misrouted: u64,
    silence_heard: u64,
    disconnects: u32,
    buffer: Vec<u8>,
}

impl Client {
    fn new(
        index: usize,
        local: IpAddr,
        offers: Receiver<GatewayOffer>,
        answers: UnboundedSender<Value>,
        sessions: Arc<Vec<String>>,
    ) -> anyhow::Result<Self> {
        let socket = UdpSocket::bind((local, 0)).context("a client socket")?;
        socket.set_nonblocking(true)?;
        // Nothing held back past a gap: an app's audio buffer plays around a
        // missing packet rather than waiting for it, so a stand-in that
        // waited would count its own waiting as the server's.
        let mut rtc = Rtc::builder()
            .set_crypto_provider(Arc::new(from_feature_flags()))
            .clear_codecs()
            .enable_opus(true, false)
            .set_reordering_size_audio(0)
            .build(Instant::now());
        let address = socket.local_addr()?;
        rtc.add_local_candidate(Candidate::host(address, "udp")?);
        let people = sessions.len();
        Ok(Self {
            index,
            name: format!("p{index:02}"),
            rtc,
            socket,
            offers,
            answers,
            sessions,
            mic: None,
            tracks: Vec::new(),
            connected: false,
            bits: OPUS_DEFAULT_BITS,
            offers_answered: 0,
            frames: 0,
            sent: 0,
            heard: vec![0; people],
            delays: Vec::new(),
            bytes_heard: 0,
            misrouted: 0,
            silence_heard: 0,
            disconnects: 0,
            buffer: vec![0; 2000],
        })
    }

    fn answer(&mut self, offer: GatewayOffer) {
        let sdp = match SdpOffer::from_sdp_string(&offer.sdp) {
            Ok(sdp) => sdp,
            Err(error) => {
                eprintln!("{}: the server's offer didn't parse: {error}", self.name);
                return;
            }
        };
        let answer = match self.rtc.sdp_api().accept_offer(sdp) {
            Ok(answer) => answer,
            Err(error) => {
                eprintln!("{}: couldn't accept the server's offer: {error}", self.name);
                return;
            }
        };
        self.tracks = offer
            .tracks
            .iter()
            .map(|(mid, session)| {
                let who = self.sessions.iter().position(|s| s == session);
                (Mid::from(mid.as_str()), who)
            })
            .collect();
        self.bits = offer.bits;
        self.offers_answered += 1;
        let _ = self.answers.send(json!({
            "op": "voice.answer",
            "d": { "sdp": answer.to_sdp_string() },
        }));
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Connected => self.connected = true,
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                self.disconnects += 1;
            }
            Event::MediaAdded(added) => {
                if !self.tracks.iter().any(|(mid, _)| *mid == added.mid) {
                    self.mic = Some(added.mid);
                }
            }
            Event::MediaData(data) => {
                let payload = &data.data;
                self.bytes_heard += (payload.len() + PACKET_OVERHEAD) as u64;
                if payload.len() < STAMP {
                    self.silence_heard += 1;
                    return;
                }
                let mut sent = [0u8; 8];
                sent.copy_from_slice(&payload[..8]);
                let sent = u64::from_le_bytes(sent);
                let who = usize::from(u16::from_le_bytes([payload[8], payload[9]]));
                let expected = self
                    .tracks
                    .iter()
                    .find(|(mid, _)| *mid == data.mid)
                    .and_then(|(_, who)| *who);
                if expected != Some(who) {
                    self.misrouted += 1;
                }
                if let Some(heard) = self.heard.get_mut(who) {
                    *heard += 1;
                }
                let delay = now_us().saturating_sub(sent);
                self.delays.push((
                    u32::try_from(sent / 1000).unwrap_or(u32::MAX),
                    u32::try_from(delay).unwrap_or(u32::MAX),
                ));
            }
            _ => {}
        }
    }

    /// Everything this stand-in has to do right now: answer what the server
    /// offered, send what's due, read what arrived.
    fn turn(&mut self) {
        while let Ok(offer) = self.offers.try_recv() {
            self.answer(offer);
        }
        loop {
            match self.rtc.poll_output() {
                Ok(Output::Transmit(transmit)) => {
                    let _ = self
                        .socket
                        .send_to(&transmit.contents, transmit.destination);
                }
                Ok(Output::Timeout(_)) => break,
                Ok(Output::Event(event)) => self.event(event),
                Err(error) => {
                    eprintln!("{}: {error}", self.name);
                    break;
                }
            }
        }
        let destination = match self.socket.local_addr() {
            Ok(address) => address,
            Err(_) => return,
        };
        loop {
            match self.socket.recv_from(&mut self.buffer) {
                Ok((size, source)) => {
                    if let Ok(contents) = self.buffer[..size].try_into() {
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
                Err(error) => {
                    eprintln!("{}: socket: {error}", self.name);
                    break;
                }
            }
        }
        let _ = self.rtc.handle_input(Input::Timeout(Instant::now()));
    }

    /// One 20 ms frame of time passing: talk, send silence, or send nothing.
    fn frame(&mut self, say: Option<Say>) {
        self.frames += 1;
        let (Some(say), Some(mic), true) = (say, self.mic, self.connected) else {
            return;
        };
        let Some(writer) = self.rtc.writer(mic) else {
            return;
        };
        let Some(pt) = writer.payload_params().next().map(|params| params.pt()) else {
            return;
        };
        let payload = match say {
            Say::Silence => vec![0xF8; SILENT],
            Say::Talk => {
                let size = usize::try_from(self.bits / 8 / 50).unwrap_or(0).max(STAMP);
                let mut payload = vec![0x0B; size];
                payload[..8].copy_from_slice(&now_us().to_le_bytes());
                let who = u16::try_from(self.index).unwrap_or(u16::MAX);
                payload[8..STAMP].copy_from_slice(&who.to_le_bytes());
                payload
            }
        };
        let time = MediaTime::new(self.frames * 960, Frequency::FORTY_EIGHT_KHZ);
        // How loud it is (RFC 6464), as the app says on every packet from
        // 0.4.9 (#197): each talker a little quieter than the one before, so
        // a server passing on the loudest has an order to keep.
        let writer = match say {
            Say::Talk => writer.audio_level(talker_level(self.index), true),
            Say::Silence => writer,
        };
        if writer.write(pt, Instant::now(), time, payload).is_ok() && say == Say::Talk {
            self.sent += 1;
        }
    }

    fn ready(&self) -> bool {
        let people = self.sessions.len();
        self.connected
            && self.mic.is_some()
            && self.tracks.len() == people - 1
            && self.tracks.iter().all(|(_, who)| who.is_some())
    }
}

/// What the stand-in threads and the main thread share.
struct Shared {
    /// How many of each worker's stand-ins are ready, by worker.
    ready: Vec<AtomicUsize>,
    /// When talking starts. Set once everybody is in, or given up on.
    talk: OnceLock<Instant>,
    frames: u64,
    talkers: usize,
    /// The first index of the people on an old app; everybody from here on.
    old_from: usize,
}

fn worker(mut mine: Vec<Client>, shared: Arc<Shared>, slot: usize) -> Vec<Client> {
    let start = loop {
        for client in &mut mine {
            client.turn();
        }
        let ready = mine.iter().filter(|client| client.ready()).count();
        shared.ready[slot].store(ready, Ordering::Relaxed);
        if let Some(start) = shared.talk.get() {
            break *start;
        }
        thread::sleep(Duration::from_millis(2));
    };
    for frame in 0..shared.frames {
        let at = start + Duration::from_millis(frame * 20);
        while Instant::now() < at {
            for client in &mut mine {
                client.turn();
            }
            thread::sleep(Duration::from_millis(2));
        }
        for client in &mut mine {
            let say = if client.index < shared.talkers {
                Some(Say::Talk)
            } else if client.index >= shared.old_from {
                Some(Say::Silence)
            } else {
                None
            };
            client.frame(say);
            client.turn();
        }
    }
    // The last frames' trip back.
    let until = Instant::now() + Duration::from_secs(1);
    while Instant::now() < until {
        for client in &mut mine {
            client.turn();
        }
        thread::sleep(Duration::from_millis(2));
    }
    mine
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Signs in on the gateway and waits for `ready`: the socket, this session's
/// id, and how often the server wants a heartbeat.
async fn identify(url: &str, token: &str) -> anyhow::Result<(Ws, String, u64)> {
    let (mut ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .context("the gateway")?;
    let identify = json!({ "op": "identify", "d": { "token": token, "client": "linger-load/0" } });
    ws.send(WsMessage::Text(identify.to_string().into()))
        .await?;
    let mut heartbeat = 30_000;
    while let Some(message) = ws.next().await {
        let WsMessage::Text(text) = message? else {
            continue;
        };
        let frame: Value = serde_json::from_str(&text)?;
        match frame["op"].as_str() {
            Some("hello") => {
                heartbeat = frame["d"]["heartbeat_interval_ms"]
                    .as_u64()
                    .unwrap_or(heartbeat);
            }
            Some("ready") => {
                let session = frame["d"]["session_id"]
                    .as_str()
                    .context("ready without a session")?
                    .to_string();
                return Ok((ws, session, heartbeat));
            }
            _ => {}
        }
    }
    bail!("the gateway closed before ready")
}

/// One stand-in's gateway connection, for as long as the run lasts: passes
/// offers to its stand-in, sends what the stand-in has to say, and keeps the
/// heartbeat.
async fn gateway(
    name: String,
    ws: Ws,
    heartbeat: u64,
    offers: Sender<GatewayOffer>,
    mut outgoing: UnboundedReceiver<Value>,
) {
    let (mut sink, mut stream) = ws.split();
    let mut last = 0u64;
    let mut beat = tokio::time::interval(Duration::from_millis(heartbeat));
    beat.tick().await;
    loop {
        tokio::select! {
            message = stream.next() => match message {
                Some(Ok(WsMessage::Text(text))) => {
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if let Some(s) = frame["s"].as_u64() {
                        last = s;
                    }
                    if frame["op"] == "voice.offer" {
                        let d = &frame["d"];
                        let tracks = d["tracks"]
                            .as_array()
                            .map(|tracks| {
                                tracks
                                    .iter()
                                    .map(|track| {
                                        (
                                            track["mid"].as_str().unwrap_or_default().to_string(),
                                            track["session_id"].as_str().unwrap_or_default().to_string(),
                                        )
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let bits = d["bitrate"]
                            .as_u64()
                            .and_then(|bits| u32::try_from(bits).ok())
                            .unwrap_or(OPUS_DEFAULT_BITS);
                        let _ = offers.send(GatewayOffer {
                            sdp: d["sdp"].as_str().unwrap_or_default().to_string(),
                            tracks,
                            bits,
                        });
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    eprintln!("{name}: gateway: {error}");
                    return;
                }
                None => {
                    eprintln!("{name}: the gateway closed");
                    return;
                }
            },
            frame = outgoing.recv() => {
                let Some(frame) = frame else { return };
                if let Err(error) = sink.send(WsMessage::Text(frame.to_string().into())).await {
                    eprintln!("{name}: gateway: {error}");
                    return;
                }
            },
            _ = beat.tick() => {
                let frame = json!({ "op": "heartbeat", "d": { "s": last } });
                let _ = sink.send(WsMessage::Text(frame.to_string().into())).await;
            },
        }
    }
}

async fn post(
    http: &reqwest::Client,
    url: String,
    token: Option<&str>,
    body: Value,
) -> anyhow::Result<Value> {
    let mut request = http.post(&url).json(&body);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.with_context(|| url.clone())?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        bail!("{url}: {status}: {body}");
    }
    Ok(body)
}

fn percentile(sorted: &[u32], share: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let at = ((sorted.len() - 1) as f64 * share).round() as usize;
    f64::from(sorted[at]) / 1000.0
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    EPOCH.get_or_init(Instant::now);
    let server = std::env::var("LINGER_LOAD_SERVER")
        .context("LINGER_LOAD_SERVER: the server, as http://address:port")?;
    let server = server.trim_end_matches('/').to_string();
    let setup = std::env::var("LINGER_LOAD_SETUP")
        .context("LINGER_LOAD_SETUP: the setup token from the fresh server's log")?;
    let people = setting("LINGER_LOAD_PEOPLE", 50).max(2);
    let talkers = setting("LINGER_LOAD_TALKERS", 8).min(people);
    let seconds = setting("LINGER_LOAD_SECONDS", 60) as u64;
    let old = setting("LINGER_LOAD_OLD", 0).min(people - talkers);

    let Some(host) = server.strip_prefix("http://") else {
        bail!("LINGER_LOAD_SERVER has to start with http:// (the gateway here speaks plain ws)");
    };
    let api = format!("{server}/api/v1");
    let gateway_url = format!("ws://{host}/api/v1/gateway");
    let server_ip = host
        .to_socket_addrs()
        .context("the server's address")?
        .next()
        .context("the server's address")?
        .ip();
    // The address this machine reaches the server from: what each stand-in's
    // socket binds, so its one candidate is real. The router in between
    // translates it, and the server learns the outside address from the
    // stand-in's own checks, as it does for the app.
    let local = {
        let probe = UdpSocket::bind("0.0.0.0:0")?;
        probe.connect(SocketAddr::new(server_ip, 3479))?;
        probe.local_addr()?.ip()
    };

    // Everybody's accounts, on the fresh server.
    let http = reqwest::Client::new();
    let password = format!("load-{setup}");
    let first = post(
        &http,
        format!("{api}/setup"),
        None,
        json!({
            "token": setup,
            "server_name": "Load test",
            "username": "p00",
            "display_name": "p00",
            "password": password,
        }),
    )
    .await
    .context("setting the server up (is it fresh, and the token current?)")?;
    let host_token = first["access_token"]
        .as_str()
        .context("setup gave no token")?
        .to_string();
    let room = post(
        &http,
        format!("{api}/rooms"),
        Some(&host_token),
        json!({ "slug": "raid", "name": "#raid" }),
    )
    .await?;
    let room_id = room["id"].as_str().context("a room id")?.to_string();
    let invite = post(
        &http,
        format!("{api}/invites"),
        Some(&host_token),
        json!({ "max_uses": null }),
    )
    .await?;
    let code = invite["code"]
        .as_str()
        .context("an invite code")?
        .to_string();
    let mut tokens = vec![host_token];
    for index in 1..people {
        let name = format!("p{index:02}");
        let account = post(
            &http,
            format!("{api}/auth/register"),
            None,
            json!({
                "invite_code": code,
                "username": name,
                "display_name": name,
                "password": password,
            }),
        )
        .await?;
        tokens.push(
            account["access_token"]
                .as_str()
                .context("register gave no token")?
                .to_string(),
        );
    }
    println!("{people} accounts on {server}");

    // Everybody on the gateway.
    let mut connected = Vec::new();
    for token in &tokens {
        connected.push(identify(&gateway_url, token).await?);
    }
    let sessions: Arc<Vec<String>> = Arc::new(
        connected
            .iter()
            .map(|(_, session, _)| session.clone())
            .collect(),
    );
    let mut clients = Vec::new();
    let mut outgoing = Vec::new();
    for (index, (ws, _, heartbeat)) in connected.into_iter().enumerate() {
        let (offers_to, offers) = mpsc::channel();
        let (say, said) = unbounded_channel();
        tokio::spawn(gateway(
            format!("p{index:02}"),
            ws,
            heartbeat,
            offers_to,
            said,
        ));
        clients.push(Client::new(
            index,
            local,
            offers,
            say.clone(),
            Arc::clone(&sessions),
        )?);
        outgoing.push(say);
    }

    let workers = thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(2, 16)
        .min(people);
    let chunk = people.div_ceil(workers);
    let shared = Arc::new(Shared {
        ready: (0..workers).map(|_| AtomicUsize::new(0)).collect(),
        talk: OnceLock::new(),
        frames: seconds * 50,
        talkers,
        old_from: people - old,
    });
    let mut handles = Vec::new();
    let mut rest = clients;
    let mut slot = 0;
    while !rest.is_empty() {
        let mine: Vec<Client> = rest.drain(..chunk.min(rest.len())).collect();
        let shared = Arc::clone(&shared);
        handles.push(thread::spawn(move || worker(mine, shared, slot)));
        slot += 1;
    }

    // Everybody joins at once, as a raid does at the start of the night.
    let joined = Instant::now();
    for say in &outgoing {
        let _ = say.send(json!({
            "op": "voice.join",
            "d": {
                "room_id": room_id,
                "controls": { "muted": false, "deafened": false },
                "forwarding": true,
            },
        }));
    }
    let deadline = joined + Duration::from_secs(120);
    let mut said = Instant::now();
    let ready = loop {
        let ready: usize = shared
            .ready
            .iter()
            .map(|count| count.load(Ordering::Relaxed))
            .sum();
        if ready == people || Instant::now() > deadline {
            break ready;
        }
        if said.elapsed() > Duration::from_secs(5) {
            println!("  {ready} of {people} in and hearing everybody…");
            said = Instant::now();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    if ready == people {
        println!(
            "{people} people joined at once and heard everybody in {:.1} s",
            joined.elapsed().as_secs_f64()
        );
    } else {
        println!("only {ready} of {people} were in and hearing everybody after two minutes; talking anyway");
    }

    let talk = Instant::now() + Duration::from_secs(3);
    let _ = shared.talk.set(talk);
    // In unix time, to line up with what the server's machine says about
    // itself over the same seconds.
    let from = (SystemTime::now() + Duration::from_secs(3))
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    println!(
        "{talkers} talking for {seconds} s from {from} (unix time){}…",
        if old > 0 {
            format!(", {old} on an old app sending silence")
        } else {
            String::new()
        }
    );
    let mut clients: Vec<Client> = Vec::new();
    for handle in handles {
        let joined = tokio::task::spawn_blocking(move || handle.join())
            .await?
            .map_err(|_| anyhow::anyhow!("a stand-in thread panicked"))?;
        clients.extend(joined);
    }
    for say in &outgoing {
        let _ = say.send(json!({ "op": "voice.leave", "d": {} }));
    }

    // What everybody heard. A server from 0.4.9 passes on a room's six
    // loudest voices and no more (#197): the first six talkers here, since
    // each says it's a little quieter than the one before. Each listener is
    // judged on those six, less itself; how many voices it heard at all is
    // said on its own.
    clients.sort_by_key(|client| client.index);
    let sent: Vec<u64> = clients.iter().map(|client| client.sent).collect();
    let loudest = talkers.min(LOUDEST);
    let mut worst = f64::INFINITY;
    let mut total_share = 0.0;
    let mut pairs = 0u32;
    let mut voices: Vec<usize> = Vec::new();
    for listener in clients.iter().filter(|client| client.ready()) {
        voices.push(
            sent.iter()
                .enumerate()
                .take(talkers)
                .filter(|(talker, said)| *talker != listener.index && **said > 0)
                .filter(|(talker, &said)| listener.heard[*talker] as f64 / said as f64 > 0.5)
                .count(),
        );
        for (talker, &said) in sent.iter().enumerate().take(loudest) {
            if talker == listener.index || said == 0 {
                continue;
            }
            let share = listener.heard[talker] as f64 / said as f64;
            worst = worst.min(share);
            total_share += share;
            pairs += 1;
        }
    }
    // The trip over time, five seconds at a time: a server falling behind
    // shows as a trip that grows, where a slow network is slow throughout.
    let mut slices: Vec<Vec<u32>> = Vec::new();
    let first = clients
        .iter()
        .flat_map(|client| client.delays.iter().map(|(sent, _)| *sent))
        .min()
        .unwrap_or(0);
    for (sent, delay) in clients.iter().flat_map(|client| client.delays.iter()) {
        let slice = ((sent - first) / 5000) as usize;
        if slices.len() <= slice {
            slices.resize(slice + 1, Vec::new());
        }
        slices[slice].push(*delay);
    }
    let mut delays: Vec<u32> = clients
        .iter()
        .flat_map(|client| client.delays.iter().map(|(_, delay)| *delay))
        .collect();
    delays.sort_unstable();
    let late = delays
        .iter()
        .filter(|delay| u128::from(**delay) > LATE.as_micros())
        .count();
    let bytes: u64 = clients.iter().map(|client| client.bytes_heard).sum();
    let misrouted: u64 = clients.iter().map(|client| client.misrouted).sum();
    let silence: u64 = clients.iter().map(|client| client.silence_heard).sum();
    let disconnects: u32 = clients.iter().map(|client| client.disconnects).sum();
    let bits = clients.first().map_or(0, |client| client.bits);
    println!();
    println!(
        "people {people}, talking {talkers}, old apps {old}, at {} kbit/s",
        bits / 1000
    );
    println!(
        "talkers sent {} packets each (of {} due)",
        sent.iter().take(talkers).min().copied().unwrap_or(0),
        seconds * 50
    );
    if pairs > 0 {
        println!(
            "delivery of the {loudest} loudest voices: worst listener heard {:.1}% of one; on average {:.2}%",
            100.0 * worst,
            100.0 * total_share / f64::from(pairs)
        );
    }
    if let (Some(most), Some(fewest)) = (voices.iter().max(), voices.iter().min()) {
        println!("voices each listener heard most of: at most {most}, at fewest {fewest}");
    }
    println!(
        "trip here → server → here: fastest {:.0} ms, median {:.0} ms, 95% under {:.0} ms, 99% under {:.0} ms, slowest {:.0} ms",
        percentile(&delays, 0.0),
        percentile(&delays, 0.5),
        percentile(&delays, 0.95),
        percentile(&delays, 0.99),
        percentile(&delays, 1.0)
    );
    let timeline: Vec<String> = slices
        .iter_mut()
        .map(|slice| {
            slice.sort_unstable();
            format!("{:.0}", percentile(slice, 0.5))
        })
        .collect();
    println!(
        "median trip, five seconds at a time: {} ms",
        timeline.join(" · ")
    );
    println!(
        "later than {} ms: {late} of {} packets ({:.2}%)",
        LATE.as_millis(),
        delays.len(),
        100.0 * late as f64 / delays.len().max(1) as f64
    );
    println!(
        "the server sent about {:.1} Mbit/s of voice (headers counted, encryption's extra not)",
        bytes as f64 * 8.0 / seconds as f64 / 1_000_000.0
    );
    if silence > 0 {
        println!("silence forwarded: {silence} packets");
    }
    if misrouted > 0 {
        println!("WRONG VOICE: {misrouted} packets arrived on somebody else's track");
    }
    if disconnects > 0 {
        println!("connections that dropped during the run: {disconnects}");
    }
    let answered: u32 = clients.iter().map(|client| client.offers_answered).sum();
    println!("offers answered: {answered}");
    Ok(())
}

/// How loud talker `index` says it is, in RFC 6464's negative decibels:
/// −15 for the first, three quieter for each after, down to −60.
fn talker_level(index: usize) -> i8 {
    let step = i8::try_from(index.min(15)).unwrap_or(15);
    -15 - 3 * step
}
