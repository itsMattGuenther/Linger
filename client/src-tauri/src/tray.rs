//! Closing the list keeps Linger running in the tray (decisions 4 and 5): voice
//! and notifications go on, and the tray icon brings the list back or quits.
//! A setting (Settings → Windows) makes closing the list quit instead. Only
//! the Buddy list client does this; the classic one quits as it always did.
//!
//! A desktop with nowhere to put a tray icon (a Linux box without the
//! appindicator library, say) gets no tray, and closing the list quits there
//! whatever the setting says: a hidden list nobody can bring back would be
//! worse than quitting. Launching Linger again also brings a hidden list back
//! (the single-instance plugin, `lib.rs`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, WebviewWindow, Wry};

/// The tray menu's voice items (decision 5): with the list hidden, they are
/// the only Mute and Leave in reach. Greyed out while you're not in voice.
#[derive(Default)]
pub struct VoiceItems(Mutex<Option<(MenuItem<Wry>, MenuItem<Wry>)>>);

/// Whether closing the list hides it into the tray. On by default; the list
/// window tells it the setting (`next_close_to_tray`) when it starts and when
/// the setting changes.
pub struct Closing {
    to_tray: AtomicBool,
    /// Set once a tray icon exists. Without one, closing always quits.
    tray: AtomicBool,
}

impl Default for Closing {
    fn default() -> Self {
        Self {
            to_tray: AtomicBool::new(true),
            tray: AtomicBool::new(false),
        }
    }
}

impl Closing {
    /// What closing the list does now: hide it, or quit Linger.
    pub fn hides(&self) -> bool {
        self.tray.load(Ordering::Relaxed) && self.to_tray.load(Ordering::Relaxed)
    }
}

/// Put Linger's icon in the tray, if this desktop has one. A failure (or, on
/// Linux, a missing library that would otherwise take the app down) leaves
/// Linger without a tray, and closing the list then quits.
pub fn install(app: &App) {
    let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build(app)));
    let ok = matches!(built, Ok(Ok(())));
    if !ok {
        eprintln!("linger: no tray icon on this desktop; closing the list will quit");
    }
    app.state::<Closing>().tray.store(ok, Ordering::Relaxed);
}

fn build(app: &App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Linger", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Mute", false, None::<&str>)?;
    let leave = MenuItem::with_id(app, "leave", "Leave voice", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Linger", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &mute,
            &leave,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    if let Ok(mut held) = app.state::<VoiceItems>().0.lock() {
        *held = Some((mute, leave));
    }
    let mut tray = TrayIconBuilder::with_id("linger")
        .tooltip("Linger")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_list(app),
            "quit" => app.exit(0),
            // Voice is the list window's: it does what the tray asks.
            "mute" | "leave" => {
                let _ = app.emit_to("main", "next:tray", event.id.as_ref());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_list(tray.app_handle());
            }
        });
    // The small mark (assets/logo/linger-door.svg), not the app icon: the
    // porch picture turns to mush at a tray's 16 to 24 pixels.
    tray = tray.icon(tauri::include_image!("icons/tray.png"));
    tray.build(app)?;
    Ok(())
}

/// Bring the list back: shown, restored and focused.
pub fn show_list(app: &AppHandle) {
    if let Some(list) = app.get_webview_window("main") {
        let _ = list.show();
        let _ = list.unminimize();
        let _ = list.set_focus();
    }
}

/// The list window's setting: whether closing it keeps Linger in the tray.
/// Only the list window may say.
#[tauri::command]
pub fn next_close_to_tray(
    window: WebviewWindow,
    closing: tauri::State<'_, Closing>,
    on: bool,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("only the list window decides what closing it does".into());
    }
    closing.to_tray.store(on, Ordering::Relaxed);
    // Whether it will really hide: false when there's no tray to hide into.
    Ok(closing.hides())
}

/// The list window's voice, for the tray menu: in voice or not, and muted or
/// not. Only the list window may say.
#[tauri::command]
pub fn next_tray_voice(
    window: WebviewWindow,
    items: tauri::State<'_, VoiceItems>,
    in_voice: bool,
    muted: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the list window says where voice is".into());
    }
    let held = items.0.lock().map_err(|e| e.to_string())?;
    if let Some((mute, leave)) = held.as_ref() {
        mute.set_text(if muted { "Unmute" } else { "Mute" })
            .map_err(|e| e.to_string())?;
        mute.set_enabled(in_voice).map_err(|e| e.to_string())?;
        leave.set_enabled(in_voice).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Closing;
    use std::sync::atomic::Ordering;

    #[test]
    fn closing_hides_only_with_a_tray_and_the_setting_on() {
        let closing = Closing::default();
        assert!(!closing.hides(), "no tray yet: closing quits");
        closing.tray.store(true, Ordering::Relaxed);
        assert!(closing.hides(), "a tray, and the default: closing hides");
        closing.to_tray.store(false, Ordering::Relaxed);
        assert!(!closing.hides(), "the setting off: closing quits");
    }
}
