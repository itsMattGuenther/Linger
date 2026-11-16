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
//! sign-ins and server connections, which live here in Rust, carry on.
//! Voice doesn't: on a phone it runs in the page (`pageVoice.ts`), and ends
//! with it. So the shell leaves voice on each server it was in, and the page
//! that comes back says so, with one tap to join again (`voice_away.rs`, #851).

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
///
/// `window_open` is asked only when a scene comes back, and that matters
/// (#901). Every event Tauri has comes through here, several for each pass
/// of the app's main loop. Asking for the windows copies each one, and on
/// the iPhone a copy of a window wakes the main loop: tao's
/// `EventLoopProxy::clone` adds a source to the run loop and calls
/// `CFRunLoopWakeUp`. Asked on every event, the loop woke itself for good,
/// and the app's main thread used a whole processor for as long as it was
/// open. So it's something to call, not a value somebody has to have
/// worked out first.
pub fn answer(happened: Happened, window_open: impl FnOnce() -> bool) -> Answer {
    match happened {
        Happened::LastWindowGone => Answer::Stay,
        Happened::SceneBack if !window_open() => Answer::OpenWindow,
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
    match answer(happened, || !app.webview_windows().is_empty()) {
        Answer::Stay => {
            if let RunEvent::ExitRequested { api, .. } = event {
                eprintln!(
                    "linger: iOS let go of the window's scene; staying for when it comes back"
                );
                api.prevent_exit();
                // Voice went with the page: leave it, so the room sees (#851).
                crate::voice_away::window_gone(app);
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

    /// Asking for the windows wakes the iPhone's main loop (`answer`), so
    /// where the answer doesn't depend on them, nobody may ask.
    fn never_asked() -> bool {
        panic!("the windows were asked for, which wakes the iPhone's main loop")
    }

    #[test]
    fn the_last_window_going_never_quits_the_phone_app() {
        assert_eq!(answer(Happened::LastWindowGone, never_asked), Answer::Stay);
    }

    #[test]
    fn a_scene_coming_back_opens_the_window_only_when_there_is_none() {
        assert_eq!(answer(Happened::SceneBack, || false), Answer::OpenWindow);
        assert_eq!(answer(Happened::SceneBack, || true), Answer::Nothing);
    }

    /// Every pass of the main loop is one of these, several times over: the
    /// windows are never asked for (#901).
    #[test]
    fn anything_else_is_left_alone_and_never_looks_at_the_windows() {
        assert_eq!(answer(Happened::Other, never_asked), Answer::Nothing);
    }
}
