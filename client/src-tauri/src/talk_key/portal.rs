//! The talk key on Linux: the desktop's global shortcuts (the
//! `org.freedesktop.portal.GlobalShortcuts` portal, through `ashpd`).
//!
//! Wayland doesn't let one app see keys meant for another, by design, and
//! that's the rule Linger keeps everywhere. So Linger asks the desktop for one
//! shortcut, `push-to-talk`, and the person gives it a key there: KDE and
//! GNOME ask, and Hyprland takes a bind line, which Settings shows. The
//! desktop then says when that shortcut goes down (`Activated`) and up
//! (`Deactivated`). Linger never sees a key, the talk key included.
//!
//! The portal names apps by their desktop file, and a program that wasn't
//! started by one has to say which it is (`org.freedesktop.host.portal.Registry`,
//! xdg-desktop-portal 1.19 and later), which works only when that file is
//! installed. Each package installs its own: the Arch package `linger`, the
//! AppImage `com.linger.desktop` (written on every launch, `linux_startup.rs`),
//! and the .deb and .rpm `Linger`. A development build has none, and the talk
//! key then works while a Linger window is in front, as Settings says.
//!
//! Each watch has a D-Bus connection of its own, opened when you join voice
//! with push-to-talk on and closed when you leave: the portal ties the app's
//! name to a connection, and nothing is left running between calls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ashpd::desktop::global_shortcuts::{GlobalShortcuts, NewShortcut};
use ashpd::zbus::zvariant::Value;
use futures_util::StreamExt;
use tauri::async_runtime::JoinHandle;
use tokio::sync::oneshot;

use super::{Edge, Reach, Reporter, SHORTCUT_ID};

/// How long the desktop gets to answer whether it has the portal, for
/// Settings. A desktop that doesn't answer in that time doesn't have it.
const ASK_WAIT: Duration = Duration::from_secs(3);

/// Stops a watch when dropped (or sent to).
pub type Stop = oneshot::Sender<()>;

/// The last watch, so the next waits for it to close its session first: the
/// desktop would otherwise see two `push-to-talk` shortcuts for a moment.
static LAST: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);

/// Why the portal couldn't be used.
#[derive(Debug, thiserror::Error)]
enum Problem {
    #[error("this copy of Linger has no desktop file, so the desktop can't name it")]
    NotInstalled,
    #[error("the desktop has no global shortcuts portal")]
    NoPortal,
    #[error("the desktop didn't answer in time")]
    Slow,
    #[error(transparent)]
    Portal(#[from] ashpd::Error),
    #[error(transparent)]
    Bus(#[from] ashpd::zbus::Error),
}

/// The app's name to the portal: the first of `candidates` whose desktop file
/// `has` (`<name>.desktop` in a data directory). The installed copy's own
/// comes first: the AppImage's for an AppImage, the package's for a package.
fn app_id(appimage: bool, packaged: bool, has: impl Fn(&str) -> bool) -> Option<&'static str> {
    let candidates: &[&'static str] = if appimage {
        &[crate::desktop_entry::APP_ID]
    } else if packaged {
        &["linger"]
    } else {
        &["Linger", "linger", crate::desktop_entry::APP_ID]
    };
    candidates.iter().copied().find(|name| has(name))
}

/// Where desktop files are found: the data directories' `applications`
/// (the XDG base directory spec, with its defaults).
fn data_dirs(
    home: Option<&Path>,
    data_home: Option<&str>,
    data_dirs: Option<&str>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match data_home.filter(|dir| !dir.is_empty()) {
        Some(dir) => dirs.push(PathBuf::from(dir)),
        None => dirs.extend(home.map(|home| home.join(".local/share"))),
    }
    let shared = data_dirs
        .filter(|list| !list.is_empty())
        .unwrap_or("/usr/local/share:/usr/share");
    dirs.extend(
        shared
            .split(':')
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from),
    );
    dirs.into_iter()
        .map(|dir| dir.join("applications"))
        .collect()
}

/// This copy's name to the portal, if the desktop can know it.
fn this_app_id() -> Option<&'static str> {
    let exe = std::env::current_exe().ok()?;
    let appimage = crate::desktop_entry::this_program().is_ok_and(|program| program != exe);
    let packaged = crate::packaging::package_manager().is_some();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let dirs = data_dirs(
        home.as_deref(),
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        std::env::var("XDG_DATA_DIRS").ok().as_deref(),
    );
    app_id(appimage, packaged, |name| {
        dirs.iter()
            .any(|dir| dir.join(format!("{name}.desktop")).is_file())
    })
}

/// Hyprland's config, where the bind line goes: Lua from 0.56, the older
/// `hyprland.conf` before. None on any other desktop.
fn hyprland() -> Option<&'static str> {
    std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(if config.join("hypr/hyprland.lua").is_file() {
        "lua"
    } else {
        "conf"
    })
}

/// A connection the portal knows as Linger, and the portal on it.
async fn connect(app_id: &str) -> Result<GlobalShortcuts, Problem> {
    let connection = ashpd::zbus::Connection::session().await?;
    register(&connection, app_id).await?;
    match GlobalShortcuts::with_connection(connection).await {
        Ok(portal) => Ok(portal),
        Err(ashpd::Error::PortalNotFound(_)) => Err(Problem::NoPortal),
        Err(error) => Err(error.into()),
    }
}

/// Tell the portal which app this connection is, before anything else on it:
/// it names a connection on the first call (`org.freedesktop.host.portal.Registry`).
/// Called directly rather than through `ashpd`, which takes only names with a
/// dot in them, and the Arch package's is `linger`. The portal checks the name
/// against the installed desktop files. A portal older than the registry
/// (before 1.19) names the app from how it was started instead, so its
/// absence isn't a refusal.
async fn register(connection: &ashpd::zbus::Connection, app_id: &str) -> Result<(), Problem> {
    let options: HashMap<&str, Value<'_>> = HashMap::new();
    let answer = connection
        .call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.host.portal.Registry"),
            "Register",
            &(app_id, options),
        )
        .await;
    match answer {
        Ok(_) => Ok(()),
        Err(ashpd::zbus::Error::MethodError(name, _, _))
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.UnknownInterface"
                    | "org.freedesktop.DBus.Error.UnknownObject"
                    | "org.freedesktop.DBus.Error.ServiceUnknown"
            ) =>
        {
            Ok(())
        }
        Err(error) => {
            eprintln!("linger: the desktop wouldn't take the name {app_id}: {error}");
            Err(Problem::NotInstalled)
        }
    }
}

/// Whether the talk key can reach past Linger's windows here, for Settings.
/// Asking opens a connection and closes it: no shortcut is made.
pub async fn reach(bind: Option<String>) -> Reach {
    let asked = async {
        let app_id = this_app_id().ok_or(Problem::NotInstalled)?;
        connect(app_id).await?;
        Ok::<_, Problem>(app_id)
    };
    match tokio::time::timeout(ASK_WAIT, asked)
        .await
        .unwrap_or(Err(Problem::Slow))
    {
        Ok(app_id) => Reach::Desktop {
            shortcut: format!("{app_id}:{SHORTCUT_ID}"),
            hyprland: hyprland(),
            bind,
        },
        Err(Problem::NotInstalled) => Reach::Window { why: "installed" },
        Err(_) => Reach::Window { why: "desktop" },
    }
}

/// Start watching the desktop's `push-to-talk` shortcut; dropping the answer
/// stops it. `trigger` is the key Linger would suggest (an X keysym name),
/// which KDE offers in its dialog. None when this copy has no name the portal
/// can know, so nothing starts.
pub fn watch(trigger: Option<String>, tell: impl Fn(Edge) + Send + 'static) -> Option<Stop> {
    let Some(app_id) = this_app_id() else {
        eprintln!(
            "linger: {}; the talk key works while a Linger window is in front",
            Problem::NotInstalled
        );
        return None;
    };
    let (stop, stopped) = oneshot::channel();
    let mut last = LAST.lock().ok()?;
    let before = last.take();
    *last = Some(tauri::async_runtime::spawn(async move {
        if let Some(before) = before {
            let _ = before.await;
        }
        if let Err(problem) = shortcut(app_id, trigger, stopped, tell).await {
            eprintln!("linger: the talk key works while a Linger window is in front: {problem}");
        }
    }));
    Some(stop)
}

/// The shortcut's life: made, reported down and up, and closed when `stopped`
/// says so, its sender is dropped, or the desktop ends it.
async fn shortcut(
    app_id: &'static str,
    trigger: Option<String>,
    mut stopped: oneshot::Receiver<()>,
    tell: impl Fn(Edge),
) -> Result<(), Problem> {
    let portal = connect(app_id).await?;
    let session = portal.create_session(Default::default()).await?;
    // Listening before binding, so the first press can't be missed.
    let downs = portal.receive_activated().await?;
    let ups = portal.receive_deactivated().await?;
    let closed = session.receive_closed().await?;
    tokio::pin!(downs, ups, closed);
    let wanted = [NewShortcut::new(SHORTCUT_ID, "Push to talk in Linger")
        .preferred_trigger(trigger.as_deref())];
    // KDE and GNOME answer once the person has seen their dialog, which may
    // be a while; Hyprland answers at once.
    let bound = portal.bind_shortcuts(&session, &wanted, None, Default::default());
    tokio::pin!(bound);
    let mut binding = true;
    // Dropped on the way out, whichever way that is: a key it reported down is
    // reported up (fail closed).
    let mut reporter = Reporter::new(false, tell);
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            answer = &mut bound, if binding => {
                binding = false;
                if let Err(error) = answer {
                    eprintln!("linger: the desktop didn't take the talk key's shortcut: {error}");
                }
            }
            down = downs.next() => match down {
                Some(down) if down.shortcut_id() == SHORTCUT_ID => reporter.saw(true),
                Some(_) => {}
                None => break,
            },
            up = ups.next() => match up {
                Some(up) if up.shortcut_id() == SHORTCUT_ID => reporter.saw(false),
                Some(_) => {}
                None => break,
            },
            _ = closed.next() => break,
        }
    }
    drop(reporter);
    let _ = session.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_copy_names_itself_by_its_own_desktop_file() {
        let all = |_: &str| true;
        assert_eq!(
            app_id(true, false, all),
            Some("com.linger.desktop"),
            "the AppImage's own entry"
        );
        assert_eq!(
            app_id(false, true, all),
            Some("linger"),
            "the Arch package's"
        );
        assert_eq!(
            app_id(false, false, all),
            Some("Linger"),
            "the .deb and .rpm's"
        );
        // A development build on a computer with the Arch package installed
        // borrows its name, which is what a person testing one wants.
        assert_eq!(
            app_id(false, false, |name| name == "linger"),
            Some("linger")
        );
    }

    #[test]
    fn a_copy_without_a_desktop_file_has_no_name() {
        let none = |_: &str| false;
        assert_eq!(app_id(false, false, none), None);
        assert_eq!(app_id(true, false, none), None);
        // An AppImage never takes the package's name, or the bind line
        // Settings shows would name the other copy.
        assert_eq!(app_id(true, false, |name| name == "linger"), None);
    }

    #[test]
    fn desktop_files_are_looked_for_where_the_spec_says() {
        let home = Path::new("/home/sam");
        assert_eq!(
            data_dirs(Some(home), None, None),
            [
                "/home/sam/.local/share/applications",
                "/usr/local/share/applications",
                "/usr/share/applications"
            ]
            .map(PathBuf::from)
        );
        assert_eq!(
            data_dirs(Some(home), Some("/data"), Some("/a:/b/")),
            ["/data/applications", "/a/applications", "/b/applications"].map(PathBuf::from)
        );
        assert_eq!(
            data_dirs(None, Some(""), Some("")),
            ["/usr/local/share/applications", "/usr/share/applications"].map(PathBuf::from)
        );
    }
}
