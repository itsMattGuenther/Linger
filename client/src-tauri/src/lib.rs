//! Tauri shell. The WebView gets the minimum permission surface (ARCHITECTURE §7):
//! every native capability it has is one narrow command in this crate, and it
//! has no others.

//!
//! The phone app is built from this crate too (SPEC §4.15). It has one window,
//! no notifications, no tray, no in-app updates and, for now, no voice, so the
//! modules for those are `#[cfg(desktop)]` and `phone_app` registers only what
//! a phone uses.

#[cfg(test)]
mod acl;
#[cfg(desktop)]
mod autostart;
#[cfg(desktop)]
mod clipboard;
pub mod cue;
#[cfg(target_os = "linux")]
pub mod desktop_entry;
pub mod gateway;
pub mod graphics;
#[cfg(desktop)]
mod notifications;
pub mod packaging;
// The phone's sounds: only the phone app registers them. Tests read them here too.
#[cfg(any(mobile, test))]
mod phone_sound;
#[cfg(any(mobile, test))]
mod phone_text;
mod secrets;
#[cfg(desktop)]
pub mod sounds;
#[cfg(desktop)]
mod tray;
#[cfg(desktop)]
mod updates;
#[cfg(desktop)]
pub mod voice;
#[cfg(desktop)]
mod voice_commands;
#[cfg(desktop)]
mod window;

use std::collections::HashMap;
use std::sync::Mutex;

use linger_core::gateway::{ClientFrame, ServerFrame};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

/// Try one server's connection again now, if it's waiting between tries: the
/// phone app back on the screen (`Handle::retry`). Android blocks an app's
/// network soon after it leaves the screen, and the tries made into that
/// block wait longer each time, up to half a minute.
#[cfg(mobile)]
#[tauri::command]
fn gateway_retry(connections: State<'_, Connections>, base_url: String) {
    connections.with(|held| {
        if let Some(handle) = held.get(&base_url) {
            handle.retry();
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

/// Entry point for the desktop app (main.rs) and the phone app, which Tauri
/// starts through `mobile_entry_point` instead of a `main`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    let app = desktop_app();
    #[cfg(mobile)]
    let app = phone_app();
    app.run(tauri::generate_context!())
        .expect("failed to start Linger");
}

/// Everything the desktop app registers. `src/acl.rs` checks that this
/// `generate_handler!` and `build.rs` name the same commands.
#[cfg(desktop)]
fn desktop_app() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        // First, so a second launch is caught before anything else starts:
        // it brings the running Linger's list forward instead (tray.rs).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_list(app);
        }))
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
        .manage(tray::Closing::default())
        .manage(tray::VoiceItems::default())
        .manage(voice_commands::VoiceEngines::default())
        .manage(std::sync::Arc::new(sounds::Sounds::default()))
        // The window is built here, not from the config, so it can leave the
        // title bar off on Hyprland (#130). See `window.rs`.
        .setup(|app| {
            window::create(app)?;
            // Linger keeps running in the tray when its list closes.
            tray::install(app);
            Ok(())
        })
        .on_window_event(window::on_event)
        .invoke_handler(tauri::generate_handler![
            sessions_load,
            session_save,
            session_forget,
            gateway_connect,
            gateway_disconnect,
            gateway_token,
            gateway_send,
            voice_commands::voice_join,
            voice_commands::voice_leave,
            voice_commands::voice_frame,
            voice_commands::voice_controls,
            voice_commands::voice_push_to_talk,
            voice_commands::voice_volume,
            voice_commands::voice_choose_devices,
            voice_commands::voice_devices,
            voice_commands::sound_play,
            notifications::show_notification,
            updates::app_version,
            updates::update_check,
            updates::newest_version,
            updates::update_install,
            graphics::graphics_started,
            window::next_open_conversation,
            window::next_open_settings,
            window::next_open_tool,
            tray::next_close_to_tray,
            tray::next_tray_voice,
            window::next_request_attention,
            autostart::autostart_state,
            autostart::autostart_set,
            clipboard::clipboard_image
        ])
}

/// What the phone app registers (SPEC §4.15): links to the browser, the
/// sign-ins and the gateway connections, which are all a text-only app needs
/// from Rust, and its sounds, which follow the phone's ringer. The window comes from `tauri.android.conf.json` and
/// `tauri.ios.conf.json`. Every command here is granted by
/// `capabilities/phone.json` and nothing else is; `src/acl.rs` checks that.
#[cfg(mobile)]
fn phone_app() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Connections::default())
        .invoke_handler(tauri::generate_handler![
            sessions_load,
            session_save,
            session_forget,
            gateway_connect,
            gateway_disconnect,
            gateway_token,
            gateway_send,
            gateway_retry,
            graphics::graphics_started,
            phone_sound::phone_sound_mode,
            phone_sound::phone_buzz,
            phone_sound::sound_play,
            phone_text::phone_text_scale
        ])
}
