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

use tauri::{App, WebviewUrl, WebviewWindowBuilder};

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
    use super::{buddy_list, chosen_client, on_hyprland, Client};
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
}
