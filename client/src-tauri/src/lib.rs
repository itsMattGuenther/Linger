//! Tauri shell. The WebView gets the minimum permission surface (ARCHITECTURE §7):
//! every native capability it has is one narrow command in this crate, and it
//! has no others.

pub mod gateway;
pub mod graphics;
mod notifications;
pub mod packaging;
mod secrets;
mod updates;
pub mod voice;
mod window;

use std::collections::HashMap;
use std::sync::Mutex;

use linger_core::gateway::{ClientFrame, ServerFrame};
use linger_core::RoomId;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use secrets::{SessionWrite, SessionsLoad, StoredSession};

/// Keyring calls talk to a system daemon and can block for as long as it takes
/// the user to unlock a wallet, so they never run on a runtime thread. A task
/// that dies still has to produce an answer — the frontend must always get one.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    on_lost: impl FnOnce() -> T,
) -> T {
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(value) => value,
        Err(_) => on_lost(),
    }
}

fn lost_worker() -> String {
    "The keyring lookup didn't finish.".to_string()
}

/// Read every saved sign-in on startup, oldest server first. Never fails:
/// "there is no keyring here" comes back as `unavailable` so the app can ask
/// for a fresh sign-in.
#[tauri::command]
async fn sessions_load() -> SessionsLoad {
    off_thread(secrets::load, || SessionsLoad::Unavailable {
        reason: lost_worker(),
    })
    .await
}

/// Save one server's session after a sign-in or a token refresh. Saving a
/// server that is already stored replaces its token and leaves the rest alone.
#[tauri::command]
async fn session_save(session: StoredSession) -> SessionWrite {
    off_thread(
        move || secrets::save(&session),
        || SessionWrite::Unavailable {
            reason: lost_worker(),
        },
    )
    .await
}

/// Forget one server on sign-out, or when it rejects our token. The other
/// servers' sign-ins are untouched.
#[tauri::command]
async fn session_forget(base_url: String) -> SessionWrite {
    off_thread(
        move || secrets::forget(&base_url),
        || SessionWrite::Unavailable {
            reason: lost_worker(),
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/// The live gateway connections, one per server, keyed by base URL.
///
/// T-412: the client can be signed into several servers at once, and each one
/// gets its own socket, its own resume state and its own backoff. One server
/// going down is one entry retrying — the others never notice.
#[derive(Default)]
struct Connections(Mutex<HashMap<String, gateway::Handle>>);

impl Connections {
    fn with<T>(&self, work: impl FnOnce(&mut HashMap<String, gateway::Handle>) -> T) -> T {
        let mut held = match self.0.lock() {
            Ok(held) => held,
            // A panic elsewhere poisoned the lock. What it guards is still a
            // perfectly good set of handles, and refusing to reconnect for the
            // rest of the session would be the worse outcome by far.
            Err(poisoned) => poisoned.into_inner(),
        };
        work(&mut held)
    }
}

/// A status change, tagged with the server it came from. Hand-written on both
/// sides and never on the wire, same as `Status` itself. `Clone` because
/// Tauri's `emit` needs one payload per listening window.
#[derive(Clone, Serialize)]
struct StatusEvent<'a> {
    server: &'a str,
    status: gateway::Status,
}

/// One sequenced frame, tagged with the server it came from. The frame keeps
/// its generated shape — the envelope around it is what says whose it is.
#[derive(Clone, Serialize)]
struct FrameEvent<'a> {
    server: &'a str,
    frame: &'a ServerFrame,
    replayed: bool,
}

/// Sends what one server's gateway client produces to the WebView.
struct WindowEvents {
    app: AppHandle,
    /// The base URL this connection was opened with. The frontend keys
    /// everything it knows on the same string.
    server: String,
}

/// Sends one server's voice signalling back down its gateway connection.
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
}

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
struct VoiceEngines(Mutex<HashMap<String, std::sync::Arc<VoiceEngine>>>);

impl VoiceEngines {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, std::sync::Arc<VoiceEngine>>) -> T) -> T {
        let mut held = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut held)
    }
}

impl gateway::Events for WindowEvents {
    fn status(&self, status: gateway::Status) {
        // A failed emit means the window is gone. There is nobody to tell.
        let _ = self.app.emit(
            gateway::STATUS_EVENT,
            StatusEvent {
                server: &self.server,
                status,
            },
        );
    }

    fn frame(&self, frame: &ServerFrame, replayed: bool) {
        let _ = self.app.emit(
            gateway::FRAME_EVENT,
            FrameEvent {
                server: &self.server,
                frame,
                replayed,
            },
        );
    }
}

/// Open (or reopen) the connection to one server. Calling this again for the
/// same server replaces its previous connection, which is what makes a frontend
/// reload or a re-sign-in start clean. Other servers are not touched.
///
/// `expires_at_ms` is when the access token dies, in Unix milliseconds; the
/// frontend knows it from the `expires_in` that came with the token. `false`
/// means the address was not one we can dial.
#[tauri::command]
fn gateway_connect(
    app: AppHandle,
    connections: State<'_, Connections>,
    base_url: String,
    token: String,
    expires_at_ms: i64,
) -> bool {
    let token = gateway::Token {
        value: token,
        expires_at_ms,
    };
    let events = WindowEvents {
        app: app.clone(),
        server: base_url.clone(),
    };
    let Some((handle, task)) = gateway::client(&base_url, token, events) else {
        return false;
    };
    tauri::async_runtime::spawn(task);
    connections.with(|held| {
        if let Some(previous) = held.insert(base_url, handle) {
            previous.shutdown();
        }
    });
    true
}

/// Close one server's connection: signing out of it, or removing it.
#[tauri::command]
fn gateway_disconnect(connections: State<'_, Connections>, base_url: String) {
    connections.with(|held| {
        if let Some(handle) = held.remove(&base_url) {
            handle.shutdown();
        }
    });
}

/// Hand one connection a fresh access token. The frontend is the only owner of
/// refresh tokens, so this is the only way a new one arrives.
#[tauri::command]
fn gateway_token(
    connections: State<'_, Connections>,
    base_url: String,
    token: String,
    expires_at_ms: i64,
) -> bool {
    connections.with(|held| {
        held.get(&base_url).is_some_and(|handle| {
            handle.set_token(gateway::Token {
                value: token,
                expires_at_ms,
            })
        })
    })
}

/// Send one client frame to one server. `false` means there was no connection
/// to send it on.
#[tauri::command]
fn gateway_send(connections: State<'_, Connections>, base_url: String, frame: ClientFrame) -> bool {
    connections.with(|held| held.get(&base_url).is_some_and(|handle| handle.send(frame)))
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
/// The mesh is not built here: it is built when the server answers with a
/// `voice.state`, which is the same path a peer arriving later takes. One code
/// path for "I joined" and "somebody joined" is what stops the two drifting.
#[tauri::command]
async fn voice_join(
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
    // The server's relay for this call (T-1403), in the shape the peer
    // connections take. Empty when the host runs none, and then it is host
    // candidates only — one network.
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

/// Stop or resume sending the microphone. Yours alone (SPEC §4.14); the
/// surface's mute button and its push-to-talk key both land here.
#[tauri::command]
async fn voice_controls(
    app: AppHandle,
    base_url: String,
    controls: linger_core::gateway::VoiceControls,
) {
    engine_for(&app, &base_url).set_controls(controls).await;
}

/// How loud one peer plays for you, 1.0 being as sent.
#[tauri::command]
async fn voice_volume(app: AppHandle, base_url: String, peer: String, volume: f32) {
    engine_for(&app, &base_url).set_volume(&peer, volume).await;
}

/// The sound devices on this machine, for the picker. Enumeration can block
/// for a moment, so it is done off the reactor.
#[tauri::command]
async fn voice_devices() -> Result<voice::device::DeviceList, String> {
    tokio::task::spawn_blocking(voice::device::list)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Leave voice, and tear the mesh down whether or not the server answers.
#[tauri::command]
async fn voice_leave(app: AppHandle, base_url: String) {
    let engine = engine_for(&app, &base_url);
    engine.leave().await;
}

/// Hand the engine a voice frame that arrived on the gateway.
///
/// The frontend routes these rather than the gateway client doing it directly,
/// for the same reason every other frame goes to the frontend first: the store
/// is the one place that knows which server is which and what state it is in.
#[tauri::command]
async fn voice_frame(app: AppHandle, base_url: String, frame: ServerFrame) {
    let engine = engine_for(&app, &base_url);
    match frame.event {
        linger_core::gateway::ServerEvent::VoiceState { room_id, peers } => {
            engine.on_state(room_id, &peers).await;
        }
        linger_core::gateway::ServerEvent::VoiceSignal {
            from,
            kind,
            payload,
        } => {
            engine.on_signal(&from, kind, &payload).await;
        }
        // Everything else is the frontend's business, not the engine's.
        _ => {}
    }
}

/// Entry point shared by main.rs and (later) mobile.
pub fn run() {
    tauri::Builder::default()
        // Links in a message go to the system browser, never to this window.
        // The capability file narrows the plugin to http and https.
        .plugin(tauri_plugin_opener::init())
        // The one thing allowed to interrupt somebody: a message that names
        // them, or one from a person they asked to hear from (SPEC §4.2).
        // There are no other notifications and no unread badge to attach one to.
        .plugin(tauri_plugin_notification::init())
        // Signed in-app updates (T-701, ARCHITECTURE §7 baseline 8). Registering
        // the plugin is what makes `[plugins.updater]` readable from Rust; the
        // capability file grants the WebView none of the plugin's own commands,
        // so the page goes through `updates.rs` or not at all.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Where each Buddy list window was, and how big (T-1808). Registered
        // before `setup` so the windows built there are restored too.
        .plugin(window::remembered_windows())
        .manage(Connections::default())
        .manage(VoiceEngines::default())
        // The window is built here, not from the config, so it can leave the
        // title bar off on Hyprland (#130). See `window.rs`.
        .setup(|app| Ok(window::create(app)?))
        .on_window_event(window::on_event)
        .invoke_handler(tauri::generate_handler![
            sessions_load,
            session_save,
            session_forget,
            gateway_connect,
            gateway_disconnect,
            gateway_token,
            gateway_send,
            voice_join,
            voice_leave,
            voice_frame,
            voice_controls,
            voice_volume,
            voice_devices,
            notifications::show_notification,
            updates::app_version,
            updates::update_check,
            updates::update_install,
            graphics::graphics_started,
            window::next_open_chat,
            window::next_open_conversation,
            window::next_open_settings
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Linger");
}
