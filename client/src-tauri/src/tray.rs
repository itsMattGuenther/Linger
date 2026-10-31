//! Closing the list keeps Linger running in the tray (decisions 4 and 5): voice
//! and notifications go on, and the tray icon brings the list back or quits.
//! A setting (Settings → Windows) makes closing the list quit instead.
//!
//! A desktop with nowhere to put a tray icon (a Linux box without the
//! appindicator library, say) gets no tray, and closing the list quits there
//! whatever the setting says: a hidden list nobody can bring back would be
//! worse than quitting. Launching Linger again also brings a hidden list back
//! (the single-instance plugin, `lib.rs`).
//!
//! The icon itself says whether you're in voice and whether your microphone
//! is live (#601): voice goes on with the list hidden, and without a mark
//! somebody could forget they're still in a room with their microphone on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, WebviewWindow, Wry};

/// The tray icon's id, to find it again when voice changes.
const TRAY_ID: &str = "linger";

/// The tray menu's voice items (decision 5): with the list hidden, they are
/// the only Mute and Leave in reach. Greyed out while you're not in voice.
/// Stop sharing too (#360), for a slide show that covers every window: greyed
/// out unless you share. Beside them, what the icon shows now, so it's only
/// redrawn on a change.
#[derive(Default)]
pub struct VoiceItems(Mutex<Option<Items>>, Mutex<Option<(Look, String)>>);

/// The menu's three voice items, to grey out and name again as voice changes,
/// and the update item (#772), which is in the menu only while an update
/// waits: the menu itself to put it in and take it out, and whether it's in.
pub struct Items {
    mute: MenuItem<Wry>,
    leave: MenuItem<Wry>,
    stop_share: MenuItem<Wry>,
    menu: Menu<Wry>,
    update: MenuItem<Wry>,
    update_shown: bool,
}

/// The update item, as the list window words it (#772): "Restart to update
/// Linger" for a copy that installs by itself, "Update Linger" for one that
/// asks for a password, and for the tooltip "0.5.4 is ready" or "is out".
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TrayUpdate {
    text: String,
    tip: String,
}

/// What the tray icon shows about voice (#601). A state, never a number of
/// people (hard rule 3), and nothing that leaves the computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Look {
    /// Not in voice: the door as it always was.
    Idle,
    /// In voice with the microphone on: the door with a lamp badge, the lamp
    /// being "your voice" (docs/design/system.md). Push-to-talk shows this
    /// too, whether or not the key is held, so the icon doesn't flicker with
    /// every word; the tooltip says push-to-talk.
    Live,
    /// In voice, muted or deafened: a grey badge, never the lamp.
    Muted,
}

impl Look {
    /// What the icon shows for this voice state.
    pub fn of(in_voice: bool, muted: bool) -> Self {
        match (in_voice, muted) {
            (false, _) => Self::Idle,
            (true, false) => Self::Live,
            (true, true) => Self::Muted,
        }
    }

    /// The small mark for this look (assets/logo/linger-door*.svg at 64px).
    fn icon(self) -> Image<'static> {
        match self {
            Self::Idle => tauri::include_image!("icons/tray.png"),
            Self::Live => tauri::include_image!("icons/tray-voice.png"),
            Self::Muted => tauri::include_image!("icons/tray-muted.png"),
        }
    }
}

/// The longest place name the tooltip carries. Windows cuts a tray tooltip
/// at 127 characters; a group DM's names can run longer than that.
const PLACE_MAX: usize = 60;

/// The tooltip, the icon's words for anybody who doesn't know the marks or
/// can't see them: "Linger · in voice in #general, muted". `place` is where,
/// as the list words it ("in #general", "with Jules"). Out of voice, an
/// update waiting says so instead (#772): "Linger · 0.5.4 is ready". In voice,
/// voice is what matters, and nothing restarts then anyway.
pub fn tooltip(
    in_voice: bool,
    muted: bool,
    deafened: bool,
    push_to_talk: bool,
    place: Option<&str>,
    update: Option<&str>,
) -> String {
    if !in_voice {
        return match update.map(str::trim).filter(|tip| !tip.is_empty()) {
            Some(tip) => format!("Linger · {tip}"),
            None => "Linger".into(),
        };
    }
    let mut words = String::from("Linger · in voice");
    if let Some(place) = place.map(str::trim).filter(|place| !place.is_empty()) {
        words.push(' ');
        if place.chars().count() > PLACE_MAX {
            words.extend(place.chars().take(PLACE_MAX - 1));
            words.push('…');
        } else {
            words.push_str(place);
        }
    }
    if deafened {
        words.push_str(", deafened");
    } else if muted {
        words.push_str(", muted");
    } else if push_to_talk {
        words.push_str(", push-to-talk");
    }
    words
}

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
    let stop_share = MenuItem::with_id(
        app,
        "stop-share",
        "Stop sharing your screen",
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Linger", true, None::<&str>)?;
    // Put in under Show Linger only while an update waits (#772).
    let update = MenuItem::with_id(
        app,
        "update",
        "Restart to update Linger",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &PredefinedMenuItem::separator(app)?,
            &mute,
            &leave,
            &stop_share,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    if let Ok(mut held) = app.state::<VoiceItems>().0.lock() {
        *held = Some(Items {
            mute,
            leave,
            stop_share,
            menu: menu.clone(),
            update,
            update_shown: false,
        });
    }
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Linger")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_list(app),
            "quit" => app.exit(0),
            // Voice is the list window's: it does what the tray asks. So is
            // updating (#772), since only it knows whether you're in voice.
            "mute" | "leave" | "update" => {
                let _ = app.emit_to("main", "next:tray", event.id.as_ref());
            }
            // A share runs in the window Share was pressed in, which may not
            // be the list: every window hears it, and the one sharing stops.
            "stop-share" => {
                let _ = app.emit("next:screen-stop", ());
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
    tray = tray.icon(Look::Idle.icon());
    tray.build(app)?;
    Ok(())
}

/// Bring the list back: shown, restored and focused, and its page told it's
/// seen again (#594).
pub fn show_list(app: &AppHandle) {
    if let Some(list) = app.get_webview_window("main") {
        let _ = list.show();
        let _ = list.unminimize();
        let _ = list.set_focus();
        crate::window::page_seen(app, "main", true);
    }
}

/// The list bringing itself back for a conversation opened from elsewhere (a
/// banner, while it was in the tray): what the tray's Show Linger does. It
/// goes through the shell rather than the page showing its own window, so
/// the page is told it's seen again (#594) even when Windows won't hand the
/// window the focus. Only the list window may ask.
#[tauri::command]
pub fn next_show_list(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the list window brings itself back".into());
    }
    show_list(window.app_handle());
    Ok(())
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

/// The list window's voice, for the tray: in voice or not, muted or not, and
/// where. It enables the menu's Mute and Leave, and sets the icon and its
/// tooltip (#601). Every way out of voice (Leave, being taken out, dropping
/// out after a sleep) comes here as `in_voice: false` and puts the plain door
/// back; quitting takes the icon with it. Only the list window may say.
// A Tauri command's arguments are the keys the page sends, one each.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn next_tray_voice(
    window: WebviewWindow,
    items: tauri::State<'_, VoiceItems>,
    in_voice: bool,
    muted: bool,
    deafened: Option<bool>,
    push_to_talk: Option<bool>,
    place: Option<String>,
    sharing: Option<bool>,
    update: Option<TrayUpdate>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the list window says where voice is".into());
    }
    // Nothing restarts to update in voice or while sharing (#772): this is
    // what the last check before an install reads.
    crate::updates::set_busy(window.app_handle(), in_voice || sharing.unwrap_or(false));
    let deafened = deafened.unwrap_or(false);
    {
        let mut held = items.0.lock().map_err(|e| e.to_string())?;
        if let Some(Items {
            mute,
            leave,
            stop_share,
            menu,
            update: item,
            update_shown,
        }) = held.as_mut()
        {
            // The update item: in the menu while one waits, under Show
            // Linger, and greyed out in voice, where nothing restarts.
            match &update {
                Some(TrayUpdate { text, .. }) => {
                    item.set_text(text).map_err(|e| e.to_string())?;
                    item.set_enabled(!in_voice).map_err(|e| e.to_string())?;
                    if !*update_shown {
                        menu.insert(item, 1).map_err(|e| e.to_string())?;
                        *update_shown = true;
                    }
                }
                None => {
                    if *update_shown {
                        menu.remove(item).map_err(|e| e.to_string())?;
                        *update_shown = false;
                    }
                }
            }
            mute.set_text(if muted { "Unmute" } else { "Mute" })
                .map_err(|e| e.to_string())?;
            mute.set_enabled(in_voice).map_err(|e| e.to_string())?;
            leave.set_enabled(in_voice).map_err(|e| e.to_string())?;
            stop_share
                .set_enabled(in_voice && sharing.unwrap_or(false))
                .map_err(|e| e.to_string())?;
        }
    }
    let look = Look::of(in_voice, muted || deafened);
    let words = tooltip(
        in_voice,
        muted,
        deafened,
        push_to_talk.unwrap_or(false),
        place.as_deref(),
        update.as_ref().map(|update| update.tip.as_str()),
    );
    let mut showing = items.1.lock().map_err(|e| e.to_string())?;
    let was = showing
        .as_ref()
        .map_or((Look::Idle, "Linger"), |(look, words)| {
            (*look, words.as_str())
        });
    if was == (look, words.as_str()) {
        return Ok(());
    }
    // No tray on this desktop: nothing to draw, and nothing wrong.
    let Some(tray) = window.app_handle().tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    if was.0 != look {
        tray.set_icon(Some(look.icon()))
            .map_err(|e| e.to_string())?;
    }
    // Windows and macOS show it; Linux's tray (appindicator) has no tooltips,
    // and there the menu's Unmute and an enabled Leave voice say it in words.
    tray.set_tooltip(Some(&words)).map_err(|e| e.to_string())?;
    *showing = Some((look, words));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{tooltip, Closing, Look};
    use std::sync::atomic::Ordering;

    #[test]
    fn the_icon_follows_voice_and_the_microphone() {
        assert_eq!(
            Look::of(false, false),
            Look::Idle,
            "not in voice: the plain door"
        );
        assert_eq!(
            Look::of(false, true),
            Look::Idle,
            "a mute left over after leaving shows nothing"
        );
        assert_eq!(Look::of(true, false), Look::Live, "in voice, microphone on");
        assert_eq!(
            Look::of(true, true),
            Look::Muted,
            "in voice, muted or deafened"
        );
    }

    #[test]
    fn the_three_looks_are_three_different_pictures() {
        let rgba = |look: Look| look.icon().rgba().to_vec();
        assert_ne!(rgba(Look::Idle), rgba(Look::Live));
        assert_ne!(rgba(Look::Idle), rgba(Look::Muted));
        assert_ne!(rgba(Look::Live), rgba(Look::Muted));
        for look in [Look::Idle, Look::Live, Look::Muted] {
            let icon = look.icon();
            assert_eq!(
                (icon.width(), icon.height()),
                (64, 64),
                "{look:?} is drawn at the tray's 64px"
            );
        }
    }

    #[test]
    fn the_tooltip_says_it_in_words() {
        assert_eq!(tooltip(false, false, false, false, None, None), "Linger");
        assert_eq!(
            tooltip(false, true, true, true, Some("in #general"), None),
            "Linger",
            "out of voice, nothing about voice"
        );
        assert_eq!(
            tooltip(true, false, false, false, Some("in #general"), None),
            "Linger · in voice in #general"
        );
        assert_eq!(
            tooltip(true, true, false, false, Some("in #general"), None),
            "Linger · in voice in #general, muted"
        );
        assert_eq!(
            tooltip(true, true, true, false, Some("with Jules"), None),
            "Linger · in voice with Jules, deafened"
        );
        assert_eq!(
            tooltip(true, false, false, true, Some("in #general"), None),
            "Linger · in voice in #general, push-to-talk"
        );
        assert_eq!(
            tooltip(true, true, false, true, None, None),
            "Linger · in voice, muted",
            "a mute says muted, push-to-talk or not"
        );
        assert_eq!(
            tooltip(true, false, false, false, Some("  "), None),
            "Linger · in voice"
        );
    }

    #[test]
    fn an_update_waiting_is_in_the_tooltip_out_of_voice() {
        assert_eq!(
            tooltip(false, false, false, false, None, Some("0.5.4 is ready")),
            "Linger · 0.5.4 is ready"
        );
        assert_eq!(
            tooltip(false, false, false, false, None, Some("  ")),
            "Linger"
        );
        assert_eq!(
            tooltip(
                true,
                true,
                false,
                false,
                Some("in #general"),
                Some("0.5.4 is ready")
            ),
            "Linger · in voice in #general, muted",
            "in voice, voice is what the tooltip says"
        );
    }

    #[test]
    fn a_long_place_is_cut_to_fit_a_windows_tooltip() {
        let place = format!("with {}", "Jules, Sam, Eli, ".repeat(10));
        let words = tooltip(true, true, true, false, Some(&place), None);
        assert!(words.chars().count() < 127, "{words}");
        assert!(
            words.contains('…') && words.ends_with(", deafened"),
            "{words}"
        );
        let wide = "in #".to_owned() + &"﷽".repeat(100);
        assert!(
            tooltip(true, false, false, false, Some(&wide), None)
                .chars()
                .count()
                < 127
        );
    }

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
