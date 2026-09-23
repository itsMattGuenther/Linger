//! The gateway client, driven over real sockets.
//!
//! AGENTS.md flags gateway resume as a place where code that reads correctly is
//! still frequently broken, and says to test it with forced disconnects rather
//! than mocks. So every test here stands up an actual TCP listener, speaks the
//! real protocol at the client, and — where it matters — kills the connection
//! with an RST instead of a polite close, the way a killed server does.
//!
//! The fake server is deliberately dumb: it says exactly what each test needs
//! it to say. Its agreement with the real server is guaranteed elsewhere, by
//! both sides sharing `linger_core::gateway`.

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use linger_client_lib::gateway::{self, Events, Status, Token};
use linger_core::gateway::{ReadyData, ServerFrame};
use linger_core::wire::User;
use linger_core::UserId;
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::WebSocketStream;

/// Every await in these tests is bounded, so a hang fails loudly instead of
/// stalling the suite.
const PATIENCE: Duration = Duration::from_secs(5);
const ROOM: &str = "018f6f4a7b2c7d3e9f0a1b2c3d4e5f60";
const USER: &str = "018f6f4a7b2c7d3e9f0a1b2c3d4e5f61";

// ---------------------------------------------------------------------------
// A server that does as it is told
// ---------------------------------------------------------------------------

struct FakeServer {
    listener: TcpListener,
    addr: SocketAddr,
}

impl FakeServer {
    async fn bind() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind a loopback port");
        let addr = listener.local_addr().expect("read the bound port");
        Self { listener, addr }
    }

    /// What the frontend would pass as the server's origin.
    fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    // The callback's error type is tungstenite's own `Response`, which is a big
    // type we do not get to choose.
    #[allow(clippy::result_large_err)]
    async fn accept(&self) -> Peer {
        let (stream, _) = timeout(PATIENCE, self.listener.accept())
            .await
            .expect("a connection attempt")
            .expect("accept it");
        let mut path = String::new();
        let ws = tokio_tungstenite::accept_hdr_async(stream, |request: &Request, response| {
            path = request.uri().path().to_string();
            Ok::<Response, _>(response)
        })
        .await
        .expect("websocket handshake");
        Peer { ws, path }
    }
}

struct Peer {
    ws: WebSocketStream<TcpStream>,
    path: String,
}

impl Peer {
    async fn send(&mut self, value: &Value) {
        let json = serde_json::to_string(value).expect("serialize a frame");
        self.ws
            .send(Message::Text(json.into()))
            .await
            .expect("send a frame");
    }

    async fn recv(&mut self) -> Value {
        loop {
            let message = timeout(PATIENCE, self.ws.next())
                .await
                .expect("a frame from the client")
                .expect("the socket is still open")
                .expect("a readable frame");
            if let Message::Text(text) = message {
                return serde_json::from_str(text.as_str()).expect("valid JSON");
            }
        }
    }

    /// Wait for the client's first frame, ignoring nothing: the handshake frame
    /// is always the first thing it sends.
    async fn hello(&mut self, heartbeat_interval_ms: u64) {
        self.send(&json!({"op":"hello","d":{"heartbeat_interval_ms":heartbeat_interval_ms}}))
            .await;
    }

    async fn ready(&mut self, session_id: &str) {
        self.send(&ready_frame(session_id)).await;
    }

    /// Kill the connection hard: an RST, with no close frame and no chance for
    /// anything in flight to be flushed. That puts the client's read on its
    /// error path rather than a tidy end-of-stream, which is the half of a lost
    /// connection that a polite `close()` never exercises.
    ///
    /// `set_linger` is deprecated because a *non-zero* linger blocks the thread
    /// on drop. Zero is the opposite: close returns at once and the kernel sends
    /// the RST.
    #[allow(deprecated)]
    fn kill(self) {
        let _ = self.ws.get_ref().set_linger(Some(Duration::ZERO));
        drop(self.ws);
    }
}

fn ready_frame(session_id: &str) -> Value {
    let user = User {
        id: UserId::new(),
        username: "matt".into(),
        display_name: "Matt".into(),
        is_host: true,
        style: linger_core::wire::Style::default(),
        status: None,
        entrance_sound: None,
        last_seen_at: None,
    };
    let data = ReadyData {
        session_id: session_id.to_string(),
        user: user.clone(),
        users: vec![user],
        rooms: Vec::new(),
        dms: Vec::new(),
        presence: Vec::new(),
        voice: None,
    };
    json!({ "op": "ready", "d": data, "s": 0 })
}

/// A cheap sequenced event to fill the stream with.
fn typing(seq: u64) -> Value {
    json!({"op":"typing","d":{"room_id":ROOM,"user_id":USER},"s":seq})
}

// ---------------------------------------------------------------------------
// Collecting what the client tells the frontend
// ---------------------------------------------------------------------------

/// `ServerFrame` is much bigger than `Status` (it carries a whole `ready`
/// payload), so it is boxed rather than making every note that size.
#[derive(Debug, Clone)]
enum Note {
    Status(Status),
    Frame(Box<ServerFrame>, bool),
}

struct Recorder {
    tx: mpsc::UnboundedSender<Note>,
}

impl Events for Recorder {
    fn status(&self, status: Status) {
        let _ = self.tx.send(Note::Status(status));
    }

    fn frame(&self, frame: &ServerFrame, replayed: bool) {
        let _ = self.tx.send(Note::Frame(Box::new(frame.clone()), replayed));
    }
}

struct Watcher {
    rx: mpsc::UnboundedReceiver<Note>,
    seen: Vec<Note>,
}

impl Watcher {
    /// Pull notes until one matches, keeping everything seen on the way. Panics
    /// on timeout, which is how "the client never got there" shows up.
    async fn until(&mut self, what: &str, matches: impl Fn(&Note) -> bool) -> Note {
        loop {
            let note = timeout(PATIENCE, self.rx.recv())
                .await
                .unwrap_or_else(|_| panic!("timed out waiting for {what}; saw {:?}", self.seen))
                .expect("the client is still running");
            self.seen.push(note.clone());
            if matches(&note) {
                return note;
            }
        }
    }

    async fn until_status(&mut self, what: &str, matches: impl Fn(&Status) -> bool) -> Status {
        let note = self
            .until(what, |note| match note {
                Note::Status(status) => matches(status),
                Note::Frame(_, _) => false,
            })
            .await;
        match note {
            Note::Status(status) => status,
            Note::Frame(_, _) => unreachable!("matched on a status"),
        }
    }

    async fn until_ready(&mut self) -> u64 {
        match self
            .until_status("ready", |status| matches!(status, Status::Ready { .. }))
            .await
        {
            Status::Ready { latency_ms } => latency_ms,
            other => unreachable!("matched on ready, got {other:?}"),
        }
    }

    /// The statuses seen so far, in order.
    fn statuses(&self) -> Vec<Status> {
        self.seen
            .iter()
            .filter_map(|note| match note {
                Note::Status(status) => Some(status.clone()),
                Note::Frame(_, _) => None,
            })
            .collect()
    }

    /// Sequence numbers of every frame handed to the frontend, in order.
    fn sequence(&self) -> Vec<u64> {
        self.seen
            .iter()
            .filter_map(|note| match note {
                Note::Frame(frame, _) => frame.s,
                Note::Status(_) => None,
            })
            .collect()
    }
}

/// Start a client against `server`, with a token that is nowhere near expiry.
fn start(server: &FakeServer, token: &str) -> (gateway::Handle, Watcher) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (handle, task) = gateway::client(
        &server.base_url(),
        Token {
            value: token.to_string(),
            expires_at_ms: now_ms() + 15 * 60 * 1000,
        },
        Recorder { tx },
    )
    .expect("a dialable address");
    tokio::spawn(task);
    (
        handle,
        Watcher {
            rx,
            seen: Vec::new(),
        },
    )
}

fn now_ms() -> i64 {
    i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("a clock set after 1970")
            .as_millis(),
    )
    .expect("a date before the year 292 million")
}

/// Does the list of statuses contain these, in this order, ignoring anything in
/// between? Latency numbers move, so `Ready` is matched by shape.
fn contains_in_order(seen: &[Status], wanted: &[Status]) -> bool {
    let mut wanted = wanted.iter();
    let mut next = wanted.next();
    for status in seen {
        let Some(target) = next else { break };
        let hit = match (status, target) {
            (Status::Ready { .. }, Status::Ready { .. })
            | (Status::Waiting { .. }, Status::Waiting { .. }) => true,
            (a, b) => a == b,
        };
        if hit {
            next = wanted.next();
        }
    }
    next.is_none()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The whole handshake, and the status text the status bar is built from
/// (SPEC §5.6: `connecting… tls ok… identify… ready (28ms)`).
#[tokio::test]
async fn handshake_walks_the_protocol_states() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    assert_eq!(peer.path, "/api/v1/gateway", "PROTOCOL §8 gateway path");
    peer.hello(30_000).await;

    let identify = peer.recv().await;
    assert_eq!(identify["op"], "identify");
    assert_eq!(identify["d"]["token"], "access-token");
    assert!(
        identify["d"]["client"]
            .as_str()
            .is_some_and(|client| client.starts_with("linger-desktop/")),
        "identify names the client, got {identify}"
    );

    peer.ready("session-1").await;
    watch.until_ready().await;

    assert!(
        contains_in_order(
            &watch.statuses(),
            &[
                Status::Connecting,
                // Plain ws on loopback, so not "tls ok" — the status bar does
                // not get to claim a TLS handshake that never happened.
                Status::Connected { tls: false },
                Status::Identifying,
                Status::Ready { latency_ms: 0 },
            ]
        ),
        "status did not follow the protocol, saw {:?}",
        watch.statuses()
    );

    // `ready` is a sequenced frame, so the frontend gets it: it carries the
    // roster and room list.
    assert_eq!(watch.sequence(), vec![0]);
    handle.shutdown();
}

/// The milestone check, from the client's side: force a disconnect mid-stream
/// while frames keep coming, and assert the frontend sees every sequence number
/// exactly once, with nothing missing and nothing repeated.
#[tokio::test]
async fn resume_replays_with_no_gaps_and_no_duplicates() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;

    for seq in 1..=3 {
        peer.send(&typing(seq)).await;
    }
    watch
        .until(
            "frame 3",
            |note| matches!(note, Note::Frame(frame, _) if frame.s == Some(3)),
        )
        .await;

    // Rip the socket away mid-stream.
    peer.kill();

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    let resume = peer.recv().await;
    assert_eq!(
        resume["op"], "resume",
        "a live session must resume, not re-identify"
    );
    assert_eq!(resume["d"]["session_id"], "session-1");
    assert_eq!(
        resume["d"]["s"], 3,
        "resume asks from the last frame it actually delivered"
    );
    assert_eq!(resume["d"]["token"], "access-token");

    peer.send(&json!({"op":"resumed","d":{"replayed":2}})).await;
    for seq in 4..=5 {
        peer.send(&typing(seq)).await;
    }
    watch
        .until(
            "frame 5",
            |note| matches!(note, Note::Frame(frame, _) if frame.s == Some(5)),
        )
        .await;

    assert_eq!(
        watch.sequence(),
        vec![0, 1, 2, 3, 4, 5],
        "every frame exactly once, in order"
    );
    peer.send(&typing(6)).await;
    watch
        .until(
            "live after replay",
            |note| matches!(note, Note::Frame(frame, false) if frame.s == Some(6)),
        )
        .await;
    let replayed: Vec<u64> = watch
        .seen
        .iter()
        .filter_map(|note| match note {
            Note::Frame(frame, true) => frame.s,
            _ => None,
        })
        .collect();
    assert_eq!(replayed, vec![4, 5]);
    handle.shutdown();
}

/// A replay that arrives twice must not reach the frontend twice. The server
/// promises it will not do this; the client does not take its word for it.
#[tokio::test]
async fn a_replayed_frame_is_not_delivered_twice() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    for seq in 1..=2 {
        peer.send(&typing(seq)).await;
    }
    // The same two frames again, then a new one.
    for seq in 1..=3 {
        peer.send(&typing(seq)).await;
    }
    watch
        .until(
            "frame 3",
            |note| matches!(note, Note::Frame(frame, _) if frame.s == Some(3)),
        )
        .await;

    assert_eq!(watch.sequence(), vec![0, 1, 2, 3]);
    handle.shutdown();
}

#[tokio::test]
async fn unknown_replay_ops_do_not_make_later_live_frames_look_replayed() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");
    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    peer.recv().await;
    peer.ready("session-1").await;
    watch.until_ready().await;
    peer.kill();
    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "resume");
    peer.send(&json!({"op":"resumed","d":{"replayed":2}})).await;
    peer.send(&json!({"op":"future.op","d":{},"s":1})).await;
    peer.send(&typing(2)).await;
    peer.send(&typing(3)).await;
    watch
        .until(
            "live frame",
            |note| matches!(note, Note::Frame(frame, false) if frame.s == Some(3)),
        )
        .await;
    assert!(watch
        .seen
        .iter()
        .any(|note| matches!(note, Note::Frame(frame, true) if frame.s == Some(2))));
    assert_eq!(watch.sequence(), vec![0, 2, 3]);
    handle.shutdown();
}

/// A hole in the stream means the frontend's copy of the world is wrong in a
/// way it cannot detect. The client starts the session over rather than carry
/// on with missing events.
#[tokio::test]
async fn a_sequence_gap_starts_the_session_over() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    watch.until_ready().await;
    peer.send(&typing(1)).await;
    watch
        .until(
            "frame 1",
            |note| matches!(note, Note::Frame(frame, _) if frame.s == Some(1)),
        )
        .await;
    // 2 never arrives.
    peer.send(&typing(3)).await;

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    let opener = peer.recv().await;
    assert_eq!(
        opener["op"], "identify",
        "a gap means the session is not trustworthy, so resume is not enough"
    );
    peer.ready("session-2").await;
    watch.until_ready().await;

    assert_eq!(
        watch.sequence(),
        vec![0, 1, 0],
        "the frame after the gap is not delivered; the new session starts at 0"
    );
    handle.shutdown();
}

/// The task's acceptance criterion: the server goes away and comes back with no
/// memory of us, and the client gets itself back on with no user action.
#[tokio::test]
async fn an_expired_session_re_identifies_by_itself() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    watch.until_ready().await;
    peer.kill();

    // The restarted server has never heard of this session.
    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "resume");
    peer.send(&json!({"op":"invalid_session","d":{"reason":"expired"}}))
        .await;
    peer.kill();

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    let opener = peer.recv().await;
    assert_eq!(opener["op"], "identify");
    peer.ready("session-2").await;
    watch.until_ready().await;

    assert!(
        contains_in_order(
            &watch.statuses(),
            &[
                Status::Ready { latency_ms: 0 },
                Status::Resuming,
                Status::Identifying,
                Status::Ready { latency_ms: 0 },
            ]
        ),
        "saw {:?}",
        watch.statuses()
    );
    handle.shutdown();
}

/// A refused token is the frontend's problem to solve, because it owns the
/// refresh token. The client asks, waits, and uses what it is given.
#[tokio::test]
async fn a_refused_token_is_asked_for_again() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "stale-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["d"]["token"], "stale-token");
    peer.send(&json!({"op":"invalid_session","d":{"reason":"unauthenticated"}}))
        .await;
    peer.kill();

    watch
        .until_status("needs_token", |status| *status == Status::NeedsToken)
        .await;
    assert!(handle.set_token(Token {
        value: "fresh-token".into(),
        expires_at_ms: now_ms() + 15 * 60 * 1000,
    }));

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    let identify = peer.recv().await;
    assert_eq!(identify["op"], "identify");
    assert_eq!(identify["d"]["token"], "fresh-token");
    peer.ready("session-2").await;
    watch.until_ready().await;
    handle.shutdown();
}

/// Two unanswered heartbeats mean the socket is dead even though nothing said
/// so (PROTOCOL §8). A short interval from `hello` keeps this test quick.
#[tokio::test]
async fn two_unanswered_heartbeats_drop_the_connection() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(150).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    watch.until_ready().await;

    // Heartbeats arrive and are pointedly ignored.
    let first = peer.recv().await;
    assert_eq!(first["op"], "heartbeat");
    assert_eq!(
        first["d"]["s"], 0,
        "the heartbeat carries the last sequence"
    );
    assert_eq!(peer.recv().await["op"], "heartbeat");

    // With no acks, the client gives up on this socket and comes back.
    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "resume");
    peer.send(&json!({"op":"resumed","d":{"replayed":0}})).await;
    watch.until_ready().await;
    handle.shutdown();
}

/// Heartbeats that *are* answered keep the connection, and the round trip is
/// what the status bar reports as latency.
#[tokio::test]
async fn an_acked_heartbeat_keeps_the_connection() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(150).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    watch.until_ready().await;

    for _ in 0..4 {
        assert_eq!(peer.recv().await["op"], "heartbeat");
        peer.send(&json!({"op":"heartbeat_ack"})).await;
        watch.until_ready().await;
    }

    // Still the same socket: a frame sent now still lands.
    peer.send(&typing(1)).await;
    watch
        .until(
            "frame 1",
            |note| matches!(note, Note::Frame(frame, _) if frame.s == Some(1)),
        )
        .await;
    handle.shutdown();
}

/// Unknown ops are ignored, not fatal (PROTOCOL §9) — but their sequence number
/// still counts, or the next real frame would look like a gap.
#[tokio::test]
async fn an_unknown_op_is_ignored_without_losing_the_count() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    peer.send(&json!({"op":"something.new","d":{"whatever":true},"s":1}))
        .await;
    peer.send(&typing(2)).await;

    watch
        .until(
            "frame 2",
            |note| matches!(note, Note::Frame(frame, _) if frame.s == Some(2)),
        )
        .await;
    assert_eq!(
        watch.sequence(),
        vec![0, 2],
        "the unknown frame is skipped, and 2 is not treated as a gap"
    );
    handle.shutdown();
}

/// Nothing to connect to: the client keeps trying, says so, and stops when told.
#[tokio::test]
async fn an_unreachable_server_waits_and_retries() {
    // Bind, note the port, then let it go — nothing is listening there now.
    let addr = {
        let server = FakeServer::bind().await;
        server.addr
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let (handle, task) = gateway::client(
        &format!("http://{addr}"),
        Token {
            value: "access-token".into(),
            expires_at_ms: now_ms() + 15 * 60 * 1000,
        },
        Recorder { tx },
    )
    .expect("a dialable address");
    tokio::spawn(task);
    let mut watch = Watcher {
        rx,
        seen: Vec::new(),
    };

    let waiting = watch
        .until_status("waiting", |status| matches!(status, Status::Waiting { .. }))
        .await;
    match waiting {
        Status::Waiting { retry_in_ms, .. } => {
            assert!(retry_in_ms > 0, "a wait with no delay is not a wait");
        }
        other => unreachable!("matched on waiting, got {other:?}"),
    }

    handle.shutdown();
    watch
        .until_status("offline", |status| *status == Status::Offline)
        .await;
}

/// Dropping the handle is the same instruction as a shutdown: no orphan
/// connection outlives the frontend that asked for it.
#[tokio::test]
async fn dropping_the_handle_closes_the_connection() {
    let server = FakeServer::bind().await;
    let (handle, mut watch) = start(&server, "access-token");

    let mut peer = server.accept().await;
    peer.hello(30_000).await;
    assert_eq!(peer.recv().await["op"], "identify");
    peer.ready("session-1").await;
    watch.until_ready().await;

    drop(handle);
    watch
        .until_status("offline", |status| *status == Status::Offline)
        .await;
}
