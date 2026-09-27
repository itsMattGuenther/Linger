//! Starting Linger when somebody signs in to their computer (#228).
//!
//! Off until they turn it on, in Settings → Account & App; a fresh install
//! registers nothing. The operating system's own record is the only state:
//! Settings asks it when it opens and after every change, so the switch says
//! what the next sign-in will do, including after a change made outside Linger
//! (Task Manager's Startup tab, GNOME Tweaks, deleting the file).
//!
//! - **Windows:** a value named `Linger` under the current user's
//!   `Software\Microsoft\Windows\CurrentVersion\Run` key, holding the quoted
//!   path of this `linger-client.exe`. The name is the product name on
//!   purpose: Tauri's NSIS uninstaller deletes exactly that value (and keeps
//!   it through an update). Task Manager and Settings → Apps → Startup switch
//!   an entry off in `…\Explorer\StartupApproved\Run`, so that counts too.
//! - **Linux:** an XDG autostart entry, `com.linger.desktop.desktop` in
//!   `$XDG_CONFIG_HOME/autostart` (`~/.config/autostart`). It starts the
//!   AppImage file rather than its temporary mount, or the package's
//!   `/usr/bin/linger-client`, with what somebody chose by hand repeated, the
//!   same way the AppImage's menu entry does (`desktop_entry.rs`). Full
//!   desktops (GNOME, KDE, Xfce…) and systemd-managed sessions start these
//!   entries; a compositor started on its own (Hyprland as Omarchy starts it,
//!   Sway, i3) doesn't. Linger leaves that compositor's own config alone:
//!   Settings says the switch may do nothing there, and links to the one
//!   line to add (`docs/user-guide.md`, "Starting Linger when you sign in").
//! - **Elsewhere** (macOS, until there's an installer for it): not offered,
//!   and Settings shows no switch.
//!
//! Settings calls these itself: it is a setting of this computer, with nothing
//! for the list window to keep in step. `capabilities/next-settings.json` and
//! `owner.json` grant them; no other window may change what runs when somebody
//! signs in (`acl.rs`).

use std::io;

use serde::Serialize;

/// What Settings shows. Hand-written on both sides, mirrored in
/// `client/src/next/core/autostart.ts`; it never crosses the wire.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Startup {
    /// What the computer has: whether the next sign-in starts Linger.
    on: bool,
    /// The desktop running now, by the name it gives itself (empty when it
    /// gives none), when it doesn't start what's in the autostart folder by
    /// itself: the switch alone may do nothing there. `None` everywhere else.
    ignored_by: Option<String>,
}

/// Whether Linger starts at sign-in, as the computer has it; `None` where
/// it isn't offered. An error is in words, for Settings to show.
#[tauri::command]
pub async fn autostart_state() -> Result<Option<Startup>, String> {
    off_thread(|| match state() {
        Ok(Some(on)) => Ok(Some(Startup {
            on,
            ignored_by: ignored_by(),
        })),
        Ok(None) => Ok(None),
        Err(error) => Err(in_words(&error)),
    })
    .await
}

/// Turn starting at sign-in on or off, then answer with what the computer
/// has now, so Settings shows that rather than what it asked for.
#[tauri::command]
pub async fn autostart_set(on: bool) -> Result<Startup, String> {
    off_thread(move || {
        let changed = if on { enable() } else { disable() };
        changed.map_err(|error| in_words(&error))?;
        match state() {
            Ok(Some(on)) => Ok(Startup {
                on,
                ignored_by: ignored_by(),
            }),
            Ok(None) => Err(NOT_HERE.to_string()),
            Err(error) => Err(in_words(&error)),
        }
    })
    .await
}

const NOT_HERE: &str = "Starting at sign-in isn't available on this computer yet.";

/// The registry and the autostart folder are quick, but they are still disk
/// and system calls, which stay off the async runtime's threads.
async fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err("Linger stopped before it finished.".to_string()))
}

/// What went wrong, for Settings to put after "Couldn't turn this on."
fn in_words(error: &io::Error) -> String {
    let said = error.to_string();
    let said = said.trim_end_matches('.');
    match error.kind() {
        io::ErrorKind::PermissionDenied => "This computer didn't allow it.".to_string(),
        io::ErrorKind::Unsupported => NOT_HERE.to_string(),
        // Linger's own reason, already in words.
        io::ErrorKind::InvalidData => format!("{said}."),
        _ => format!("This computer said: {said}."),
    }
}

#[cfg(target_os = "linux")]
fn state() -> io::Result<Option<bool>> {
    linux::state_in(&linux::dir()?).map(Some)
}

#[cfg(target_os = "linux")]
fn enable() -> io::Result<()> {
    use crate::desktop_entry;
    let program = desktop_entry::this_program()?;
    let chosen = desktop_entry::remembered();
    let Some(exec) = desktop_entry::exec_line(&program, |key| chosen.lookup(key)) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Linger's location can't be written into a startup entry: {}",
                program.display()
            ),
        ));
    };
    // The AppImage's menu entry installs its icon under the app's identifier;
    // the packages install theirs as `linger-client`.
    let icon = if program == std::env::current_exe()? {
        desktop_entry::WM_CLASS
    } else {
        desktop_entry::APP_ID
    };
    linux::enable_in(&linux::dir()?, &linux::entry(&exec, &program, icon))
}

#[cfg(target_os = "linux")]
fn disable() -> io::Result<()> {
    linux::disable_in(&linux::dir()?)
}

#[cfg(target_os = "linux")]
fn ignored_by() -> Option<String> {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    linux::ignored_by(desktop.as_deref(), linux::systemd_starts_entries)
}

#[cfg(not(target_os = "linux"))]
fn ignored_by() -> Option<String> {
    None
}

#[cfg(windows)]
fn state() -> io::Result<Option<bool>> {
    windows::state().map(Some)
}

#[cfg(windows)]
fn enable() -> io::Result<()> {
    windows::enable(&run_command(&std::env::current_exe()?))
}

#[cfg(windows)]
fn disable() -> io::Result<()> {
    windows::disable()
}

#[cfg(not(any(target_os = "linux", windows)))]
fn state() -> io::Result<Option<bool>> {
    Ok(None)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn enable() -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, NOT_HERE))
}

#[cfg(not(any(target_os = "linux", windows)))]
fn disable() -> io::Result<()> {
    Ok(())
}

/// The command the Run value holds: the program's full path, in quotes. The
/// usual per-user install is `C:\Users\<name>\AppData\Local\Linger\`, and a
/// name with a space in it is common; unquoted, Windows would try
/// `C:\Users\Jane.exe` first. A Windows path can't contain `"`, so the
/// quotes need no escaping.
#[cfg(any(windows, test))]
fn run_command(exe: &std::path::Path) -> String {
    format!("\"{}\"", exe.display())
}

/// Whether Task Manager (or Settings → Apps → Startup) has left an entry on,
/// from its `StartupApproved` value. No value means nobody switched it off.
/// The first byte is even while it's on (`02`) and odd once switched off
/// (`03`, followed by when).
#[cfg(any(windows, test))]
fn approved(value: Option<&[u8]>) -> bool {
    value
        .and_then(|bytes| bytes.first())
        .is_none_or(|first| first % 2 == 0)
}

#[cfg(windows)]
mod windows {
    use std::io;

    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    /// The product name: what Tauri's NSIS uninstaller deletes from `RUN`.
    const NAME: &str = "Linger";

    fn missing(error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::NotFound
    }

    pub fn state() -> io::Result<bool> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let run = match user.open_subkey_with_flags(RUN, KEY_QUERY_VALUE) {
            Ok(run) => run,
            Err(error) if missing(&error) => return Ok(false),
            Err(error) => return Err(error),
        };
        match run.get_raw_value(NAME) {
            Ok(_) => {}
            Err(error) if missing(&error) => return Ok(false),
            Err(error) => return Err(error),
        }
        let switched = user
            .open_subkey_with_flags(APPROVED, KEY_QUERY_VALUE)
            .and_then(|approved| approved.get_raw_value(NAME))
            .ok();
        Ok(super::approved(
            switched.as_ref().map(|value| value.bytes.as_slice()),
        ))
    }

    pub fn enable(command: &str) -> io::Result<()> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = user.create_subkey_with_flags(RUN, KEY_SET_VALUE)?;
        run.set_value(NAME, &command.to_string())?;
        // Switched off in Task Manager earlier: turning it on here means on.
        forget_switch(&user)
    }

    pub fn disable() -> io::Result<()> {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        match user.open_subkey_with_flags(RUN, KEY_SET_VALUE) {
            Ok(run) => match run.delete_value(NAME) {
                Ok(()) => {}
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            },
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        forget_switch(&user)
    }

    /// Drop Task Manager's on/off record for the entry, so nothing of it is
    /// left behind and a new entry starts switched on.
    fn forget_switch(user: &RegKey) -> io::Result<()> {
        match user.open_subkey_with_flags(APPROVED, KEY_SET_VALUE) {
            Ok(approved) => match approved.delete_value(NAME) {
                Ok(()) => Ok(()),
                Err(error) if missing(&error) => Ok(()),
                Err(error) => Err(error),
            },
            Err(error) if missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::OsString;
    use std::fs;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};

    use crate::desktop_entry::{APP_ID, WM_CLASS};

    /// The entry's file name: the app's identifier, like its menu entry.
    fn file() -> String {
        format!("{APP_ID}.desktop")
    }

    /// Where the XDG Autostart spec keeps a user's entries.
    pub fn dir() -> io::Result<PathBuf> {
        dir_from(
            std::env::var_os("XDG_CONFIG_HOME"),
            std::env::var_os("HOME"),
        )
    }

    /// `$XDG_CONFIG_HOME/autostart`, or `$HOME/.config/autostart`. A relative
    /// `XDG_CONFIG_HOME` is ignored, as the base directory spec says.
    pub(super) fn dir_from(
        config_home: Option<OsString>,
        home: Option<OsString>,
    ) -> io::Result<PathBuf> {
        if let Some(config) = config_home
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
        {
            return Ok(config.join("autostart"));
        }
        match home.filter(|home| !home.is_empty()) {
            Some(home) => Ok(PathBuf::from(home).join(".config/autostart")),
            None => Err(io::Error::new(
                io::ErrorKind::NotFound,
                "HOME is unset, so there is no autostart folder",
            )),
        }
    }

    /// The entry. `TryExec` names the program, so a desktop skips the entry
    /// once the program is gone (an AppImage moved or deleted), and so does
    /// [`starts`]: the switch then says off rather than promising a start
    /// that won't happen. It is left out for a path with a backslash, which
    /// the entry format would read as an escape.
    pub fn entry(exec: &str, program: &Path, icon: &str) -> String {
        let try_exec = program
            .to_str()
            .filter(|path| !path.contains('\\'))
            .map(|path| format!("TryExec={path}\n"))
            .unwrap_or_default();
        format!(
            "\
[Desktop Entry]
Type=Application
Name=Linger
Comment=Start Linger when you sign in
Exec={exec}
{try_exec}Icon={icon}
Terminal=false
StartupWMClass={WM_CLASS}
"
        )
    }

    /// Whether an entry starts anything at sign-in. The Autostart spec skips
    /// one marked `Hidden`; GNOME's own switch writes
    /// `X-GNOME-Autostart-enabled=false`; and an entry whose `TryExec`
    /// program is missing is skipped too.
    pub(super) fn starts(text: &str, exists: impl Fn(&Path) -> bool) -> bool {
        let mut in_entry = false;
        let mut has_exec = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            if !in_entry {
                continue;
            }
            match (key.trim(), value.trim()) {
                ("Hidden", "true") | ("X-GNOME-Autostart-enabled", "false") => return false,
                ("TryExec", program)
                    if !program.contains('\\') && Path::new(program).is_absolute() =>
                {
                    if !exists(Path::new(program)) {
                        return false;
                    }
                }
                ("Exec", command) => has_exec = !command.is_empty(),
                _ => {}
            }
        }
        has_exec
    }

    /// Desktops whose own session starts what's in the autostart folder, as
    /// they name themselves in `XDG_CURRENT_DESKTOP`.
    const STARTS_ENTRIES: &[&str] = &[
        "GNOME",
        "KDE",
        "XFCE",
        "X-Cinnamon",
        "Cinnamon",
        "MATE",
        "LXQt",
        "LXDE",
        "Budgie",
        "Unity",
        "Pantheon",
        "Deepin",
        "DDE",
        "COSMIC",
        "Enlightenment",
        "UKUI",
    ];

    /// The running desktop's name when it won't start the entry by itself;
    /// `None` when it will. A compositor started under systemd's session
    /// (uwsm, for one) gets the entries started by systemd instead, which
    /// `systemd_starts` answers; it is asked only when the name alone
    /// doesn't settle it.
    pub(super) fn ignored_by(
        current: Option<&str>,
        systemd_starts: impl FnOnce() -> bool,
    ) -> Option<String> {
        let names: Vec<&str> = current
            .unwrap_or("")
            .split(':')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        let known = names.iter().any(|name| {
            STARTS_ENTRIES
                .iter()
                .any(|desktop| desktop.eq_ignore_ascii_case(name))
        });
        if known || systemd_starts() {
            return None;
        }
        Some(
            names
                .first()
                .map(|name| (*name).to_string())
                .unwrap_or_default(),
        )
    }

    /// Whether systemd is starting autostart entries in this session: its
    /// `xdg-desktop-autostart.target` is up. Anything that stops the question
    /// being answered counts as no.
    pub fn systemd_starts_entries() -> bool {
        std::process::Command::new("systemctl")
            .args([
                "--user",
                "--quiet",
                "is-active",
                "xdg-desktop-autostart.target",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    pub fn state_in(dir: &Path) -> io::Result<bool> {
        match fs::read_to_string(dir.join(file())) {
            Ok(text) => Ok(starts(&text, Path::is_file)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Write the entry whole or not at all: into a file beside it, then
    /// renamed over it.
    pub fn enable_in(dir: &Path, body: &str) -> io::Result<()> {
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!("{}.tmp", file()));
        {
            let mut out = fs::File::create(&tmp)?;
            out.write_all(body.as_bytes())?;
            out.sync_all()?;
        }
        fs::rename(&tmp, dir.join(file())).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
    }

    pub fn disable_in(dir: &Path) -> io::Result<()> {
        match fs::remove_file(dir.join(file())) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_run_value_quotes_a_path_with_spaces() {
        assert_eq!(
            run_command(std::path::Path::new(
                r"C:\Users\Jane Doe\AppData\Local\Linger\linger-client.exe"
            )),
            r#""C:\Users\Jane Doe\AppData\Local\Linger\linger-client.exe""#
        );
    }

    #[test]
    fn task_managers_switch_is_read_from_the_first_byte() {
        // Never touched in Task Manager.
        assert!(approved(None));
        assert!(approved(Some(&[])));
        // On, as Task Manager writes it.
        assert!(approved(Some(&[0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        assert!(approved(Some(&[0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
        // Off, followed by when.
        assert!(!approved(Some(&[
            0x03, 0, 0, 0, 0x5b, 0x1c, 0x2e, 0x7a, 0x3f, 0x91, 0xdb, 0x01
        ])));
        assert!(!approved(Some(&[0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
    }

    #[test]
    fn settings_reads_the_answer_by_these_names() {
        // Mirrored by hand in client/src/next/core/autostart.ts.
        let answer = Startup {
            on: true,
            ignored_by: Some("Hyprland".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&answer).unwrap(),
            serde_json::json!({ "on": true, "ignored_by": "Hyprland" })
        );
        let quiet = Startup {
            on: false,
            ignored_by: None,
        };
        assert_eq!(
            serde_json::to_value(&quiet).unwrap(),
            serde_json::json!({ "on": false, "ignored_by": null })
        );
    }

    #[test]
    fn a_refusal_is_said_in_plain_words() {
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(in_words(&denied), "This computer didn't allow it.");
        let other = io::Error::other("the disk is full.");
        assert_eq!(in_words(&other), "This computer said: the disk is full.");
        let ours = io::Error::new(
            io::ErrorKind::InvalidData,
            "Linger's location can't be written",
        );
        assert_eq!(in_words(&ours), "Linger's location can't be written.");
        let elsewhere = io::Error::from(io::ErrorKind::Unsupported);
        assert_eq!(in_words(&elsewhere), NOT_HERE);
    }

    #[cfg(target_os = "linux")]
    mod linux_entries {
        use std::ffi::OsString;
        use std::fs;
        use std::path::{Path, PathBuf};

        use super::super::linux::{dir_from, disable_in, enable_in, entry, starts, state_in};
        use crate::desktop_entry::exec_line;

        /// A fresh stand-in for `$XDG_CONFIG_HOME`, under the system temp dir.
        fn scratch(name: &str) -> PathBuf {
            let root = std::env::temp_dir().join(format!(
                "linger-autostart-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            root
        }

        #[test]
        fn the_folder_follows_xdg_config_home_then_home() {
            let config = OsString::from("/home/me/.cfg");
            let home = OsString::from("/home/me");
            assert_eq!(
                dir_from(Some(config), Some(home.clone())).unwrap(),
                PathBuf::from("/home/me/.cfg/autostart")
            );
            assert_eq!(
                dir_from(None, Some(home.clone())).unwrap(),
                PathBuf::from("/home/me/.config/autostart")
            );
            // Relative and empty values are ignored, as the spec says.
            assert_eq!(
                dir_from(Some("cfg".into()), Some(home.clone())).unwrap(),
                PathBuf::from("/home/me/.config/autostart")
            );
            assert_eq!(
                dir_from(Some("".into()), Some(home)).unwrap(),
                PathBuf::from("/home/me/.config/autostart")
            );
            assert!(dir_from(None, None).is_err());
        }

        #[test]
        fn an_appimage_entry_starts_the_file_with_what_was_chosen() {
            let program = Path::new("/home/me/My Apps/Linger_0.4.2_amd64.AppImage");
            let exec = exec_line(program, |key| {
                (key == "LINGER_LINUX_BACKEND").then(|| "x11".to_string())
            })
            .unwrap();
            let body = entry(&exec, program, "com.linger.desktop");
            assert!(body.starts_with("[Desktop Entry]\n"));
            assert!(body.contains(
                "Exec=env LINGER_LINUX_BACKEND=x11 \"/home/me/My Apps/Linger_0.4.2_amd64.AppImage\"\n"
            ));
            assert!(body.contains("TryExec=/home/me/My Apps/Linger_0.4.2_amd64.AppImage\n"));
            assert!(body.contains("Name=Linger\n"));
            assert!(body.contains("Icon=com.linger.desktop\n"));
            assert!(body.contains("Terminal=false\n"));
            assert!(body.contains("StartupWMClass=linger-client\n"));
            // It opens the app as usual: no arguments, nothing hidden.
            assert!(!body.contains("--"));
            assert!(!body.contains("Hidden="));
        }

        #[test]
        fn a_package_entry_starts_the_installed_program() {
            let program = Path::new("/usr/bin/linger-client");
            let body = entry(
                &exec_line(program, |_| None).unwrap(),
                program,
                "linger-client",
            );
            assert!(body.contains("Exec=/usr/bin/linger-client\n"));
            assert!(body.contains("TryExec=/usr/bin/linger-client\n"));
            assert!(body.contains("Icon=linger-client\n"));
        }

        #[test]
        fn a_backslash_leaves_try_exec_out() {
            let program = Path::new("/home/me/odd\\name/Linger.AppImage");
            let body = entry(&exec_line(program, |_| None).unwrap(), program, "x");
            assert!(!body.contains("TryExec="));
        }

        #[test]
        fn switched_off_hidden_or_missing_entries_start_nothing() {
            let there = |_: &Path| true;
            let gone = |_: &Path| false;
            let ours = entry(
                "/usr/bin/linger-client",
                Path::new("/usr/bin/linger-client"),
                "i",
            );
            assert!(starts(&ours, there));
            // The program it names is gone: the desktop would skip it.
            assert!(!starts(&ours, gone));
            // GNOME Tweaks and KDE switch an entry off without deleting it.
            assert!(!starts(
                &format!("{ours}X-GNOME-Autostart-enabled=false\n"),
                there
            ));
            assert!(!starts(&format!("{ours}Hidden=true\n"), there));
            assert!(starts(
                &format!("{ours}X-GNOME-Autostart-enabled=true\n"),
                there
            ));
            // Keys outside the main group don't count; no Exec starts nothing.
            assert!(starts(
                &format!("{ours}[Desktop Action x]\nHidden=true\n"),
                there
            ));
            assert!(!starts("[Desktop Entry]\nName=Linger\n", there));
            assert!(!starts("Exec=/usr/bin/linger-client\n", there));
        }

        #[test]
        fn turning_it_on_and_off_writes_and_removes_one_entry() {
            let root = scratch("toggle");
            let dir = dir_from(Some(root.clone().into_os_string()), None).unwrap();
            // A fresh install registers nothing.
            assert!(!state_in(&dir).unwrap());

            // The program here is this test binary, so TryExec finds it.
            let program = std::env::current_exe().unwrap();
            let body = entry(
                &exec_line(&program, |_| None).unwrap(),
                &program,
                "linger-client",
            );
            enable_in(&dir, &body).unwrap();
            assert!(state_in(&dir).unwrap());
            let file = dir.join("com.linger.desktop.desktop");
            assert_eq!(fs::read_to_string(&file).unwrap(), body);
            assert!(!dir.join("com.linger.desktop.desktop.tmp").exists());

            // Switched off in GNOME Tweaks: the switch says off.
            fs::write(&file, format!("{body}X-GNOME-Autostart-enabled=false\n")).unwrap();
            assert!(!state_in(&dir).unwrap());
            // Turned on again from Linger: it's written fresh, and on.
            enable_in(&dir, &body).unwrap();
            assert!(state_in(&dir).unwrap());

            disable_in(&dir).unwrap();
            assert!(!file.exists());
            assert!(!state_in(&dir).unwrap());
            // Turning off what is already off is fine.
            disable_in(&dir).unwrap();

            // Somebody else's entries are left alone.
            fs::write(dir.join("other.desktop"), "[Desktop Entry]\nExec=other\n").unwrap();
            enable_in(&dir, &body).unwrap();
            disable_in(&dir).unwrap();
            assert!(dir.join("other.desktop").exists());
            fs::remove_dir_all(&root).unwrap();
        }

        #[test]
        fn full_desktops_start_entries_and_a_lone_compositor_does_not() {
            use super::super::linux::ignored_by;
            let never = || -> bool { panic!("the name settles it") };
            assert_eq!(ignored_by(Some("GNOME"), never), None);
            assert_eq!(ignored_by(Some("ubuntu:GNOME"), never), None);
            assert_eq!(ignored_by(Some("KDE"), never), None);
            assert_eq!(ignored_by(Some("X-Cinnamon"), never), None);
            assert_eq!(ignored_by(Some("xfce"), never), None);
            // Omarchy starts Hyprland on its own: nothing reads the folder.
            assert_eq!(
                ignored_by(Some("Hyprland"), || false).as_deref(),
                Some("Hyprland")
            );
            assert_eq!(ignored_by(Some("sway"), || false).as_deref(), Some("sway"));
            // Under uwsm, systemd starts the entries for Hyprland.
            assert_eq!(ignored_by(Some("Hyprland"), || true), None);
            // A desktop that gives no name.
            assert_eq!(ignored_by(None, || false).as_deref(), Some(""));
            assert_eq!(ignored_by(Some(""), || true), None);
        }

        #[test]
        fn a_folder_that_cannot_be_made_is_an_error_not_a_panic() {
            let root = scratch("blocked");
            // `autostart` is a file, so there is no folder to write into.
            fs::write(root.join("autostart"), b"not a folder").unwrap();
            let dir = dir_from(Some(root.clone().into_os_string()), None).unwrap();
            assert!(enable_in(&dir, "[Desktop Entry]\nExec=x\n").is_err());
            fs::remove_dir_all(&root).unwrap();
        }
    }
}
