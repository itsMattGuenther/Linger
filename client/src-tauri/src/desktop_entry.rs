//! How a freedesktop desktop entry starts this copy of Linger again (Linux).
//!
//! Linger writes two entries for itself: the AppImage's menu entry
//! (`linux_startup.rs`, in the binary) and the sign-in entry Settings turns on
//! (`autostart.rs`, #228). Both must start the same program, repeat the same
//! settings somebody chose by hand, and quote the same way, so the rules live
//! here once.

use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The app's identifier (`tauri.conf.json`), which names the entries Linger
/// writes for itself.
pub const APP_ID: &str = "com.linger.desktop";
/// The window class of every Linger window, so a desktop matches an entry to
/// the windows it opened. It is also the packages' icon name.
pub const WM_CLASS: &str = "linger-client";

/// NVIDIA's driver and newer WebKitGTK disagree about explicit sync on
/// Wayland, and the compositor closes the connection (`Error 71`). Defaults to
/// `1` when unset; only NVIDIA's driver reads it.
pub const NV_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";
/// WebKit's GPU display path. `1` turns it off, which avoids an abort on some
/// computers and costs a frame of delay on every one (#169). Decided per launch
/// by `linux_startup::choose_gbm` unless somebody set it.
pub const GBM: &str = "WEBKIT_DMABUF_RENDERER_DISABLE_GBM";
/// `wayland` or `x11`, to pick GTK's backend by hand.
pub const BACKEND: &str = "LINGER_LINUX_BACKEND";
/// GTK's own GL switch; `disable` stops GTK drawing windows through the GPU.
/// WebKit asks GTK for GL before it turns hardware acceleration on, so with
/// GTK's GL off it draws pages on the CPU instead. The binary's
/// `linux_startup` sets it on NVIDIA's legacy driver unless somebody set it
/// (#229).
pub const GDK_GL: &str = "GDK_GL";

/// What somebody set before this process touched anything. Entries are built
/// from these, never from the values `linux_startup::configure` fills in
/// itself.
#[derive(Debug, Default, Clone)]
pub struct Chosen {
    pub gbm: Option<OsString>,
    pub nv_explicit_sync: Option<OsString>,
    pub backend: Option<OsString>,
    pub gdk_gl: Option<OsString>,
}

impl Chosen {
    /// Read them from the environment. Only meaningful before `configure`
    /// changes it.
    #[must_use]
    pub fn from_env() -> Self {
        Self {
            gbm: std::env::var_os(GBM),
            nv_explicit_sync: std::env::var_os(NV_EXPLICIT_SYNC),
            backend: std::env::var_os(BACKEND),
            gdk_gl: std::env::var_os(GDK_GL),
        }
    }

    #[must_use]
    pub fn lookup(&self, key: &str) -> Option<String> {
        let value = match key {
            GBM => self.gbm.as_ref(),
            NV_EXPLICIT_SYNC => self.nv_explicit_sync.as_ref(),
            BACKEND => self.backend.as_ref(),
            GDK_GL => self.gdk_gl.as_ref(),
            _ => None,
        };
        value.and_then(|value| value.to_str()).map(str::to_string)
    }
}

static REMEMBERED: OnceLock<Chosen> = OnceLock::new();

/// Keep this launch's choices for an entry written while the app runs (the
/// sign-in entry, from Settings), by which time `configure` has changed the
/// environment. `configure` calls this once.
pub fn remember(chosen: Chosen) {
    let _ = REMEMBERED.set(chosen);
}

/// This launch's choices: nothing chosen if `remember` never ran.
#[must_use]
pub fn remembered() -> Chosen {
    REMEMBERED.get().cloned().unwrap_or_default()
}

/// The program an entry should start: the AppImage file itself when this copy
/// runs from one, otherwise this executable.
///
/// Inside an AppImage, `current_exe` is `/tmp/.mount_Linger…/usr/bin/…`, a
/// mount that is gone the moment Linger quits. `APPIMAGE` is the file somebody
/// downloaded, and the in-app updater replaces that same file, so it is what
/// has to run next time. It is believed only when this executable really is
/// inside the AppImage's mount (`APPDIR`): a package's Linger started from a
/// terminal that an AppImage opened inherits that other app's `APPIMAGE`.
#[must_use]
pub fn program(exe: &Path, appimage: Option<&Path>, appdir: Option<&Path>) -> PathBuf {
    match (appimage, appdir) {
        (Some(image), Some(mount)) if image.is_absolute() && exe.starts_with(mount) => {
            image.to_path_buf()
        }
        _ => exe.to_path_buf(),
    }
}

/// [`program`] for this process.
pub fn this_program() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    // `current_exe` is the resolved path, so compare it with the resolved mount.
    let appdir = std::env::var_os("APPDIR")
        .map(PathBuf::from)
        .map(|dir| std::fs::canonicalize(&dir).unwrap_or(dir));
    Ok(program(&exe, appimage.as_deref(), appdir.as_deref()))
}

/// The `Exec=` value that starts `program` with what somebody chose. `None`
/// for a path that can't be written on one line.
pub fn exec_line(program: &Path, chosen: impl Fn(&str) -> Option<String>) -> Option<String> {
    let path = std::str::from_utf8(program.as_os_str().as_bytes()).ok()?;
    let quoted = quote_exec_arg(path)?;
    let prefix = env_prefix(chosen);
    if prefix.is_empty() {
        Some(quoted)
    } else {
        Some(format!("env {prefix}{quoted}"))
    }
}

/// The settings an entry should repeat: what somebody chose that Linger
/// would not choose by itself. `lookup` answers with what was set before
/// `configure` ran, and is a parameter so tests need not touch the process
/// environment.
///
/// A workaround key set to `1` is never repeated. For explicit sync that is
/// the default anyway. For GBM it is the trap #169 fell into: releases up to
/// 0.3.4 wrote their *own* `WEBKIT_DMABUF_RENDERER_DISABLE_GBM=1` into every
/// menu entry, so every later launch passed it back as if somebody had chosen
/// it, and no change to the default could ever reach an existing install.
/// Dropping it costs one launch with the old setting, then the entry is clean.
/// A computer that really does abort on the GPU path is caught by the probe
/// (`choose_gbm`) instead. `GDK_GL` takes words, and Linger never wrote it
/// into an entry, so `GDK_GL=disable` set by hand is kept.
fn env_prefix(lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut parts = Vec::new();
    for key in [GBM, NV_EXPLICIT_SYNC, BACKEND, GDK_GL] {
        if let Some(raw) = lookup(key) {
            if let Some(value) = simple_token(&raw) {
                if key != BACKEND && value == "1" {
                    continue;
                }
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
/// A literal `%` is `%%` whether quoted or not, or it reads as a field code.
pub fn quote_exec_arg(path: &str) -> Option<String> {
    if path.is_empty() || path.contains('\n') || path.contains('\r') || path.contains('\0') {
        return None;
    }
    const SPECIAL: [char; 17] = [
        ' ', '\t', '\\', '"', '\'', '>', '<', '~', '|', '&', ';', '$', '*', '?', '#', '(', ')',
    ];
    let quoted = if path.contains('`') || path.chars().any(|c| SPECIAL.contains(&c)) {
        let escaped = path
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`");
        format!("\"{escaped}\"")
    } else {
        path.to_string()
    };
    Some(quoted.replace('%', "%%"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_percent_sign_is_not_read_as_a_field_code() {
        assert_eq!(
            quote_exec_arg("/home/me/Linger%201.AppImage").as_deref(),
            Some("/home/me/Linger%%201.AppImage")
        );
        assert_eq!(
            quote_exec_arg("/home/me/My Apps/100%.AppImage").as_deref(),
            Some("\"/home/me/My Apps/100%%.AppImage\"")
        );
    }

    #[test]
    fn entries_repeat_only_what_somebody_chose() {
        let from = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| (*value).to_string())
            }
        };
        // What every menu entry up to 0.3.4 passed back in (#169). Both are
        // what Linger does by itself, so neither is written down again.
        assert_eq!(env_prefix(from(&[(GBM, "1"), (NV_EXPLICIT_SYNC, "1")])), "");
        // Turning the GPU path on by hand is a real choice, and is kept.
        assert_eq!(
            env_prefix(from(&[(GBM, "0")])),
            "WEBKIT_DMABUF_RENDERER_DISABLE_GBM=0 "
        );
        assert_eq!(
            env_prefix(from(&[(NV_EXPLICIT_SYNC, "0"), (BACKEND, "x11")])),
            "__NV_DISABLE_EXPLICIT_SYNC=0 LINGER_LINUX_BACKEND=x11 "
        );
        assert_eq!(
            env_prefix(from(&[(BACKEND, "wayland")])),
            "LINGER_LINUX_BACKEND=wayland "
        );
        // The hand-set workaround for GTK's GL crash (#229) is kept.
        assert_eq!(env_prefix(from(&[(GDK_GL, "disable")])), "GDK_GL=disable ");
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
    fn an_exec_line_carries_the_choices_before_the_quoted_program() {
        let chosen = Chosen {
            backend: Some("x11".into()),
            ..Chosen::default()
        };
        assert_eq!(
            exec_line(Path::new("/home/me/My Apps/Linger.AppImage"), |key| chosen
                .lookup(key))
            .as_deref(),
            Some("env LINGER_LINUX_BACKEND=x11 \"/home/me/My Apps/Linger.AppImage\"")
        );
        assert_eq!(
            exec_line(Path::new("/usr/bin/linger-client"), |_| None).as_deref(),
            Some("/usr/bin/linger-client")
        );
    }

    #[test]
    fn the_appimage_file_is_the_program_not_its_mount() {
        let mount = Path::new("/tmp/.mount_LingerAbc123");
        let inside = mount.join("usr/bin/linger-client");
        let image = Path::new("/home/me/Apps/Linger_0.4.2_amd64.AppImage");
        assert_eq!(program(&inside, Some(image), Some(mount)), image);
    }

    #[test]
    fn a_package_is_its_own_program() {
        // The .deb, .rpm and Arch packages all install the real program here.
        let exe = Path::new("/usr/bin/linger-client");
        assert_eq!(program(exe, None, None), exe);
    }

    #[test]
    fn an_appimage_somebody_else_started_is_not_believed() {
        // A package's Linger, started from a terminal an AppImage opened,
        // inherits that AppImage's variables.
        let exe = Path::new("/usr/bin/linger-client");
        let other = Path::new("/home/me/Apps/Terminal.AppImage");
        let mount = Path::new("/tmp/.mount_TerminXyz");
        assert_eq!(program(exe, Some(other), Some(mount)), exe);
        // Nor is a relative APPIMAGE, or one with no mount to check against.
        let inside = mount.join("usr/bin/linger-client");
        assert_eq!(
            program(&inside, Some(Path::new("Linger.AppImage")), Some(mount)),
            inside
        );
        assert_eq!(program(&inside, Some(other), None), inside);
    }

    #[test]
    fn nothing_remembered_means_nothing_chosen() {
        // `remember` is only called by `configure`, which tests never run.
        assert!(remembered().lookup(BACKEND).is_none());
    }
}
