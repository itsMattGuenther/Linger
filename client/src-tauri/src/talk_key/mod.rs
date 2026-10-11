//! Push-to-talk with another app in front (#500, SPEC §4.14).
//!
//! A Linger window hears the talk key only while it has focus, and a game in
//! front is where push-to-talk matters most. So while you're in voice with
//! push-to-talk on, the list window asks this to watch for the one key you
//! chose (`voice_talk_key`), and this tells the list window when it goes down
//! and up (`next:talkkey`), the way the tray menu's Mute does. The list window
//! keeps the rules (mute and deafen still win, `core/talkHold.ts`), so the
//! microphone has one owner and the two can never disagree.
//!
//! What it never does (AGENTS.md hard rule 2, PRIV-2; `privacy.test.ts` reads
//! this source): see any key but the chosen one, keep or send anything about
//! keys, take the key away from the app in front, or ask what that app is.
//!
//! - **Windows:** a thread asks Windows whether that one key (or mouse button)
//!   is down, 50 times a second, and exists only while watching.
//!   `GetAsyncKeyState` answers for the one key it's asked about, and asking
//!   takes nothing from the game. A game run as administrator hides its keys
//!   from an app that isn't, as it does from Discord.
//! - **Linux:** the desktop's global shortcuts (the `GlobalShortcuts` portal,
//!   `portal.rs`). Linger asks for one shortcut, `push-to-talk`; the person
//!   gives it a key in their desktop, and the desktop says when it goes down
//!   and up. Linger never sees a key at all. Without the portal (X11 on most
//!   desktops, or a development build the desktop can't name), nothing runs.
//! - **macOS:** as on Windows, a thread asks macOS whether that one key (or
//!   mouse button) is down, 50 times a second (`CGEventSourceKeyState`,
//!   `CGEventSourceButtonState`, #587). Asking about one key takes nothing
//!   from the app in front and never sees another key. A key a Mac has no
//!   code for (Pause, Scroll Lock, F21 and up) works only while a Linger
//!   window is in front. Not yet tried on a Mac: whether macOS asks for the
//!   Input Monitoring permission first.
//!
//! Whatever watches, a key it reported down is reported up when it stops, for
//! any reason, a panic included: the microphone fails closed.

// Each platform builds the parts it uses: the phone builds none of the
// watching, and only Windows and macOS say they reach anywhere.
#![cfg_attr(
    not(any(windows, target_os = "linux", target_os = "macos")),
    allow(dead_code)
)]

#[cfg(target_os = "linux")]
mod portal;

#[cfg(any(windows, target_os = "macos", test))]
use std::sync::mpsc;
use std::sync::Mutex;
#[cfg(any(windows, target_os = "macos", test))]
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, WebviewWindow};

/// What the list window hears from the watcher: `"down"` or `"up"`.
pub const TALK_KEY_EVENT: &str = "next:talkkey";

/// How often the Windows and macOS watchers ask about the key: 50 times a
/// second, the rate the voice sender already runs at while you're in a call,
/// so a press is heard within one 20 ms frame of audio.
#[cfg(any(windows, target_os = "macos", test))]
const POLL: Duration = Duration::from_millis(20);

/// The key went down or came up.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Down,
    Up,
}

impl Edge {
    fn word(self) -> &'static str {
        match self {
            Edge::Down => "down",
            Edge::Up => "up",
        }
    }
}

/// The key as last reported, from samples (Windows) or the desktop's signals
/// (Linux): reports only changes, and never a press that began before
/// watching did.
#[derive(Debug)]
pub struct Edges {
    reported: bool,
    /// False while a key held when watching started is still held: joining
    /// voice with the key already down opens nothing until it's pressed again,
    /// as undeafening does (SPEC §4.14).
    armed: bool,
}

impl Edges {
    pub fn new(down_at_start: bool) -> Self {
        Self {
            reported: false,
            armed: !down_at_start,
        }
    }

    /// The key is down (or not) now: the edge to report, if any.
    pub fn saw(&mut self, down: bool) -> Option<Edge> {
        if !down {
            self.armed = true;
            return self.stop();
        }
        if self.armed && !self.reported {
            self.reported = true;
            return Some(Edge::Down);
        }
        None
    }

    /// Watching stopped: a key reported down is let go.
    pub fn stop(&mut self) -> Option<Edge> {
        if self.reported {
            self.reported = false;
            Some(Edge::Up)
        } else {
            None
        }
    }
}

/// Reports edges to the list window, and lets go of a key it reported down
/// when it's dropped: when watching stops, fails or panics, the microphone
/// closes.
struct Reporter<F: Fn(Edge)> {
    edges: Edges,
    tell: F,
}

impl<F: Fn(Edge)> Reporter<F> {
    fn new(down_at_start: bool, tell: F) -> Self {
        Self {
            edges: Edges::new(down_at_start),
            tell,
        }
    }

    fn saw(&mut self, down: bool) {
        if let Some(edge) = self.edges.saw(down) {
            (self.tell)(edge);
        }
    }
}

impl<F: Fn(Edge)> Drop for Reporter<F> {
    fn drop(&mut self) {
        if let Some(edge) = self.edges.stop() {
            (self.tell)(edge);
        }
    }
}

/// Ask `down` about the key every `every` until `stop` says so (or its sender
/// is dropped), reporting each change. Windows' and macOS's watcher, with the
/// question passed in so a test can answer it.
#[cfg(any(windows, target_os = "macos", test))]
fn poll(down: impl Fn() -> bool, every: Duration, stop: &mpsc::Receiver<()>, tell: impl Fn(Edge)) {
    let mut reporter = Reporter::new(down(), tell);
    while let Err(mpsc::RecvTimeoutError::Timeout) = stop.recv_timeout(every) {
        reporter.saw(down());
    }
}

/// One talk key the picker offers (`client/src/next/core/talkKey.ts`, which
/// saves a `KeyboardEvent.code`, and a name of Linger's own for a mouse
/// button), as each system names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TalkKey {
    /// Windows' virtual-key code, for `GetAsyncKeyState`.
    pub vk: u16,
    /// Its name in a Hyprland bind: an X keysym name, or `mouse:` and the
    /// button's Linux code.
    pub bind: String,
    /// A mouse button: the shortcuts spec has no name for one, so the portal
    /// is given no preferred trigger for it.
    pub mouse: bool,
}

/// The key for a saved code, or none for a code the picker wouldn't offer.
/// Left and right Ctrl, Alt and Shift are different keys, as in the picker:
/// the shortcuts use the left Ctrl and must never open the microphone.
#[must_use]
pub fn talk_key(code: &str) -> Option<TalkKey> {
    let key = |vk: u16, bind: &str| {
        Some(TalkKey {
            vk,
            bind: bind.to_string(),
            mouse: bind.starts_with("mouse:"),
        })
    };
    match code {
        "ControlLeft" => key(0xA2, "Control_L"),
        "ControlRight" => key(0xA3, "Control_R"),
        "AltLeft" => key(0xA4, "Alt_L"),
        "AltRight" => key(0xA5, "Alt_R"),
        "ShiftLeft" => key(0xA0, "Shift_L"),
        "ShiftRight" => key(0xA1, "Shift_R"),
        "Pause" => key(0x13, "Pause"),
        "ScrollLock" => key(0x91, "Scroll_Lock"),
        "Insert" => key(0x2D, "Insert"),
        "ContextMenu" => key(0x5D, "Menu"),
        // Middle, back and forward: Windows' MBUTTON, XBUTTON1 and XBUTTON2,
        // and Linux's BTN_MIDDLE, BTN_SIDE and BTN_EXTRA.
        "MouseMiddle" => key(0x04, "mouse:274"),
        "MouseBack" => key(0x05, "mouse:275"),
        "MouseForward" => key(0x06, "mouse:276"),
        _ => {
            let number: u16 = code.strip_prefix('F')?.parse().ok()?;
            if (1..=24).contains(&number) && code == format!("F{number}") {
                // VK_F1 is 0x70, and F2 to F24 follow it.
                key(0x6F + number, code)
            } else {
                None
            }
        }
    }
}

/// One talk key as macOS asks about it: a key code (Carbon's `kVK_…`, the
/// same on every keyboard layout) or a mouse button's number.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacKey {
    Key(u16),
    Button(u32),
}

/// The macOS key for a saved code, or none for one a Mac has no code for:
/// Pause and Scroll Lock, and F21 to F24. Those work only while a Linger
/// window is in front. Left and right are different keys here too.
#[cfg(any(target_os = "macos", test))]
#[must_use]
pub fn mac_key(code: &str) -> Option<MacKey> {
    /// `kVK_F1` to `kVK_F20`, which aren't in order.
    const F: [u16; 20] = [
        0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71,
        0x6A, 0x40, 0x4F, 0x50, 0x5A,
    ];
    let key = match code {
        "ControlLeft" => MacKey::Key(0x3B),  // kVK_Control
        "ControlRight" => MacKey::Key(0x3E), // kVK_RightControl
        "AltLeft" => MacKey::Key(0x3A),      // kVK_Option
        "AltRight" => MacKey::Key(0x3D),     // kVK_RightOption
        "ShiftLeft" => MacKey::Key(0x38),    // kVK_Shift
        "ShiftRight" => MacKey::Key(0x3C),   // kVK_RightShift
        // A PC keyboard's Insert is Help on a Mac.
        "Insert" => MacKey::Key(0x72),      // kVK_Help
        "ContextMenu" => MacKey::Key(0x6E), // kVK_ContextualMenu
        // Middle, back and forward: buttons 2, 3 and 4 (0 is the left).
        "MouseMiddle" => MacKey::Button(2),
        "MouseBack" => MacKey::Button(3),
        "MouseForward" => MacKey::Button(4),
        _ => {
            let number: usize = code.strip_prefix('F')?.parse().ok()?;
            if code != format!("F{number}") {
                return None;
            }
            MacKey::Key(*F.get(number.checked_sub(1)?)?)
        }
    };
    Some(key)
}

/// How far the talk key reaches on this computer, for Settings (Talk key) to
/// say. Mirrored by hand in `client/src/lib/ipc.ts` (`TalkKeyReach`): it never
/// leaves the computer, so it isn't a wire type (AGENTS.md rule 7), and a test
/// below pins its spellings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Reach {
    /// Whatever app is in front (Windows, and macOS for a key a Mac has).
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    Anywhere,
    /// Whatever app is in front, once the desktop has given Linger's shortcut
    /// a key: `shortcut` is its name there, as Hyprland's `global` takes it.
    /// `hyprland` is the config to put the bind line in, `"lua"` (0.56 and
    /// later) or `"conf"`, on Hyprland; `bind` is the chosen key's name in it.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Desktop {
        shortcut: String,
        hyprland: Option<&'static str>,
        bind: Option<String>,
    },
    /// Only while a Linger window is in front, and why: `"mac"` (a key a Mac
    /// has no code for), `"desktop"` (this desktop has no global shortcuts
    /// for apps), or `"installed"` (a copy the desktop can't name, a
    /// development build).
    #[cfg_attr(windows, allow(dead_code))]
    Window { why: &'static str },
}

/// The shortcut Linger asks the desktop for.
pub const SHORTCUT_ID: &str = "push-to-talk";

/// The watcher running now, if any. Dropping it stops it.
#[derive(Default)]
pub struct TalkKeyWatch(Mutex<Option<Watching>>);

struct Watching {
    /// The saved code it watches for (Windows, macOS), or was started with
    /// (Linux, where the desktop holds the key and a new one changes nothing
    /// here).
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    key: String,
    #[cfg(any(windows, target_os = "macos"))]
    _stop: mpsc::Sender<()>,
    #[cfg(target_os = "linux")]
    _stop: portal::Stop,
}

fn tell(app: &AppHandle) -> impl Fn(Edge) + Send + 'static {
    let app = app.clone();
    move |edge: Edge| {
        let _ = app.emit_to("main", TALK_KEY_EVENT, edge.word());
    }
}

/// Watch for the talk key with any app in front, or stop (`key` null): the
/// list window asks while you're in voice with push-to-talk on, and only then
/// (SPEC §4.14). Only the list window may ask: it owns voice. A key the
/// picker wouldn't offer stops watching.
#[tauri::command]
pub fn voice_talk_key(
    app: AppHandle,
    window: WebviewWindow,
    watch: tauri::State<'_, TalkKeyWatch>,
    key: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("only the list window watches for the talk key".into());
    }
    let mut held = watch.0.lock().map_err(|e| e.to_string())?;
    let wanted = key.filter(|code| talk_key(code).is_some());
    let Some(code) = wanted else {
        // Dropping it stops it, and lets go of a key it held.
        *held = None;
        return Ok(());
    };
    if let Some(running) = held.as_ref() {
        // The portal watches the desktop's shortcut, whatever key Linger
        // picked; Windows and macOS watch the key itself, so a new one
        // restarts it.
        if cfg!(not(any(windows, target_os = "macos"))) || running.key == code {
            return Ok(());
        }
    }
    *held = None;
    *held = start(&app, code);
    Ok(())
}

#[cfg(windows)]
fn start(app: &AppHandle, code: String) -> Option<Watching> {
    let vk = talk_key(&code)?.vk;
    let (stop, stopped) = mpsc::channel();
    let tell = tell(app);
    let spawned = std::thread::Builder::new()
        .name("linger-talk-key".into())
        .spawn(move || poll(move || windows_key::down(vk), POLL, &stopped, tell));
    if let Err(error) = spawned {
        eprintln!("linger: couldn't watch for the talk key: {error}");
        return None;
    }
    Some(Watching {
        key: code,
        _stop: stop,
    })
}

#[cfg(target_os = "linux")]
fn start(app: &AppHandle, code: String) -> Option<Watching> {
    let trigger = talk_key(&code).filter(|key| !key.mouse).map(|key| key.bind);
    let stop = portal::watch(trigger, tell(app))?;
    Some(Watching {
        key: code,
        _stop: stop,
    })
}

#[cfg(target_os = "macos")]
fn start(app: &AppHandle, code: String) -> Option<Watching> {
    let key = mac_key(&code)?;
    let (stop, stopped) = mpsc::channel();
    let tell = tell(app);
    let spawned = std::thread::Builder::new()
        .name("linger-talk-key".into())
        .spawn(move || poll(move || mac_keys::down(key), POLL, &stopped, tell));
    if let Err(error) = spawned {
        eprintln!("linger: couldn't watch for the talk key: {error}");
        return None;
    }
    Some(Watching {
        key: code,
        _stop: stop,
    })
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn start(_app: &AppHandle, _code: String) -> Option<Watching> {
    None
}

/// How far the talk key reaches on this computer, for Settings to say, with
/// `key`'s name in a Hyprland bind (SPEC §4.14). Asking starts nothing.
#[tauri::command]
pub async fn voice_talk_key_reach(key: String) -> Reach {
    reach(&key).await
}

#[cfg(windows)]
async fn reach(_key: &str) -> Reach {
    Reach::Anywhere
}

#[cfg(target_os = "linux")]
async fn reach(key: &str) -> Reach {
    portal::reach(talk_key(key).map(|key| key.bind)).await
}

#[cfg(target_os = "macos")]
async fn reach(key: &str) -> Reach {
    if mac_key(key).is_some() {
        Reach::Anywhere
    } else {
        Reach::Window { why: "mac" }
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
async fn reach(_key: &str) -> Reach {
    Reach::Window { why: "mac" }
}

#[cfg(windows)]
mod windows_key {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    /// Whether the one key `vk` is down now, whatever app is in front. Only
    /// the high bit means anything: the low one says whether it was pressed
    /// since some app last asked, which another app's asking can clear.
    pub fn down(vk: u16) -> bool {
        // SAFETY: `GetAsyncKeyState` takes a plain integer and reads no memory
        // of ours; any value is allowed and an unknown one answers "up".
        let state = unsafe { GetAsyncKeyState(i32::from(vk)) };
        state < 0
    }
}

#[cfg(target_os = "macos")]
mod mac_keys {
    use super::MacKey;

    /// CoreGraphics' combined session state: the keys and buttons as the
    /// whole login session sees them, whatever app is in front.
    const COMBINED_SESSION_STATE: i32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }

    /// Whether the one key or button is down now, whatever app is in front.
    pub fn down(key: MacKey) -> bool {
        // SAFETY: both take plain integers and read no memory of ours; an
        // unknown key or button answers "up".
        unsafe {
            match key {
                MacKey::Key(code) => CGEventSourceKeyState(COMBINED_SESSION_STATE, code),
                MacKey::Button(button) => CGEventSourceButtonState(COMBINED_SESSION_STATE, button),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn edges_report_changes_only() {
        let mut edges = Edges::new(false);
        assert_eq!(edges.saw(false), None);
        assert_eq!(edges.saw(true), Some(Edge::Down));
        assert_eq!(edges.saw(true), None, "a key held is one press");
        assert_eq!(edges.saw(false), Some(Edge::Up));
        assert_eq!(edges.saw(false), None);
        assert_eq!(edges.stop(), None, "nothing held, nothing to let go");
    }

    #[test]
    fn a_key_held_when_watching_starts_needs_pressing_again() {
        let mut edges = Edges::new(true);
        assert_eq!(edges.saw(true), None);
        assert_eq!(edges.saw(false), None, "never reported down, so no up");
        assert_eq!(edges.saw(true), Some(Edge::Down));
    }

    #[test]
    fn stopping_with_the_key_down_lets_go_of_it() {
        let mut edges = Edges::new(false);
        assert_eq!(edges.saw(true), Some(Edge::Down));
        assert_eq!(edges.stop(), Some(Edge::Up));
        assert_eq!(edges.stop(), None);
    }

    fn recorder() -> (Arc<Mutex<Vec<Edge>>>, impl Fn(Edge) + Send + 'static) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&seen);
        (seen, move |edge| into.lock().unwrap().push(edge))
    }

    #[test]
    fn a_reporter_dropped_with_the_key_down_lets_go_of_it_even_in_a_panic() {
        let (seen, tell) = recorder();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut reporter = Reporter::new(false, tell);
            reporter.saw(true);
            panic!("the watcher broke");
        }));
        assert!(caught.is_err());
        assert_eq!(*seen.lock().unwrap(), vec![Edge::Down, Edge::Up]);
    }

    #[test]
    fn polling_reports_presses_and_lets_go_when_stopped() {
        // The key goes down on the second question and stays down; stopping
        // then must report it up, or the microphone would stay open.
        let (seen, tell) = recorder();
        let asked = Arc::new(Mutex::new(0_u32));
        let counter = Arc::clone(&asked);
        let (stop, stopped) = mpsc::channel::<()>();
        let watcher = std::thread::spawn(move || {
            poll(
                move || {
                    let mut count = counter.lock().unwrap();
                    *count += 1;
                    *count >= 2
                },
                Duration::from_millis(1),
                &stopped,
                tell,
            );
        });
        while seen.lock().unwrap().is_empty() {
            std::thread::sleep(Duration::from_millis(1));
        }
        drop(stop);
        watcher.join().unwrap();
        assert_eq!(*seen.lock().unwrap(), vec![Edge::Down, Edge::Up]);
        assert!(*asked.lock().unwrap() >= 2);
    }

    #[test]
    fn polling_asks_about_the_key_only_on_its_clock() {
        // Started and stopped at once, it asks once (where the key was at the
        // start) and reports nothing: no busy loop between questions.
        let (seen, tell) = recorder();
        let asked = Arc::new(Mutex::new(0_u32));
        let counter = Arc::clone(&asked);
        let (stop, stopped) = mpsc::channel::<()>();
        stop.send(()).unwrap();
        poll(
            move || {
                *counter.lock().unwrap() += 1;
                false
            },
            POLL,
            &stopped,
            tell,
        );
        assert_eq!(*asked.lock().unwrap(), 1);
        assert!(seen.lock().unwrap().is_empty());
    }

    /// Every code the picker offers (`talkKey.ts`, `TALK_KEYS`), which a test
    /// there checks against this file.
    fn offered() -> Vec<String> {
        let mut codes: Vec<String> = [
            "ControlLeft",
            "ControlRight",
            "AltLeft",
            "AltRight",
            "ShiftLeft",
            "ShiftRight",
            "Pause",
            "ScrollLock",
            "Insert",
            "ContextMenu",
            "MouseMiddle",
            "MouseBack",
            "MouseForward",
        ]
        .map(String::from)
        .to_vec();
        codes.extend((1..=24).map(|n| format!("F{n}")));
        codes
    }

    #[test]
    fn every_key_the_picker_offers_has_a_windows_code_and_a_bind_name() {
        let mut vks = std::collections::BTreeSet::new();
        for code in offered() {
            let key = talk_key(&code).unwrap_or_else(|| panic!("{code} has no mapping"));
            assert!(vks.insert(key.vk), "{code} shares a Windows code");
            assert!(!key.bind.is_empty());
        }
    }

    #[test]
    fn keys_map_to_windows_and_linux_names() {
        let at = |code: &str| talk_key(code).unwrap();
        // Right Ctrl is VK_RCONTROL, never the either-side VK_CONTROL (0x11),
        // or the shortcuts' left Ctrl would open the microphone.
        assert_eq!(at("ControlRight").vk, 0xA3);
        assert_eq!(at("ControlRight").bind, "Control_R");
        assert_eq!(at("ControlLeft").vk, 0xA2);
        assert_eq!(at("F1").vk, 0x70);
        assert_eq!(at("F13").vk, 0x7C);
        assert_eq!(at("F24").vk, 0x87);
        assert_eq!(at("F24").bind, "F24");
        assert_eq!(at("ScrollLock").bind, "Scroll_Lock");
        assert_eq!(at("ContextMenu").vk, 0x5D);
        let back = at("MouseBack");
        assert_eq!(
            (back.vk, back.bind.as_str(), back.mouse),
            (0x05, "mouse:275", true)
        );
        assert_eq!(at("MouseForward").vk, 0x06);
        assert_eq!(at("MouseMiddle").bind, "mouse:274");
        assert!(!at("Pause").mouse);
    }

    #[test]
    fn mac_keys_are_one_key_each_and_left_is_never_right() {
        let mut seen = std::collections::BTreeSet::new();
        for code in offered() {
            let Some(key) = mac_key(&code) else {
                assert!(
                    matches!(
                        code.as_str(),
                        "Pause" | "ScrollLock" | "F21" | "F22" | "F23" | "F24"
                    ),
                    "{code} has a Mac key"
                );
                continue;
            };
            assert!(seen.insert(format!("{key:?}")), "{code} shares a Mac key");
        }
        assert_eq!(mac_key("ControlRight"), Some(MacKey::Key(0x3E)));
        assert_eq!(mac_key("ControlLeft"), Some(MacKey::Key(0x3B)));
        assert_eq!(mac_key("F1"), Some(MacKey::Key(0x7A)));
        assert_eq!(mac_key("F13"), Some(MacKey::Key(0x69)));
        assert_eq!(mac_key("F20"), Some(MacKey::Key(0x5A)));
        assert_eq!(mac_key("MouseBack"), Some(MacKey::Button(3)));
        for code in [
            "KeyA",
            "Space",
            "F0",
            "F01",
            "F25",
            "MouseLeft",
            "MouseRight",
            "",
        ] {
            assert_eq!(mac_key(code), None, "{code}");
        }
    }

    #[test]
    fn keys_that_type_or_click_are_never_talk_keys() {
        for code in [
            "KeyA",
            "Space",
            "Enter",
            "Escape",
            "Tab",
            "CapsLock",
            "F0",
            "F25",
            "F01",
            "F",
            "MouseLeft",
            "MouseRight",
            "",
        ] {
            assert_eq!(talk_key(code), None, "{code}");
        }
    }

    #[test]
    fn reach_is_spelled_as_settings_reads_it() {
        // `client/src/lib/ipc.ts` (`TalkKeyReach`) mirrors these by hand.
        let json = |reach: Reach| serde_json::to_string(&reach).unwrap();
        assert_eq!(json(Reach::Anywhere), r#"{"kind":"anywhere"}"#);
        assert_eq!(
            json(Reach::Desktop {
                shortcut: "linger:push-to-talk".into(),
                hyprland: Some("lua"),
                bind: Some("Control_R".into()),
            }),
            r#"{"kind":"desktop","shortcut":"linger:push-to-talk","hyprland":"lua","bind":"Control_R"}"#
        );
        assert_eq!(
            json(Reach::Window { why: "mac" }),
            r#"{"kind":"window","why":"mac"}"#
        );
    }
}
