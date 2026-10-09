//! Voice through the forwarding server (#197), end to end on this machine: two
//! real engines, the real forwarding server in-process, and a tone that goes
//! into one engine's source and comes out of the other's sink. Since the mesh
//! was taken out (#306), this is the only way voice travels.
//!
//! Like `voice.rs`, it proves the negotiation and the audio path, and nothing
//! about a real network: both ends are on loopback (AGENTS "Where you will be
//! wrong"). Four people on four networks is still the check that counts.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::sync::{mpsc as std_mpsc, Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use linger_client_lib::voice::audio::{Devices, Discard, Silence, Sink, Tone};
use linger_client_lib::voice::{Engine, Signaller, Watcher};
use linger_core::gateway::{ClientFrame, VoiceControls, VoiceTrack};
use linger_core::RoomId;
use linger_sfu::{Offer, Sfu};
use tokio::sync::mpsc;

struct Wire(mpsc::UnboundedSender<ClientFrame>);

impl Signaller for Wire {
    fn send(&self, frame: ClientFrame) {
        let _ = self.0.send(frame);
    }
}

/// Every connection-state change an engine reported, in order, and who it
/// said was talking (`None` is the engine's own microphone).
#[derive(Default)]
struct Log(
    Mutex<Vec<(String, String)>>,
    Mutex<Vec<(Option<String>, bool)>>,
);

impl Watcher for Log {
    fn peer_state(&self, peer: &str, state: &str) {
        self.0
            .lock()
            .unwrap()
            .push((peer.to_string(), state.to_string()));
    }

    fn speaking(&self, peer: Option<&str>, speaking: bool) {
        self.1
            .lock()
            .unwrap()
            .push((peer.map(str::to_string), speaking));
    }
}

impl Log {
    /// The talking marks for one person, in order.
    fn talking(&self, peer: Option<&str>) -> Vec<bool> {
        self.1
            .lock()
            .unwrap()
            .iter()
            .filter(|(who, _)| who.as_deref() == peer)
            .map(|(_, speaking)| *speaking)
            .collect()
    }
}

/// Every frame played, by whom; and, by how many frames had been played
/// from them at the time, every pause the receive loop told of (#462).
#[derive(Default)]
struct Recorder(Mutex<Vec<(String, Vec<i16>)>>, Mutex<Vec<(String, usize)>>);

#[async_trait]
impl Sink for Recorder {
    async fn play(&self, peer: &str, samples: &[i16]) {
        self.0
            .lock()
            .unwrap()
            .push((peer.to_string(), samples.to_vec()));
    }

    async fn resume(&self, peer: &str) {
        let played = heard(self, peer).len();
        self.1.lock().unwrap().push((peer.to_string(), played));
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

/// The test's stand-in for the gateway: the forwarding server on this
/// machine, where its offers arrive, and who has a seat. A join from somebody
/// without one seats them; a repeated join only carries controls, as the real
/// gateway treats it, since joining the forwarding server again would start
/// that person's connection afresh.
struct Gateway {
    sfu: Sfu,
    offers: std_mpsc::Receiver<Offer>,
    room: RoomId,
    seated: BTreeSet<String>,
    /// Every join routed, with the controls it carried, in order.
    joins: Vec<(String, Option<VoiceControls>)>,
}

impl Gateway {
    fn start(room: RoomId) -> Self {
        let (sender, offers) = std_mpsc::channel();
        let local: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let sfu = Sfu::start(local, local, move |offer: Offer| {
            let _ = sender.send(offer);
        })
        .expect("the forwarding server starts");
        Self {
            sfu,
            offers,
            room,
            seated: BTreeSet::new(),
            joins: Vec::new(),
        }
    }

    /// Joins and answers go to the forwarding server, and its offers come
    /// back to their engine.
    async fn route(&mut self, rigs: &mut [Routed<'_>]) {
        let room = self.room.to_string();
        for (session, _, rx) in rigs.iter_mut() {
            while let Ok(frame) = rx.try_recv() {
                match frame {
                    ClientFrame::VoiceJoin {
                        forwarding,
                        controls,
                        ..
                    } => {
                        self.joins.push(((*session).to_string(), controls));
                        assert_eq!(
                            forwarding,
                            Some(true),
                            "the engine didn't say it can forward"
                        );
                        if self.seated.insert((*session).to_string()) {
                            self.sfu.join(session, &room);
                        }
                    }
                    ClientFrame::VoiceAnswer { sdp } => self.sfu.answer(session, &sdp),
                    // What the gateway does with a restart: join afresh, same room.
                    ClientFrame::VoiceRestart => self.sfu.join(session, &room),
                    ClientFrame::VoiceLeave => {
                        self.seated.remove(*session);
                        self.sfu.leave(session);
                    }
                    _ => {}
                }
            }
        }
        while let Ok(offer) = self.offers.try_recv() {
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
                engine.on_offer(&offer.sdp, &tracks, Some(offer.bits)).await;
            }
        }
    }
}

const A: &str = "aaa-session";
const B: &str = "bbb-session";

#[tokio::test(flavor = "multi_thread")]
async fn a_tone_crosses_the_forwarding_server() {
    let room = RoomId::new();
    let mut gateway = Gateway::start(room);
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

    let mut heard = 0;
    for _ in 0..800 {
        gateway
            .route(&mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)])
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
    // Each was told the room's quality on its offer (#431): two is a small room.
    assert_eq!(a.bits(), Some(linger_sfu::SMALL_ROOM_BITS));
    assert_eq!(b.bits(), Some(linger_sfu::SMALL_ROOM_BITS));

    // A leaves: B's next offer drops A, and B forgets A.
    a.leave().await;
    gateway.sfu.leave(A);
    for _ in 0..200 {
        gateway.route(&mut [(B, &b, &mut b_rx)]).await;
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
    let room = RoomId::new();
    let mut gateway = Gateway::start(room);
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
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_secs(30) {
        gateway
            .route(&mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)])
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

/// A connection to the forwarding server that fails is started afresh without
/// leaving voice (#197): the engine closes it, asks for a new offer, and the
/// voice comes back.
#[tokio::test(flavor = "multi_thread")]
async fn a_restarted_connection_brings_the_voice_back() {
    let room = RoomId::new();
    let mut gateway = Gateway::start(room);
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
        gateway
            .route(&mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)])
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
        gateway
            .route(&mut [(A, &a, &mut a_rx), (B, &b, &mut b_rx)])
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
}

/// How loud a stretch of samples is.
fn rms(samples: &[i16]) -> f64 {
    let sum: f64 = samples.iter().map(|s| f64::from(*s).powi(2)).sum();
    (sum / samples.len().max(1) as f64).sqrt()
}

/// Everything `recorder` heard from `peer`, frame by frame.
fn heard(recorder: &Recorder, peer: &str) -> Vec<Vec<i16>> {
    recorder
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|(who, _)| who == peer)
        .map(|(_, frame)| frame.clone())
        .collect()
}

/// Route until B's recorder has `n` more frames from A, or twenty seconds
/// pass. Answers whether it got them.
async fn hear(
    gateway: &mut Gateway,
    rigs: &mut [Routed<'_>],
    recorder: &Recorder,
    n: usize,
) -> bool {
    let target = heard(recorder, A).len() + n;
    for _ in 0..800 {
        gateway.route(rigs).await;
        if heard(recorder, A).len() >= target {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    false
}

/// How loud the last frame from A was.
fn last(recorder: &Recorder) -> f64 {
    rms(heard(recorder, A).last().expect("something from A"))
}

/// Route until nothing new from A has come for 600 ms, and say what did come
/// meanwhile. Silence isn't sent (#197): a mute, a deafen or a key let go
/// ends in a few quiet frames as Opus eases out, then nothing at all.
async fn goes_quiet(
    gateway: &mut Gateway,
    rigs: &mut [Routed<'_>],
    recorder: &Recorder,
) -> Vec<Vec<i16>> {
    let from = heard(recorder, A).len();
    let mut count = from;
    let mut still = std::time::Instant::now();
    for _ in 0..800 {
        gateway.route(rigs).await;
        let now = heard(recorder, A).len();
        if now != count {
            count = now;
            still = std::time::Instant::now();
        } else if still.elapsed() >= Duration::from_millis(600) {
            return heard(recorder, A).split_off(from);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("A never stopped sending");
}

/// Few frames, the last of them quiet: Opus easing out, and then nothing.
fn eased_out(tail: &[Vec<i16>], what: &str) {
    assert!(
        tail.len() <= 30,
        "{what} kept sending: {} frames",
        tail.len()
    );
    if let Some(final_frame) = tail.last() {
        assert!(
            rms(final_frame) < 200.0,
            "{what} ended loud: rms {}",
            rms(final_frame)
        );
    }
}

/// Mute sends nothing through the server, once Opus has eased out (#197:
/// silence isn't sent), and unmuting brings the tone back on the same
/// connection. Deafen too. B's engine marks A talking, then quiet when A
/// mutes, then talking again; and B, which sent only silence, never talks.
#[tokio::test(flavor = "multi_thread")]
async fn muting_stops_sending_through_the_server_and_the_mark_follows() {
    let room = RoomId::new();
    let mut gateway = Gateway::start(room);
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
    let mut rigs = [(A, &a, &mut a_rx), (B, &b, &mut b_rx)];
    assert!(
        hear(&mut gateway, &mut rigs, &recorder, 25).await,
        "B never heard A"
    );
    assert!(last(&recorder) > 2000.0, "not the tone");

    // Mute: a few quiet frames as Opus eases out, then nothing.
    a.set_controls(VoiceControls {
        muted: true,
        deafened: false,
    })
    .await;
    assert!(a.is_muted());
    eased_out(
        &goes_quiet(&mut gateway, &mut rigs, &recorder).await,
        "mute",
    );
    let before = heard(&recorder, A).len();

    // Unmute: the tone is back on the same connection.
    a.set_controls(VoiceControls::default()).await;
    assert!(
        hear(&mut gateway, &mut rigs, &recorder, 25).await,
        "unmuting stopped the frames"
    );
    assert!(
        last(&recorder) > 2000.0,
        "the tone did not come back: rms {}",
        last(&recorder)
    );
    // B's speakers were told it came after a pause, by A's own clock, so
    // they could hold its first word back rather than take it for late.
    assert!(
        recorder
            .1
            .lock()
            .unwrap()
            .contains(&(A.to_string(), before)),
        "no pause told before the tone came back: {:?}",
        recorder.1.lock().unwrap()
    );

    // Deafen also stops sending, even with the microphone asked to be on.
    a.set_controls(VoiceControls {
        muted: false,
        deafened: true,
    })
    .await;
    eased_out(
        &goes_quiet(&mut gateway, &mut rigs, &recorder).await,
        "deafen",
    );
    a.set_controls(VoiceControls::default()).await;
    assert!(hear(&mut gateway, &mut rigs, &recorder, 25).await);
    assert!(last(&recorder) > 2000.0);

    let of_a = b_log.talking(Some(A));
    assert!(
        of_a.starts_with(&[true, false, true]),
        "the talking mark did not follow the audio: {of_a:?}"
    );
    assert!(
        !b_log.talking(None).contains(&true),
        "a silent microphone was marked as talking"
    );
    a.leave().await;
    b.leave().await;
}

/// Push-to-talk (#232), through the server: with the key up, nothing loud
/// goes out from the very first frame, then nothing at all (#197: silence
/// isn't sent), and A is never marked talking; held, the tone goes out and A
/// lights up, for A and for B; let go, quiet and then nothing again. None of
/// it is a mute: A's only report to the room is the join, saying the
/// microphone is on.
#[tokio::test(flavor = "multi_thread")]
async fn push_to_talk_sends_nothing_through_the_server_until_the_key_is_held() {
    let room = RoomId::new();
    let mut gateway = Gateway::start(room);
    let (a, mut a_rx, a_log) = engine(A).await;
    let (b, mut b_rx, b_log) = engine(B).await;
    let recorder = Arc::new(Recorder::default());
    // The key is up before A joins, as the app arranges it.
    a.set_push_to_talk_closed(true);
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
    let mut rigs = [(A, &a, &mut a_rx), (B, &b, &mut b_rx)];

    // Key up: at most a few quiet frames reach B, then nothing.
    let key_up = goes_quiet(&mut gateway, &mut rigs, &recorder).await;
    eased_out(&key_up, "the key up");
    let loudest = key_up.iter().map(|frame| rms(frame)).fold(0.0, f64::max);
    assert!(
        loudest < 200.0,
        "the tone went out before the key was held: rms {loudest}"
    );
    assert!(
        a_log.talking(None).is_empty(),
        "A was marked talking with the key up"
    );

    // Held: the tone arrives, on the same connection.
    a.set_push_to_talk_closed(false);
    assert!(hear(&mut gateway, &mut rigs, &recorder, 25).await);
    assert!(
        last(&recorder) > 2000.0,
        "holding the key didn't open the microphone"
    );

    // Let go: quiet, then nothing again.
    a.set_push_to_talk_closed(true);
    eased_out(
        &goes_quiet(&mut gateway, &mut rigs, &recorder).await,
        "letting go",
    );

    assert_eq!(a_log.talking(None), vec![true, false]);
    let of_a = b_log.talking(Some(A));
    assert!(of_a.starts_with(&[true, false]), "B's mark for A: {of_a:?}");
    let from_a: Vec<Option<VoiceControls>> = gateway
        .joins
        .iter()
        .filter(|(session, _)| session == A)
        .map(|(_, controls)| *controls)
        .collect();
    assert_eq!(from_a, vec![Some(VoiceControls::default())]);
    a.leave().await;
    b.leave().await;
}

/// A crowd (#197): seven people talking at once, one far quieter than the
/// rest. Each engine puts how loud each frame is on its packets, and the
/// forwarding server passes on a room's six loudest voices by it. The quiet
/// one starts first and has a seat; once six louder ones are talking, it's
/// the one left out. Without the level it would have kept its seat, and one
/// of the six would have gone unheard.
#[tokio::test(flavor = "multi_thread")]
async fn past_six_talking_the_quietest_voice_is_left_out() {
    let room = RoomId::new();
    let mut gateway = Gateway::start(room);
    let names: Vec<String> = (0..7).map(|n| format!("talker-{n}")).collect();
    let quiet = &names[0];
    let (ear, mut ear_rx, _) = engine("ear").await;
    let recorder = Arc::new(Recorder::default());
    ear.join(
        room,
        Devices {
            source: Arc::new(Silence),
            sink: Arc::clone(&recorder) as Arc<dyn Sink>,
        },
        Vec::new(),
    )
    .await;
    let heard_from = |recorder: &Recorder| -> BTreeSet<String> {
        recorder
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|(peer, _)| peer.clone())
            .collect()
    };

    let mut rigs = Vec::new();
    let mut settled = false;
    for (n, name) in names.iter().enumerate() {
        let (engine, rx, _) = engine(name).await;
        // About 18 dB apart: somebody murmuring, then six shouting.
        let peak = if n == 0 { 1000.0 } else { 8000.0 };
        engine
            .join(
                room,
                Devices {
                    source: Arc::new(Tone::at(peak)),
                    sink: Arc::new(Discard),
                },
                Vec::new(),
            )
            .await;
        rigs.push((engine, rx));
        // The quiet one is heard, and has a seat, before anybody else talks.
        if n > 0 {
            continue;
        }
        for _ in 0..400 {
            let mut routed: Vec<Routed<'_>> = rigs
                .iter_mut()
                .zip(names.iter())
                .map(|((engine, rx), name)| (name.as_str(), &*engine, rx))
                .collect();
            routed.push(("ear", &ear, &mut ear_rx));
            gateway.route(&mut routed).await;
            if heard_from(&recorder).contains(quiet) {
                settled = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    assert!(settled, "the listener never heard the quiet one alone");

    let loud: BTreeSet<String> = names[1..].iter().cloned().collect();
    let mut all_six = false;
    for _ in 0..600 {
        let mut routed: Vec<Routed<'_>> = rigs
            .iter_mut()
            .zip(names.iter())
            .map(|((engine, rx), name)| (name.as_str(), &*engine, rx))
            .collect();
        routed.push(("ear", &ear, &mut ear_rx));
        gateway.route(&mut routed).await;
        if loud.is_subset(&heard_from(&recorder)) {
            all_six = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        all_six,
        "the listener heard only {:?}",
        heard_from(&recorder)
    );

    // The quiet one lost its seat to the last of the six, just now, and what
    // the server passed on of it before then may still be on its way here: on
    // a busy machine its last frames were played up to 15 ms after this point,
    // though the server had stopped passing it on 10–46 ms before (#461). So
    // wait until the listener has gone 200 ms without hearing it at all.
    let quiet_frames = |recorder: &Recorder| -> usize {
        recorder
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(peer, _)| peer == quiet)
            .count()
    };
    let mut drained = false;
    let mut still = 0;
    let mut seen = quiet_frames(&recorder);
    for _ in 0..200 {
        let mut routed: Vec<Routed<'_>> = rigs
            .iter_mut()
            .zip(names.iter())
            .map(|((engine, rx), name)| (name.as_str(), &*engine, rx))
            .collect();
        routed.push(("ear", &ear, &mut ear_rx));
        gateway.route(&mut routed).await;
        tokio::time::sleep(Duration::from_millis(25)).await;
        let now = quiet_frames(&recorder);
        still = if now == seen { still + 1 } else { 0 };
        seen = now;
        if still >= 8 {
            drained = true;
            break;
        }
    }
    assert!(drained, "the quiet one never stopped reaching the listener");

    // From here on: the six loud voices, and never the quiet one.
    recorder.0.lock().unwrap().clear();
    for _ in 0..60 {
        let mut routed: Vec<Routed<'_>> = rigs
            .iter_mut()
            .zip(names.iter())
            .map(|((engine, rx), name)| (name.as_str(), &*engine, rx))
            .collect();
        routed.push(("ear", &ear, &mut ear_rx));
        gateway.route(&mut routed).await;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let heard = heard_from(&recorder);
    assert!(
        !heard.contains(quiet),
        "the quietest of seven was passed on: {heard:?}"
    );
    assert_eq!(heard, loud, "the listener heard {heard:?}");
}
