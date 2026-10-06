//! Whether WebKit's GPU display path (GBM) works on this computer (#169).
//!
//! With GBM off, typing and scrolling run a frame behind, and the page draws
//! on whichever GPU the graphics drivers offer rather than the window's, which
//! on a computer with two GPUs takes `linux_startup::force_shm` to show at all
//! (#433). With GBM on, some computers abort at startup (`Could not create GBM
//! EGL display`). The only way to find out which kind this computer is, is to
//! try.
//!
//! So the binary's `linux_startup` decides, before GTK starts, whether this
//! launch tries the GPU path. A launch that tries it leaves `PROBE` behind in
//! [`state_dir`], and the page removes it through [`graphics_started`] once it
//! has drawn frames. A probe still there at the next launch means that launch
//! died before drawing anything, so an `OFF_PREFIX` record is written for the
//! WebKit it was running, and later launches with that WebKit stay off the GPU
//! path.
//!
//! Every launch also holds `RUNNING` until it exits. A launch that finds it
//! held is a second copy, which hands over to the running Linger and quits
//! before it could draw, so it leaves the probe alone (#447).
//!
//! This lives in the library rather than beside `linux_startup` because the
//! command that clears the probe has to be registered with the Tauri builder.

use std::path::PathBuf;

/// Left behind by a launch that is trying the GPU path; removed once it draws.
/// It holds the WebKitGTK version that launch was running.
pub const PROBE: &str = "gbm-probe";
/// `gbm-off-<webkit version>`: that WebKitGTK aborted on the GPU path on this
/// computer, so launches running it stay off it. Keyed by version (#187): the
/// AppImage's bundled WebKit and the system's are different libraries, and a
/// WebKit update deserves a fresh try. Delete the file to try again.
pub const OFF_PREFIX: &str = "gbm-off-";
/// Locked (`flock`) by every running Linger for as long as it runs. The
/// kernel lets go of it when the process ends, crash or not, so the file
/// itself being there means nothing.
pub const RUNNING: &str = "running.lock";
/// 0.3.5's record, written without saying which WebKit crashed. Ignored and
/// removed: it was usually the AppImage's WebKit, which never tries GBM now.
pub const LEGACY_OFF: &str = "gbm-off";

/// `$XDG_STATE_HOME/linger`, else `~/.local/state/linger`. `None` without a
/// home to put it in, which the caller treats as "no safety net".
pub fn state_dir() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("XDG_STATE_HOME") {
        if !custom.is_empty() {
            return Some(PathBuf::from(custom).join("linger"));
        }
    }
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(PathBuf::from(home).join(".local/state/linger"))
}

/// The page has drawn frames, so this launch got past the point where the GBM
/// abort happens. Called by the frontend once, after its first two frames.
/// A missing probe is the ordinary case: GBM was never tried this launch.
#[tauri::command]
pub fn graphics_started() {
    #[cfg(target_os = "linux")]
    if let Some(dir) = state_dir() {
        let _ = std::fs::remove_file(dir.join(PROBE));
    }
}
