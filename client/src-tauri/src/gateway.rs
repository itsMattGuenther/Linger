//! The gateway client (PROTOCOL §8): one WebSocket to one server, owned by this
//! process rather than by the WebView.
//!
//! ARCHITECTURE §1 puts it here on purpose. The parts of a realtime client that
//! are easy to get quietly wrong — sequence accounting, resume, backoff — end up
//! somewhere they can be driven by a test over a real socket, and the connection
//! survives anything the frontend does to itself.
//!
//! ```text
//!   connect ──→ hello ──→ identify ──→ ready ───┐
//!      ↑                  └ resume ──→ resumed ─┤
//!      └──────── wait ←──── the socket died ←───┘
//! ```
//!
//! Two rules keep the rest small:
//!
//! * **Frames with a sequence number are the frontend's business; frames
//!   without one are this file's.** `hello`, `heartbeat_ack`, `resumed` and
//!   `invalid_session` are connection plumbing and never leave Rust.
//! * **The frontend owns tokens.** When the server refuses one, this asks for
//!   another instead of reaching for the refresh token itself: refresh tokens
//!   rotate, and two parties spending one revokes the whole family
//!   (PROTOCOL §2).

use std::future::Future;
use std::sync::Once;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use linger_core::gateway::{ClientFrame, ServerEvent, ServerFrame};
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout, Instant};
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// Tauri event carrying a [`Status`] to the frontend.
pub const STATUS_EVENT: &str = "gateway:status";
/// Tauri event carrying one sequenced [`ServerFrame`] to the frontend.
pub const FRAME_EVENT: &str = "gateway:frame";

/// What we tell the server we are, in `identify` (PROTOCOL §8).
const CLIENT_NAME: &str = concat!("linger-desktop/", env!("CARGO_PKG_VERSION"));

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const BACKOFF_BASE: Duration = Duration::from_millis(500);
const BACKOFF_CAP: Duration = Duration::from_secs(30);
/// How long to wait for the frontend to hand over a token before asking again.
const TOKEN_WAIT: Duration = Duration::from_secs(20);
/// Unacknowledged heartbeats before the socket counts as dead (PROTOCOL §8).
const MISSED_ACKS: u32 = 2;
/// Bounds on the interval a server may ask us to heartbeat at, so a nonsense
/// `hello` can neither spin the CPU nor silently disable liveness checks.
const MIN_HEARTBEAT: Duration = Duration::from_millis(100);
const MAX_HEARTBEAT: Duration = Duration::from_secs(300);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Writer = SplitSink<Socket, Message>;
type Reader = SplitStream<Socket>;

// ---------------------------------------------------------------------------
// What the outside world sees
// ---------------------------------------------------------------------------

/// The connection state, as the status bar shows it (SPEC §5.6: protocol text,
/// not spinners).
///
/// Mirrored by hand in `client/src/lib/gateway.ts` — this never crosses the
/// wire, so AGENTS rule 7 does not apply, and a test below pins the tag
/// spellings so the two halves cannot drift in silence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Status {
    /// Not connected and not trying: no server yet, or told to stop.
    Offline,
    Connecting,
    /// The socket is up. `tls` is false for a plain `ws://` server on your own
    /// machine, where claiming "tls ok" would be a lie.
    Connected {
        tls: bool,
    },
    Identifying,
    Resuming,
    Ready {
        latency_ms: u64,
    },
    /// Nothing to do but wait; `retry_in_ms` counts from when this was emitted.
    /// `reason` is short lowercase protocol text, not a sentence.
    Waiting {
        retry_in_ms: u64,
        reason: String,
    },
    /// The server refused our access token and the frontend has to supply
    /// another one. Nothing happens until it does.
    NeedsToken,
}

/// Where status changes and frames go. The Tauri shell implements this by
/// emitting events; tests implement it by collecting them, which is the reason
/// this file knows nothing about Tauri.
pub trait Events: Send + Sync + 'static {
    fn status(&self, status: Status);
    /// A sequenced frame. It has already been parsed here, so the frontend's
    /// `ServerFrame` annotation is true rather than hopeful; unknown ops never
    /// get this far.
    fn frame(&self, frame: &ServerFrame, replayed: bool);
}

/// An access token and when it dies. The frontend computes `expires_at_ms` from
/// the `expires_in` the server sent with it.
#[derive(Debug, Clone)]
pub struct Token {
    pub value: String,
    /// Unix milliseconds. Non-positive means "unknown", which we treat as
    /// usable — the server is the real authority either way.
    pub expires_at_ms: i64,
}

impl Token {
    /// A token this close to expiry would very likely be refused by the time
    /// the handshake landed, so we ask for a fresh one instead of spending a
    /// round trip finding out.
    const GRACE_MS: i64 = 30_000;

    fn usable(&self) -> bool {
        self.expires_at_ms <= 0 || self.expires_at_ms - Self::GRACE_MS > now_ms()
    }
}

/// The frontend's grip on a running connection. Every method is non-blocking:
/// a full queue or a finished client answers `false` rather than waiting.
pub struct Handle {
    cmd: mpsc::Sender<Cmd>,
}

impl Handle {
    /// Hand over a fresh access token, after a sign-in or a refresh.
    pub fn set_token(&self, token: Token) -> bool {
        self.cmd.try_send(Cmd::Token(token)).is_ok()
    }

    /// Send one client frame. Dropped if we are not connected — the frontend
    /// re-states what matters after `ready`, so queueing stale presence would
    /// be worse than losing it.
    pub fn send(&self, frame: ClientFrame) -> bool {
        self.cmd.try_send(Cmd::Send(frame)).is_ok()
    }

    /// Close the connection for good.
    pub fn shutdown(&self) {
        let _ = self.cmd.try_send(Cmd::Shutdown);
    }

    /// Try again now if the connection is waiting between tries. The phone
    /// sends this when the app comes back to the screen: Android blocks an
    /// app's network soon after it leaves, the tries into that block back
    /// off towards half a minute, and somebody looking at the app shouldn't
    /// wait that out. A live connection, or one waiting for a token, ignores it.
    pub fn retry(&self) {
        let _ = self.cmd.try_send(Cmd::Retry);
    }
}

enum Cmd {
    Token(Token),
    Send(ClientFrame),
    Retry,
    Shutdown,
}

/// Build a client for `base_url` (an origin like `https://linger.example`).
///
/// Returns the handle and the task that does the work; the caller spawns it,
/// which is what keeps this file free of any particular runtime's `spawn`.
/// `None` means the address was not something we can dial.
pub fn client<E: Events>(
    base_url: &str,
    token: Token,
    events: E,
) -> Option<(Handle, impl Future<Output = ()> + Send)> {
    let (url, tls) = gateway_url(base_url)?;
    install_crypto_provider();
    let (cmd_tx, cmd_rx) = mpsc::channel(32);
    let runner = Runner {
        url,
        tls,
        events,
        cmd: cmd_rx,
        token: Some(token),
        session: None,
        attempt: 0,
    };
    Some((Handle { cmd: cmd_tx }, runner.run()))
}

/// `https://host` → `wss://host/api/v1/gateway`, plus whether it is encrypted.
///
/// Anything that is not http(s) or ws(s) is refused rather than guessed at.
fn gateway_url(base_url: &str) -> Option<(String, bool)> {
    let trimmed = base_url.trim().trim_end_matches('/');
    // What someone might paste, what the socket needs, and whether it is encrypted.
    const SCHEMES: [(&str, &str, bool); 4] = [
        ("https://", "wss", true),
        ("http://", "ws", false),
        ("wss://", "wss", true),
        ("ws://", "ws", false),
    ];
    let (scheme, rest, tls) = SCHEMES.iter().find_map(|(prefix, scheme, tls)| {
        trimmed
            .strip_prefix(prefix)
            .map(|rest| (*scheme, rest, *tls))
    })?;
    if rest.is_empty() {
        return None;
    }
    Some((format!("{scheme}://{rest}/api/v1/gateway"), tls))
}

/// rustls needs one crypto provider chosen for the process before any TLS
/// config is built, and building one without it panics. We pick *ring*: it
/// compiles with no cmake or nasm on the box, which keeps `pnpm tauri build`
/// working on a plain developer machine.
fn install_crypto_provider() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // An error here means something else installed one first, which is
        // exactly as good for us.
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

struct Runner<E: Events> {
    url: String,
    tls: bool,
    events: E,
    cmd: mpsc::Receiver<Cmd>,
    token: Option<Token>,
    session: Option<Session>,
    /// Consecutive failed attempts, reset by every successful handshake. It is
    /// the only input to the reconnect delay.
    attempt: u32,
}

/// A server session we may still be able to resume into.
struct Session {
    id: String,
    /// Highest sequence number handed to the frontend; `None` until `ready`.
    last_seq: Option<u64>,
    /// Last sequence in the current replay; unknown ops still advance this boundary.
    replay_through: Option<u64>,
}

/// How one connection ended.
enum Outcome {
    /// The socket died. Reconnect and resume if we still have a session.
    Dropped(String),
    /// The session is gone server-side. Reconnect and identify fresh.
    Restart {
        immediate: bool,
        reason: String,
    },
    /// The token was refused. Get another, then identify fresh.
    Reauth,
    Shutdown,
}

/// Result of waiting: what interrupted us, if anything.
#[derive(PartialEq, Eq)]
enum Wait {
    Elapsed,
    Token,
    Shutdown,
}

/// What one incoming frame did.
enum Step {
    /// Nothing that changes the shape of the connection.
    Idle,
    /// The handshake landed; the attempt counter can go back to zero.
    Ready,
    Out(Outcome),
}

impl<E: Events> Runner<E> {
    async fn run(mut self) {
        'reconnect: loop {
            // A usable token first — there is nothing to identify with without
            // one, and asking early beats burning a round trip to be told.
            while !self.token.as_ref().is_some_and(Token::usable) {
                self.token = None;
                self.events.status(Status::NeedsToken);
                if self.wait(TOKEN_WAIT, true).await == Wait::Shutdown {
                    break 'reconnect;
                }
            }
            let Some(token) = self.token.clone() else {
                continue;
            };

            self.events.status(Status::Connecting);
            let dial = timeout(
                CONNECT_TIMEOUT,
                tokio_tungstenite::connect_async(self.url.as_str()),
            )
            .await;
            let socket = match dial {
                Ok(Ok((socket, _response))) => socket,
                Ok(Err(err)) => {
                    if self.pause(short_reason(&err)).await == Wait::Shutdown {
                        break;
                    }
                    continue;
                }
                Err(_) => {
                    if self.pause("no answer".into()).await == Wait::Shutdown {
                        break;
                    }
                    continue;
                }
            };
            self.events.status(Status::Connected { tls: self.tls });

            match self.session(socket, &token).await {
                Outcome::Shutdown => break,
                Outcome::Dropped(reason) => {
                    if self.pause(reason).await == Wait::Shutdown {
                        break;
                    }
                }
                Outcome::Restart { immediate, reason } => {
                    self.session = None;
                    // The server just answered us, so a fresh identify is
                    // different work rather than a retry of the same thing:
                    // there is nothing to wait for.
                    if !immediate && self.pause(reason).await == Wait::Shutdown {
                        break;
                    }
                }
                Outcome::Reauth => {
                    self.token = None;
                    if self.pause("token refused".into()).await == Wait::Shutdown {
                        break;
                    }
                }
            }
        }
        self.events.status(Status::Offline);
    }

    /// Run one connection until it ends. Everything below the handshake is
    /// three things happening at once: reading frames, keeping the heartbeat,
    /// and serving the frontend's commands.
    async fn session(&mut self, socket: Socket, token: &Token) -> Outcome {
        let (mut tx, mut rx) = socket.split();

        // `hello` carries the heartbeat interval we are expected to keep to.
        let interval = match timeout(HANDSHAKE_TIMEOUT, next_frame(&mut rx)).await {
            Ok(Some(value)) => match hello_interval(&value) {
                Some(interval) => interval,
                None => return Outcome::Dropped("no hello".into()),
            },
            Ok(None) => return Outcome::Dropped("closed".into()),
            Err(_) => return Outcome::Dropped("silent".into()),
        };

        let resuming = self.session.is_some();
        let opener = match &self.session {
            Some(session) => {
                self.events.status(Status::Resuming);
                ClientFrame::Resume {
                    session_id: session.id.clone(),
                    token: token.value.clone(),
                    s: session.last_seq.unwrap_or(0),
                }
            }
            None => {
                self.events.status(Status::Identifying);
                ClientFrame::Identify {
                    token: token.value.clone(),
                    client: CLIENT_NAME.to_string(),
                }
            }
        };
        let opened_at = Instant::now();
        if !send_frame(&mut tx, &opener).await {
            return Outcome::Dropped("write failed".into());
        }

        // Borrow the fields the loop touches separately: `select!` keeps every
        // branch's future alive while a handler runs, so `&mut self` in two
        // places at once would not compile.
        let Self {
            events,
            cmd,
            session,
            token: stored,
            attempt,
            ..
        } = self;
        let mut beat = Beat::new(interval);

        loop {
            tokio::select! {
                incoming = next_frame(&mut rx) => {
                    let Some(value) = incoming else {
                        return Outcome::Dropped("connection lost".into());
                    };
                    match apply(events, session, &value, &mut beat, opened_at, resuming) {
                        Step::Idle => {}
                        Step::Ready => *attempt = 0,
                        Step::Out(outcome) => return outcome,
                    }
                }
                () = tokio::time::sleep_until(beat.next) => {
                    if beat.outstanding >= MISSED_ACKS {
                        return Outcome::Dropped("no heartbeat".into());
                    }
                    let last = session.as_ref().and_then(|open| open.last_seq);
                    if !send_frame(&mut tx, &ClientFrame::Heartbeat { s: last }).await {
                        return Outcome::Dropped("write failed".into());
                    }
                    beat.sent();
                }
                command = cmd.recv() => match command {
                    // A closed channel means the handle was dropped, which is
                    // the same instruction as an explicit shutdown.
                    None | Some(Cmd::Shutdown) => {
                        let _ = tx.send(Message::Close(None)).await;
                        return Outcome::Shutdown;
                    }
                    Some(Cmd::Token(fresh)) => *stored = Some(fresh),
                    Some(Cmd::Send(frame)) => {
                        if !send_frame(&mut tx, &frame).await {
                            return Outcome::Dropped("write failed".into());
                        }
                    }
                    // Already connected: nothing to try again.
                    Some(Cmd::Retry) => {}
                },
            }
        }
    }

    /// Wait out the reconnect delay for this attempt, announcing it first.
    async fn pause(&mut self, reason: String) -> Wait {
        let delay = backoff_delay(self.attempt, rand01());
        self.attempt = self.attempt.saturating_add(1);
        if delay.is_zero() {
            return Wait::Elapsed;
        }
        self.events.status(Status::Waiting {
            retry_in_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
            reason,
        });
        self.wait(delay, false).await
    }

    /// Sleep, but keep serving commands. `stop_on_token` is for the case where
    /// a new token is the very thing being waited for.
    async fn wait(&mut self, duration: Duration, stop_on_token: bool) -> Wait {
        let deadline = Instant::now() + duration;
        loop {
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return Wait::Elapsed,
                command = self.cmd.recv() => match command {
                    None | Some(Cmd::Shutdown) => return Wait::Shutdown,
                    Some(Cmd::Token(token)) => {
                        self.token = Some(token);
                        if stop_on_token {
                            return Wait::Token;
                        }
                    }
                    // Nothing to send it over. See `Handle::send`.
                    Some(Cmd::Send(_)) => {}
                    // Between tries: go now, and start the backoff over, so a
                    // try that fails too waits half a second, not half a
                    // minute. Waiting for a token, there's nothing to try with.
                    Some(Cmd::Retry) => {
                        if !stop_on_token {
                            self.attempt = 0;
                            return Wait::Elapsed;
                        }
                    }
                },
            }
        }
    }
}

/// Fold one incoming frame into the session.
///
/// This is where resume either works or quietly corrupts the frontend's copy of
/// the world, so both failure directions are checked rather than trusted.
fn apply<E: Events>(
    events: &E,
    session: &mut Option<Session>,
    value: &Value,
    beat: &mut Beat,
    opened_at: Instant,
    resuming: bool,
) -> Step {
    let seq = value.get("s").and_then(Value::as_u64);
    // Unknown ops are ignored rather than fatal (PROTOCOL §9) — but their
    // sequence number is not ignored, because skipping it would look exactly
    // like a gap when the next frame arrives.
    let typed = serde_json::from_value::<ServerFrame>(value.clone()).ok();

    match typed.as_ref().map(|frame| &frame.event) {
        Some(ServerEvent::HeartbeatAck) => {
            if let Some(latency_ms) = beat.acked() {
                events.status(Status::Ready { latency_ms });
            }
            return Step::Idle;
        }
        Some(ServerEvent::InvalidSession { reason }) => {
            return Step::Out(if resuming {
                // The session aged out of the server's 120s window, or the
                // server restarted. Identifying fresh is the documented answer
                // and we already know the server is there.
                Outcome::Restart {
                    immediate: true,
                    reason: reason.clone(),
                }
            } else if reason == "unauthenticated" {
                Outcome::Reauth
            } else {
                Outcome::Restart {
                    immediate: false,
                    reason: reason.clone(),
                }
            });
        }
        Some(ServerEvent::Resumed { replayed }) => {
            if let Some(open) = session.as_mut() {
                open.replay_through = open.last_seq.map(|last| last.saturating_add(*replayed));
            }
            events.status(Status::Ready {
                latency_ms: since_ms(opened_at),
            });
            return Step::Ready;
        }
        // A second hello, or anything else without a sequence number, is not
        // ours to act on.
        Some(ServerEvent::Hello { .. }) => return Step::Idle,
        _ => {}
    }

    let Some(seq) = seq else {
        return Step::Idle;
    };

    if let Some(ServerEvent::Ready(data)) = typed.as_ref().map(|frame| &frame.event) {
        // A fresh session starts the numbering over, so the old high-water mark
        // goes with it.
        *session = Some(Session {
            id: data.session_id.clone(),
            last_seq: Some(seq),
            replay_through: None,
        });
        // Payload first, then the announcement: "ready" should mean the
        // frontend already has the roster and rooms, not that they are coming.
        if let Some(frame) = &typed {
            events.frame(frame, false);
        }
        events.status(Status::Ready {
            latency_ms: since_ms(opened_at),
        });
        return Step::Ready;
    }

    // Sequenced traffic before `ready` has nowhere to be counted; drop it.
    let Some(open) = session.as_mut() else {
        return Step::Idle;
    };
    match open.last_seq {
        // The server promises no duplicates on resume. Believing that blindly
        // is how one off-by-one becomes a message shown twice.
        Some(previous) if seq <= previous => return Step::Idle,
        // A hole means the replay missed something and the frontend's copy is
        // now wrong in a way it cannot see. Start the session over instead of
        // papering over it — the same trade the server makes when its bus lags.
        Some(previous) if seq > previous + 1 => {
            return Step::Out(Outcome::Restart {
                immediate: true,
                reason: "sequence gap".into(),
            })
        }
        _ => {}
    }
    open.last_seq = Some(seq);
    if let Some(frame) = &typed {
        events.frame(
            frame,
            open.replay_through.is_some_and(|through| seq <= through),
        );
    }
    Step::Idle
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/// Heartbeat bookkeeping: when the next one is due, how many are unanswered,
/// and how long the last one took.
struct Beat {
    interval: Duration,
    next: Instant,
    outstanding: u32,
    sent_at: Option<Instant>,
}

impl Beat {
    fn new(interval: Duration) -> Self {
        Self {
            interval,
            next: Instant::now() + jittered(interval),
            outstanding: 0,
            sent_at: None,
        }
    }

    fn sent(&mut self) {
        let now = Instant::now();
        self.outstanding += 1;
        self.sent_at = Some(now);
        self.next = now + jittered(self.interval);
    }

    /// Returns the round trip in milliseconds, when we know which beat it was.
    fn acked(&mut self) -> Option<u64> {
        self.outstanding = 0;
        self.sent_at.take().map(since_ms)
    }
}

/// ±10% so a room full of clients does not heartbeat in lockstep.
fn jittered(interval: Duration) -> Duration {
    interval.mul_f64(0.9 + 0.2 * rand01())
}

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/// The reconnect delay for a zero-based attempt count.
///
/// The first try after a healthy connection is immediate: a dropped socket is
/// usually a blip, and the server only holds a resumable session for 120
/// seconds. After that it doubles from 500ms to a 30s ceiling, with half the
/// delay drawn at random so a server coming back up does not get every client
/// in the same millisecond.
fn backoff_delay(attempt: u32, fraction: f64) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    let doublings = (attempt - 1).min(16);
    let base = BACKOFF_BASE
        .checked_mul(1u32 << doublings)
        .unwrap_or(BACKOFF_CAP)
        .min(BACKOFF_CAP);
    base.mul_f64(0.5 + 0.5 * fraction.clamp(0.0, 1.0))
}

fn rand01() -> f64 {
    rand::random::<f64>()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

fn since_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// Short lowercase protocol text for the status bar. The underlying errors are
/// long and full of internals, and the status bar is 11px of mono.
fn short_reason(err: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match err {
        Error::Io(_) => "unreachable".into(),
        Error::Tls(_) => "tls failed".into(),
        Error::Http(response) => format!("http {}", response.status().as_u16()),
        Error::Url(_) => "bad address".into(),
        _ => "handshake failed".into(),
    }
}

/// Read the next protocol frame. `None` means the socket is finished.
///
/// Cancel-safe, which matters because it is one arm of a `select!`: everything
/// partially read stays inside the stream, never in this function.
async fn next_frame(rx: &mut Reader) -> Option<Value> {
    loop {
        match rx.next().await? {
            Ok(Message::Text(text)) => match serde_json::from_str::<Value>(text.as_str()) {
                Ok(value) => return Some(value),
                // Malformed JSON is ignored, same as an unknown op.
                Err(_) => continue,
            },
            Ok(Message::Close(_)) | Err(_) => return None,
            // Ping and pong are answered inside tungstenite; binary is not ours.
            Ok(_) => continue,
        }
    }
}

async fn send_frame(tx: &mut Writer, frame: &ClientFrame) -> bool {
    match serde_json::to_string(frame) {
        Ok(json) => tx.send(Message::Text(json.into())).await.is_ok(),
        Err(_) => false,
    }
}

/// The heartbeat interval from a `hello` frame, clamped to something sane.
fn hello_interval(value: &Value) -> Option<Duration> {
    let frame = serde_json::from_value::<ServerFrame>(value.clone()).ok()?;
    let ServerEvent::Hello {
        heartbeat_interval_ms,
    } = frame.event
    else {
        return None;
    };
    Some(Duration::from_millis(heartbeat_interval_ms).clamp(MIN_HEARTBEAT, MAX_HEARTBEAT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_url_maps_scheme_and_path() {
        assert_eq!(
            gateway_url("https://linger.example"),
            Some(("wss://linger.example/api/v1/gateway".into(), true))
        );
        assert_eq!(
            gateway_url("http://localhost:8080/"),
            Some(("ws://localhost:8080/api/v1/gateway".into(), false))
        );
        assert_eq!(gateway_url("linger.example"), None);
        assert_eq!(gateway_url("ftp://linger.example"), None);
        assert_eq!(gateway_url("https://"), None);
    }

    #[test]
    fn backoff_is_immediate_then_doubles_to_a_cap() {
        assert_eq!(backoff_delay(0, 0.5), Duration::ZERO);
        // Half the delay is fixed and half is random, so every draw sits in
        // [base/2, base].
        for attempt in 1..40u32 {
            let low = backoff_delay(attempt, 0.0);
            let high = backoff_delay(attempt, 1.0);
            assert!(low <= high);
            assert!(high <= BACKOFF_CAP, "attempt {attempt} exceeded the cap");
            assert!(low >= high / 2);
        }
        assert_eq!(backoff_delay(1, 1.0), BACKOFF_BASE);
        assert_eq!(backoff_delay(2, 1.0), BACKOFF_BASE * 2);
        assert_eq!(backoff_delay(30, 1.0), BACKOFF_CAP);
    }

    #[test]
    fn a_token_near_expiry_is_not_usable() {
        assert!(Token {
            value: "t".into(),
            expires_at_ms: now_ms() + 600_000,
        }
        .usable());
        assert!(!Token {
            value: "t".into(),
            expires_at_ms: now_ms() + 5_000,
        }
        .usable());
        // Unknown expiry: use it and let the server decide.
        assert!(Token {
            value: "t".into(),
            expires_at_ms: 0,
        }
        .usable());
    }

    /// The frontend switches on `kind`, so these spellings are the contract
    /// with `client/src/lib/gateway.ts`.
    #[test]
    fn statuses_are_tagged_in_snake_case() {
        let cases = [
            (Status::Offline, r#"{"kind":"offline"}"#),
            (Status::Connecting, r#"{"kind":"connecting"}"#),
            (
                Status::Connected { tls: true },
                r#"{"kind":"connected","tls":true}"#,
            ),
            (Status::Identifying, r#"{"kind":"identifying"}"#),
            (Status::Resuming, r#"{"kind":"resuming"}"#),
            (
                Status::Ready { latency_ms: 28 },
                r#"{"kind":"ready","latency_ms":28}"#,
            ),
            (
                Status::Waiting {
                    retry_in_ms: 500,
                    reason: "unreachable".into(),
                },
                r#"{"kind":"waiting","retry_in_ms":500,"reason":"unreachable"}"#,
            ),
            (Status::NeedsToken, r#"{"kind":"needs_token"}"#),
        ];
        for (status, expected) in cases {
            let json = serde_json::to_string(&status).expect("serialize");
            assert_eq!(json, expected);
        }
    }

    #[test]
    fn hello_interval_is_clamped() {
        let hello = serde_json::json!({"op":"hello","d":{"heartbeat_interval_ms":30000}});
        assert_eq!(hello_interval(&hello), Some(Duration::from_secs(30)));
        let silly = serde_json::json!({"op":"hello","d":{"heartbeat_interval_ms":1}});
        assert_eq!(hello_interval(&silly), Some(MIN_HEARTBEAT));
        let huge = serde_json::json!({"op":"hello","d":{"heartbeat_interval_ms":9_000_000}});
        assert_eq!(hello_interval(&huge), Some(MAX_HEARTBEAT));
        let wrong = serde_json::json!({"op":"heartbeat_ack"});
        assert_eq!(hello_interval(&wrong), None);
    }
}
