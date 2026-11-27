//! The theme a person picked (#963, #965, SPEC §5.3), for what the shell
//! draws itself. The page holds the choice and draws everything inside a
//! window; the list window tells the shell the theme each time it puts one
//! on (`followThemeInShell` in core/theme.ts), by its id.
//!
//! - **On a computer**, the color a window shows before its page draws:
//!   every open window takes it at once, and a window opened later is built
//!   in it. Without it a window opened dark under Daylight's paper.
//! - **At start, everywhere**, Linger opens on The door's navy and its page
//!   then draws the theme (Matt, 2026-11-27): the list is built before any
//!   page runs, and a phone's launch screen is fixed, so nothing the shell
//!   draws first can know the theme. The page's own saved choice is the
//!   only copy; the shell keeps nothing for the next start.
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
pub use desktop::window_color;

/// The list window puts a theme on: every window takes its color, and so
/// does every window opened after. Only the list says; another window's
/// word is refused. Not `async`, so it runs on the app's main thread, one
/// at a time in the order the list said them.
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

    use tauri::window::Color;
    use tauri::{AppHandle, Manager, WebviewWindow};

    use super::{look, Look};

    /// The theme the list last told, which windows opened from now on are
    /// built in. The door until the list says, so the list itself opens on
    /// The door's navy at start (`window::create`).
    static SHOWN: Mutex<&str> = Mutex::new("door");

    fn color(look: Look) -> Color {
        let [r, g, b] = look.window;
        Color(r, g, b, 255)
    }

    /// The color a window is built in: the theme's once the list has said
    /// it, so a window opened later never shows another theme's for a
    /// moment before its page draws; The door's navy before.
    pub fn window_color() -> Color {
        color(look(
            &SHOWN
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        ))
    }

    /// `app_theme` on a computer, on the app's main thread.
    pub fn put_on(app: &AppHandle, window: &WebviewWindow, theme: &str) -> Result<(), String> {
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
        Ok(())
    }
}

/// The page puts a theme on: the phone's bars take its icons, dark on a
/// light theme and light on a dark one, and the page's ground takes its
/// window color. A phone opens on The door's navy whatever the theme (its
/// launch screen, and the ground before the page draws), with light icons
/// on it, so that's what the ground leaves: nothing navy shows under
/// Daylight's paper once the page has said.
#[cfg(mobile)]
#[tauri::command]
pub async fn app_theme(webview: tauri::Webview, theme: String) {
    let theme = look(&theme);
    let [r, g, b] = theme.window;
    let _ = webview.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
    platform::follow(&webview, theme.light).await;
}

#[cfg(target_os = "android")]
mod platform {
    //! `SystemBars.kt`, asked from a thread kept for blocking work, which
    //! redraws the bars on the app's own thread. Nothing is kept for the
    //! next start: Linger opens on The door's navy (`themes.xml`, and the
    //! page's ground in `tauri.android.conf.json`), so `MainActivity.kt`
    //! starts with light icons.

    use jni::objects::JValue;

    use crate::phone_sound::android::{app_class, with_env};

    pub async fn follow(_webview: &tauri::Webview, light: bool) {
        crate::off_thread(move || bars(light), || None).await;
    }

    fn bars(light: bool) -> Option<()> {
        with_env(|env, app| {
            let class = app_class(env, app, "io.github.itsmattguenther.linger.SystemBars")?;
            env.call_static_method(&class, "follow", "(Z)V", &[JValue::Bool(u8::from(light))])
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
    //! Nothing is kept for the next start: an iPhone opens on The door's
    //! navy, its launch screen (`LaunchScreen.storyboard`, Apple allows
    //! one fixed one) and the page's ground before it draws
    //! (`tauri.ios.conf.json`), and starts dark (`UIUserInterfaceStyle` in
    //! `Info.plist`), so its icons are light on it until the page says.

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

    /// A phone opens on The door's navy before its page draws, whatever the
    /// theme: the launch screen, the page's ground, and a start with light
    /// bar icons on it (`app_theme` on a phone). Every copy is The door's.
    #[test]
    fn a_phone_opens_on_the_doors_navy() {
        let [r, g, b] = look("door").window;
        let hex = format!("#{r:02x}{g:02x}{b:02x}");
        for config in [
            include_str!("../tauri.ios.conf.json"),
            include_str!("../tauri.android.conf.json"),
        ] {
            assert!(
                config.contains(&format!("\"backgroundColor\": \"{hex}\"")),
                "a phone's page ground isn't The door's"
            );
        }
        // iPhone: the launch screen, and a dark start.
        let launch = include_str!("../gen/apple/LaunchScreen.storyboard");
        let at = launch
            .find("<color key=\"backgroundColor\"")
            .expect("the launch screen's color");
        let line = &launch[at..at + launch[at..].find("/>").expect("its end")];
        let part = |name: &str| -> f64 {
            let from = line.find(&format!("{name}=\"")).expect(name) + name.len() + 2;
            line[from..from + line[from..].find('"').expect("quote")]
                .parse()
                .expect("a number")
        };
        for (name, byte) in [("red", r), ("green", g), ("blue", b)] {
            assert!(
                (part(name) * 255.0 - f64::from(byte)).abs() < 0.01,
                "the launch screen's {name} isn't The door's"
            );
        }
        assert!(line.contains("customColorSpace=\"sRGB\""));
        let plist = include_str!("../gen/apple/linger-client_iOS/Info.plist");
        let plist: String = plist.split_whitespace().collect();
        assert!(plist.contains("<key>UIUserInterfaceStyle</key><string>Dark</string>"));
        let project = include_str!("../gen/apple/project.yml");
        assert!(project.contains("UIUserInterfaceStyle: Dark"));
        // Android: the starting window and Android 12's launch screen, in
        // light mode and dark, with light bar icons.
        let colors = include_str!("../gen/android/app/src/main/res/values/colors.xml");
        assert!(colors.contains(&format!(
            "<color name=\"door\">#FF{}</color>",
            hex[1..].to_uppercase()
        )));
        for theme in [
            include_str!("../gen/android/app/src/main/res/values/themes.xml"),
            include_str!("../gen/android/app/src/main/res/values-night/themes.xml"),
        ] {
            for item in [
                "<item name=\"android:windowBackground\">@color/door</item>",
                "<item name=\"android:windowSplashScreenBackground\" tools:targetApi=\"31\">@color/door</item>",
                "<item name=\"android:windowLightStatusBar\">false</item>",
            ] {
                assert!(theme.contains(item), "themes.xml lacks {item}");
            }
        }
        let activity = include_str!(
            "../gen/android/app/src/main/java/io/github/itsmattguenther/linger/MainActivity.kt"
        );
        assert!(
            activity
                .contains("SystemBars.draw(this, savedInstanceState != null && SystemBars.last)"),
            "only a rebuilt screen takes the page's last answer; a new one starts light"
        );
        let registered = activity.find("SystemBars.activity = WeakReference(this)");
        let drawn = activity.find("SystemBars.draw(this,");
        assert!(
            registered < drawn,
            "registered before it reads the last answer"
        );
        let bars = include_str!(
            "../gen/android/app/src/main/java/io/github/itsmattguenther/linger/SystemBars.kt"
        );
        assert!(
            bars.contains("var last: Boolean = false"),
            "a cold start's icons are light"
        );
    }

    #[test]
    fn a_theme_it_does_not_know_is_the_door() {
        for stray in ["", "Daylight", "light", "sunrise", "door "] {
            assert_eq!(look(stray), look("door"), "{stray:?}");
        }
        assert_eq!(look("dusk").id, "dusk");
    }
}
