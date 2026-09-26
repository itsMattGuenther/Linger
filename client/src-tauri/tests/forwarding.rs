//! Voice through the forwarding server (#197), end to end on this machine: two
//! real engines, the real forwarding server in-process, and a tone that goes
//! into one engine's source and comes out of the other's sink.
//!
//! Like `voice.rs`, it proves the negotiation and the audio path, and nothing
//! about a real network: both ends are on loopback (AGENTS "Where you will be
//! wrong"). Four people on four networks is still the check that counts.

use std::net::SocketAddr;
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use linger_client_lib::voice::audio::{Devices, Discard, Silence, Sink, Tone};
use linger_client_lib::voice::{Engine, Signaller, Watcher};
use linger_core::gateway::{ClientFrame, VoicePeer, VoiceTrack};
use linger_core::{RoomId, UserId};
use linger_sfu::{Offer, Sfu};
use tokio::sync::mpsc;

struct Wire(mpsc::UnboundedSender<ClientFrame>);

impl Signaller for Wire {
    fn send(&self, frame: ClientFrame) {
        let _ = self.0.send(frame);
    }
}

#[derive(Default)]
struct Log(Mutex<Vec<(String, String)>>);

impl Watcher for Log {
    fn peer_state(&self, peer: &str, state: &str) {
        self.0
            .lock()
            .unwrap()
            .push((peer.to_string(), state.to_string()));
    }
}

#[derive(Default)]
struct Recorder(Mutex<Vec<(String, Vec<i16>)>>);

#[async_trait]
impl Sink for Recorder {
    async fn play(&self, peer: &str, samples: &[i16]) {
        self.0
            .lock()
            .unwrap()
            .push((peer.to_string(), samples.to_vec()));
    }
}

/// One engine as the router sees it: its session, the engine, its outbox.
type Routed<'a> = (
    &'a str,
    &'a Arc<Engine<Wire, Log>>,
    &'a mut mpsc::UnboundedReceiver<ClientFrame>,
);

type Rig = (
    Arc<Engine<Wire, Log>>,
    mpsc::UnboundedReceiver<ClientFrame>,
    Arc<Log>,
);

async fn engine(session: &str) -> Rig {
    let (tx, rx) = mpsc::unbounded_channel();
    let log = Arc::new(Log::default());
    let engine = Arc::new(Engine::new(
        Arc::new(Wire(tx)),
        Arc::clone(&log),
        Vec::new(),
    ));
    engine.set_session(session.to_string()).await;
    (engine, rx, log)
}

fn forwarded(ids: &[&str]) -> Vec<VoicePeer> {
    ids.iter()
        .map(|id| VoicePeer {
            session_id: (*id).to_string(),
            user_id: UserId::new(),
            controls: None,
            forwarded: Some(true),
        })
        .collect()
}

/// The test's stand-in for the gateway: joins and answers go to the
/// forwarding server, and its offers come back to their engine.
async fn route(
    sfu: &Sfu,
    offers: &std_mpsc::Receiver<Offer>,
    room: RoomId,
    rigs: &mut [Routed<'_>],
) {
    for (session, _, rx) in rigs.iter_mut() {
        while let Ok(frame) = rx.try_recv() {
            match frame {
                ClientFrame::VoiceJoin { forwarding, .. } => {
                    assert_eq!(
                        forwarding,
                        Some(true),
                        "the engine didn't say it can forward"
                    );
                    sfu.join(session, &room.to_string());
                }
                ClientFrame::VoiceAnswer { sdp } => sfu.answer(session, &sdp),
                // What the gateway does with a restart: join afresh, same room.
                ClientFrame::VoiceRestart => sfu.join(session, &room.to_string()),
                _ => {}
            }
        }
    }
    while let Ok(offer) = offers.try_recv() {
        if let Some((_, engine, _)) = rigs
            .iter()
            .find(|(session, _, _)| *session == offer.session)
        {
            let tracks: Vec<VoiceTrack> = offer
                .tracks
                .iter()
                .map(|track| VoiceTrack {
                    mid: track.mid.clone(),
                    session_id: track.session.clone(),
                })
                .collect();
            engine.on_offer(&offer.sdp, &tracks).await;
        }
    }
}

const A: &str = "aaa-session";
const B: &str = "bbb-session";

#[tokio::test(flavor = "multi_thread")]
async fn a_tone_crosses_the_forwarding_server() {
    let (sender, offers) = std_mpsc::channel();
    let local: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let sfu = Sfu::start(local, local, move |offer: Offer| {
        let _ = sender.send(offer);
    })
    .expect("the forwarding server starts");

    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    let (b, mut b_rx, b_log) = engine(B).await;
    let recorder = Arc::new(Recorder::default());
    a.join(
        room,
        Devices {
            source: Arc::new(Tone::default()),
            sink: Arc::new(Discard),
        },
        Vec::new(),
    )
    .await;
    b.join(
        room,
        Devices {
            source: Arc::new(Silence),
            sink: Arc::clone(&recorder) as Arc<dyn Sink>,
        },
        Vec::new(),
    )
    .await;

    // The server says both are forwarded: neither builds a mesh.
    let state = forwarded(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;
    assert!(a.is_forwarded().await && b.is_forwarded().await);
    assert_eq!(
        a.peer_count().await,
        0,
        "a forwarded engine built a mesh connection"
    );

    let mut heard = 0;
    for _ in 0..800 {
        route(
            &sfu,
            &offers,
            room,
            &mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)],
        )
        .await;
        heard = recorder
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(peer, _)| peer == A)
            .count();
        if heard >= 25 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        heard >= 25,
        "B heard {heard} frames from A through the server.\na: {:?}\nb: {:?}",
        a_log.0.lock().unwrap(),
        b_log.0.lock().unwrap()
    );
    let frames = recorder.0.lock().unwrap().clone();
    assert!(
        frames.iter().all(|(peer, _)| peer == A),
        "B heard somebody who isn't A"
    );
    let recent: Vec<i16> = frames
        .iter()
        .rev()
        .take(10)
        .flat_map(|(_, f)| f.iter().copied())
        .collect();
    let rms =
        (recent.iter().map(|s| f64::from(*s).powi(2)).sum::<f64>() / recent.len() as f64).sqrt();
    assert!(
        rms > 2000.0,
        "what arrived is too quiet to be the tone: rms {rms}"
    );
    let crossings = recent
        .windows(2)
        .filter(|w| (w[0] < 0) != (w[1] < 0))
        .count()
        / 10;
    assert!(
        (12..=24).contains(&crossings),
        "what arrived is not the tone: {crossings} crossings per frame"
    );
    assert!(a.is_forward_connected().await && b.is_forward_connected().await);

    // A leaves: B's next offer drops A, and B forgets A.
    a.leave().await;
    sfu.leave(A);
    for _ in 0..200 {
        route(&sfu, &offers, room, &mut [(B, &b, &mut b_rx)]).await;
        if b_log
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(peer, state)| peer == A && state == "closed")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        b_log
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|(peer, state)| peer == A && state == "closed"),
        "B was never told A left: {:?}",
        b_log.0.lock().unwrap()
    );
}

/// Heard frames with when they arrived, to find gaps.
#[derive(Default)]
struct Clock(Mutex<Vec<(String, std::time::Instant)>>);

#[async_trait]
impl Sink for Clock {
    async fn play(&self, peer: &str, _samples: &[i16]) {
        self.0
            .lock()
            .unwrap()
            .push((peer.to_string(), std::time::Instant::now()));
    }
}

/// The longest silence from `peer` in what `clock` heard, and when it last
/// heard them.
fn longest_gap(clock: &Clock, peer: &str) -> (Duration, Option<std::time::Instant>) {
    let heard: Vec<std::time::Instant> = clock
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|(from, _)| from == peer)
        .map(|(_, at)| *at)
        .collect();
    let gap = heard
        .windows(2)
        .map(|w| w[1] - w[0])
        .max()
        .unwrap_or(Duration::MAX);
    (gap, heard.last().copied())
}

/// Two people talking at once for half a minute stay connected (#210). The
/// server used to be an ICE-lite agent, which counts a connection alive only
/// while the app sends it STUN checks; the app's WebRTC stack sends those only
/// when the line goes quiet, so with voice both ways the server dropped each
/// connection about 15 seconds in, and the app took half a minute to come back.
#[tokio::test(flavor = "multi_thread")]
async fn a_conversation_through_the_server_holds_for_half_a_minute() {
    let (sender, offers) = std_mpsc::channel();
    let local: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let sfu = Sfu::start(local, local, move |offer: Offer| {
        let _ = sender.send(offer);
    })
    .expect("the forwarding server starts");

    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    let (b, mut b_rx, b_log) = engine(B).await;
    let a_ears = Arc::new(Clock::default());
    let b_ears = Arc::new(Clock::default());
    for (engine, ears) in [(&a, &a_ears), (&b, &b_ears)] {
        engine
            .join(
                room,
                Devices {
                    source: Arc::new(Tone::default()),
                    sink: Arc::clone(ears) as Arc<dyn Sink>,
                },
                Vec::new(),
            )
            .await;
    }
    let state = forwarded(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;

    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        route(
            &sfu,
            &offers,
            room,
            &mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)],
        )
        .await;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let now = std::time::Instant::now();
    for (who, ears, from, log) in [("B", &b_ears, A, &b_log), ("A", &a_ears, B, &a_log)] {
        let (gap, last) = longest_gap(ears, from);
        let quiet_for = last.map_or(Duration::MAX, |at| now - at);
        assert!(
            gap < Duration::from_secs(1) && quiet_for < Duration::from_secs(1),
            "{who} lost the other for {gap:?}, and last heard them {quiet_for:?} ago.\nlog: {:?}",
            log.0.lock().unwrap()
        );
        let trouble: Vec<(String, String)> = log
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, state)| state == "disconnected" || state == "failed")
            .cloned()
            .collect();
        assert!(
            trouble.is_empty(),
            "{who}'s connection dropped: {trouble:?}"
        );
    }
}

/// The room goes back to the mesh when an older app joins it: the engine lets
/// its forwarding connection go and builds the mesh instead, and the next
/// forwarded state drops the mesh again.
#[tokio::test(flavor = "multi_thread")]
async fn back_to_the_mesh_and_forwarded_again() {
    let (sender, offers) = std_mpsc::channel();
    let local: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let sfu = Sfu::start(local, local, move |offer: Offer| {
        let _ = sender.send(offer);
    })
    .expect("the forwarding server starts");
    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    a.join(
        room,
        Devices {
            source: Arc::new(Silence),
            sink: Arc::new(Discard),
        },
        Vec::new(),
    )
    .await;
    a.on_state(room, &forwarded(&[A])).await;
    for _ in 0..40 {
        route(&sfu, &offers, room, &mut [(A, &a, &mut a_rx)]).await;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(a.is_forwarded().await);

    // An older app, "ccc", joins: everybody is on the mesh now.
    let mut mesh = forwarded(&[A, "ccc-session"]);
    for peer in &mut mesh {
        peer.forwarded = None;
    }
    a.on_state(room, &mesh).await;
    assert!(!a.is_forwarded().await, "still forwarded in a mesh room");
    assert!(
        !a.is_forward_connected().await,
        "the forwarding connection stayed open"
    );
    assert_eq!(
        a.peer_count().await,
        1,
        "no mesh connection to the older app"
    );

    // It leaves: forwarded again, and the mesh goes.
    a.on_state(room, &forwarded(&[A])).await;
    assert!(a.is_forwarded().await);
    assert_eq!(
        a.peer_count().await,
        0,
        "the mesh stayed up while forwarded"
    );
    let log = a_log.0.lock().unwrap().clone();
    assert!(
        log.iter()
            .any(|(peer, state)| peer == "ccc-session" && state == "closed"),
        "{log:?}"
    );
}

/// A connection to the forwarding server that fails is started afresh without
/// leaving voice (#197): the engine closes it, asks for a new offer, and the
/// voice comes back.
#[tokio::test(flavor = "multi_thread")]
async fn a_restarted_connection_brings_the_voice_back() {
    let (sender, offers) = std_mpsc::channel();
    let local: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let sfu = Sfu::start(local, local, move |offer: Offer| {
        let _ = sender.send(offer);
    })
    .expect("the forwarding server starts");
    let room = RoomId::new();
    let (a, mut a_rx, _) = engine(A).await;
    let (b, mut b_rx, b_log) = engine(B).await;
    let recorder = Arc::new(Recorder::default());
    a.join(
        room,
        Devices {
            source: Arc::new(Tone::default()),
            sink: Arc::new(Discard),
        },
        Vec::new(),
    )
    .await;
    b.join(
        room,
        Devices {
            source: Arc::new(Silence),
            sink: Arc::clone(&recorder) as Arc<dyn Sink>,
        },
        Vec::new(),
    )
    .await;
    let state = forwarded(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;
    let heard_from_a = |recorder: &Recorder| {
        recorder
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(peer, _)| peer == A)
            .count()
    };
    for _ in 0..400 {
        route(
            &sfu,
            &offers,
            room,
            &mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)],
        )
        .await;
        if heard_from_a(&recorder) >= 10 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        heard_from_a(&recorder) >= 10,
        "B never heard A in the first place"
    );

    b.restart_forward().await;
    assert!(
        !b.is_forward_connected().await,
        "the old connection is still up"
    );
    let before = heard_from_a(&recorder);
    for _ in 0..400 {
        route(
            &sfu,
            &offers,
            room,
            &mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)],
        )
        .await;
        if heard_from_a(&recorder) >= before + 10 && b.is_forward_connected().await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        b.is_forward_connected().await,
        "the new connection never came up: {:?}",
        b_log.0.lock().unwrap()
    );
    assert!(
        heard_from_a(&recorder) >= before + 10,
        "B didn't hear A again after restarting"
    );
    assert!(b.is_forwarded().await, "restarting left voice");
}

/// Settings' switch for the old way: the engine stops asking to forward, which
/// puts its whole room on the mesh.
#[tokio::test(flavor = "multi_thread")]
async fn the_old_way_switch_stops_asking_to_forward() {
    let (a, mut a_rx, _) = engine(A).await;
    a.set_can_forward(false);
    a.join(
        RoomId::new(),
        Devices {
            source: Arc::new(Silence),
            sink: Arc::new(Discard),
        },
        Vec::new(),
    )
    .await;
    let mut asked = None;
    while let Ok(frame) = a_rx.try_recv() {
        if let ClientFrame::VoiceJoin { forwarding, .. } = frame {
            asked = Some(forwarding);
        }
    }
    assert_eq!(asked, Some(Some(false)));
}
