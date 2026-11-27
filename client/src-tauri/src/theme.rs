//! The theme a person picked (#963, #965, SPEC §5.3), for what the shell
//! draws itself. The page holds the choice and draws everything inside a
//! window; the list window tells the shell the theme each time it puts one
//! on (`followThemeInShell` in core/theme.ts), by its id.
//!
//! - **On a computer**, the color a window shows before its page draws:
//!   every open window takes it at once, a window opened later is built in
//!   it, and it's kept for the next start, when the list is built before any
//!   page runs. Without it a window opened dark under Daylight's paper.
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
pub use desktop::{take_kept, window_color};

/// The list window puts a theme on: every window takes its color, and so
/// does every window opened after, and the next start. Only the list says;
/// another window's word is refused.
#[cfg(desktop)]
#[tauri::command]
pub async fn app_theme(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    theme: String,
) -> Result<(), String> {
    desktop::put_on(&app, &window, &theme).await
}

#[cfg(desktop)]
mod desktop {
    use std::path::Path;
    use std::sync::Mutex;

    use tauri::window::Color;
    use tauri::{AppHandle, Manager, WebviewWindow};

    use super::{look, Look};

    /// The theme the list last told, which windows opened from now on are
    /// built in. The door until a start reads the one kept, or the list says.
    static SHOWN: Mutex<&str> = Mutex::new("door");

    /// One write of the kept theme at a time, each writing what's shown when
    /// its turn comes: whichever write is last writes the newest theme, in
    /// whatever order they were asked for.
    static WRITING: Mutex<()> = Mutex::new(());

    /// Where the theme is kept for the next start, in the app's config
    /// folder, beside the windows' remembered sizes.
    const KEPT: &str = "theme";

    fn color(look: Look) -> Color {
        let [r, g, b] = look.window;
        Color(r, g, b, 255)
    }

    fn shown() -> Look {
        look(
            &SHOWN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    /// The color a window is built in: the theme's, so it never shows another
    /// theme's for a moment before its page draws.
    pub fn window_color() -> Color {
        color(shown())
    }

    /// Read the theme the last run kept, once, as the windows are first
    /// built, so the list opens in it before its page has said anything.
    pub fn take_kept(app: &tauri::App) {
        let Ok(dir) = app.path().app_config_dir() else {
            return;
        };
        if let Some(kept) = read(&dir) {
            *SHOWN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = kept.id;
        }
    }

    fn read(dir: &Path) -> Option<Look> {
        let said = std::fs::read_to_string(dir.join(KEPT)).ok()?;
        Some(look(said.trim()))
    }

    /// Write the theme for the next start. Says whether it was written.
    fn keep(dir: &Path, theme: Look) -> bool {
        std::fs::create_dir_all(dir).is_ok() && std::fs::write(dir.join(KEPT), theme.id).is_ok()
    }

    /// Write the theme shown now, in turn with any other write.
    fn keep_shown(dir: &Path) -> bool {
        let _turn = WRITING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        keep(dir, shown())
    }

    /// `app_theme` on a computer.
    pub async fn put_on(
        app: &AppHandle,
        window: &WebviewWindow,
        theme: &str,
    ) -> Result<(), String> {
        if window.label() != crate::window::OWNER {
            return Err("only the list window says the theme".into());
        }
        let now = look(theme);
        *SHOWN
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = now.id;
        for open in app.webview_windows().values() {
            let _ = open.set_background_color(Some(color(now)));
        }
        // Written each time the list says, so a write that failed is made
        // again: the page hears the refusal and tells again at the next look
        // it applies (`followThemeInShell`).
        let Ok(dir) = app.path().app_config_dir() else {
            return Ok(());
        };
        if !crate::off_thread(move || keep_shown(&dir), || false).await {
            return Err("couldn't keep the theme for the next start".into());
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{keep, keep_shown, read};
        use crate::theme::look;

        #[test]
        fn the_theme_is_kept_for_the_next_start() {
            let dir = std::env::temp_dir().join(format!("linger-theme-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            assert_eq!(read(&dir), None, "nothing kept yet");
            assert!(keep(&dir, look("daylight")));
            assert_eq!(read(&dir), Some(look("daylight")));
            assert!(keep(&dir, look("dusk")));
            assert_eq!(read(&dir), Some(look("dusk")));
            // Kept by a later Linger that has a theme this one doesn't.
            std::fs::write(dir.join(super::KEPT), "sunrise").unwrap();
            assert_eq!(read(&dir), Some(look("door")));
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// A write that fails says so, and `put_on` hands the refusal to the
        /// page, which tells again.
        #[test]
        fn a_theme_that_could_not_be_kept_says_so() {
            let file =
                std::env::temp_dir().join(format!("linger-theme-file-{}", std::process::id()));
            std::fs::write(&file, "a file where the folder would go").unwrap();
            let kept = keep(&file, look("daylight"));
            let _ = std::fs::remove_file(&file);
            assert!(!kept);
        }

        /// A write keeps the theme shown when its turn comes, not the one it
        /// was asked for, so writes finishing out of order can't leave an
        /// older theme for the next start.
        #[test]
        fn a_write_keeps_the_theme_shown_when_it_runs() {
            let dir =
                std::env::temp_dir().join(format!("linger-theme-shown-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            *super::SHOWN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = "dusk";
            let kept = keep_shown(&dir).then(|| read(&dir));
            *super::SHOWN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = "door";
            let _ = std::fs::remove_dir_all(&dir);
            assert_eq!(kept, Some(Some(look("dusk"))));
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
