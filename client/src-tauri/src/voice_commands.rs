//! Voice's Tauri commands, and what connects the engine (`voice/`) to the
//! gateway and the window. Kept apart from `lib.rs` so the phone app, which is
//! text only for now (SPEC §4.15), leaves all of it out with one switch.
//!
//! `sound_play` is here too: it plays through a call's own speaker when there
//! is one, and opens the voice engine's speaker when there isn't.

use std::collections::HashMap;
use std::sync::Mutex;

use linger_core::gateway::{ClientFrame, ServerFrame};
use linger_core::RoomId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::{sounds, voice, Connections};

/// Sends one server's voice frames (joins, answers, restarts) back down its
/// gateway connection.
///
/// The engine does not know what a server is — it produces `ClientFrame`s and
/// this puts them on the right socket, which is the same thing the frontend's
/// `gateway_send` does for everything else.
struct VoiceWire {
    app: AppHandle,
    server: String,
}

impl voice::Signaller for VoiceWire {
    fn send(&self, frame: ClientFrame) {
        // The connection is Tauri state rather than something this holds: a
        // signaller that owned a handle would keep a dead socket alive after a
        // reconnect replaced it, and voice would go quiet with everything
        // looking fine.
        let connections = self.app.state::<Connections>();
        connections.with(|held| {
            if let Some(handle) = held.get(&self.server) {
                handle.send(frame);
            }
        });
    }
}

/// One peer's connection state, on its way to the window.
#[derive(Clone, Serialize)]
struct VoicePeerEvent<'a> {
    server: &'a str,
    peer: &'a str,
    state: &'a str,
}

/// Tells the window when a peer connects, fails or goes.
struct VoiceWatcher {
    app: AppHandle,
    server: String,
}

impl voice::Watcher for VoiceWatcher {
    fn peer_state(&self, peer: &str, state: &str) {
        let _ = self.app.emit(
            VOICE_PEER_EVENT,
            VoicePeerEvent {
                server: &self.server,
                peer,
                state,
            },
        );
    }

    fn audio_state(&self, state: &str) {
        let _ = self.app.emit(
            VOICE_AUDIO_EVENT,
            VoiceAudioEvent {
                server: &self.server,
                state,
            },
        );
    }

    fn speaking(&self, peer: Option<&str>, speaking: bool) {
        let _ = self.app.emit(
            VOICE_SPEAKING_EVENT,
            VoiceSpeakingEvent {
                server: &self.server,
                peer,
                speaking,
            },
        );
    }

    fn microphone_refused(&self, refused: Option<&voice::audio::Refused>) {
        let _ = self.app.emit(
            VOICE_MICROPHONE_EVENT,
            VoiceMicrophoneEvent {
                server: &self.server,
                refused: refused.map(|refused| RefusedMicrophone {
                    name: &refused.name,
                    why: &refused.why,
                }),
            },
        );
    }
}

/// The microphone picked in Settings wouldn't open, so the system default is
/// in its place (#398); `refused` null when that's over.
#[derive(Clone, Serialize)]
struct VoiceMicrophoneEvent<'a> {
    server: &'a str,
    refused: Option<RefusedMicrophone<'a>>,
}

/// Which microphone, by the name it was picked by, and why, in the system's words.
#[derive(Clone, Serialize)]
struct RefusedMicrophone<'a> {
    name: &'a str,
    why: &'a str,
}

/// The event a picked microphone refusing, or no longer, arrives on.
pub const VOICE_MICROPHONE_EVENT: &str = "voice:microphone";

/// Somebody started or stopped talking. `peer` is null for you.
#[derive(Clone, Serialize)]
struct VoiceSpeakingEvent<'a> {
    server: &'a str,
    peer: Option<&'a str>,
    speaking: bool,
}

/// The event a change in who is talking arrives on.
pub const VOICE_SPEAKING_EVENT: &str = "voice:speaking";

/// Our own microphone's state, on its way to the window: `sending`, or
/// `stopped` when the device went away mid-call.
#[derive(Clone, Serialize)]
struct VoiceAudioEvent<'a> {
    server: &'a str,
    state: &'a str,
}

/// The event a voice peer's state change arrives on.
pub const VOICE_PEER_EVENT: &str = "voice:peer";

/// The event our own audio's state change arrives on.
pub const VOICE_AUDIO_EVENT: &str = "voice:audio";

type VoiceEngine = voice::Engine<VoiceWire, VoiceWatcher>;

/// One voice engine per server. A person can be signed into several and is in
/// voice on at most one, but which one is theirs to decide, and an engine per
/// server is what makes "leave the one you were in" a local question.
#[derive(Default)]
pub(crate) struct VoiceEngines(Mutex<HashMap<String, std::sync::Arc<VoiceEngine>>>);

impl VoiceEngines {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, std::sync::Arc<VoiceEngine>>) -> T) -> T {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut held)
    }
}

/// Get (or build) the voice engine for one server.
fn engine_for(app: &AppHandle, base_url: &str) -> std::sync::Arc<VoiceEngine> {
    let engines = app.state::<VoiceEngines>();
    engines.with(|held| {
        std::sync::Arc::clone(held.entry(base_url.to_string()).or_insert_with(|| {
            std::sync::Arc::new(voice::Engine::new(
                std::sync::Arc::new(VoiceWire {
                    app: app.clone(),
                    server: base_url.to_string(),
                }),
                std::sync::Arc::new(VoiceWatcher {
                    app: app.clone(),
                    server: base_url.to_string(),
                }),
                // No ICE servers yet. Host candidates alone reach another
                // machine on the same network and nothing beyond it — which is
                // the whole reason T-1403 (a TURN server in the deploy) is its
                // own task, and why this list being empty is a gap rather than
                // a default.
                Vec::new(),
            ))
        }))
    })
}

/// Join voice in a room (SPEC §4.14).
///
/// Joining is turning the microphone on, so the default microphone and the
/// default speakers are opened here, and a machine with neither gets an error
/// in words rather than a seat in voice it cannot use. Opening a device can
/// block for a moment, so it happens off the reactor.
///
/// The connection is not built here: it is built when the server's
/// `voice.offer` arrives (`voice_frame`).
// A Tauri command's arguments are the frontend's named fields, so they can't
// be gathered into a struct without changing every caller's invoke.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn voice_join(
    app: AppHandle,
    base_url: String,
    session_id: String,
    room_id: RoomId,
    input: Option<String>,
    output: Option<String>,
    ice: Vec<linger_core::wire::IceServer>,
) -> Result<(), String> {
    let engine = engine_for(&app, &base_url);
    engine.set_session(session_id).await;
    let devices = tokio::task::spawn_blocking(move || {
        voice::device::open(input.as_deref(), output.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;
    // The server's relay for this call (T-1403), in the shape the connection
    // takes. Empty when the host runs none, and then a client that can't
    // reach the server's UDP port directly can't be heard.
    let ice = ice
        .into_iter()
        .map(|server| voice::RTCIceServer {
            urls: server.urls,
            username: server.username.unwrap_or_default(),
            credential: server.credential.unwrap_or_default(),
        })
        .collect();
    engine.join(room_id, devices, ice).await;
    Ok(())
}

/// Mute and deafen: stop or resume sending the microphone, and tell the room.
/// Yours alone (SPEC §4.14); the surface's mute and deafen buttons land here.
#[tauri::command]
pub async fn voice_controls(
    app: AppHandle,
    base_url: String,
    controls: linger_core::gateway::VoiceControls,
) {
    engine_for(&app, &base_url).set_controls(controls).await;
}

/// Push-to-talk's key: the microphone closed while it is up, open while it is
/// held. Nothing is told to the room (#232), so not holding the key never
/// shows as a mute.
#[tauri::command]
pub async fn voice_push_to_talk(app: AppHandle, base_url: String, closed: bool) {
    engine_for(&app, &base_url).set_push_to_talk_closed(closed);
}

/// Other devices picked in Settings while in a call (#249): the call carries
/// on through them, without leaving. `None` is the system default. Whichever
/// server's engine holds the call is the one that changes.
#[tauri::command]
pub async fn voice_choose_devices(app: AppHandle, input: Option<String>, output: Option<String>) {
    let engines: Vec<_> = app
        .state::<VoiceEngines>()
        .with(|held| held.values().map(std::sync::Arc::clone).collect());
    for engine in engines {
        engine
            .choose_devices(input.as_deref(), output.as_deref())
            .await;
    }
}

/// Play one of Linger's own sounds on the Speakers picked in Settings (#250):
/// mono samples at 48 kHz, already at the sound volume. In a call it is mixed
/// into the call's own speaker; otherwise a speaker is opened for it, and
/// closed again once no sound has played for a while (`sounds.rs`). Answers
/// whether it played: the page plays it through Web Audio when it didn't.
#[tauri::command]
pub async fn sound_play(app: AppHandle, samples: Vec<i16>, output: Option<String>) -> bool {
    let Some(samples) = sounds::checked(samples) else {
        return false;
    };
    let engines: Vec<_> = app
        .state::<VoiceEngines>()
        .with(|held| held.values().map(std::sync::Arc::clone).collect());
    for engine in engines {
        if engine.cue(&samples).await {
            return true;
        }
    }
    let sounds = std::sync::Arc::clone(app.state::<std::sync::Arc<sounds::Sounds>>().inner());
    let playing = std::sync::Arc::clone(&sounds);
    match tokio::task::spawn_blocking(move || playing.play(&samples, output.as_deref())).await {
        Ok(Ok(())) => {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(sounds::KEEP_OPEN).await;
                let _ =
                    tokio::task::spawn_blocking(move || sounds.close_idle(sounds::KEEP_OPEN)).await;
            });
            true
        }
        Ok(Err(error)) => {
            eprintln!("sounds: {error}");
            false
        }
        Err(_) => false,
    }
}

/// How loud one peer plays for you, 1.0 being as sent.
#[tauri::command]
pub async fn voice_volume(app: AppHandle, base_url: String, peer: String, volume: f32) {
    engine_for(&app, &base_url).set_volume(&peer, volume).await;
}

/// The sound devices on this machine, for the picker. Enumeration can block
/// for a moment, so it is done off the reactor.
#[tauri::command]
pub async fn voice_devices() -> Result<voice::device::DeviceList, String> {
    tokio::task::spawn_blocking(voice::device::list)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Leave voice, and close the connection whether or not the server answers.
#[tauri::command]
pub async fn voice_leave(app: AppHandle, base_url: String) {
    let engine = engine_for(&app, &base_url);
    engine.leave().await;
}

/// Hand the engine a voice frame that arrived on the gateway.
///
/// The frontend routes these rather than the gateway client doing it directly,
/// for the same reason every other frame goes to the frontend first: the store
/// is the one place that knows which server is which and what state it is in.
#[tauri::command]
pub async fn voice_frame(app: AppHandle, base_url: String, frame: ServerFrame) {
    let engine = engine_for(&app, &base_url);
    // The forwarding server's offer is the one frame the engine acts on
    // (#197). Who is in voice is the frontend's to draw.
    if let linger_core::gateway::ServerEvent::VoiceOffer {
        sdp,
        tracks,
        bitrate,
    } = frame.event
    {
        engine.on_offer(&sdp, &tracks, bitrate).await;
    }
}
