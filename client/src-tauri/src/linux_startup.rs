//! Linux launch plumbing that has to run before GTK.
//!
//! Graphics workarounds WebKitGTK needs on some GPUs, then three jobs about
//! the AppImage-from-a-terminal path: the backend override that survives
//! linuxdeploy's X11 fallback, ignoring the hang-up that would otherwise kill
//! the window when the terminal closes, and writing a user menu entry so the
//! next open does not need a terminal.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const MENU_ID: &str = "com.linger.desktop";

/// Graphics workarounds that default to `1` when unset. GBM: WebKit aborts on
/// some NVIDIA + AMD machines creating its GBM display. Explicit sync: NVIDIA's
/// driver and newer WebKitGTK disagree on Wayland and the compositor closes
/// the connection (`Error 71`); only NVIDIA's driver reads that variable.
const DEFAULT_ON: [&str; 2] = [
    "WEBKIT_DMABUF_RENDERER_DISABLE_GBM",
    "__NV_DISABLE_EXPLICIT_SYNC",
];
const WM_CLASS: &str = "linger-client";

fn backend(
    value: Option<&OsStr>,
    wayland_display: Option<&OsStr>,
) -> Result<Option<&'static str>, &'static str> {
    match value.and_then(OsStr::to_str) {
        None if value.is_none() => Ok(wayland_display.filter(|v| !v.is_empty()).map(|_| "wayland")),
        Some("wayland") => Ok(Some("wayland")),
        Some("x11") => Ok(Some("x11")),
        _ => Err("LINGER_LINUX_BACKEND must be wayland or x11; unset it to use the default."),
    }
}

// Keep explicit values (including 0); otherwise turn the workaround on.
fn default_on(value: Option<&OsStr>) -> &OsStr {
    value.unwrap_or_else(|| OsStr::new("1"))
}

/// Run before GTK or any worker starts, so the launcher cannot override the choice.
pub fn configure() -> Result<(), &'static str> {
    let requested = std::env::var_os("LINGER_LINUX_BACKEND");
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    if let Some(selected) = backend(requested.as_deref(), wayland_display.as_deref())? {
        std::env::set_var("GDK_BACKEND", selected);
    }
    for key in DEFAULT_ON {
        let current = std::env::var_os(key);
        std::env::set_var(key, default_on(current.as_deref()));
    }
    ignore_terminal_hangup();
    if let Err(err) = install_appimage_menu_entry() {
        eprintln!("Linger couldn't add itself to the application menu: {err}");
    }
    Ok(())
}

/// Closing the terminal sends SIGHUP to this process. A GUI app should keep
/// its window; the next print to that dead tty would then raise SIGPIPE and
/// panic, so hang-up also points stdout/stderr at `/dev/null`.
fn ignore_terminal_hangup() {
    // SAFETY: `sigaction` is the POSIX handler install; `zeroed` is how a
    // `sigaction` struct is started before filling the fields we need. The
    // handler only calls async-signal-safe C functions.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_hangup as *const () as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGHUP, &action, std::ptr::null_mut());
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

extern "C" fn on_hangup(_signum: libc::c_int) {
    // open/dup2/close only: this runs in a signal handler.
    let path = b"/dev/null\0";
    // SAFETY: `/dev/null` is a C string constant; dup2 onto stdio fds is
    // async-signal-safe and leaves later Rust prints writing at a live fd.
    let fd = unsafe { libc::open(path.as_ptr().cast(), libc::O_RDWR) };
    if fd >= 0 {
        unsafe {
            libc::dup2(fd, libc::STDIN_FILENO);
            libc::dup2(fd, libc::STDOUT_FILENO);
            libc::dup2(fd, libc::STDERR_FILENO);
            if fd > libc::STDERR_FILENO {
                libc::close(fd);
            }
        }
    }
}

fn install_appimage_menu_entry() -> io::Result<()> {
    let Some(appimage) = std::env::var_os("APPIMAGE") else {
        return Ok(());
    };
    let appimage = PathBuf::from(appimage);
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    write_menu_entry(&data_home()?, &appimage, appdir.as_deref())
}

fn data_home() -> io::Result<PathBuf> {
    if let Some(custom) = std::env::var_os("XDG_DATA_HOME") {
        if !custom.is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    let Some(home) = std::env::var_os("HOME") else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "HOME is unset, so there is nowhere to put a menu entry",
        ));
    };
    Ok(PathBuf::from(home).join(".local/share"))
}

fn write_menu_entry(data_home: &Path, appimage: &Path, appdir: Option<&Path>) -> io::Result<()> {
    let Some(exec) = exec_line(appimage) else {
        return Ok(());
    };
    let applications = data_home.join("applications");
    fs::create_dir_all(&applications)?;
    let icon_installed = install_menu_icon(data_home, appdir)?;
    let body = desktop_entry(&exec, icon_installed);
    let dest = applications.join(format!("{MENU_ID}.desktop"));
    if fs::read(&dest).ok().as_deref() == Some(body.as_bytes()) {
        return Ok(());
    }
    let tmp = applications.join(format!("{MENU_ID}.desktop.tmp"));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(&tmp, &dest)?;
    Ok(())
}

fn exec_line(appimage: &Path) -> Option<String> {
    let path = std::str::from_utf8(appimage.as_os_str().as_bytes()).ok()?;
    let quoted = quote_exec_arg(path)?;
    let prefix = env_prefix(|key| std::env::var(key).ok());
    if prefix.is_empty() {
        Some(quoted)
    } else {
        Some(format!("env {prefix}{quoted}"))
    }
}

// The lookup is a parameter so tests need not touch the process environment.
fn env_prefix(lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut parts = Vec::new();
    for key in DEFAULT_ON.into_iter().chain(["LINGER_LINUX_BACKEND"]) {
        if let Some(raw) = lookup(key) {
            if let Some(value) = simple_token(&raw) {
                parts.push(format!("{key}={value}"));
            }
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("{} ", parts.join(" "))
    }
}

fn simple_token(raw: &str) -> Option<&str> {
    if !raw.is_empty()
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+'))
    {
        Some(raw)
    } else {
        None
    }
}

/// Freedesktop Exec quoting. Refuse a path that cannot be put on one line.
fn quote_exec_arg(path: &str) -> Option<String> {
    if path.is_empty() || path.contains('\n') || path.contains('\r') || path.contains('\0') {
        return None;
    }
    const SPECIAL: [char; 17] = [
        ' ', '\t', '\\', '"', '\'', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')',
    ];
    if path.contains('`') || path.chars().any(|c| SPECIAL.contains(&c)) {
        let escaped = path
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`");
        Some(format!("\"{escaped}\""))
    } else {
        Some(path.to_string())
    }
}

fn desktop_entry(exec: &str, icon: bool) -> String {
    let icon_line = if icon {
        format!("Icon={MENU_ID}\n")
    } else {
        String::new()
    };
    format!(
        "\
[Desktop Entry]
Type=Application
Name=Linger
Comment=A small place for friends to hang out
Exec={exec}
{icon_line}Terminal=false
Categories=Network;InstantMessaging;
StartupWMClass={WM_CLASS}
"
    )
}

fn install_menu_icon(data_home: &Path, appdir: Option<&Path>) -> io::Result<bool> {
    let Some(appdir) = appdir else {
        return Ok(false);
    };
    let source = [
        appdir.join("usr/share/icons/hicolor/256x256/apps/linger-client.png"),
        appdir.join("usr/share/icons/hicolor/256x256@2/apps/linger-client.png"),
        appdir.join(".DirIcon"),
    ]
    .into_iter()
    .find(|path| path.is_file());
    let Some(source) = source else {
        return Ok(false);
    };
    let dest_dir = data_home.join("icons/hicolor/256x256/apps");
    fs::create_dir_all(&dest_dir)?;
    fs::copy(source, dest_dir.join(format!("{MENU_ID}.png")))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStrExt;

    #[test]
    fn native_wayland_is_default_and_explicit_choices_win() {
        assert_eq!(backend(None, None), Ok(None));
        assert_eq!(backend(None, Some(OsStr::new(""))), Ok(None));
        assert_eq!(
            backend(None, Some(OsStr::new("wayland-0"))),
            Ok(Some("wayland"))
        );
        assert_eq!(default_on(None), OsStr::new("1"));
        assert_eq!(default_on(Some(OsStr::new("0"))), OsStr::new("0"));
        assert_eq!(
            backend(Some(OsStr::new("wayland")), None),
            Ok(Some("wayland"))
        );
        assert_eq!(
            backend(Some(OsStr::new("x11")), Some(OsStr::new("wayland-0"))),
            Ok(Some("x11"))
        );
        for invalid in ["", "auto", "wayland,x11", "WAYLAND"] {
            assert!(backend(Some(OsStr::new(invalid)), None).is_err());
        }
        assert!(backend(Some(OsStr::from_bytes(&[0xff])), None).is_err());
    }

    #[test]
    fn exec_paths_with_spaces_are_quoted_and_newlines_are_refused() {
        assert_eq!(
            quote_exec_arg("/home/me/Linger.AppImage").as_deref(),
            Some("/home/me/Linger.AppImage")
        );
        assert_eq!(
            quote_exec_arg("/home/me/Linger 0.2.0.AppImage").as_deref(),
            Some("\"/home/me/Linger 0.2.0.AppImage\"")
        );
        assert_eq!(quote_exec_arg("/tmp/Linger\n.AppImage"), None);
        assert_eq!(
            quote_exec_arg("/tmp/say\"hi.AppImage").as_deref(),
            Some("\"/tmp/say\\\"hi.AppImage\"")
        );
    }

    #[test]
    fn menu_entry_names_linger_and_does_not_ask_for_a_terminal() {
        let body = desktop_entry("/home/me/Linger.AppImage", true);
        assert!(body.contains("Name=Linger\n"));
        assert!(body.contains("Terminal=false\n"));
        assert!(body.contains("StartupWMClass=linger-client\n"));
        assert!(body.contains("Icon=com.linger.desktop\n"));
        assert!(body.contains("Exec=/home/me/Linger.AppImage\n"));
        assert!(!body.contains("Terminal=true"));
    }

    #[test]
    fn menu_entry_omits_icon_when_none_was_installed() {
        let body = desktop_entry("/opt/Linger.AppImage", false);
        assert!(!body.contains("Icon="));
    }

    #[test]
    fn menu_entry_keeps_the_graphics_workarounds() {
        let after_configure = |key: &str| match key {
            "WEBKIT_DMABUF_RENDERER_DISABLE_GBM" | "__NV_DISABLE_EXPLICIT_SYNC" => {
                Some("1".to_string())
            }
            _ => None,
        };
        assert_eq!(
            env_prefix(after_configure),
            "WEBKIT_DMABUF_RENDERER_DISABLE_GBM=1 __NV_DISABLE_EXPLICIT_SYNC=1 "
        );
        let opted_out = |key: &str| match key {
            "__NV_DISABLE_EXPLICIT_SYNC" => Some("0".to_string()),
            "LINGER_LINUX_BACKEND" => Some("x11".to_string()),
            _ => None,
        };
        assert_eq!(
            env_prefix(opted_out),
            "__NV_DISABLE_EXPLICIT_SYNC=0 LINGER_LINUX_BACKEND=x11 "
        );
        assert_eq!(env_prefix(|_| None), "");
    }

    #[test]
    fn simple_tokens_reject_spaces_and_shell_characters() {
        assert_eq!(simple_token("1"), Some("1"));
        assert_eq!(simple_token("wayland"), Some("wayland"));
        assert_eq!(simple_token("x11"), Some("x11"));
        assert_eq!(simple_token(""), None);
        assert_eq!(simple_token("wayland;rm"), None);
        assert_eq!(simple_token("1 2"), None);
    }

    #[test]
    fn writes_a_stable_menu_file_for_an_appimage() {
        let root = std::env::temp_dir().join(format!(
            "linger-launcher-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("squash")).unwrap();
        let appimage = root.join("Linger.AppImage");
        fs::write(&appimage, []).unwrap();
        let icon = root.join("squash/.DirIcon");
        fs::write(&icon, b"png-bytes").unwrap();

        write_menu_entry(&root.join("data"), &appimage, Some(&root.join("squash"))).unwrap();

        let entry =
            fs::read_to_string(root.join("data/applications/com.linger.desktop.desktop")).unwrap();
        assert!(entry.contains("Name=Linger\n"));
        assert!(entry.contains("Terminal=false\n"));
        assert!(entry.contains(&format!("Exec={}\n", appimage.to_str().expect("utf8 path"))));
        assert!(entry.contains("Icon=com.linger.desktop\n"));
        assert_eq!(
            fs::read(root.join("data/icons/hicolor/256x256/apps/com.linger.desktop.png")).unwrap(),
            b"png-bytes"
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
