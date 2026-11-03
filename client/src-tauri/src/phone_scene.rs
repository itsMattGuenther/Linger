//! The iPhone's scenes on Tauri 2.12 (#836).
//!
//! From iOS 26, tao 0.37 runs the app on UIKit's scenes even without a scene
//! manifest. iOS discards a scene left in the background when it wants the
//! memory, and tao reports that as the window destroyed (tauri-apps/tao#1261).
//! With no window left, Tauri asks to quit, and Linger was gone, to start over
//! the next time it was opened: the simulator's share flow, which leaves
//! Linger in the background while it shares, found it. Nobody quits an iPhone
//! app from inside it, so Linger stays, and when iOS brings the scene back
//! (`SceneRequested`) it opens its window again, in that scene: tao gives a
//! new window to a connected scene that has none. The page loads again; the
//! sign-ins, connections and any call, which live here in Rust, carry on.

/// What happened, as far as the phone's window cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Happened {
    /// Tauri asks to quit because the last window went, not because
    /// anything called `exit` (which gives a code).
    LastWindowGone,
    /// iOS connected a scene the app didn't ask for: one coming back.
    SceneBack,
    Other,
}

/// What to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Stay,
    OpenWindow,
    Nothing,
}

/// The phone app never quits because its window went, and opens its window
/// again when a scene comes back to one that has none.
pub fn answer(happened: Happened, window_open: bool) -> Answer {
    match happened {
        Happened::LastWindowGone => Answer::Stay,
        Happened::SceneBack if !window_open => Answer::OpenWindow,
        Happened::SceneBack | Happened::Other => Answer::Nothing,
    }
}

/// Tauri's events, answered. Said in the log either way, since only the
/// simulator and a phone can show this happening.
#[cfg(target_os = "ios")]
pub fn handle(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use tauri::{Manager, RunEvent, WebviewWindowBuilder};

    let happened = match &event {
        RunEvent::ExitRequested { code: None, .. } => Happened::LastWindowGone,
        RunEvent::SceneRequested { .. } => Happened::SceneBack,
        _ => Happened::Other,
    };
    match answer(happened, !app.webview_windows().is_empty()) {
        Answer::Stay => {
            if let RunEvent::ExitRequested { api, .. } = event {
                eprintln!(
                    "linger: iOS let go of the window's scene; staying for when it comes back"
                );
                api.prevent_exit();
            }
        }
        Answer::OpenWindow => {
            // The one window tauri.ios.conf.json declares, as Tauri opened it
            // at the start.
            let opened = app
                .config()
                .app
                .windows
                .first()
                .ok_or_else(|| "tauri.ios.conf.json declares no window".to_string())
                .and_then(|config| {
                    WebviewWindowBuilder::from_config(app, config)
                        .and_then(|builder| builder.build())
                        .map_err(|error| error.to_string())
                });
            match opened {
                Ok(_) => eprintln!("linger: a scene came back; its window is open again"),
                Err(error) => {
                    eprintln!("linger: a scene came back, and its window couldn't open: {error}")
                }
            }
        }
        Answer::Nothing => {}
    }
}

#[cfg(test)]
mod tests {
    use super::{answer, Answer, Happened};

    #[test]
    fn the_last_window_going_never_quits_the_phone_app() {
        assert_eq!(answer(Happened::LastWindowGone, false), Answer::Stay);
        assert_eq!(answer(Happened::LastWindowGone, true), Answer::Stay);
    }

    #[test]
    fn a_scene_coming_back_opens_the_window_only_when_there_is_none() {
        assert_eq!(answer(Happened::SceneBack, false), Answer::OpenWindow);
        assert_eq!(answer(Happened::SceneBack, true), Answer::Nothing);
    }

    #[test]
    fn anything_else_is_left_alone() {
        assert_eq!(answer(Happened::Other, false), Answer::Nothing);
        assert_eq!(answer(Happened::Other, true), Answer::Nothing);
    }
}
