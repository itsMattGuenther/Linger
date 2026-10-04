//! The voice engine on its own, in one process (T-1402): its controls, its
//! devices and its sending loop, with no connection to carry the sound.
//!
//! The sound itself, through the real forwarding server, is `forwarding.rs`.
//! Neither says anything about a real network: both ends are on loopback,
//! which AGENTS §"Where you will be wrong" names as the arrangement that works
//! right up until somebody is behind carrier-grade NAT.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use linger_client_lib::voice::audio::{self, Devices, Discard, Silence, Sink};
use linger_client_lib::voice::{Engine, Signaller, Watcher};
use linger_core::gateway::{ClientFrame, VoiceControls};
use linger_core::RoomId;
use tokio::sync::mpsc;

/// Where an engine's outgoing frames go: into a channel the test reads, to
/// see what it would have told the server.
struct Wire(mpsc::UnboundedSender<ClientFrame>);

impl Signaller for Wire {
    fn send(&self, frame: ClientFrame) {
        let _ = self.0.send(frame);
    }
}

/// Every connection-state change an engine reported, in order.
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

/// Push-to-talk closes the microphone without telling the room (#232): the
/// key going up or down sends no frame at all, joining with it closed reports
/// an open microphone, and a real mute is still reported and still wins.
#[tokio::test]
async fn push_to_talk_closes_the_microphone_without_telling_the_room() {
    let (engine, mut rx, _) = engine("a").await;
    let room = RoomId::new();
    // Closed before joining, as the app does when push-to-talk is on.
    engine.set_push_to_talk_closed(true);
    engine
        .join(
            room,
            Devices {
                source: Arc::new(Silence),
                sink: Arc::new(Discard),
            },
            vec![],
        )
        .await;
    assert!(
        matches!(
            rx.try_recv().unwrap(),
            ClientFrame::VoiceJoin {
                controls: Some(VoiceControls {
                    muted: false,
                    deafened: false
                }),
                ..
            }
        ),
        "the join reported push-to-talk's closed microphone as a mute"
    );
    assert!(engine.is_push_to_talk_closed());
    assert!(!engine.is_muted());

    // The key down and up again: the microphone opens and closes, and the
    // room hears nothing about it.
    engine.set_push_to_talk_closed(false);
    engine.set_push_to_talk_closed(true);
    assert!(
        rx.try_recv().is_err(),
        "a push-to-talk edge went to the server"
    );

    // A real mute is reported, and the key can't open what mute closed.
    engine
        .set_controls(VoiceControls {
            muted: true,
            deafened: false,
        })
        .await;
    assert!(matches!(
        rx.try_recv().unwrap(),
        ClientFrame::VoiceJoin {
            controls: Some(VoiceControls {
                muted: true,
                deafened: false
            }),
            ..
        }
    ));
    engine.set_push_to_talk_closed(false);
    assert!(engine.is_muted(), "holding the key undid a mute");
    assert!(rx.try_recv().is_err());
    engine.leave().await;
}

/// Stand-in devices that remember every device they were asked to use.
#[derive(Default)]
struct Chooser(Mutex<Vec<Option<String>>>);

#[async_trait]
impl audio::Source for Chooser {
    async fn frame(&self) -> Option<Vec<i16>> {
        tokio::time::sleep(Duration::from_millis(u64::from(audio::FRAME_MS))).await;
        Some(vec![0; audio::FRAME_SAMPLES])
    }

    fn choose(&self, name: Option<&str>) {
        self.0.lock().unwrap().push(name.map(str::to_owned));
    }
}

#[async_trait]
impl Sink for Chooser {
    async fn play(&self, _peer: &str, _samples: &[i16]) {}

    fn choose(&self, name: Option<&str>) {
        self.0.lock().unwrap().push(name.map(str::to_owned));
    }
}

/// Devices picked in Settings during a call reach the call's own microphone
/// and speakers, without leaving (#249). Outside a call there is nothing to
/// change, and nothing is told to the room either way.
#[tokio::test]
async fn devices_chosen_in_a_call_reach_the_call() {
    let (engine, mut rx, _) = engine("a").await;
    assert!(
        !engine.choose_devices(Some("USB mic"), None).await,
        "changed a call that wasn't there"
    );
    let mic = Arc::new(Chooser::default());
    let speakers = Arc::new(Chooser::default());
    engine
        .join(
            RoomId::new(),
            Devices {
                source: Arc::clone(&mic) as Arc<dyn audio::Source>,
                sink: Arc::clone(&speakers) as Arc<dyn Sink>,
            },
            vec![],
        )
        .await;
    while rx.try_recv().is_ok() {}

    assert!(
        engine
            .choose_devices(Some("USB mic"), Some("Headphones"))
            .await
    );
    assert!(engine.choose_devices(None, Some("Headphones")).await);
    assert_eq!(
        *mic.0.lock().unwrap(),
        vec![Some("USB mic".to_string()), None]
    );
    assert_eq!(
        *speakers.0.lock().unwrap(),
        vec![
            Some("Headphones".to_string()),
            Some("Headphones".to_string())
        ]
    );
    assert!(rx.try_recv().is_err(), "a device change went to the server");

    engine.leave().await;
    assert!(!engine.choose_devices(Some("USB mic"), None).await);
    assert_eq!(mic.0.lock().unwrap().len(), 2, "a left call was changed");
}

/// A sink that remembers the sounds it was handed (#250).
#[derive(Default)]
struct Cued(Mutex<Vec<Vec<i16>>>);

#[async_trait]
impl Sink for Cued {
    async fn play(&self, _peer: &str, _samples: &[i16]) {}

    fn cue(&self, samples: &[i16]) -> bool {
        self.0.lock().unwrap().push(samples.to_vec());
        true
    }
}

/// In a call, Linger's own sounds go into the call's own speakers (#250).
/// Outside one there is nowhere here to put them, and the engine says so.
#[tokio::test]
async fn a_sound_in_a_call_goes_into_the_calls_speakers() {
    let (engine, _rx, _) = engine("a").await;
    assert!(!engine.cue(&[1, 2, 3]).await, "played with no call");
    let speakers = Arc::new(Cued::default());
    engine
        .join(
            RoomId::new(),
            Devices {
                source: Arc::new(Silence),
                sink: Arc::clone(&speakers) as Arc<dyn Sink>,
            },
            vec![],
        )
        .await;
    assert!(engine.cue(&[1, 2, 3]).await);
    assert_eq!(*speakers.0.lock().unwrap(), vec![vec![1, 2, 3]]);
    engine.leave().await;
    assert!(!engine.cue(&[4]).await, "played into a call that ended");
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

const A: &str = "aaa-session";

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

#[tokio::test]
async fn a_picked_microphone_that_wouldnt_open_is_said_once_and_unsaid_once() {
    // Six frames. The picked microphone is refused from the third to the
    // fifth (the default standing in for it, #398), then picked again.
    struct Refusing(std::sync::atomic::AtomicU8);

    #[async_trait]
    impl audio::Source for Refusing {
        async fn frame(&self) -> Option<Vec<i16>> {
            let n = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            (n < 6).then(|| vec![0i16; audio::FRAME_SAMPLES])
        }

        fn refused(&self) -> Option<audio::Refused> {
            let delivered = self.0.load(std::sync::atomic::Ordering::Relaxed);
            (3..=5).contains(&delivered).then(|| audio::Refused {
                name: "Headset Microphone".to_string(),
                why: "the device is in use".to_string(),
            })
        }
    }

    #[derive(Default)]
    struct Said(Mutex<Vec<String>>);
    impl Watcher for Said {
        fn peer_state(&self, _peer: &str, _state: &str) {}
        fn audio_state(&self, state: &str) {
            self.0.lock().unwrap().push(state.to_string());
        }
        fn microphone_refused(&self, refused: Option<&audio::Refused>) {
            self.0.lock().unwrap().push(match refused {
                Some(refused) => format!("refused {}: {}", refused.name, refused.why),
                None => "refused nothing".to_string(),
            });
        }
    }

    let (tx, _rx) = mpsc::unbounded_channel();
    let said = Arc::new(Said::default());
    let engine = Engine::new(Arc::new(Wire(tx)), Arc::clone(&said), Vec::new());
    engine.set_session(A.to_string()).await;
    engine
        .join(
            RoomId::new(),
            Devices {
                source: Arc::new(Refusing(std::sync::atomic::AtomicU8::new(0))),
                sink: Arc::new(Discard),
            },
            Vec::new(),
        )
        .await;

    let mut lines = Vec::new();
    for _ in 0..40 {
        lines = said.0.lock().unwrap().clone();
        if lines.iter().any(|line| line == "stopped") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        lines,
        vec![
            "sending".to_string(),
            "refused Headset Microphone: the device is in use".to_string(),
            "refused nothing".to_string(),
            "stopped".to_string(),
        ],
        "a refused microphone was not said once and unsaid once"
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
