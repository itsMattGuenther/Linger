//! The computer's sound in a screen share (#736, SPEC §4.20, PROTOCOL §8
//! "The computer's sound"), both ends of it in the shell.
//!
//! **Sharing.** The page runs the share and its screen socket
//! (`client/src/lib/screen/share.ts`); this captures the computer's sound,
//! less everything Linger plays, and hands the page each 20 ms Opus packet
//! on a channel of raw bytes, already in the socket's shape, for it to
//! stamp on the share's own clock and send. Only Windows captures for now
//! (`screen_sound/windows.rs`): leaving Linger's own voice out of a PipeWire
//! capture on Linux needs Linger's streams found in the audio graph and left
//! out of it, which is later work (TASKS.md). One capture at a time, for the
//! window that started it; closing that window stops it (`forget`).
//!
//! **Watching.** The page hands each packet that came on its watch socket
//! here, and this plays it in the call, through the Speakers picked in
//! Settings, mixed over the voices the way Linger's own sounds are (#250):
//! watching is being in voice, so there is always a call to play it in. A
//! phone plays it in the page instead (`client/src/lib/screen/listen.ts`).

mod pack;
#[cfg(windows)]
mod windows;

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use linger_core::screen::{ScreenSoundHead, SCREEN_FRAME_HEADER_BYTES};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Manager, Window};

use crate::voice_commands;

/// The header a played packet names its server in: the server whose call
/// it plays in, as the page knows it.
const SERVER_HEADER: &str = "linger-server";

/// What the shell tells the page about the sound it captures, besides the
/// sound.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum SoundSays {
    /// It stopped by itself: Windows stopped giving sound, and opening it
    /// again didn't help. The share carries on without it.
    Ended,
}

/// The sound being captured, and each server's being played.
#[derive(Default)]
pub struct ScreenSounds {
    capturing: Mutex<Option<Capturing>>,
    /// The watched share's sound, by server: what turns its packets back
    /// into sound.
    listening: Mutex<HashMap<String, pack::Listener>>,
}

struct Capturing {
    /// The window that started it, and the only one it answers.
    window: String,
    /// Held, never read: dropping it stops the capture.
    #[cfg(windows)]
    _capture: windows::Capture,
}

fn lock<T>(held: &Mutex<T>) -> MutexGuard<'_, T> {
    held.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether this app can share the computer's sound: Windows 10 2004 or
/// later. Asking opens nothing.
#[tauri::command]
pub async fn screen_sound_available() -> bool {
    #[cfg(windows)]
    {
        windows::available()
    }
    #[cfg(not(windows))]
    false
}

/// Start capturing the computer's sound for the share `window` runs: each
/// packet comes on `sounds`, and `says` is told if it stops by itself.
/// Refused with `no-sound` when it can't start; the share carries on
/// without it.
#[tauri::command]
pub async fn screen_sound_start(
    app: AppHandle,
    window: Window,
    sounds: Channel<InvokeResponseBody>,
    says: Channel<SoundSays>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        let before = lock(&app.state::<ScreenSounds>().capturing).take();
        let started = tokio::task::spawn_blocking(move || {
            drop(before);
            windows::Capture::start(
                move |packet| {
                    let _ = sounds.send(InvokeResponseBody::Raw(packet));
                },
                move |why| {
                    eprintln!("linger: the computer's sound stopped: {why}");
                    let _ = says.send(SoundSays::Ended);
                },
            )
        })
        .await
        .map_err(|error| error.to_string())?;
        let capture = started.map_err(|why| {
            eprintln!("linger: the computer's sound couldn't be shared: {why}");
            "no-sound".to_string()
        })?;
        // The window that asked closed meanwhile: its `forget` has been.
        if app.get_webview_window(&label).is_none() {
            let _ = tokio::task::spawn_blocking(move || drop(capture)).await;
            return Err("no-sound".into());
        }
        let before = lock(&app.state::<ScreenSounds>().capturing).replace(Capturing {
            window: label,
            _capture: capture,
        });
        if let Some(before) = before {
            let _ = tokio::task::spawn_blocking(move || drop(before)).await;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, sounds, says);
        Err("no-sound".into())
    }
}

/// Stop capturing the sound `window` started.
#[tauri::command]
pub async fn screen_sound_stop(app: AppHandle, window: Window) {
    if let Some(capturing) = taken_from(&app, window.label()) {
        let _ = tokio::task::spawn_blocking(move || drop(capturing)).await;
    }
}

/// A window has gone, or loaded again: a capture it started stops.
pub fn forget(app: &AppHandle, label: &str) {
    if let Some(capturing) = taken_from(app, label) {
        // Stopping waits for the capture's thread, up to a tenth of a second.
        std::thread::spawn(move || drop(capturing));
    }
}

fn taken_from(app: &AppHandle, label: &str) -> Option<Capturing> {
    let sounds = app.state::<ScreenSounds>();
    let mut held = lock(&sounds.capturing);
    if held.as_ref().is_some_and(|running| running.window == label) {
        held.take()
    } else {
        None
    }
}

/// Play one packet of a watched share's sound, as it came on the watch
/// socket (the body, raw), in the call on the server the `linger-server`
/// header names.
#[tauri::command]
pub async fn screen_sound_play(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(packet) = request.body() else {
        return Err("not sound".into());
    };
    let server = request
        .headers()
        .get(SERVER_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or("no server")?
        .to_string();
    let head = ScreenSoundHead::read(packet).ok_or("not sound")?;
    let opus = &packet[SCREEN_FRAME_HEADER_BYTES..];
    let stereo = {
        let sounds = app.state::<ScreenSounds>();
        let mut listening = lock(&sounds.listening);
        let listener = match listening.entry(server.clone()) {
            std::collections::hash_map::Entry::Occupied(held) => held.into_mut(),
            std::collections::hash_map::Entry::Vacant(empty) => {
                empty.insert(pack::Listener::new().map_err(|error| error.to_string())?)
            }
        };
        listener.hear(head.micros, opus)
    };
    if !stereo.is_empty() {
        voice_commands::screen_sound(&app, &server, &stereo).await;
    }
    Ok(())
}

/// How loud the watched share's sound plays on `base_url`, 0 to 1: the
/// watcher's own, from beside the screen.
#[tauri::command]
pub async fn screen_sound_volume(app: AppHandle, base_url: String, volume: f32) {
    voice_commands::screen_volume(&app, &base_url, volume).await;
}

/// The watched share's sound on `base_url` is over: watching ended, or its
/// sound button was turned off. What was waiting to play goes.
#[tauri::command]
pub async fn screen_sound_end(app: AppHandle, base_url: String) {
    lock(&app.state::<ScreenSounds>().listening).remove(&base_url);
    voice_commands::screen_quiet(&app, &base_url).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_shell_says_reads_as_the_page_reads_it() {
        // `lib/screen/sound.ts`: { op: "ended" }.
        let said = serde_json::to_value(SoundSays::Ended).expect("json");
        assert_eq!(said, serde_json::json!({ "op": "ended" }));
    }
}
