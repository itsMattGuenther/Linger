//! Sharing a screen from the Linux app, captured here in the shell rather
//! than by the page (#360, SPEC §4.20, T-1907). `screen_shell/linux.rs` has
//! why, and how.
//!
//! The page still runs the share: its screen socket to the server, who's
//! watching, what to say when it ends (`client/src/lib/screen/share.ts`).
//! This hands it the frames, already encoded and in the socket's shape, on a
//! channel of raw bytes, and the preview's small pictures on another, and
//! does what it asks: start (which opens the desktop's picker), a key frame,
//! the preview shown or hidden, stop. One share at a time, in the window
//! that started it; closing that window stops it (`forget`).
//!
//! On Windows and macOS the page shares by itself, and these say there's
//! nothing here.

use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Window};

#[cfg(target_os = "linux")]
mod linux;

/// What the shell tells the page about a share, besides its frames.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum ShareSays {
    /// It ended by itself: `gone` when the screen went (the desktop's own
    /// Stop, or the window shared closed), `failed` when it couldn't be read.
    Ended { why: &'static str },
    /// About once a second: whether the share is black
    /// (`client/src/lib/screen/black.ts`).
    Looks { black: bool },
}

/// The share running, if there is one.
#[derive(Default)]
pub struct ScreenShares(Mutex<Option<Running>>);

struct Running {
    /// The window that started it, and the only one it answers.
    window: String,
    #[cfg(target_os = "linux")]
    capture: linux::Capture,
}

fn lock(shares: &ScreenShares) -> MutexGuard<'_, Option<Running>> {
    shares.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether this app shares a screen from the shell: Linux, with the
/// desktop's screen-sharing portal and GStreamer's PipeWire and VP8 plugins.
/// Asking opens nothing.
#[tauri::command]
pub async fn screen_share_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        let encodes = tokio::task::spawn_blocking(linux::can_encode)
            .await
            .unwrap_or(false);
        encodes && linux::portal_shares().await
    }
    #[cfg(not(target_os = "linux"))]
    false
}

/// Share a screen at `fps`: the desktop's picker opens, and once something
/// is picked its frames come on `frames`, and the preview's JPEG pictures on
/// `pictures` while it's `shown`. Refused with `declined` when the picker was
/// closed, `no-screen` when the desktop gave none, and `no-encoder` when
/// GStreamer couldn't read it.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri hands each one over by name.
pub async fn screen_share_start(
    app: AppHandle,
    window: Window,
    fps: u8,
    shown: bool,
    frames: Channel<InvokeResponseBody>,
    pictures: Channel<InvokeResponseBody>,
    says: Channel<ShareSays>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let speed = linux::speed(fps).ok_or("not a speed")?;
        stop_running(&app).await;
        let picked = linux::pick().await.map_err(|refused| match refused {
            linux::Refused::Declined => "declined".to_string(),
            linux::Refused::NoScreen(why) => {
                eprintln!("linger: no screen to share: {why}");
                "no-screen".to_string()
            }
        })?;
        let capture = linux::Capture::start(
            picked,
            speed,
            shown,
            linux::Outlets {
                frame: move |frame| {
                    let _ = frames.send(InvokeResponseBody::Raw(frame));
                },
                picture: move |picture| {
                    let _ = pictures.send(InvokeResponseBody::Raw(picture));
                },
                looked: {
                    let says = says.clone();
                    move |black| {
                        let _ = says.send(ShareSays::Looks { black });
                    }
                },
                ended: move |ended| {
                    let why = match ended {
                        linux::Ended::Gone => "gone",
                        linux::Ended::Failed(error) => {
                            eprintln!("linger: the shared screen couldn't be read: {error}");
                            "failed"
                        }
                    };
                    let _ = says.send(ShareSays::Ended { why });
                },
            },
        );
        let capture = match capture {
            Ok(capture) => capture,
            Err(failed) => {
                eprintln!("linger: the shared screen couldn't be read: {}", failed.why);
                failed.picked.close().await;
                return Err("no-encoder".into());
            }
        };
        // Another start finished while the picker was open: that one goes.
        let before = lock(&app.state::<ScreenShares>()).replace(Running {
            window: window.label().to_string(),
            capture,
        });
        if let Some(before) = before {
            close(before).await;
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, window, fps, shown, frames, pictures, says);
        Err("no-screen".into())
    }
}

/// Make the next frame a key frame (somebody new is watching, or a watcher
/// fell behind), for the share `window` started.
#[tauri::command]
pub async fn screen_share_keyframe(app: AppHandle, window: Window) {
    #[cfg(target_os = "linux")]
    if let Some(running) = lock(&app.state::<ScreenShares>()).as_ref() {
        if running.window == window.label() {
            running.capture.keyframe();
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, window);
}

/// Show the preview of the share `window` started, or hide it, which stops
/// making its pictures.
#[tauri::command]
pub async fn screen_share_preview(app: AppHandle, window: Window, shown: bool) {
    #[cfg(target_os = "linux")]
    if let Some(running) = lock(&app.state::<ScreenShares>()).as_ref() {
        if running.window == window.label() {
            running.capture.show_preview(shown);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, window, shown);
}

/// Stop the share `window` started.
#[tauri::command]
pub async fn screen_share_stop(app: AppHandle, window: Window) {
    let running = taken_from(&app, window.label());
    if let Some(running) = running {
        close(running).await;
    }
}

/// A window has gone: a share it started stops with it.
pub fn forget(app: &AppHandle, label: &str) {
    if let Some(running) = taken_from(app, label) {
        tauri::async_runtime::spawn(close(running));
    }
}

/// The share `label`'s window started, taken out, if that's the one running.
fn taken_from(app: &AppHandle, label: &str) -> Option<Running> {
    let shares = app.state::<ScreenShares>();
    let mut held = lock(&shares);
    if held.as_ref().is_some_and(|running| running.window == label) {
        held.take()
    } else {
        None
    }
}

async fn stop_running(app: &AppHandle) {
    let running = lock(&app.state::<ScreenShares>()).take();
    if let Some(running) = running {
        close(running).await;
    }
}

/// Stop reading, and end the desktop's session so its "sharing" mark goes.
async fn close(running: Running) {
    #[cfg(target_os = "linux")]
    if let Some(picked) = running.capture.stop() {
        picked.close().await;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = running;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_shell_says_reads_as_the_page_reads_it() {
        // `lib/screen/shell.ts`: { op: "ended", why: "gone" | "failed" }.
        let said = serde_json::to_value(ShareSays::Ended { why: "gone" }).expect("json");
        assert_eq!(said, serde_json::json!({ "op": "ended", "why": "gone" }));
        // `lib/screen/shell.ts`: { op: "looks", black }.
        let said = serde_json::to_value(ShareSays::Looks { black: true }).expect("json");
        assert_eq!(said, serde_json::json!({ "op": "looks", "black": true }));
    }
}
