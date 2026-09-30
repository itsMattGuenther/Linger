//! The main window, built here rather than by Tauri's config so its frame can
//! depend on the desktop it opens on.
//!
//! On a Wayland session GTK draws the title bar itself (client-side
//! decorations), whatever the compositor would have done. Hyprland draws no
//! title bars and leaves moving, resizing and closing to its own keys, so the
//! GTK bar is a second frame nobody asked for (#130). Other desktops keep the
//! bar: GNOME, for one, draws nothing, and without it the window could not be
//! moved or closed with the mouse.

use tauri::{App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Window positions and sizes, remembered on this computer (T-1808): where
/// each window was and how big, restored when it opens again, the chat
/// window's and every popped-out conversation's included.
pub fn remembered_windows() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_window_state::Builder::default()
        .with_state_flags(remembered())
        .build()
}

/// What is remembered of a window: only size, position and maximized.
/// Whether a window has a frame depends on the desktop it opens on
/// (`create`), not on last time.
fn remembered() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Create every window in `tauri.conf.json`, with the title bar dropped on
/// Hyprland. The config marks them `"create": false` so Tauri doesn't build
/// them first; changing the frame after the window is on screen would flash
/// the bar and resize the page underneath it. The one window there is the
/// list: its own page, tall and narrow, with no system title bar on any
/// desktop, because every window draws its own (`docs/design/buddy-list.md`).
pub fn create(app: &App) -> tauri::Result<()> {
    let decorated = !on_hyprland(
        std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").as_deref(),
        std::env::var_os("XDG_CURRENT_DESKTOP").as_deref(),
    );
    for config in &app.config().app.windows {
        WebviewWindowBuilder::from_config(app, config)?
            .decorations(config.decorations && decorated)
            .build()?;
    }
    Ok(())
}

/// The owner window's label. Only it may open the Buddy list client's other
/// windows (docs/design/architecture.md, "Window management").
const OWNER: &str = "main";

/// The page for one conversation in a window of its own: popped out of the
/// tabs beside the list, or every conversation when each opens in its own
/// (#337). The address is built here from a fixed pattern, never taken from
/// the page, so no window can be told to load something else. `server` must
/// be a plain origin and `room` an id; anything else is refused.
fn conversation_url(server: &str, room: &str) -> Result<String, String> {
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

/// A message to open a conversation at (a search hit, a media tile): an id,
/// added to the address only when it is one.
fn at_message(url: String, message: Option<&str>) -> Result<String, String> {
    match message {
        None => Ok(url),
        Some(id)
            if !id.is_empty()
                && id.len() <= 64
                && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') =>
        {
            Ok(format!("{url}&message={}", escape(id)))
        }
        Some(_) => Err("not a message id".into()),
    }
}

/// The Settings window's label: one, whichever window asked for it.
const SETTINGS: &str = "settings";

/// Search and the media collection each have one window of their own
/// (decision 15, the prototype's choice).
const SEARCH: &str = "search";
const MEDIA: &str = "media";

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

/// What a conversation's own window, already open, is told when asked to
/// show a message in it.
#[derive(Clone, serde::Serialize)]
struct OpenConversation<'a> {
    server: &'a str,
    room: &'a str,
    message: Option<&'a str>,
}

/// Open one conversation in a window of its own, or bring its window forward.
/// Only the list window may ask; the tabs beside the list are in it, and a
/// conversation's own window asks it (an intent).
///
/// **Every command here that builds a window is `async`, and must stay so.**
/// On Windows, building a WebView2 window from a synchronous command
/// deadlocks: the new window comes up white and never answers, which is what
/// 0.4.0 shipped (tauri-apps/wry#583). Async commands run off the main thread,
/// and the build hands the window to it properly.
#[tauri::command]
pub async fn next_open_conversation(
    app: AppHandle,
    window: WebviewWindow,
    server: String,
    room: String,
    kind: String,
    message: Option<String>,
) -> Result<(), String> {
    if window.label() != OWNER {
        return Err("only the list window opens windows".into());
    }
    let url = at_message(conversation_url(&server, &room)?, message.as_deref())?;
    let (width, height) = conversation_size(&kind)?;
    let label = conversation_label(&server, &room);
    if let Some(open) = app.get_webview_window(&label) {
        let _ = open.unminimize();
        let _ = open.set_focus();
        // Asked for a message: the window already showing the conversation goes to it.
        if message.is_some() {
            return app
                .emit_to(
                    label.as_str(),
                    "next:open",
                    OpenConversation {
                        server: &server,
                        room: &room,
                        message: message.as_deref(),
                    },
                )
                .map_err(|e| e.to_string());
        }
        return Ok(());
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
pub async fn next_open_settings(
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

/// Open Search or Media (`which`), or bring it forward and tell it so
/// (`next:shown`, which puts the cursor in Search's box). Only the list window
/// may ask.
#[tauri::command]
pub async fn next_open_tool(
    app: AppHandle,
    window: WebviewWindow,
    which: String,
) -> Result<(), String> {
    if window.label() != OWNER {
        return Err("only the list window opens windows".into());
    }
    let (label, title, width, height) = tool_window(&which)?;
    if let Some(open) = app.get_webview_window(label) {
        let _ = open.unminimize();
        let _ = open.set_focus();
        return app
            .emit_to(label, "next:shown", ())
            .map_err(|e| e.to_string());
    }
    let url = format!("next.html?window={label}");
    WebviewWindowBuilder::new(&app, label, WebviewUrl::App(url.into()))
        // Files dropped on the page reach it on Windows too (COMP-11, lib/drops.ts).
        .disable_drag_drop_handler()
        .title(title)
        .inner_size(width, height)
        .min_inner_size(360.0, 420.0)
        .decorations(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Search's and Media's windows: label, title and size. Media is wide for its
/// grid; Search is a column of results. Anything else is refused.
fn tool_window(which: &str) -> Result<(&'static str, &'static str, f64, f64), String> {
    match which {
        SEARCH => Ok((SEARCH, "Linger Search", 560.0, 680.0)),
        MEDIA => Ok((MEDIA, "Linger Media", 780.0, 680.0)),
        _ => Err("not a window Linger opens".into()),
    }
}

/// Tell the owner a Buddy list window has gone, however it went: its own close
/// button, the desktop's, or a crash. A window that closes cleanly says so
/// itself first; this covers the ones that can't, so the owner never keeps
/// counting a window that no longer exists towards you being here
/// (docs/design/architecture.md, "Windows and their roles").
pub fn on_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    // Closing the list keeps Linger in the tray, or quits it and every
    // window with it (tray.rs).
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == OWNER {
            let app = window.app_handle();
            if app.state::<crate::tray::Closing>().hides() {
                api.prevent_close();
                let _ = window.hide();
            } else {
                app.exit(0);
            }
        }
    }
    if matches!(event, tauri::WindowEvent::Destroyed) && is_viewer(window.label()) {
        let app = window.app_handle();
        let _ = app.emit_to(OWNER, "next:closed", window.label());
        // Where every window is goes to disk now, this one's included (the
        // plugin noted it as the window closed). The plugin writes only when
        // Linger quits through its event loop, and it doesn't always: an
        // update on Windows ends Linger outright (the updater calls
        // `std::process::exit`), and so does a crash, and every window would
        // then open where it was before this run (#225).
        let _ = app.save_window_state(remembered());
    }
}

/// Which window to point at for a DM (#291), or none. Nothing while any
/// Linger window has the focus: whoever's using the app sees the DM's row
/// light up. Otherwise the first that's showing of the DM's own window and
/// the list, where the tabs are (#337). A minimized window counts, because its taskbar
/// button is exactly what should flash; one hidden in the tray doesn't.
fn attention_target<'a>(
    order: &[&'a str],
    showing: impl Fn(&str) -> bool,
    any_focused: bool,
) -> Option<&'a str> {
    if any_focused {
        return None;
    }
    order.iter().copied().find(|label| showing(label))
}

/// Ask the desktop to point at Linger when a DM arrives (#291): the OS's own
/// "look here", which it stops by itself once the window is used. Windows
/// flashes the taskbar button, Linux marks the window urgent (the desktop
/// decides how that looks) and macOS bounces the dock icon once. Only the
/// list window may ask, as it's the one that hears messages. Says whether it
/// asked for anything.
#[tauri::command]
pub fn next_request_attention(
    app: AppHandle,
    window: WebviewWindow,
    server: String,
    room: String,
) -> Result<bool, String> {
    if window.label() != OWNER {
        return Err("only the list window asks for attention".into());
    }
    let windows = app.webview_windows();
    let any_focused = windows
        .values()
        .any(|open| open.is_focused().unwrap_or(false));
    let own = conversation_label(&server, &room);
    let showing = |label: &str| {
        windows
            .get(label)
            .is_some_and(|open| open.is_visible().unwrap_or(false))
    };
    let Some(label) = attention_target(&[own.as_str(), OWNER], showing, any_focused) else {
        return Ok(false);
    };
    let Some(target) = windows.get(label) else {
        return Ok(false);
    };
    target
        .request_user_attention(Some(tauri::UserAttentionType::Informational))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// The Buddy list client's windows other than the owner: conversations in
/// windows of their own, Settings, Search and Media.
fn is_viewer(label: &str) -> bool {
    label == SETTINGS || label == SEARCH || label == MEDIA || label.starts_with("chat-")
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
        at_message, attention_target, conversation_label, conversation_size, conversation_url,
        escape, is_origin, is_viewer, on_hyprland, settings_url, tool_window, MEDIA, OWNER, SEARCH,
        SETTINGS,
    };

    /// A DM points at its own window, then the list, where the tabs are
    /// (#337), whichever is showing, and at nothing while Linger has the
    /// focus (#291).
    #[test]
    fn a_dm_points_at_the_window_it_would_show_in() {
        let order = ["chat-0123", OWNER];
        let only = |shown: &'static [&'static str]| move |label: &str| shown.contains(&label);
        assert_eq!(
            attention_target(&order, only(&["chat-0123", OWNER]), false),
            Some("chat-0123")
        );
        assert_eq!(attention_target(&order, only(&[OWNER]), false), Some(OWNER));
        // The list hidden in the tray and nothing else open: nothing to flash.
        assert_eq!(attention_target(&order, only(&[]), false), None);
        // Somebody's using Linger: the DM's row lights up instead.
        assert_eq!(attention_target(&order, only(&[OWNER]), true), None);
    }
    use std::ffi::OsStr;

    /// Whether a capability's `windows` entry names this label: exactly, or
    /// by a trailing `*` (`chat-*`), the only pattern the files use.
    fn names(pattern: &str, label: &str) -> bool {
        match pattern.strip_suffix('*') {
            Some(prefix) => {
                assert!(
                    !prefix.contains('*'),
                    "a pattern this test can't read: {pattern}"
                );
                label.starts_with(prefix)
            }
            None => pattern == label,
        }
    }

    /// Every permission granted to a window with this label, from every
    /// capability file that names it.
    fn permissions_of(label: &str) -> Vec<String> {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut granted = Vec::new();
        for entry in std::fs::read_dir(dir).expect("the capabilities folder") {
            let text = std::fs::read_to_string(entry.expect("a capability file").path())
                .expect("a readable capability file");
            let capability: serde_json::Value =
                serde_json::from_str(&text).expect("a capability is JSON");
            let windows = capability["windows"].as_array().expect("windows");
            if !windows
                .iter()
                .any(|pattern| names(pattern.as_str().unwrap_or(""), label))
            {
                continue;
            }
            for permission in capability["permissions"].as_array().expect("permissions") {
                let id = permission
                    .as_str()
                    .or_else(|| permission["identifier"].as_str())
                    .unwrap_or("");
                granted.push(id.to_string());
            }
        }
        granted
    }

    /// Every window Linger opens is frameless and moved by its own title bar
    /// (the kit's `TitleBar`), which asks Tauri to start a drag, and to
    /// maximize on a double press. A window not granted those calls has a
    /// title bar that silently does nothing, which on Windows leaves it
    /// where it opened (#225).
    #[test]
    fn every_window_linger_opens_may_be_moved_by_its_title_bar() {
        let conversation = conversation_label("https://home.example", "r-general");
        for label in [OWNER, conversation.as_str(), SETTINGS, SEARCH, MEDIA] {
            let granted = permissions_of(label);
            assert!(
                granted
                    .iter()
                    .any(|id| id == "core:window:allow-start-dragging"),
                "{label} may not start a drag, so its title bar can't move it"
            );
            assert!(
                granted.iter().any(|id| matches!(
                    id.as_str(),
                    "core:default"
                        | "core:window:default"
                        | "core:window:allow-internal-toggle-maximize"
                )),
                "{label} may not maximize from its title bar"
            );
        }
    }

    /// The browser tests copy Tauri's rule for which presses move a window
    /// (`client/tests/browser/tauri-drag.ts`), since a browser has no Tauri.
    /// A copy of another Tauri's rule would prove nothing, so after an
    /// upgrade this fails until somebody has compared Tauri's `drag.js` with
    /// the copy and brought the copy's version up to date.
    #[test]
    fn the_title_bar_tests_know_the_tauri_they_copy() {
        let tauri = include_str!("../Cargo.lock")
            .split("[[package]]")
            .find(|package| package.contains("\nname = \"tauri\"\n"))
            .and_then(|package| {
                package
                    .lines()
                    .find_map(|line| line.strip_prefix("version = \""))
            })
            .map(|version| version.trim_end_matches('"'))
            .expect("tauri in Cargo.lock");
        let copy = include_str!("../../tests/browser/tauri-drag.ts");
        assert!(
            copy.contains(&format!("TAURI_DRAG_VERSION = \"{tauri}\"")),
            "Tauri is now {tauri}: compare its src/window/scripts/drag.js with the copy in \
             client/tests/browser/tauri-drag.ts, then update the copy and TAURI_DRAG_VERSION"
        );
    }

    #[test]
    fn a_conversation_window_opens_only_our_page_with_a_real_server_and_room() {
        assert_eq!(
            conversation_url("https://linger.example", "0193a2b4-7c1d-7000-8000-000000000001").as_deref(),
            Ok("next.html?window=chat&server=https%3A%2F%2Flinger.example&room=0193a2b4-7c1d-7000-8000-000000000001")
        );
        assert!(conversation_url("http://localhost:8080", "r-general").is_ok());
        for server in [
            "",
            "linger.example",
            "javascript:alert(1)",
            "https://linger.example/path",
            "https://a b",
            "file:///etc/passwd",
            "https://",
        ] {
            assert!(conversation_url(server, "r-general").is_err(), "{server:?}");
        }
        for room in ["", "r general", "../x", "r&x=1", "r?x", &"r".repeat(65)] {
            assert!(
                conversation_url("https://linger.example", room).is_err(),
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
    fn the_list_window_is_tall_narrow_and_frameless() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        let list = &windows[0];
        assert_eq!(list["label"].as_str().unwrap_or("main"), OWNER);
        assert_eq!(list["url"], "next.html");
        assert!(list["height"].as_f64() > list["width"].as_f64());
        assert_eq!(list["decorations"], false);
        assert_eq!(list["create"], false);
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
        for label in ["chat-2", "chat-r-general", "settings", "search", "media"] {
            assert!(is_viewer(label), "{label}");
        }
        // `chat` was the tabs window, gone since the tabs moved beside the list (#337).
        for label in ["main", "", "chat", "chatty", "settings-2", "Chat"] {
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
    fn a_conversation_window_is_sized_for_what_it_shows() {
        assert_eq!(conversation_size("room"), Ok((560.0, 760.0)));
        assert_eq!(conversation_size("dm"), Ok((460.0, 500.0)));
        assert!(conversation_size("settings").is_err());
    }

    #[test]
    fn a_conversation_opens_at_a_message_only_when_it_is_an_id() {
        let url = conversation_url("https://home.example", "r-general").unwrap();
        assert_eq!(at_message(url.clone(), None).unwrap(), url);
        assert_eq!(
            at_message(url.clone(), Some("m000123")).unwrap(),
            format!("{url}&message=m000123")
        );
        for bad in ["", "m1&window=settings", "../x", &"m".repeat(65)] {
            assert!(at_message(url.clone(), Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn search_and_media_are_the_only_other_windows_it_opens() {
        assert_eq!(tool_window("search").unwrap().0, "search");
        assert_eq!(tool_window("media").unwrap().0, "media");
        assert!(tool_window("settings").is_err());
        assert!(tool_window("").is_err());
        assert!(is_viewer("search") && is_viewer("media"));
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
