//! Linux launch plumbing that has to run before GTK.
//!
//! Graphics workarounds GTK and WebKitGTK need on some GPUs, then three jobs about
//! the AppImage-from-a-terminal path: the backend override that survives
//! linuxdeploy's X11 fallback, ignoring the hang-up that would otherwise kill
//! the window when the terminal closes, and writing a user menu entry so the
//! next open does not need a terminal.

use std::ffi::OsStr;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use linger_client_lib::desktop_entry::{
    self, exec_line, Chosen, APP_ID as MENU_ID, GBM, GDK_GL, NV_EXPLICIT_SYNC, WM_CLASS,
};
use linger_client_lib::graphics::{self, LEGACY_OFF, OFF_PREFIX, PROBE};

/// Exists while NVIDIA's kernel driver is loaded, and holds its version, e.g.
/// `580.178.04`. The open and the closed kernel module both write it.
const NVIDIA_VERSION: &str = "/sys/module/nvidia/version";
/// NVIDIA's 590 driver dropped Maxwell, Pascal and Volta cards. They stay on
/// the 580 branch (`nvidia-580xx` on Arch).
const NVIDIA_CURRENT: u32 = 590;
/// Holds a `renderD<n>` entry for every GPU that can draw.
const DRM_CLASS: &str = "/sys/class/drm";
/// WebKit's switch for handing finished frames to the window in ordinary
/// memory rather than as GPU buffers. Set by [`configure`] on some computers
/// (#433) unless somebody set it.
const FORCE_SHM: &str = "WEBKIT_DMABUF_RENDERER_FORCE_SHM";

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

/// The major version of NVIDIA's driver when it is on the legacy branch, from
/// [`NVIDIA_VERSION`]: `Some(580)` for `580.178.04`.
///
/// GTK draws without the GPU there (#229). On a GTX 980 Ti with 580.178.04,
/// under Hyprland, resizing a Linger window while another was open crashed
/// the app 3 times out of 3. The core shows GTK finishing one window's frame
/// with the *other* window's GL context current, then reading that window's
/// paint surface, which is NULL between frames (`gdk_gl_texture_from_surface`
/// → `cairo_surface_get_device_scale`). GTK keeps the old context when a
/// switch fails, so most likely `eglMakeCurrent` failed on the window being
/// resized. WebKit's web process crashed inside the same driver too, on its
/// GPU painting thread. With `GDK_GL=disable` the resize crash stopped, and
/// WebKit paints on the CPU, off the path its own crash was on. It costs what
/// the GPU path saves: typing runs a beat behind (#169). The 610 driver on the
/// RTX 4090 Omarchy machine, with the same GTK and WebKit, has not crashed.
fn legacy_nvidia(version: &str) -> Option<u32> {
    let major: u32 = version.trim().split('.').next()?.parse().ok()?;
    (major < NVIDIA_CURRENT).then_some(major)
}

/// Whether this launch tries WebKit's GPU display path.
#[derive(Debug, PartialEq, Eq)]
enum Gbm {
    On,
    Off,
}

/// How this process was started, as far as the GPU path is concerned.
struct Launch<'a> {
    native_wayland: bool,
    /// Running from the AppImage, with its own bundled WebKitGTK.
    appimage: bool,
    /// The WebKitGTK version this process will run, e.g. `2.52.6`.
    webkit: &'a str,
}

/// Decide the GPU path for a launch nobody chose it for, and leave the probe
/// that lets the next launch know how this one went (see `graphics.rs`).
///
/// Off in the AppImage (#187). It bundles WebKitGTK 2.50.4 from Ubuntu 22.04,
/// which cannot create a GBM display on the RTX 4090 + AMD Raphael Omarchy
/// machine at all: 11 launches out of 11 aborted on 2026-09-25, on either GPU.
/// Every AppImage user on hardware like that would pay a crashed launch for
/// nothing. Packages that run the system's WebKit (`.deb`, `.rpm`, the Arch
/// package, dev builds) are where the GPU path works, and the reason #169's
/// typing lag has a fix.
///
/// Off under X11, where the abort was first seen and nothing has shown it is
/// safe since. Off, too, when there is nowhere to keep the probe: a computer
/// that aborts would then abort on every launch with nothing to stop it.
///
/// Otherwise on, unless this very WebKit version has aborted here before. A
/// probe left by a launch that died is recorded against the WebKit *that*
/// launch ran, so a WebKit update gets a fresh try.
fn choose_gbm(launch: &Launch, state: Option<&Path>) -> Gbm {
    if launch.appimage || !launch.native_wayland {
        return Gbm::Off;
    }
    let Some(state) = state else {
        return Gbm::Off;
    };
    let _ = fs::remove_file(state.join(LEGACY_OFF));
    if let Ok(crashed) = fs::read_to_string(state.join(PROBE)) {
        // The last launch tried the GPU path and never drew a frame.
        let crashed = match crashed.trim() {
            "" => launch.webkit,
            version => version,
        };
        let off = state.join(format!("{OFF_PREFIX}{crashed}"));
        let note = format!(
            "The last launch that tried WebKit's GPU path (GBM) with WebKitGTK {crashed} \
             stopped before drawing anything, so Linger keeps it off while this WebKit is \
             installed. Delete this file to try again.\n"
        );
        let _ = fs::write(&off, note);
        let _ = fs::remove_file(state.join(PROBE));
        eprintln!(
            "Linger: the last launch stopped during graphics startup, so WebKit's GPU path \
             stays off with WebKitGTK {crashed}. Delete {} to try it again.",
            off.display()
        );
    }
    if state
        .join(format!("{OFF_PREFIX}{}", launch.webkit))
        .exists()
    {
        return Gbm::Off;
    }
    match fs::create_dir_all(state).and_then(|()| fs::write(state.join(PROBE), launch.webkit)) {
        Ok(()) => Gbm::On,
        Err(_) => Gbm::Off,
    }
}

/// Whether WebKit reads this `WEBKIT_DMABUF_RENDERER_DISABLE_GBM` as off: any
/// value but `0`, the empty one included.
fn gbm_disabled(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| value != OsStr::new("0"))
}

/// How many GPUs this computer can draw with, counted by their `renderD<n>`
/// entries in [`DRM_CLASS`]. Unreadable counts as none.
fn gpus(drm_class: &Path) -> usize {
    fs::read_dir(drm_class).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().as_encoded_bytes().starts_with(b"renderD"))
            .count()
    })
}

/// Whether WebKit hands finished frames to the window in ordinary memory
/// (#433).
///
/// With GBM off, WebKit's page process no longer draws on the GPU WebKit
/// chose for the window. It opens a surfaceless EGL display instead, which
/// lands on whichever GPU the graphics drivers offer, and still hands its
/// frames over as GPU buffers (DMA-BUFs). With two GPUs that can be the other
/// one, and then the window can't import a single frame (`Failed to create EGL
/// image from DMABuf`): it stays grey while the page draws behind it, so the
/// GBM probe never notices. On the RTX 4090 + AMD Raphael Omarchy machine it
/// came down to boot order, which numbered the two GPUs differently on
/// 2026-10-05 than on the boots before. Ordinary memory is something every
/// GPU's window can show. With one GPU there is no other to land on, and with
/// GBM on WebKit draws on the window's own GPU, so neither changes.
fn force_shm(gbm_disabled: bool, gpus: usize) -> bool {
    gbm_disabled && gpus > 1
}

/// The WebKitGTK this process is about to run, as `major.minor.micro`. In the
/// AppImage that is the bundled copy, elsewhere the system's.
fn webkit_version() -> String {
    // SAFETY: three argument-free getters that report the loaded library's
    // version; they touch no GTK or WebKit state, so calling them before GTK
    // starts is fine.
    let (major, minor, micro) = unsafe {
        (
            webkit2gtk_sys::webkit_get_major_version(),
            webkit2gtk_sys::webkit_get_minor_version(),
            webkit2gtk_sys::webkit_get_micro_version(),
        )
    };
    format!("{major}.{minor}.{micro}")
}

/// Run before GTK or any worker starts, so the launcher cannot override the choice.
pub fn configure() -> Result<(), &'static str> {
    // What somebody set before this process touched anything. Entries Linger
    // writes are built from these, never from the values filled in below.
    let chosen = Chosen::from_env();
    let wayland_display = std::env::var_os("WAYLAND_DISPLAY");
    let selected = backend(chosen.backend.as_deref(), wayland_display.as_deref())?;
    if let Some(selected) = selected {
        std::env::set_var("GDK_BACKEND", selected);
    }
    std::env::set_var(
        NV_EXPLICIT_SYNC,
        default_on(chosen.nv_explicit_sync.as_deref()),
    );
    // Somebody's own `GDK_GL` always wins, whatever it says.
    let legacy = match chosen.gdk_gl {
        Some(_) => None,
        None => fs::read_to_string(NVIDIA_VERSION)
            .ok()
            .and_then(|version| legacy_nvidia(&version)),
    };
    if let Some(driver) = legacy {
        std::env::set_var(GDK_GL, "disable");
        eprintln!(
            "Linger: NVIDIA's {driver} driver is loaded, so windows are drawn without the \
             GPU (#229). Setting GDK_GL yourself overrides this."
        );
    }
    // Somebody's own `WEBKIT_DMABUF_RENDERER_DISABLE_GBM` always wins; WebKit
    // reads it straight from the environment. With GTK's GL off, WebKit never
    // reaches the GPU path, so there is nothing to probe.
    if chosen.gbm.is_none() && legacy.is_none() {
        let webkit = webkit_version();
        let launch = Launch {
            native_wayland: selected == Some("wayland"),
            appimage: std::env::var_os("APPIMAGE").is_some(),
            webkit: &webkit,
        };
        if choose_gbm(&launch, graphics::state_dir().as_deref()) == Gbm::Off {
            std::env::set_var(GBM, "1");
        }
    }
    // Whoever turned GBM off, Linger or somebody by hand. Somebody's own
    // `WEBKIT_DMABUF_RENDERER_FORCE_SHM` always wins.
    if std::env::var_os(FORCE_SHM).is_none() {
        let gpus = gpus(Path::new(DRM_CLASS));
        if force_shm(gbm_disabled(std::env::var_os(GBM).as_deref()), gpus) {
            std::env::set_var(FORCE_SHM, "1");
            eprintln!(
                "Linger: WebKit's GPU path (GBM) is off and this computer has {gpus} GPUs, \
                 so pages reach the window in ordinary memory (#433). Setting \
                 {FORCE_SHM} yourself overrides this."
            );
        }
    }
    ignore_terminal_hangup();
    if let Err(err) = install_appimage_menu_entry(&chosen) {
        eprintln!("Linger couldn't add itself to the application menu: {err}");
    }
    // A package-manager install has its own menu entry. A leftover one from
    // the AppImage has the same name, sits in the user's folder and wins, so
    // the menu would keep launching the old AppImage (#188).
    if std::env::var_os("APPIMAGE").is_none()
        && linger_client_lib::packaging::package_manager().is_some()
    {
        if let Ok(home) = data_home() {
            remove_appimage_menu_entry(&home);
        }
    }
    // For the sign-in entry, if Settings turns it on (#228).
    desktop_entry::remember(chosen);
    Ok(())
}

/// Delete the menu entry and icon an AppImage wrote for itself, if that is
/// what is there. Anything that isn't recognisably ours is left alone.
fn remove_appimage_menu_entry(data_home: &Path) {
    let entry = data_home.join(format!("applications/{MENU_ID}.desktop"));
    let Ok(text) = fs::read_to_string(&entry) else {
        return;
    };
    let ours = text.contains(&format!("StartupWMClass={WM_CLASS}"))
        && text
            .lines()
            .any(|line| line.starts_with("Exec=") && line.contains(".AppImage"));
    if ours {
        let _ = fs::remove_file(&entry);
        let _ =
            fs::remove_file(data_home.join(format!("icons/hicolor/256x256/apps/{MENU_ID}.png")));
    }
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

fn install_appimage_menu_entry(chosen: &Chosen) -> io::Result<()> {
    let Some(appimage) = std::env::var_os("APPIMAGE") else {
        return Ok(());
    };
    let appimage = PathBuf::from(appimage);
    let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
    write_menu_entry(&data_home()?, &appimage, appdir.as_deref(), chosen)
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

fn write_menu_entry(
    data_home: &Path,
    appimage: &Path,
    appdir: Option<&Path>,
    chosen: &Chosen,
) -> io::Result<()> {
    let Some(exec) = exec_line(appimage, |key| chosen.lookup(key)) else {
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
    fn only_nvidias_legacy_driver_turns_gtks_gl_off() {
        // The driver on the GTX 980 Ti that crashed resizing windows (#229).
        assert_eq!(legacy_nvidia("580.178.04\n"), Some(580));
        // The RTX 4090 Omarchy machine, same GTK and WebKit, no crash.
        assert_eq!(legacy_nvidia("610.57.04\n"), None);
        assert_eq!(legacy_nvidia("470.256.02"), Some(470));
        assert_eq!(legacy_nvidia("590.44.01"), None);
        // Unreadable means leave the GPU on, as without NVIDIA at all.
        assert_eq!(legacy_nvidia(""), None);
        assert_eq!(legacy_nvidia("unknown"), None);
    }

    #[test]
    fn two_gpus_with_gbm_off_hand_frames_over_in_memory() {
        // The RTX 4090 + AMD Raphael machine with `gbm-off-2.52.6`: the page
        // drew on the NVIDIA card, the window was on the AMD (#433).
        assert!(force_shm(true, 2));
        assert!(force_shm(true, 3));
        // One GPU: the page can only land on the window's.
        assert!(!force_shm(true, 1));
        // GBM on: WebKit draws on the window's GPU itself.
        assert!(!force_shm(false, 2));
        // Nothing readable in /sys: leave WebKit as it was.
        assert!(!force_shm(true, 0));
    }

    #[test]
    fn gbm_is_off_for_any_value_but_0() {
        // WebKit's own test is `value && strcmp(value, "0")`.
        assert!(!gbm_disabled(None));
        assert!(!gbm_disabled(Some(OsStr::new("0"))));
        assert!(gbm_disabled(Some(OsStr::new("1"))));
        assert!(gbm_disabled(Some(OsStr::new(""))));
        assert!(gbm_disabled(Some(OsStr::new("yes"))));
    }

    #[test]
    fn gpus_are_counted_by_their_render_nodes() {
        let root = scratch("drm-class");
        // What the Omarchy machine's /sys/class/drm holds: connectors and the
        // version file are not GPUs.
        for name in [
            "card0",
            "card0-DP-1",
            "card1",
            "card1-HDMI-A-1",
            "renderD128",
            "renderD129",
            "version",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        assert_eq!(gpus(&root), 2);
        assert_eq!(gpus(&root.join("missing")), 0);
        fs::remove_dir_all(&root).unwrap();
    }

    /// A fresh directory for one test, under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "linger-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    const SYSTEM: Launch = Launch {
        native_wayland: true,
        appimage: false,
        webkit: "2.52.6",
    };

    #[test]
    fn x11_stays_off_the_gpu_path_and_leaves_no_probe() {
        let root = scratch("gbm-x11");
        let state = root.join("state");
        let x11 = Launch {
            native_wayland: false,
            ..SYSTEM
        };
        assert_eq!(choose_gbm(&x11, Some(&state)), Gbm::Off);
        assert!(!state.join(PROBE).exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_appimage_never_tries_the_gpu_path() {
        // Its bundled WebKitGTK 2.50.4 aborted 11 times out of 11 (#187).
        let root = scratch("gbm-appimage");
        let state = root.join("state");
        let appimage = Launch {
            appimage: true,
            webkit: "2.50.4",
            ..SYSTEM
        };
        assert_eq!(choose_gbm(&appimage, Some(&state)), Gbm::Off);
        assert!(!state.join(PROBE).exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn wayland_tries_the_gpu_path_and_a_launch_that_dies_turns_it_off() {
        let root = scratch("gbm-wayland");
        let state = root.join("state");

        // First launch: tries it, and says with which WebKit.
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::On);
        assert_eq!(fs::read_to_string(state.join(PROBE)).unwrap(), "2.52.6");

        // It drew frames (`graphics_started`), so the next launch tries again.
        fs::remove_file(state.join(PROBE)).unwrap();
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::On);

        // This one aborted before drawing: the probe is still there.
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::Off);
        assert!(state.join("gbm-off-2.52.6").exists());
        assert!(!state.join(PROBE).exists());

        // And it stays off, rather than aborting every other launch.
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::Off);
        assert!(!state.join(PROBE).exists());

        // Deleting the file is how somebody asks to try again.
        fs::remove_file(state.join("gbm-off-2.52.6")).unwrap();
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::On);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_crash_is_held_against_the_webkit_that_crashed() {
        let root = scratch("gbm-versions");
        let state = root.join("state");
        // A launch with an older WebKit tried and died...
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join(PROBE), "2.50.4").unwrap();
        // ...and WebKit has been updated since: the new one still gets its try.
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::On);
        assert!(state.join("gbm-off-2.50.4").exists());
        assert!(!state.join("gbm-off-2.52.6").exists());
        assert_eq!(fs::read_to_string(state.join(PROBE)).unwrap(), "2.52.6");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_unversioned_record_from_0_3_5_is_dropped() {
        // 0.3.5 wrote `gbm-off` without saying which WebKit crashed; on the
        // Omarchy machine it was the AppImage's, and it must not keep the
        // system's WebKit off the GPU path.
        let root = scratch("gbm-legacy");
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join(LEGACY_OFF), "old note").unwrap();
        assert_eq!(choose_gbm(&SYSTEM, Some(&state)), Gbm::On);
        assert!(!state.join(LEGACY_OFF).exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn no_safety_net_means_no_gpu_path() {
        assert_eq!(choose_gbm(&SYSTEM, None), Gbm::Off);
        // A state "directory" that is really a file cannot hold the probe.
        let root = scratch("gbm-unwritable");
        let blocked = root.join("state");
        fs::write(&blocked, b"not a directory").unwrap();
        assert_eq!(choose_gbm(&SYSTEM, Some(&blocked)), Gbm::Off);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn webkit_reports_a_version() {
        let version = webkit_version();
        assert_eq!(version.split('.').count(), 3, "{version}");
        assert!(version.starts_with("2."), "{version}");
    }

    fn nothing_chosen() -> Chosen {
        Chosen {
            gbm: None,
            nv_explicit_sync: None,
            backend: None,
            gdk_gl: None,
        }
    }

    #[test]
    fn writes_a_stable_menu_file_for_an_appimage() {
        let root = scratch("launcher");
        fs::create_dir_all(root.join("squash")).unwrap();
        let appimage = root.join("Linger.AppImage");
        fs::write(&appimage, []).unwrap();
        let icon = root.join("squash/.DirIcon");
        fs::write(&icon, b"png-bytes").unwrap();

        write_menu_entry(
            &root.join("data"),
            &appimage,
            Some(&root.join("squash")),
            &nothing_chosen(),
        )
        .unwrap();

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

    #[test]
    fn an_old_menu_entry_loses_the_gbm_workaround_it_wrote_for_itself() {
        // Launched from a 0.3.4 entry: the old workaround arrives as if chosen.
        let root = scratch("launcher-upgrade");
        let appimage = root.join("Linger.AppImage");
        fs::write(&appimage, []).unwrap();
        let chosen = Chosen {
            gbm: Some("1".into()),
            nv_explicit_sync: Some("1".into()),
            backend: Some("wayland".into()),
            gdk_gl: None,
        };

        write_menu_entry(&root.join("data"), &appimage, None, &chosen).unwrap();

        let entry =
            fs::read_to_string(root.join("data/applications/com.linger.desktop.desktop")).unwrap();
        let path = appimage.to_str().expect("utf8 path");
        assert!(entry.contains(&format!("Exec=env LINGER_LINUX_BACKEND=wayland {path}\n")));
        assert!(!entry.contains(GBM));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_package_install_removes_the_appimage_menu_entry_and_nothing_else() {
        let root = scratch("menu-cleanup");
        let appimage = root.join("Linger.AppImage");
        fs::write(&appimage, []).unwrap();
        fs::create_dir_all(root.join("squash")).unwrap();
        fs::write(root.join("squash/.DirIcon"), b"png").unwrap();
        write_menu_entry(
            &root.join("data"),
            &appimage,
            Some(&root.join("squash")),
            &nothing_chosen(),
        )
        .unwrap();
        let entry = root.join("data/applications/com.linger.desktop.desktop");
        let icon = root.join("data/icons/hicolor/256x256/apps/com.linger.desktop.png");
        assert!(entry.exists() && icon.exists());

        remove_appimage_menu_entry(&root.join("data"));
        assert!(!entry.exists());
        assert!(!icon.exists());

        // An entry somebody wrote by hand under the same name is not ours.
        fs::write(
            &entry,
            "[Desktop Entry]\nName=Linger\nExec=/opt/linger/run\n",
        )
        .unwrap();
        remove_appimage_menu_entry(&root.join("data"));
        assert!(entry.exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
