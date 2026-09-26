//! The main window, built here rather than by Tauri's config so its frame can
//! depend on the desktop it opens on.
//!
//! On a Wayland session GTK draws the title bar itself (client-side
//! decorations), whatever the compositor would have done. Hyprland draws no
//! title bars and leaves moving, resizing and closing to its own keys, so the
//! GTK bar is a second frame nobody asked for (#130). Other desktops keep the
//! bar: GNOME, for one, draws nothing, and without it the window could not be
//! moved or closed with the mouse.

use std::ffi::OsStr;

use tauri::{App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Create every window in `tauri.conf.json`, with the title bar dropped on
/// Hyprland. The config marks them `"create": false` so Tauri doesn't build
/// them first; changing the frame after the window is on screen would flash
/// the bar and resize the page underneath it.
/// Window positions and sizes, remembered on this computer (T-1808): where
/// each Buddy list window was and how big, restored when it opens again, the
/// chat window's and every popped-out conversation's included. Today's client
/// keeps its old behavior, so its main window is left out. Only size,
/// position and maximized are kept: whether a window has a frame depends on
/// the desktop it opens on (`create`), not on last time.
pub fn remembered_windows() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_window_state::{Builder, StateFlags};
    let builder = Builder::default()
        .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
    if chosen_client(std::env::var_os(NEXT).as_deref()) == Client::Next {
        builder.build()
    } else {
        builder.with_denylist(&[OWNER]).build()
    }
}

pub fn create(app: &App) -> tauri::Result<()> {
    let decorated = !on_hyprland(
        std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").as_deref(),
        std::env::var_os("XDG_CURRENT_DESKTOP").as_deref(),
    );
    let client = chosen_client(std::env::var_os(NEXT).as_deref());
    for config in &app.config().app.windows {
        if client == Client::Next && config.label == "main" {
            WebviewWindowBuilder::from_config(app, &buddy_list(config))?.build()?;
            continue;
        }
        WebviewWindowBuilder::from_config(app, config)?
            .decorations(config.decorations && decorated)
            .build()?;
    }
    Ok(())
}

/// The hidden switch for the Buddy list client under development (M15,
/// `docs/design/architecture.md`). `LINGER_NEXT=1` opens it as the main
/// window; anything else, including unset, opens today's client, so nobody
/// meets the new one by accident.
const NEXT: &str = "LINGER_NEXT";

#[derive(Debug, PartialEq, Eq)]
enum Client {
    Current,
    Next,
}

fn chosen_client(value: Option<&OsStr>) -> Client {
    match value.and_then(OsStr::to_str) {
        Some("1") => Client::Next,
        _ => Client::Current,
    }
}

/// The main window as the Buddy list client wants it: the list's own page, a
/// tall narrow window, and no system title bar on any desktop, because every
/// window of the new client draws its own (`docs/design/buddy-list.md`).
fn buddy_list(config: &tauri::utils::config::WindowConfig) -> tauri::utils::config::WindowConfig {
    let mut list = config.clone();
    list.url = WebviewUrl::App("next.html".into());
    list.width = 340.0;
    list.height = 820.0;
    list.min_width = Some(300.0);
    list.min_height = Some(480.0);
    list.decorations = false;
    list
}

/// The owner window's label. Only it may open the Buddy list client's other
/// windows (docs/design/architecture.md, "Window management").
const OWNER: &str = "main";

/// The chat window's label, in tabs mode (the default): one window, one tab
/// per conversation.
const CHAT: &str = "chat";

/// The page for a chat window opened on one conversation. The address is
/// built here from a fixed pattern, never taken from the page, so no window
/// can be told to load something else. `server` must be a plain origin and
/// `room` an id; anything else is refused.
fn chat_url(server: &str, room: &str) -> Result<String, String> {
    if !is_origin(server) {
        return Err("not a server address".into());
    }
    if room.is_empty()
        || room.len() > 64
        || !room.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("not a room id".into());
    }
    Ok(format!(
        "next.html?window=chat&server={}&room={}",
        escape(server),
        escape(room)
    ))
}

/// The Settings window's label: one, whichever window asked for it.
const SETTINGS: &str = "settings";

/// The page for the Settings window, opened on a section when one is named.
/// A section is a short lowercase key (`profile`, `invites`); anything else
/// is refused rather than put into the address.
fn settings_url(section: Option<&str>) -> Result<String, String> {
    match section {
        None => Ok("next.html?window=settings".into()),
        Some(key)
            if !key.is_empty()
                && key.len() <= 24
                && key.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') =>
        {
            Ok(format!("next.html?window=settings&section={key}"))
        }
        Some(_) => Err("not a settings section".into()),
    }
}

/// The page for one conversation in a window of its own: popped out of the
/// tabs, or every conversation in windows mode.
fn conversation_url(server: &str, room: &str) -> Result<String, String> {
    chat_url(server, room).map(|url| url + "&single=1")
}

/// One window per conversation: the label is made from the conversation, so
/// asking again brings the same window forward rather than opening a second.
/// FNV-1a, because it gives the same label in every run and every build,
/// which std's hasher does not promise.
fn conversation_label(server: &str, room: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in server
        .bytes()
        .chain(std::iter::once(b'#'))
        .chain(room.bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("chat-{hash:016x}")
}

/// A room's window is tall, for reading; a DM's is smaller (the prototype's
/// sizes). Anything else is refused.
fn conversation_size(kind: &str) -> Result<(f64, f64), String> {
    match kind {
        "room" => Ok((560.0, 760.0)),
        "dm" => Ok((460.0, 500.0)),
        _ => Err("not a kind of conversation".into()),
    }
}

/// `https://host[:port]` or `http://host[:port]`, with nothing after it.
fn is_origin(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    else {
        return false;
    };
    !rest.is_empty()
        && rest.len() <= 255
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'))
}

/// Percent-encode everything but the unreserved characters (RFC 3986).
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// What an already-open chat window is told when asked to show a conversation.
#[derive(Clone, serde::Serialize)]
struct OpenConversation<'a> {
    server: &'a str,
    room: &'a str,
}

/// Open the chat window on a conversation, or, if it is already open, bring it
/// forward and tell it to show that conversation (it adds a tab or selects
/// one). Only the list window may ask.
#[tauri::command]
pub fn next_open_chat(
    app: AppHandle,
    window: WebviewWindow,
    server: String,
    room: String,
) -> Result<(), String> {
    if window.label() != OWNER {
        return Err("only the list window opens windows".into());
    }
    let url = chat_url(&server, &room)?;
    if let Some(chat) = app.get_webview_window(CHAT) {
        let _ = chat.unminimize();
        let _ = chat.set_focus();
        return app
            .emit_to(
                CHAT,
                "next:open",
                OpenConversation {
                    server: &server,
                    room: &room,
                },
            )
            .map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, CHAT, WebviewUrl::App(url.into()))
        // Files dropped on the page reach it on Windows too (COMP-11, lib/drops.ts).
        .disable_drag_drop_handler()
        .title("Linger")
        .inner_size(780.0, 820.0)
        .min_inner_size(420.0, 360.0)
        .decorations(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Open one conversation in a window of its own, or bring its window forward.
/// Only the list window may ask; a chat window asks the list window (an
/// intent) to pop a tab out.
#[tauri::command]
pub fn next_open_conversation(
    app: AppHandle,
    window: WebviewWindow,
    server: String,
    room: String,
    kind: String,
) -> Result<(), String> {
    if window.label() != OWNER {
        return Err("only the list window opens windows".into());
    }
    let url = conversation_url(&server, &room)?;
    let (width, height) = conversation_size(&kind)?;
    let label = conversation_label(&server, &room);
    if let Some(open) = app.get_webview_window(&label) {
        let _ = open.unminimize();
        return open.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        // Files dropped on the page reach it on Windows too (COMP-11, lib/drops.ts).
        .disable_drag_drop_handler()
        .title("Linger")
        .inner_size(width, height)
        .min_inner_size(360.0, 360.0)
        .decorations(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Open the Settings window, on a section if one is named, or bring it
/// forward and tell it to show that section. Only the list window may ask; a
/// chat window asks the list window (an intent).
#[tauri::command]
pub fn next_open_settings(
    app: AppHandle,
    window: WebviewWindow,
    section: Option<String>,
) -> Result<(), String> {
    if window.label() != OWNER {
        return Err("only the list window opens windows".into());
    }
    let url = settings_url(section.as_deref())?;
    if let Some(open) = app.get_webview_window(SETTINGS) {
        let _ = open.unminimize();
        let _ = open.set_focus();
        return app
            .emit_to(SETTINGS, "next:section", section)
            .map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, SETTINGS, WebviewUrl::App(url.into()))
        // Files dropped on the page reach it on Windows too (COMP-11, lib/drops.ts).
        .disable_drag_drop_handler()
        .title("Linger Settings")
        .inner_size(720.0, 640.0)
        .min_inner_size(560.0, 480.0)
        .decorations(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Tell the owner a Buddy list window has gone, however it went: its own close
/// button, the desktop's, or a crash. A window that closes cleanly says so
/// itself first; this covers the ones that can't, so the owner never keeps
/// counting a window that no longer exists towards you being here
/// (docs/design/architecture.md, "Windows and their roles").
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) && is_viewer(window.label()) {
        let _ = window
            .app_handle()
            .emit_to(OWNER, "next:closed", window.label());
    }
}

/// The Buddy list client's windows other than the owner: the chat window,
/// conversations popped out of it, and Settings.
fn is_viewer(label: &str) -> bool {
    label == CHAT || label == SETTINGS || label.starts_with("chat-")
}

/// Hyprland exports its instance signature to every client it starts;
/// `XDG_CURRENT_DESKTOP` covers a launch that passed through something which
/// dropped it. Only Linux has either, so this is false everywhere else.
fn on_hyprland(
    signature: Option<&std::ffi::OsStr>,
    current_desktop: Option<&std::ffi::OsStr>,
) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    signature.is_some_and(|value| !value.is_empty())
        || current_desktop
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|desktops| {
                desktops
                    .split(':')
                    .any(|name| name.eq_ignore_ascii_case("hyprland"))
            })
}

#[cfg(test)]
mod tests {

    /// Tauri's own drop handling keeps dropped files from the page on
    /// Windows (COMP-11), so every window turns it off and the page refuses
    /// stray drops itself (`lib/drops.ts`).
    #[test]
    fn every_window_leaves_dropped_files_to_the_page() {
        let source = include_str!("window.rs");
        let built = source.matches("WebviewWindowBuilder::new(").count();
        let off = source.matches(".disable_drag_drop_handler()").count();
        assert!(built >= 3);
        assert_eq!(off, built, "a window built here keeps Tauri's drop handler");
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        for window in config["app"]["windows"].as_array().expect("windows") {
            assert_eq!(window["dragDropEnabled"], serde_json::Value::Bool(false));
        }
    }
    use super::{
        buddy_list, chat_url, chosen_client, conversation_label, conversation_size,
        conversation_url, escape, is_origin, is_viewer, on_hyprland, settings_url, Client,
    };
    use std::ffi::OsStr;
    use tauri::WebviewUrl;

    #[test]
    fn only_linger_next_1_opens_the_new_client() {
        assert_eq!(chosen_client(Some(OsStr::new("1"))), Client::Next);
        for other in ["", "0", "true", "yes", "2", " 1"] {
            assert_eq!(
                chosen_client(Some(OsStr::new(other))),
                Client::Current,
                "{other:?}"
            );
        }
        assert_eq!(chosen_client(None), Client::Current);
    }

    #[test]
    fn a_chat_window_opens_only_our_page_with_a_real_server_and_room() {
        assert_eq!(
            chat_url("https://linger.example", "0193a2b4-7c1d-7000-8000-000000000001").as_deref(),
            Ok("next.html?window=chat&server=https%3A%2F%2Flinger.example&room=0193a2b4-7c1d-7000-8000-000000000001")
        );
        assert!(chat_url("http://localhost:8080", "r-general").is_ok());
        for server in [
            "",
            "linger.example",
            "javascript:alert(1)",
            "https://linger.example/path",
            "https://a b",
            "file:///etc/passwd",
            "https://",
        ] {
            assert!(chat_url(server, "r-general").is_err(), "{server:?}");
        }
        for room in ["", "r general", "../x", "r&x=1", "r?x", &"r".repeat(65)] {
            assert!(
                chat_url("https://linger.example", room).is_err(),
                "{room:?}"
            );
        }
    }

    #[test]
    fn origins_and_escaping_are_strict() {
        assert!(is_origin("https://[::1]:8443"));
        assert!(!is_origin("https://linger.example?x=1"));
        assert_eq!(escape("a b/c:d"), "a%20b%2Fc%3Ad");
    }

    #[test]
    fn the_buddy_list_window_is_tall_narrow_and_frameless() {
        let main = tauri::utils::config::WindowConfig::default();
        let list = buddy_list(&main);
        assert_eq!(list.url, WebviewUrl::App("next.html".into()));
        assert!(list.height > list.width);
        assert!(!list.decorations);
        assert_eq!(list.label, main.label);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn hyprland_is_recognised_by_either_variable() {
        assert!(on_hyprland(Some(OsStr::new("abc_123")), None));
        assert!(on_hyprland(None, Some(OsStr::new("Hyprland"))));
        assert!(on_hyprland(None, Some(OsStr::new("hyprland"))));
        assert!(on_hyprland(None, Some(OsStr::new("Hyprland:wlroots"))));
    }

    #[test]
    fn other_desktops_keep_their_title_bar() {
        assert!(!on_hyprland(None, None));
        assert!(!on_hyprland(Some(OsStr::new("")), None));
        assert!(!on_hyprland(None, Some(OsStr::new("GNOME"))));
        assert!(!on_hyprland(None, Some(OsStr::new("ubuntu:GNOME"))));
        assert!(!on_hyprland(None, Some(OsStr::new("KDE"))));
        assert!(!on_hyprland(None, Some(OsStr::new("NotHyprland"))));
    }

    #[test]
    fn only_the_buddy_list_windows_other_than_the_owner_are_viewers() {
        for label in ["chat", "chat-2", "chat-r-general", "settings"] {
            assert!(is_viewer(label), "{label}");
        }
        for label in ["main", "", "chatty", "settings-2", "Chat"] {
            assert!(!is_viewer(label), "{label}");
        }
    }

    #[test]
    fn a_conversation_window_has_one_label_per_conversation() {
        let general = conversation_label("https://home.example", "r-general");
        assert_eq!(
            general,
            conversation_label("https://home.example", "r-general")
        );
        assert_ne!(
            general,
            conversation_label("https://work.example", "r-general")
        );
        assert_ne!(
            general,
            conversation_label("https://home.example", "r-plans")
        );
        // The same bytes split differently are a different conversation.
        assert_ne!(
            conversation_label("https://a.example", "b-c"),
            conversation_label("https://a.example#b", "c")
        );
        assert!(general.starts_with("chat-") && general.len() == 21);
        assert!(general
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        assert!(is_viewer(&general));
    }

    #[test]
    fn a_conversation_window_opens_only_on_a_real_conversation() {
        assert_eq!(
            conversation_url("https://home.example", "r-general").as_deref(),
            Ok("next.html?window=chat&server=https%3A%2F%2Fhome.example&room=r-general&single=1")
        );
        assert!(conversation_url("javascript:alert(1)", "r-general").is_err());
        assert!(conversation_url("https://home.example", "../settings").is_err());
        assert_eq!(conversation_size("room"), Ok((560.0, 760.0)));
        assert_eq!(conversation_size("dm"), Ok((460.0, 500.0)));
        assert!(conversation_size("settings").is_err());
    }

    #[test]
    fn settings_opens_only_on_a_section_key() {
        assert_eq!(
            settings_url(None).as_deref(),
            Ok("next.html?window=settings")
        );
        assert_eq!(
            settings_url(Some("invites")).as_deref(),
            Ok("next.html?window=settings&section=invites")
        );
        for junk in [
            "",
            "Profile",
            "a&window=chat",
            "../x",
            "x".repeat(25).as_str(),
        ] {
            assert!(settings_url(Some(junk)).is_err(), "{junk}");
        }
    }
}
