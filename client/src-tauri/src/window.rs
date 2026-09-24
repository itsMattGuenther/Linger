//! The main window, built here rather than by Tauri's config so its frame can
//! depend on the desktop it opens on.
//!
//! On a Wayland session GTK draws the title bar itself (client-side
//! decorations), whatever the compositor would have done. Hyprland draws no
//! title bars and leaves moving, resizing and closing to its own keys, so the
//! GTK bar is a second frame nobody asked for (#130). Other desktops keep the
//! bar: GNOME, for one, draws nothing, and without it the window could not be
//! moved or closed with the mouse.

use tauri::{App, WebviewWindowBuilder};

/// Create every window in `tauri.conf.json`, with the title bar dropped on
/// Hyprland. The config marks them `"create": false` so Tauri doesn't build
/// them first; changing the frame after the window is on screen would flash
/// the bar and resize the page underneath it.
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
    use super::on_hyprland;
    use std::ffi::OsStr;

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
