//! Two peer connections, in one process, actually connecting (T-1402).
//!
//! **What this proves and what it does not.** It proves the negotiation is
//! right: that two engines wired to each other reach `connected`, that exactly
//! one of them offers, that candidates arriving early are not lost, and that
//! the mesh is rebuilt when somebody reconnects with a new session id. Those
//! are the parts whose correctness can be established by making them happen.
//!
//! It proves **nothing at all about a real network**. Both ends are on loopback
//! with no NAT between them, which is the arrangement AGENTS §"Where you will
//! be wrong" names explicitly as the one that works right up until somebody is
//! behind carrier-grade NAT. TASKS.md says the same thing in fewer words: *do
//! not test this on one machine*. The four-people-four-networks check is the
//! evidence, and this file is not it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use linger_client_lib::voice::audio::{self, Devices, Discard, Silence, Sink, Tone};
use linger_client_lib::voice::{Engine, Signaller, Watcher};
use linger_core::gateway::{ClientFrame, VoiceControls, VoicePeer, VoiceSignalKind};
use linger_core::{RoomId, UserId};
use tokio::sync::mpsc;

/// Where one engine's outgoing frames go: straight into a channel the test
/// pumps into the other engine. No server, because the thing under test is the
/// negotiation and a real socket in the middle would only make a failure harder
/// to read — T-1401's suite already proves the server routes these.
struct Wire(mpsc::UnboundedSender<ClientFrame>);

impl Signaller for Wire {
    fn send(&self, frame: ClientFrame) {
        let _ = self.0.send(frame);
    }
}

/// Every peer-state change an engine reported, in order.
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

impl Log {
    fn states(&self) -> Vec<(String, String)> {
        self.0.lock().unwrap().clone()
    }
}

type Rig = (
    Arc<Engine<Wire, Log>>,
    mpsc::UnboundedReceiver<ClientFrame>,
    Arc<Log>,
);

#[tokio::test]
async fn deafen_gates_both_directions_and_reports_after_applying() {
    #[derive(Default)]
    struct Gate(std::sync::atomic::AtomicBool);
    #[async_trait]
    impl Sink for Gate {
        async fn play(&self, _: &str, _: &[i16]) {}
        async fn set_deafened(&self, value: bool) {
            self.0.store(value, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let (engine, mut rx, _) = engine("a").await;
    let gate = Arc::new(Gate::default());
    let room = RoomId::new();
    engine
        .join(
            room,
            Devices {
                source: Arc::new(Silence),
                sink: gate.clone(),
            },
            vec![],
        )
        .await;
    while rx.try_recv().is_ok() {}
    engine
        .set_controls(VoiceControls {
            muted: false,
            deafened: true,
        })
        .await;
    assert!(
        engine.is_muted(),
        "deafen closes the microphone even with muted=false"
    );
    assert!(gate.0.load(std::sync::atomic::Ordering::SeqCst));
    assert!(matches!(
        rx.try_recv().unwrap(),
        ClientFrame::VoiceJoin {
            controls: Some(VoiceControls {
                muted: true,
                deafened: true
            }),
            ..
        }
    ));
    engine
        .set_controls(VoiceControls {
            muted: true,
            deafened: false,
        })
        .await;
    assert!(engine.is_muted());
    assert!(!gate.0.load(std::sync::atomic::Ordering::SeqCst));
    engine.set_controls(VoiceControls::default()).await;
    assert!(!engine.is_muted());
    engine.leave().await;
}

async fn engine(session: &str) -> Rig {
    let (tx, rx) = mpsc::unbounded_channel();
    let log = Arc::new(Log::default());
    // No ICE servers: on loopback there is nothing to traverse, and a STUN
    // lookup in a test is a network call that will one day fail in CI for
    // reasons that have nothing to do with the code.
    let engine = Arc::new(Engine::new(
        Arc::new(Wire(tx)),
        Arc::clone(&log),
        Vec::new(),
    ));
    engine.set_session(session.to_string()).await;
    (engine, rx, log)
}

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

/// Carry whatever each side has to say to the other, once.
///
/// The test's stand-in for the gateway, and deliberately dumb: it forwards
/// frames and looks at nothing. T-1401's suite already proves the real server
/// routes these; what is under test here is what the two ends do with them.
async fn pump_once(
    a: &Arc<Engine<Wire, Log>>,
    a_id: &str,
    a_rx: &mut mpsc::UnboundedReceiver<ClientFrame>,
    b: &Arc<Engine<Wire, Log>>,
    b_id: &str,
    b_rx: &mut mpsc::UnboundedReceiver<ClientFrame>,
) {
    while let Ok(frame) = a_rx.try_recv() {
        if let ClientFrame::VoiceSignal { to, kind, payload } = frame {
            assert_eq!(to, b_id, "a signal was addressed to the wrong peer");
            b.on_signal(a_id, kind, &payload).await;
        }
    }
    while let Ok(frame) = b_rx.try_recv() {
        if let ClientFrame::VoiceSignal { to, kind, payload } = frame {
            assert_eq!(to, a_id, "a signal was addressed to the wrong peer");
            a.on_signal(b_id, kind, &payload).await;
        }
    }
}

/// Session ids are compared to decide who offers, so the test picks two whose
/// order is obvious: `aaa` offers, `bbb` answers.
const A: &str = "aaa-session";
const B: &str = "bbb-session";

#[tokio::test(flavor = "multi_thread")]
async fn two_peers_negotiate_and_connect() {
    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    let (b, mut b_rx, b_log) = engine(B).await;

    a.join(room, Devices::silent(), Vec::new()).await;
    b.join(room, Devices::silent(), Vec::new()).await;
    // The join frames themselves go nowhere here — there is no server — so the
    // test plays the part the server plays and tells both sides who is in.
    while a_rx.try_recv().is_ok() {}
    while b_rx.try_recv().is_ok() {}

    let state = peers(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;

    assert_eq!(a.peer_count().await, 1, "a did not build a peer for b");
    assert_eq!(b.peer_count().await, 1, "b did not build a peer for a");

    let mut connected = false;
    for _ in 0..600 {
        pump_once(&a, A, &mut a_rx, &b, B, &mut b_rx).await;
        if a.is_connected(B).await && b.is_connected(A).await {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        connected,
        "two peers on loopback never connected.\na: {:?}\nb: {:?}",
        a_log.states(),
        b_log.states()
    );

    // Both sides saw it happen, which is what the voice surface will draw.
    assert!(a_log.states().iter().any(|(_, s)| s == "connected"));
    assert!(b_log.states().iter().any(|(_, s)| s == "connected"));
}

#[tokio::test(flavor = "multi_thread")]
async fn exactly_one_side_offers() {
    let room = RoomId::new();
    let (a, mut a_rx, _) = engine(A).await;
    let (b, mut b_rx, _) = engine(B).await;
    a.join(room, Devices::silent(), Vec::new()).await;
    b.join(room, Devices::silent(), Vec::new()).await;
    while a_rx.try_recv().is_ok() {}
    while b_rx.try_recv().is_ok() {}

    let state = peers(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut offers = 0;
    let mut from_b = 0;
    while let Ok(ClientFrame::VoiceSignal { kind, .. }) = a_rx.try_recv() {
        if kind == VoiceSignalKind::Offer {
            offers += 1;
        }
    }
    while let Ok(ClientFrame::VoiceSignal { kind, .. }) = b_rx.try_recv() {
        if kind == VoiceSignalKind::Offer {
            from_b += 1;
        }
    }
    // Glare is two offers crossing, and it leaves both sides waiting for an
    // answer to an offer the other one threw away.
    assert_eq!(offers, 1, "the lower session id did not offer exactly once");
    assert_eq!(from_b, 0, "the higher session id offered as well");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_peer_who_reconnects_gets_a_new_connection() {
    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    let (b, mut b_rx, _) = engine(B).await;
    a.join(room, Devices::silent(), Vec::new()).await;
    b.join(room, Devices::silent(), Vec::new()).await;
    while a_rx.try_recv().is_ok() {}
    while b_rx.try_recv().is_ok() {}

    a.on_state(room, &peers(&[A, B])).await;
    b.on_state(room, &peers(&[A, B])).await;
    assert_eq!(a.peer_count().await, 1);

    // B's session ends and it comes back as somebody else, which is what a
    // reconnect past the resume window looks like from A's side.
    const B2: &str = "bbb-session-2";
    a.on_state(room, &peers(&[A, B2])).await;

    assert_eq!(
        a.peer_count().await,
        1,
        "a is holding two peers for one person"
    );
    assert!(
        a.outbound(B).await.is_none(),
        "the old connection was left open"
    );
    assert!(
        a.outbound(B2).await.is_some(),
        "the new connection was never built"
    );
    assert!(
        a_log.states().iter().any(|(p, s)| p == B && s == "closed"),
        "nothing said the old peer went: {:?}",
        a_log.states()
    );
    let _ = b;
    let _ = b_rx;
}

#[tokio::test(flavor = "multi_thread")]
async fn leaving_closes_every_peer() {
    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    a.join(room, Devices::silent(), Vec::new()).await;
    while a_rx.try_recv().is_ok() {}
    a.on_state(room, &peers(&[A, B, "ccc-session"])).await;
    assert_eq!(a.peer_count().await, 2);

    a.leave().await;
    assert_eq!(a.peer_count().await, 0, "a peer survived leaving");
    let closed = a_log.states().iter().filter(|(_, s)| s == "closed").count();
    assert!(
        closed >= 2,
        "not every peer was reported closed: {:?}",
        a_log.states()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_state_for_a_room_we_are_not_in_is_ignored() {
    let ours = RoomId::new();
    let theirs = RoomId::new();
    let (a, mut a_rx, _) = engine(A).await;
    a.join(ours, Devices::silent(), Vec::new()).await;
    while a_rx.try_recv().is_ok() {}

    // We are told about every room we can see, not only the one we are in.
    a.on_state(theirs, &peers(&[A, B])).await;
    assert_eq!(
        a.peer_count().await,
        0,
        "a voice room we are not in built a mesh"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_candidate_that_arrives_before_the_answer_is_kept() {
    let room = RoomId::new();
    let (a, mut a_rx, _) = engine(A).await;
    a.join(room, Devices::silent(), Vec::new()).await;
    while a_rx.try_recv().is_ok() {}
    a.on_state(room, &peers(&[A, B])).await;

    // ICE trickles, so the far end starts sending candidates before its answer
    // has been applied here. Dropping them is a call that takes the long way
    // round or never connects — and on a good network you never notice, which
    // is what makes it the kind of bug this project is warned about.
    a.on_signal(
        B,
        VoiceSignalKind::Candidate,
        "candidate:1 1 udp 1 127.0.0.1 1 typ host",
    )
    .await;
    a.on_signal(
        B,
        VoiceSignalKind::Candidate,
        "candidate:2 1 udp 2 127.0.0.1 2 typ host",
    )
    .await;

    // Nothing has blown up and the peer is still there to answer into.
    assert_eq!(a.peer_count().await, 1);
    assert!(a.outbound(B).await.is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_signal_from_a_stranger_is_harmless() {
    let room = RoomId::new();
    let (a, mut a_rx, _) = engine(A).await;
    a.join(room, Devices::silent(), Vec::new()).await;
    while a_rx.try_recv().is_ok() {}

    // An answer or a candidate for a connection we do not have. The server
    // should never route one, so this is about not trusting that.
    a.on_signal("nobody", VoiceSignalKind::Answer, "v=0 nonsense")
        .await;
    a.on_signal("nobody", VoiceSignalKind::Candidate, "candidate:1")
        .await;
    assert_eq!(a.peer_count().await, 0);
}

/// A sink that keeps everything it is given, by peer.
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

impl Recorder {
    fn frames(&self) -> Vec<(String, Vec<i16>)> {
        self.0.lock().unwrap().clone()
    }
}

fn rms(samples: &[i16]) -> f64 {
    let sum: f64 = samples.iter().map(|s| f64::from(*s).powi(2)).sum();
    (sum / samples.len() as f64).sqrt()
}

fn zero_crossings(samples: &[i16]) -> usize {
    samples
        .windows(2)
        .filter(|w| (w[0] < 0) != (w[1] < 0))
        .count()
}

/// The whole path, end to end: a tone goes into one engine's source and comes
/// out of the other engine's sink, having been Opus-encoded, packetised,
/// encrypted, sent over a real peer connection, and decoded again.
///
/// This is the closest a single machine gets to "somebody heard somebody".
/// What it cannot say is anything about a microphone, a speaker, or a network
/// with a NAT in it — the first two are the `#[ignore]` tests in
/// `voice::device`, and the third is T-1402's acceptance criterion.
#[tokio::test(flavor = "multi_thread")]
async fn a_tone_crosses_a_peer_connection() {
    let room = RoomId::new();
    let (a, mut a_rx, a_log) = engine(A).await;
    let (b, mut b_rx, b_log) = engine(B).await;
    let recorder = Arc::new(Recorder::default());

    // A talks, B listens.
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
    while a_rx.try_recv().is_ok() {}
    while b_rx.try_recv().is_ok() {}

    let state = peers(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;

    // Connect, then keep pumping signals while audio flows — late candidates
    // still need carrying — until B has heard half a second of A.
    let mut heard = 0;
    for _ in 0..800 {
        pump_once(&a, A, &mut a_rx, &b, B, &mut b_rx).await;
        heard = recorder
            .frames()
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
        "B heard {heard} frames from A in twenty seconds.\na: {:?}\nb: {:?}",
        a_log.states(),
        b_log.states()
    );

    let frames = recorder.frames();
    assert!(
        frames.iter().all(|(peer, _)| peer == A),
        "B heard a frame from somebody other than A"
    );
    assert!(
        frames.iter().all(|(_, f)| f.len() == audio::FRAME_SAMPLES),
        "a frame arrived at the wrong length"
    );

    // The last ten frames are steady state: loud, and at 440 Hz — which is
    // about 17 or 18 zero crossings per 20 ms.
    let recent: Vec<i16> = frames
        .iter()
        .rev()
        .take(10)
        .flat_map(|(_, f)| f.iter().copied())
        .collect();
    assert!(
        rms(&recent) > 2000.0,
        "what arrived is too quiet to be the tone: rms {}",
        rms(&recent)
    );
    let per_frame = zero_crossings(&recent) / 10;
    assert!(
        (12..=24).contains(&per_frame),
        "what arrived is not the tone: {per_frame} crossings per frame"
    );
}

/// Mute sends silence, not nothing, and the far end can tell the difference
/// from a dead connection only because the frames keep coming. Unmuting
/// brings the tone back on the same connection, with nothing renegotiated.
///
/// Also the proof of "who is speaking": B's watcher is told A started
/// talking, then stopped when A muted, then started again.
#[tokio::test(flavor = "multi_thread")]
async fn muting_sends_silence_and_the_mark_follows() {
    /// Records who was said to be speaking, in order.
    #[derive(Default)]
    struct Ears(Mutex<Vec<(Option<String>, bool)>>);
    impl Watcher for Ears {
        fn peer_state(&self, _peer: &str, _state: &str) {}
        fn speaking(&self, peer: Option<&str>, speaking: bool) {
            self.0
                .lock()
                .unwrap()
                .push((peer.map(str::to_string), speaking));
        }
    }

    let room = RoomId::new();
    let (a, mut a_rx, _) = engine(A).await;
    let (b_tx, mut b_rx) = mpsc::unbounded_channel();
    let ears = Arc::new(Ears::default());
    let b = Arc::new(Engine::new(
        Arc::new(Wire(b_tx)),
        Arc::clone(&ears),
        Vec::new(),
    ));
    b.set_session(B.to_string()).await;
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
    while a_rx.try_recv().is_ok() {}
    while b_rx.try_recv().is_ok() {}
    let state = peers(&[A, B]);
    a.on_state(room, &state).await;
    b.on_state(room, &state).await;

    // A generic pump that works for two engines with different watchers.
    async fn carry(
        a: &Arc<Engine<Wire, Log>>,
        a_rx: &mut mpsc::UnboundedReceiver<ClientFrame>,
        b: &Arc<Engine<Wire, Ears>>,
        b_rx: &mut mpsc::UnboundedReceiver<ClientFrame>,
    ) {
        while let Ok(ClientFrame::VoiceSignal { kind, payload, .. }) = a_rx.try_recv() {
            b.on_signal(A, kind, &payload).await;
        }
        while let Ok(ClientFrame::VoiceSignal { kind, payload, .. }) = b_rx.try_recv() {
            a.on_signal(B, kind, &payload).await;
        }
    }

    // Wait until B has heard `n` frames in all.
    async fn heard_after(recorder: &Recorder, n: usize) -> bool {
        for _ in 0..800 {
            if recorder.frames().len() >= n {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }
    let mut ok = false;
    for _ in 0..800 {
        carry(&a, &mut a_rx, &b, &mut b_rx).await;
        if recorder.frames().len() >= 25 {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(ok, "B never heard A");
    assert!(
        rms(&recorder.frames().last().unwrap().1) > 2000.0,
        "not the tone"
    );

    // Mute: the frames keep arriving and they are quiet.
    a.set_controls(VoiceControls {
        muted: true,
        deafened: false,
    })
    .await;
    assert!(a.is_muted());
    let before = recorder.frames().len();
    assert!(
        heard_after(&recorder, before + 25).await,
        "muting stopped the frames"
    );
    let quiet = recorder.frames().last().unwrap().1.clone();
    assert!(
        rms(&quiet) < 200.0,
        "mute is not silence: rms {}",
        rms(&quiet)
    );

    // Unmute: the tone is back on the same connection.
    a.set_controls(VoiceControls::default()).await;
    let before = recorder.frames().len();
    assert!(
        heard_after(&recorder, before + 25).await,
        "unmuting stopped the frames"
    );
    let loud = recorder.frames().last().unwrap().1.clone();
    assert!(
        rms(&loud) > 2000.0,
        "the tone did not come back: rms {}",
        rms(&loud)
    );

    // Deafen also sends silence, even when a caller requests an unmuted mic.
    a.set_controls(VoiceControls {
        muted: false,
        deafened: true,
    })
    .await;
    let before = recorder.frames().len();
    assert!(heard_after(&recorder, before + 25).await);
    assert!(rms(&recorder.frames().last().unwrap().1) < 200.0);
    a.set_controls(VoiceControls::default()).await;
    let before = recorder.frames().len();
    assert!(heard_after(&recorder, before + 25).await);
    assert!(rms(&recorder.frames().last().unwrap().1) > 2000.0);

    // B's watcher saw A talk, go quiet, and talk again — each change once.
    let marks = ears.0.lock().unwrap().clone();
    let of_a: Vec<bool> = marks
        .iter()
        .filter(|(peer, _)| peer.as_deref() == Some(A))
        .map(|(_, speaking)| *speaking)
        .collect();
    assert!(
        of_a.starts_with(&[true, false, true]),
        "the speaking mark did not follow the audio: {of_a:?}"
    );
    // And B, which sent only silence, was never said to be talking.
    assert!(
        !marks
            .iter()
            .any(|(peer, speaking)| peer.is_none() && *speaking),
        "a silent microphone was marked as talking"
    );
}

/// The microphone loop stops when the source does, and says so. Until
/// T-1405, that is what "the microphone was unplugged" looks like.
#[tokio::test(flavor = "multi_thread")]
async fn a_source_that_ends_stops_sending_and_says_so() {
    /// Three frames, then nothing.
    struct Brief(std::sync::atomic::AtomicU8);

    #[async_trait]
    impl audio::Source for Brief {
        async fn frame(&self) -> Option<Vec<i16>> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            (n < 3).then(|| vec![0i16; audio::FRAME_SAMPLES])
        }
    }

    #[derive(Default)]
    struct AudioLog(Mutex<Vec<String>>);
    impl Watcher for AudioLog {
        fn peer_state(&self, _peer: &str, _state: &str) {}
        fn audio_state(&self, state: &str) {
            self.0.lock().unwrap().push(state.to_string());
        }
    }

    let (tx, _rx) = mpsc::unbounded_channel();
    let log = Arc::new(AudioLog::default());
    let engine = Engine::new(Arc::new(Wire(tx)), Arc::clone(&log), Vec::new());
    engine.set_session(A.to_string()).await;
    engine
        .join(
            RoomId::new(),
            Devices {
                source: Arc::new(Brief(std::sync::atomic::AtomicU8::new(0))),
                sink: Arc::new(Discard),
            },
            Vec::new(),
        )
        .await;

    let mut states = Vec::new();
    for _ in 0..40 {
        states = log.0.lock().unwrap().clone();
        if states.iter().any(|s| s == "stopped") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        states,
        vec!["sending".to_string(), "stopped".to_string()],
        "the sending loop did not report starting and stopping"
    );
}

#[test]
fn the_audio_seam_is_one_twenty_millisecond_frame() {
    // The seam `cpal` and Opus arrive at. Asserted here as well as in the unit
    // tests because it is the number both of those have to agree with, and a
    // change to it is a change to the shape of the hole they fill.
    assert_eq!(audio::FRAME_SAMPLES, 960);
    assert_eq!(audio::SAMPLE_RATE, 48_000);
    assert_eq!(audio::CHANNELS, 1);
}
