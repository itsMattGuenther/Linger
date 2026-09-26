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
