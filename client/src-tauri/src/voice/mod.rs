//! Voice: one connection to the server's voice forwarding (SPEC §4.14,
//! ARCHITECTURE §2, #197).
//!
//! Audio lives in Rust rather than in the WebView, and this is where. The
//! server offers one `RTCPeerConnection` per client: an m-line for the
//! microphone, and one per other person in the room. This end only answers.
//! The mesh that came before it, one connection per pair of people, is gone
//! (#306).
//!
//! **The whole path is here.** Real DTLS, real ICE, real RTP, real sound:
//! `audio::Source` frames are Opus-encoded once and written to the outbound
//! track, and every inbound track is decoded and handed to the `audio::Sink`,
//! which mixes. The devices behind those two traits are `device.rs`; the tests
//! use the stand-ins in `audio.rs`.
//!
//! **Loopback proves little about a real network.** AGENTS §"Where you will be
//! wrong" is explicit that WebRTC written from memory works on localhost and
//! dies behind carrier-grade NAT. What the tests prove is that two engines and
//! the forwarding server on one machine negotiate, carry packets, and that a
//! tone sent by one comes out of the other's sink; the real-network checks are
//! what count.

pub mod audio;
pub mod codec;
pub mod device;
pub mod level;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use linger_core::gateway::{ClientFrame, VoiceControls, VoiceTrack};
use linger_core::RoomId;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
pub use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::media::Sample;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use audio::{Devices, Sink, Source};

/// Where a frame goes when this module wants to send one: joins, answers and
/// restarts, on their way to the gateway.
///
/// A trait rather than a channel to the gateway, so the tests can wire the
/// engines to a forwarding server in the same process and leave the gateway
/// out of it — a real socket in the middle would only make a failure harder
/// to read.
pub trait Signaller: Send + Sync + 'static {
    fn send(&self, frame: ClientFrame);
}

/// What the engine tells the app about.
///
/// Deliberately small: T-1404 draws the voice surface and will want more, but
/// inventing what it wants before it exists is how a callback ends up carrying
/// three fields nobody reads.
pub trait Watcher: Send + Sync + 'static {
    /// The connection carrying somebody's voice changed state — `connected`,
    /// `failed`, `closed` — named by their session id.
    fn peer_state(&self, peer: &str, state: &str);

    /// Our own audio changed state: `sending` when the microphone loop is
    /// running, `stopped` when it ended on its own — a device that went away
    /// — or a reason it could not start. Not a peer's business, so not
    /// `peer_state`.
    fn audio_state(&self, _state: &str) {}

    /// Somebody started or stopped talking. `None` is you — what the
    /// microphone is sending, after mute — so the surface can show that the
    /// mic is live in the same way it shows everybody else. Fired on change
    /// only (see `level::Gate`), so a quiet room sends nothing.
    fn speaking(&self, _peer: Option<&str>, _speaking: bool) {}

    /// The microphone picked by name wouldn't open, so the default is in its
    /// place, or (`None`) that's over: another device picked, or the call
    /// rejoined. Fired on change only (#398).
    fn microphone_refused(&self, _refused: Option<&audio::Refused>) {}
}

/// The one connection to the server's voice forwarding (#197). The server
/// makes every offer; this end only answers.
struct Forward {
    conn: Arc<RTCPeerConnection>,
    /// What we send the server: the microphone, once, for everybody.
    outbound: Arc<TrackLocalStaticSample>,
}

/// Voice, and everything it is doing.
pub struct Engine<S: Signaller, W: Watcher> {
    signaller: Arc<S>,
    watcher: Arc<W>,
    ice_servers: Vec<RTCIceServer>,
    /// Shared with the sending loop and every inbound track's reader, which
    /// is why it is an `Arc` rather than a field.
    inner: Arc<Mutex<Inner>>,
    /// Mute is yours and local (SPEC §4.14). The sending loop reads it every
    /// frame and sends silence while it is set — silence rather than nothing,
    /// so the far end's decoder keeps its clock.
    muted: Arc<AtomicBool>,
    /// Push-to-talk's closed microphone (#232): silence while the key is up,
    /// exactly as mute sends it, but never reported to the room. Not holding
    /// the key isn't muting yourself, so nobody is shown a mute for it; they
    /// hear you when you hold it, and the "talking" mark follows the audio.
    push_to_talk_closed: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    controls: VoiceControls,
    /// Our own session id, once the gateway has told us. It names the
    /// microphone's track.
    me: Option<String>,
    room: Option<RoomId>,
    /// The microphone and the speakers, while we are in voice. Dropping them
    /// is what closes the devices.
    devices: Option<Devices>,
    /// The loop that carries microphone frames to the server.
    pump: Option<JoinHandle<()>>,
    /// STUN and TURN for this call, fetched from the server at join (T-1403).
    /// Empty means host candidates only: one network, and nothing beyond it.
    ice_servers: Vec<RTCIceServer>,
    /// The connection to the forwarding server, once it has offered one.
    forward: Option<Forward>,
    /// Whose voice each receiving m-line carries, by mid, from the latest
    /// `voice.offer`.
    tracks: BTreeMap<String, String>,
}

impl<S: Signaller, W: Watcher> Engine<S, W> {
    /// `ice_servers` is STUN and, later, TURN (T-1403). Empty means host
    /// candidates only, which is enough for two machines on one network and
    /// nothing else — that is the whole reason T-1403 exists.
    #[must_use]
    pub fn new(signaller: Arc<S>, watcher: Arc<W>, ice_servers: Vec<RTCIceServer>) -> Self {
        Self {
            signaller,
            watcher,
            ice_servers,
            inner: Arc::new(Mutex::new(Inner::default())),
            muted: Arc::new(AtomicBool::new(false)),
            push_to_talk_closed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Talk and listen through other devices in the call you are in, without
    /// leaving it (#249). `None` is the system default. Only a device that
    /// changed is reopened; the call carries on over the moment it takes.
    /// Answers whether there was a call to change: outside one, the choice
    /// is only Settings' and the next join opens it.
    pub async fn choose_devices(&self, input: Option<&str>, output: Option<&str>) -> bool {
        let inner = self.inner.lock().await;
        let Some(devices) = &inner.devices else {
            return false;
        };
        devices.source.choose(input);
        devices.sink.choose(output);
        true
    }

    /// Stop or resume sending what the microphone hears, and tell the room
    /// (SPEC §4.14): mute and deafen are choices the room can see. Local,
    /// instant, and nobody else's to change. Push-to-talk is not this; see
    /// `set_push_to_talk_closed`.
    pub async fn set_controls(&self, controls: VoiceControls) {
        let controls = controls.normalized();
        let mut inner = self.inner.lock().await;
        // Close the mic before silencing playback; reopen it only after the
        // speaker gate has been restored. Both choices are one serialized change.
        if controls.muted {
            self.muted.store(true, Ordering::Relaxed);
        }
        if let Some(devices) = &inner.devices {
            devices.sink.set_deafened(controls.deafened).await;
        }
        self.muted.store(controls.muted, Ordering::Relaxed);
        let changed = inner.controls != controls;
        inner.controls = controls;
        if changed {
            if let Some(room_id) = inner.room {
                self.signaller.send(ClientFrame::VoiceJoin {
                    room_id,
                    controls: Some(controls),
                    forwarding: Some(true),
                });
            }
        }
    }

    /// Whether mute or deafen has the microphone closed: the state the room
    /// is told about.
    #[must_use]
    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    /// Close or open the microphone for push-to-talk (#232): closed while the
    /// key is up, open while it is held. It sends silence just as mute does,
    /// but it is not a mute and nothing goes to the server: the room sees no
    /// "muted" for somebody who simply isn't holding the key. Mute and deafen
    /// still close the microphone whatever this says.
    ///
    /// Set before `join` when push-to-talk is on, so not one frame of the
    /// room goes out before the key is held.
    pub fn set_push_to_talk_closed(&self, closed: bool) {
        self.push_to_talk_closed.store(closed, Ordering::Relaxed);
    }

    /// Whether push-to-talk has the microphone closed.
    #[must_use]
    pub fn is_push_to_talk_closed(&self) -> bool {
        self.push_to_talk_closed.load(Ordering::Relaxed)
    }

    /// One of Linger's own sounds, into the call's own speakers, over the
    /// voices (#250). Answers whether there was a call to play it in.
    pub async fn cue(&self, samples: &[i16]) -> bool {
        let sink = self
            .inner
            .lock()
            .await
            .devices
            .as_ref()
            .map(|d| Arc::clone(&d.sink));
        sink.is_some_and(|sink| sink.cue(samples))
    }

    /// How loud one peer plays for you. Nothing crosses the wire.
    pub async fn set_volume(&self, peer: &str, volume: f32) {
        let sink = self
            .inner
            .lock()
            .await
            .devices
            .as_ref()
            .map(|d| Arc::clone(&d.sink));
        if let Some(sink) = sink {
            sink.set_volume(peer, volume).await;
        }
    }

    /// Our own session id, from the gateway's `ready`.
    pub async fn set_session(&self, session_id: String) {
        self.inner.lock().await.me = Some(session_id);
    }

    /// Ask to join voice in a room, with the devices to do it through and the
    /// STUN/TURN servers the host's server handed out for it (T-1403).
    ///
    /// The connection is not built here — it is built when the server's
    /// `voice.offer` arrives (`on_offer`). What *does* start here is the
    /// sending loop: it encodes frames from the moment we join and writes them
    /// to the connection once it exists, so the first word after it comes up
    /// is not waiting on anything. The join says `forwarding`, which every
    /// server that carries voice now asks for (#306).
    pub async fn join(&self, room_id: RoomId, devices: Devices, ice_servers: Vec<RTCIceServer>) {
        let source = Arc::clone(&devices.source);
        let previous = {
            let mut inner = self.inner.lock().await;
            devices.sink.set_deafened(inner.controls.deafened).await;
            inner.room = Some(room_id);
            inner.devices = Some(devices);
            // The server's relay for this call, or whatever the engine was built
            // with when the server offered none.
            inner.ice_servers = if ice_servers.is_empty() {
                self.ice_servers.clone()
            } else {
                ice_servers
            };
            inner.pump.take()
        };
        if let Some(previous) = previous {
            previous.abort();
        }
        let pump = tokio::spawn(pump(
            Arc::clone(&self.inner),
            source,
            Arc::clone(&self.watcher),
            Closed {
                muted: Arc::clone(&self.muted),
                push_to_talk: Arc::clone(&self.push_to_talk_closed),
            },
        ));
        self.inner.lock().await.pump = Some(pump);
        let inner = self.inner.lock().await;
        self.signaller.send(ClientFrame::VoiceJoin {
            room_id,
            controls: Some(inner.controls),
            forwarding: Some(true),
        });
    }

    /// Leave, and close the connection whether or not the server answers.
    ///
    /// The devices go too: leaving voice is the microphone turning off, and
    /// dropping the `Devices` is what closes it.
    pub async fn leave(&self) {
        self.signaller.send(ClientFrame::VoiceLeave);
        let (devices, pump, forward, tracks) = {
            let mut inner = self.inner.lock().await;
            inner.room = None;
            (
                inner.devices.take(),
                inner.pump.take(),
                inner.forward.take(),
                std::mem::take(&mut inner.tracks),
            )
        };
        if let Some(forward) = forward {
            let _ = forward.conn.close().await;
        }
        for session in tracks.into_values() {
            if let Some(devices) = &devices {
                devices.sink.forget(&session).await;
            }
            self.watcher.peer_state(&session, "closed");
        }
        if let Some(pump) = pump {
            // Abort, then wait for it to be gone: the loop holds the source,
            // and the microphone only closes once nobody does.
            pump.abort();
            let _ = pump.await;
        }
        // Closing the devices can block briefly while the audio threads are
        // joined, so it is done off the reactor.
        if let Some(devices) = devices {
            let _ = tokio::task::spawn_blocking(move || drop(devices)).await;
        }
    }

    /// The forwarding server's offer (#197): answer it, on the one connection.
    pub async fn on_offer(&self, sdp: &str, tracks: &[VoiceTrack]) {
        if let Err(error) = self.apply_offer(sdp, tracks).await {
            tracing_error("the forwarding server", &error);
        }
    }

    async fn apply_offer(&self, sdp: &str, tracks: &[VoiceTrack]) -> Result<(), webrtc::Error> {
        let (conn, gone, sink) = {
            let mut inner = self.inner.lock().await;
            if inner.room.is_none() {
                return Ok(());
            }
            let named: BTreeMap<String, String> = tracks
                .iter()
                .map(|track| (track.mid.clone(), track.session_id.clone()))
                .collect();
            let still: BTreeSet<&String> = named.values().collect();
            let gone: Vec<String> = inner
                .tracks
                .values()
                .filter(|session| !still.contains(session))
                .cloned()
                .collect();
            inner.tracks = named;
            (
                inner
                    .forward
                    .as_ref()
                    .map(|forward| Arc::clone(&forward.conn)),
                gone,
                inner.devices.as_ref().map(|d| Arc::clone(&d.sink)),
            )
        };
        for session in gone {
            if let Some(sink) = &sink {
                sink.forget(&session).await;
            }
            self.watcher.peer_state(&session, "closed");
        }
        let conn = match conn {
            Some(conn) => conn,
            None => self.open_forward().await?,
        };
        conn.set_remote_description(RTCSessionDescription::offer(sdp.to_string())?)
            .await?;
        let answer = conn.create_answer(None).await?;
        conn.set_local_description(answer.clone()).await?;
        self.signaller
            .send(ClientFrame::VoiceAnswer { sdp: answer.sdp });
        // Somebody new, on a connection that's already up, is reachable now.
        if conn.connection_state() == RTCPeerConnectionState::Connected {
            for track in tracks {
                self.watcher.peer_state(&track.session_id, "connected");
            }
        }
        Ok(())
    }

    /// Build the connection to the forwarding server. The microphone's
    /// transceiver is made first, send-only and with no mid, so the server's
    /// receiving m-line takes it; every other m-line in the offer is somebody's
    /// voice coming in.
    async fn open_forward(&self) -> Result<Arc<RTCPeerConnection>, webrtc::Error> {
        let (ice_servers, me) = {
            let inner = self.inner.lock().await;
            (
                inner.ice_servers.clone(),
                inner.me.clone().unwrap_or_default(),
            )
        };
        let conn = Arc::new(
            build_api()?
                .new_peer_connection(RTCConfiguration {
                    ice_servers,
                    ..Default::default()
                })
                .await?,
        );
        let outbound = Arc::new(TrackLocalStaticSample::new(
            opus_capability(),
            "audio".to_owned(),
            format!("linger-{me}"),
        ));
        let transceiver = conn
            .add_transceiver_from_track(
                Arc::clone(&outbound) as Arc<_>,
                Some(RTCRtpTransceiverInit {
                    direction: RTCRtpTransceiverDirection::Sendonly,
                    send_encodings: vec![],
                }),
            )
            .await?;
        let sender = transceiver.sender().await;
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 1500];
            while sender.read(&mut buffer).await.is_ok() {}
        });

        // Their voices, each on its own m-line: whose it is comes from the
        // latest offer, looked up as the packets arrive, since the server can
        // hand a stopped m-line to somebody else later.
        let inner = Arc::clone(&self.inner);
        let ears = Arc::clone(&self.watcher);
        conn.on_track(Box::new(move |track, _receiver, transceiver| {
            let inner = Arc::clone(&inner);
            let ears = Arc::clone(&ears);
            Box::pin(async move {
                let Some(mid) = transceiver.mid().map(|mid| mid.to_string()) else {
                    return;
                };
                let sink = inner
                    .lock()
                    .await
                    .devices
                    .as_ref()
                    .map(|d| Arc::clone(&d.sink));
                let Some(sink) = sink else { return };
                tokio::spawn(receive_forwarded(track, mid, inner, sink, ears));
            })
        }));

        // One connection carries everybody, so its state is everybody's. A
        // failed one is started afresh after a moment, while we're still in
        // voice, so a network blip doesn't leave the room silent.
        let inner = Arc::clone(&self.inner);
        let watcher = Arc::clone(&self.watcher);
        let signaller = Arc::clone(&self.signaller);
        let this = Arc::downgrade(&conn);
        conn.on_peer_connection_state_change(Box::new(move |state| {
            let inner = Arc::clone(&inner);
            let watcher = Arc::clone(&watcher);
            let signaller = Arc::clone(&signaller);
            let this = this.clone();
            Box::pin(async move {
                let sessions: Vec<String> = inner.lock().await.tracks.values().cloned().collect();
                for session in &sessions {
                    watcher.peer_state(session, &state.to_string());
                }
                if state == RTCPeerConnectionState::Failed {
                    tokio::spawn(async move {
                        tokio::time::sleep(RESTART_AFTER).await;
                        let current = inner.lock().await.forward.as_ref().is_some_and(|forward| {
                            std::ptr::eq(Arc::as_ptr(&forward.conn), this.as_ptr())
                        });
                        if current {
                            restart_forward(&inner, &*signaller, &*watcher).await;
                        }
                    });
                }
            })
        }));

        self.inner.lock().await.forward = Some(Forward {
            conn: Arc::clone(&conn),
            outbound,
        });
        Ok(conn)
    }

    /// Start the connection to the forwarding server afresh, without leaving
    /// voice: the old one is closed and the server is asked for a new offer.
    /// Called on its own when the connection fails; public for the tests.
    pub async fn restart_forward(&self) {
        restart_forward(&self.inner, &*self.signaller, &*self.watcher).await;
    }

    /// Whether the connection to the forwarding server is up.
    pub async fn is_forward_connected(&self) -> bool {
        let conn = self
            .inner
            .lock()
            .await
            .forward
            .as_ref()
            .map(|forward| Arc::clone(&forward.conn));
        conn.is_some_and(|conn| conn.connection_state() == RTCPeerConnectionState::Connected)
    }
}

/// The two things that close the microphone, as the sending loop reads them.
struct Closed {
    /// Mute or deafen: reported to the room.
    muted: Arc<AtomicBool>,
    /// Push-to-talk with its key up: not reported (#232).
    push_to_talk: Arc<AtomicBool>,
}

impl Closed {
    /// Whether this frame goes out as silence.
    fn now(&self) -> bool {
        self.muted.load(Ordering::Relaxed) || self.push_to_talk.load(Ordering::Relaxed)
    }
}

/// The sending loop: microphone frames, encoded once, to the server, which
/// passes them on to everybody else in the room (#197). The loop paces itself
/// on the source — a microphone delivers a frame every 20 ms, and so do the
/// stand-ins.
///
/// Mute and push-to-talk are applied here, by encoding a frame of zeros in
/// place of the real one; the level gate sees what is *sent*, so the "you
/// are talking" mark goes out when the microphone does. Silence isn't sent
/// at all (#197): Opus's DTX eases out over a few quiet frames and then
/// hands back only "still quiet", which stays here, and the next frame sent
/// says how many weren't, so the far end's clock keeps time.
///
/// It ends when the source does. That is a microphone that went away, and
/// until T-1405 makes it recover, the honest thing is to say so and stop.
async fn pump<W: Watcher>(
    inner: Arc<Mutex<Inner>>,
    source: Arc<dyn Source>,
    watcher: Arc<W>,
    closed: Closed,
) {
    let mut encoder = match codec::Encoder::new() {
        Ok(encoder) => encoder,
        Err(error) => {
            watcher.audio_state(&format!("encoder: {error}"));
            return;
        }
    };
    let mut gate = level::Gate::default();
    let mut refused = None;
    // Frames left unsent since the last one sent: silence (#197).
    let mut unsent: u16 = 0;
    let quiet = vec![0i16; audio::FRAME_SAMPLES];
    watcher.audio_state("sending");
    while let Some(frame) = source.frame().await {
        // Read on every frame, since the device under the source can change
        // in a call (#249); said only when it does.
        let now = source.refused();
        if now != refused {
            watcher.microphone_refused(now.as_ref());
            refused = now;
        }
        let frame = if closed.now() { &quiet } else { &frame };
        if let Some(talking) = gate.update(level::rms(frame), Instant::now()) {
            watcher.speaking(None, talking);
        }
        let packet = match encoder.encode(frame) {
            Ok(packet) => packet,
            Err(error) => {
                eprintln!("voice: encode: {error}");
                continue;
            }
        };
        // Silence isn't sent (#197), as Discord doesn't send it: in a room of
        // fifty, everybody not talking sends nothing. Muted and push-to-talk
        // are silence too, so they stop sending as well.
        if codec::is_silence(&packet) || encoder.was_silence() {
            unsent = unsent.saturating_add(1);
            continue;
        }
        let track = inner
            .lock()
            .await
            .forward
            .as_ref()
            .map(|forward| Arc::clone(&forward.outbound));
        let sample = Sample {
            data: Bytes::from(packet),
            duration: Duration::from_millis(u64::from(audio::FRAME_MS)),
            // The frames not sent move this packet's timestamp on by their
            // length, so the far end's clock keeps time across the pause.
            prev_dropped_packets: std::mem::take(&mut unsent),
            ..Default::default()
        };
        if let Some(track) = track {
            // A track whose connection is not up yet writes to nobody and
            // says so; that is the first second of every call, not an error.
            let _ = track.write_sample(&sample).await;
        }
    }
    if gate.is_on() {
        watcher.speaking(None, false);
    }
    watcher.audio_state("stopped");
}

/// How long a failed connection to the forwarding server waits before it is
/// started afresh: long enough not to hammer a server that's restarting.
const RESTART_AFTER: Duration = Duration::from_secs(3);

/// Close the connection to the forwarding server, forget whose voice it
/// carried, and ask the server for a new offer. Nothing happens unless we're
/// in voice.
async fn restart_forward<S: Signaller, W: Watcher>(
    inner: &Mutex<Inner>,
    signaller: &S,
    watcher: &W,
) {
    let (forward, tracks, sink) = {
        let mut held = inner.lock().await;
        if held.room.is_none() {
            return;
        }
        (
            held.forward.take(),
            std::mem::take(&mut held.tracks),
            held.devices.as_ref().map(|d| Arc::clone(&d.sink)),
        )
    };
    if let Some(forward) = forward {
        let _ = forward.conn.close().await;
    }
    for session in tracks.into_values() {
        if let Some(sink) = &sink {
            sink.forget(&session).await;
        }
        watcher.peer_state(&session, "connecting");
    }
    signaller.send(ClientFrame::VoiceRestart);
}

/// A WebRTC API with the default codecs and interceptors: NACKs, reports.
fn build_api() -> Result<webrtc::api::API, webrtc::Error> {
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media)?;
    Ok(APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .build())
}

/// Opus, as WebRTC audio is.
fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: audio::SAMPLE_RATE,
        channels: audio::CHANNELS,
        ..Default::default()
    }
}

/// The receiving loop for one m-line from the forwarding server (#197): RTP
/// in, frames to the sink. Whose voice it is comes from the latest offer,
/// looked up as packets arrive. A stopped m-line the server later reuses for
/// somebody else starts them with a fresh decoder, and the last person's
/// "talking" mark goes out.
///
/// An Opus RTP payload is one Opus packet (RFC 7587), so there is nothing to
/// reassemble. Sequence numbers are watched for the one thing worth doing
/// about a gap: asking the decoder to conceal each missing frame, so a lost
/// packet is a smear rather than a click, and the far end's clock keeps its
/// place. A gap of more than a few is a pause, not loss, and is left alone.
/// The level gate runs on what was decoded, so "they are talking" is judged
/// on the same samples that reach the speaker.
async fn receive_forwarded<W: Watcher>(
    track: Arc<TrackRemote>,
    mid: String,
    inner: Arc<Mutex<Inner>>,
    sink: Arc<dyn Sink>,
    watcher: Arc<W>,
) {
    let mut current: Option<(String, codec::Decoder, level::Gate)> = None;
    let mut expected: Option<u16> = None;
    loop {
        // Somebody who stops talking stops sending (#197), so their light
        // goes off when nothing has come for as long as a pause takes.
        let packet = match tokio::time::timeout(level::HANGOVER, track.read_rtp()).await {
            Ok(Ok((packet, _))) => packet,
            Ok(Err(_)) => break,
            Err(_quiet) => {
                if let Some((who, _, gate)) = current.as_mut() {
                    if let Some(talking) = gate.update(0.0, Instant::now()) {
                        watcher.speaking(Some(who), talking);
                    }
                }
                continue;
            }
        };
        let Some(peer) = inner.lock().await.tracks.get(&mid).cloned() else {
            continue;
        };
        if current.as_ref().is_none_or(|(who, _, _)| *who != peer) {
            if let Some((who, _, gate)) = current.take() {
                if gate.is_on() {
                    watcher.speaking(Some(&who), false);
                }
            }
            match codec::Decoder::new() {
                Ok(decoder) => current = Some((peer.clone(), decoder, level::Gate::default())),
                Err(error) => {
                    eprintln!("voice: {peer}: decoder: {error}");
                    return;
                }
            }
            expected = None;
        }
        let Some((who, decoder, gate)) = current.as_mut() else {
            continue;
        };
        let sequence = packet.header.sequence_number;
        if let Some(expected) = expected {
            let gap = sequence.wrapping_sub(expected);
            if (1..5).contains(&gap) {
                for _ in 0..gap {
                    if let Ok(guess) = decoder.conceal() {
                        sink.play(who, &guess).await;
                    }
                }
            }
        }
        expected = Some(sequence.wrapping_add(1));
        if packet.payload.is_empty() {
            continue;
        }
        match decoder.decode(&packet.payload) {
            Ok(samples) => {
                if let Some(talking) = gate.update(level::rms(&samples), Instant::now()) {
                    watcher.speaking(Some(who), talking);
                }
                sink.play(who, &samples).await;
            }
            Err(error) => eprintln!("voice: {who}: decode: {error}"),
        }
    }
    if let Some((who, _, gate)) = current {
        if gate.is_on() {
            watcher.speaking(Some(&who), false);
        }
    }
}

/// Somewhere for an error to go that is not a panic and not silence.
///
/// An offer that couldn't be answered is not fatal — the next offer, or a
/// restart, tries again — so a failure here has to be visible without taking
/// the call down with it.
fn tracing_error(peer: &str, error: &webrtc::Error) {
    eprintln!("voice: peer {peer}: {error}");
}
