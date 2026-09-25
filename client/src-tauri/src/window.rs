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
        .title("Linger")
        .inner_size(780.0, 820.0)
        .min_inner_size(420.0, 360.0)
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
    label == CHAT || label == "settings" || label.starts_with("chat-")
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
    use super::{
        buddy_list, chat_url, chosen_client, escape, is_origin, is_viewer, on_hyprland, Client,
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
}
