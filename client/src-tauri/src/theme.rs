//! The theme a person picked (#963, #965, SPEC §5.3), for what the shell
//! draws itself. The page holds the choice and draws everything inside a
//! window; the list window tells the shell the theme each time it puts one
//! on (`followThemeInShell` in core/theme.ts), by its id.
//!
//! - **On a computer**, the color a window shows before its page draws:
//!   every open window takes it at once, and a window opened later is built
//!   in it. Without it a window opened dark under Daylight's paper. At start
//!   the list is built before any page runs, so it waits, hidden, until its
//!   page says (#965): the page's own saved choice is the only copy, and
//!   nothing the shell keeps can fall behind it.
//! - **On a phone**, the status bar's and navigation bar's icons: dark on
//!   Daylight's paper, light on every dark theme. The page is drawn under
//!   both bars, so their icons have to read on its ground rather than follow
//!   the phone's own dark mode. Android draws them from `SystemBars.kt`; an
//!   iPhone's follow the window's light or dark style.
//!
//! A theme crosses as its id, never as a color, and one the shell doesn't
//! know is The door, as in `public/theme.js`.

/// Every theme: its id, its window color (`--surface-window`, as next.html
/// paints it before the styles load; the tests hold the two together), and
/// whether it's light (`color-scheme: light` in tokens.css).
const THEMES: [(&str, [u8; 3], bool); 6] = [
    ("door", [0x13, 0x1a, 0x28], false),
    ("after-dark", [0x09, 0x0a, 0x0d], false),
    ("porch-light", [0x1c, 0x17, 0x14], false),
    ("dusk", [0x21, 0x2f, 0x58], false),
    ("original", [0x01, 0x13, 0x33], false),
    ("daylight", [0xf6, 0xf8, 0xfb], true),
];

/// One theme, as the shell draws it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Look {
    #[cfg_attr(mobile, allow(dead_code))]
    id: &'static str,
    #[cfg_attr(mobile, allow(dead_code))]
    window: [u8; 3],
    #[cfg_attr(not(mobile), allow(dead_code))]
    light: bool,
}

/// The theme with this id, or The door for one it doesn't know.
fn look(id: &str) -> Look {
    let (id, window, light) = THEMES
        .iter()
        .find(|(known, _, _)| *known == id)
        .copied()
        .unwrap_or(THEMES[0]);
    Look { id, window, light }
}

#[cfg(desktop)]
pub use desktop::{shown_id, start_in, wait_for_theme, waiting, window_color};

/// The list window puts a theme on: every window takes its color, and so
/// does every window opened after, and a list waiting to be shown at start
/// is shown in it. Only the list says; another window's word is refused.
/// Not `async`, so it runs on the app's main thread, one at a time in the
/// order the list said them.
#[cfg(desktop)]
#[tauri::command]
pub fn app_theme(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    theme: String,
) -> Result<(), String> {
    desktop::put_on(&app, &window, &theme)
}

#[cfg(desktop)]
mod desktop {
    use std::sync::Mutex;
    use std::time::Duration;

    use tauri::window::Color;
    use tauri::{AppHandle, Manager, WebviewWindow};

    use super::{look, Look};

    /// The theme the list last told, which windows opened from now on are
    /// built in. The door until the list says, or a restart to update hands
    /// over the one it was showing.
    static SHOWN: Shown = Shown::new();

    /// A theme shown, by its id.
    pub(super) struct Shown(Mutex<&'static str>);

    impl Shown {
        pub(super) const fn new() -> Self {
            Self(Mutex::new("door"))
        }

        pub(super) fn id(&self) -> &'static str {
            *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        }

        /// Show this theme from now on; one this Linger doesn't know is The
        /// door.
        pub(super) fn put(&self, id: &str) {
            *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = look(id).id;
        }

        pub(super) fn color(&self) -> Color {
            color(look(self.id()))
        }
    }

    /// Whether the list is hidden at start until its page says its theme.
    static WAIT: Wait = Wait::new();

    /// How long the list waits for its page before it's shown anyway. Only a
    /// page that failed to load runs into it, so it's generous: a slow
    /// computer's first start still has its page say first.
    const DEADLINE: Duration = Duration::from_secs(10);

    /// A window waiting to be shown until its page has said its theme.
    /// Ended once, by whichever comes first: the page's word or the
    /// deadline. The window is shown at the end, so only once.
    pub(super) struct Wait(Mutex<bool>);

    impl Wait {
        pub(super) const fn new() -> Self {
            Self(Mutex::new(false))
        }

        fn held(&self) -> std::sync::MutexGuard<'_, bool> {
            self.0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        }

        pub(super) fn start(&self) {
            *self.held() = true;
        }

        pub(super) fn waiting(&self) -> bool {
            *self.held()
        }

        /// End the wait. Says whether this ended it, and so whether to show
        /// the window now: a second end, or one with no wait, shows nothing.
        pub(super) fn end(&self) -> bool {
            std::mem::replace(&mut *self.held(), false)
        }
    }

    fn color(look: Look) -> Color {
        let [r, g, b] = look.window;
        Color(r, g, b, 255)
    }

    /// The theme shown now, by its id: what a restart to update hands the
    /// next start (`updates.rs`).
    pub fn shown_id() -> &'static str {
        SHOWN.id()
    }

    /// Start in the theme the last run was showing when it restarted to
    /// update (`updates::Back`), so a list shown at once is built in it.
    /// One this Linger doesn't know is The door.
    pub fn start_in(id: &str) {
        SHOWN.put(id);
    }

    /// The color a window is built in: the theme's, so it never shows another
    /// theme's for a moment before its page draws.
    pub fn window_color() -> Color {
        SHOWN.color()
    }

    /// The list was built hidden at start (`window::create`): it's shown
    /// when its page says its theme, in that theme's color, so it never
    /// shows another theme's first. Nothing is kept for this: the page's
    /// own saved choice is the only copy, and it tells first thing
    /// (`followThemeInShell`). A page that never says is shown at the
    /// deadline, so Linger never starts with nothing on screen.
    pub fn wait_for_theme(app: &AppHandle) {
        WAIT.start();
        eprintln!("linger: the list waits for its page's theme");
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(DEADLINE).await;
            let shell = app.clone();
            let _ = app.run_on_main_thread(move || {
                show_if_waiting(&shell, "its page never said its theme");
            });
        });
    }

    /// Whether the list is still waiting for its page's theme. Bringing it
    /// forward meanwhile (the tray, a second start, a link) is left to the
    /// end of the wait, moments away, which brings it forward anyway, so
    /// it isn't shown in another theme's color first (`tray::show_list`).
    pub fn waiting() -> bool {
        WAIT.waiting()
    }

    /// At the end of the wait the list comes forward as the tray's Show
    /// Linger brings it: shown, restored and focused, as a start that
    /// somebody made, built visible and focused, always came up. Only such
    /// a start waits (`window::ListStart`).
    /// Said in the log with `why`, so a start that took long can be told
    /// apart from one whose page never said.
    fn show_if_waiting(app: &AppHandle, why: &str) {
        if WAIT.end() {
            eprintln!("linger: {why}; the list is shown");
            crate::tray::show_list(app);
        }
    }

    /// `app_theme` on a computer, on the app's main thread: the color goes
    /// on every window before a waiting list is shown, so its first frame
    /// is in it.
    pub fn put_on(app: &AppHandle, window: &WebviewWindow, theme: &str) -> Result<(), String> {
        if window.label() != crate::window::OWNER {
            return Err("only the list window says the theme".into());
        }
        let now = look(theme);
        SHOWN.put(now.id);
        for open in app.webview_windows().values() {
            let _ = open.set_background_color(Some(color(now)));
        }
        show_if_waiting(app, "its page said its theme");
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{Shown, Wait};

        #[test]
        fn a_waiting_window_is_shown_once() {
            let wait = Wait::new();
            wait.start();
            assert!(wait.waiting(), "a show asked for meanwhile waits too");
            assert!(wait.end(), "the page's word shows it");
            assert!(!wait.waiting(), "after it, a show asked for shows it");
            assert!(!wait.end(), "the deadline after it shows nothing");
            assert!(!wait.end(), "nor a second word");
        }

        /// A restart to update hands over its theme (`updates::Back`); the
        /// next start builds its windows in it, and in The door for one it
        /// doesn't know, as before anything says.
        #[test]
        fn a_start_builds_in_the_theme_it_was_handed() {
            let shown = Shown::new();
            assert_eq!(shown.id(), "door");
            shown.put("daylight");
            assert_eq!(shown.id(), "daylight");
            assert_eq!(shown.color(), super::color(crate::theme::look("daylight")));
            shown.put("sunrise");
            assert_eq!(shown.id(), "door");
        }

        #[test]
        fn a_window_that_never_waited_is_never_shown_by_the_end_of_one() {
            // A start into the tray (#772): the list stays hidden there,
            // whatever the page says or the deadline.
            let wait = Wait::new();
            assert!(!wait.waiting());
            assert!(!wait.end());
        }
    }
}

/// The page puts a theme on: the phone's bars take its icons, dark on a
/// light theme and light on a dark one.
#[cfg(mobile)]
#[tauri::command]
pub async fn app_theme(webview: tauri::Webview, theme: String) {
    platform::follow(&webview, look(&theme).light).await;
}

#[cfg(target_os = "android")]
mod platform {
    //! `SystemBars.kt`, asked from a thread kept for blocking work, which
    //! redraws the bars on the app's own thread and keeps the answer for
    //! the next start (`MainActivity.kt`).

    use jni::objects::JValue;

    use crate::phone_sound::android::{app_class, with_env};

    pub async fn follow(_webview: &tauri::Webview, light: bool) {
        crate::off_thread(move || bars(light), || None).await;
    }

    fn bars(light: bool) -> Option<()> {
        with_env(|env, app| {
            let class = app_class(env, app, "io.github.itsmattguenther.linger.SystemBars")?;
            env.call_static_method(
                &class,
                "follow",
                "(Landroid/content/Context;Z)V",
                &[JValue::Object(app), JValue::Bool(u8::from(light))],
            )
            .ok()?;
            Some(())
        })
    }
}

#[cfg(target_os = "ios")]
mod platform {
    //! The window's light or dark style, which the status bar's default
    //! style follows: dark icons on a light window, light on a dark one.
    //! Linger's view controller (tao's) asks for that default, so setting
    //! the window's style is all it takes. The keyboard and the share sheet
    //! follow it too, so they match the page.
    //!
    //! Nothing is kept here, unlike Android: at a cold start the bars follow
    //! the phone's own light or dark mode until the page says, a moment
    //! after it loads.

    use objc2::MainThreadMarker;
    use objc2_ui_kit::{UIUserInterfaceStyle, UIViewController};

    pub async fn follow(webview: &tauri::Webview, light: bool) {
        let _ = webview.with_webview(move |shown| {
            if MainThreadMarker::new().is_none() {
                return;
            }
            // SAFETY: Tauri hands over the window's root view controller,
            // which lives as long as the window, and calls this on the main
            // thread, checked just above.
            let Some(root) =
                (unsafe { shown.view_controller().cast::<UIViewController>().as_ref() })
            else {
                return;
            };
            let style = if light {
                UIUserInterfaceStyle::Light
            } else {
                UIUserInterfaceStyle::Dark
            };
            match root.view().and_then(|view| view.window()) {
                Some(window) => window.setOverrideUserInterfaceStyle(style),
                None => root.setOverrideUserInterfaceStyle(style),
            }
            root.setNeedsStatusBarAppearanceUpdate();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{look, THEMES};

    /// The color next.html paints each theme's window before the styles
    /// load: the page's own `<style>`, read the way contrast.test.ts reads it.
    fn painted() -> Vec<(String, [u8; 3])> {
        let page = include_str!("../../next.html");
        let style = &page[page.find("<style>").expect("next.html's <style>")..];
        let style = &style[..style.find("</style>").expect("its end")];
        style
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let rest = line.strip_prefix("html")?;
                let id = match rest.strip_prefix("[data-theme=\"") {
                    Some(named) => named[..named.find('"')?].to_string(),
                    None => "door".to_string(),
                };
                let hex = &line[line.find('#')? + 1..];
                let hex = &hex[..6];
                let byte = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
                Some((id, [byte(0)?, byte(2)?, byte(4)?]))
            })
            .collect()
    }

    #[test]
    fn every_theme_is_the_color_the_page_paints_before_it_draws() {
        let mut page = painted();
        let mut shell: Vec<(String, [u8; 3])> = THEMES
            .iter()
            .map(|(id, window, _)| ((*id).to_string(), *window))
            .collect();
        page.sort();
        shell.sort();
        assert_eq!(page.len(), 6, "next.html paints six themes");
        assert_eq!(shell, page);
    }

    #[test]
    fn only_a_theme_tokens_css_calls_light_is_light() {
        let tokens = include_str!("../../src/next/styles/tokens.css");
        for (id, _, light) in THEMES {
            let says_light = tokens
                .find(&format!("[data-theme=\"{id}\"] {{"))
                .map(|at| &tokens[at..])
                .and_then(|block| block.get(..block.find('}')?))
                .is_some_and(|block| block.contains("color-scheme: light"));
            assert_eq!(light, says_light, "{id}");
        }
        assert!(look("daylight").light);
        assert!(!look("door").light);
    }

    #[test]
    fn a_theme_it_does_not_know_is_the_door() {
        for stray in ["", "Daylight", "light", "sunrise", "door "] {
            assert_eq!(look(stray), look("door"), "{stray:?}");
        }
        assert_eq!(look("dusk").id, "dusk");
    }
}
