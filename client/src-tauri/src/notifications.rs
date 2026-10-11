//! Visual desktop banners with no second, OS-selected chime.
//! The notification plugin still owns permission; the app sound player owns audio.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Where a banner leads when it's clicked (decision 20): a conversation, at a
/// message. Opaque here; the list window checks it and opens the chat.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct BannerTarget {
    server: String,
    room: String,
    message: String,
}

/// Banners still waiting to hear whether they're clicked. Each waits on a
/// thread of its own (the notification libraries only offer a blocking wait),
/// and a desktop that keeps banners in a tray until dismissed would otherwise
/// grow one per mention. Past this many, a banner is shown without waiting:
/// clicking it does what the desktop does by default.
const MAX_WAITING: usize = 16;
static WAITING: AtomicUsize = AtomicUsize::new(0);

fn silent_banner(title: &str, body: &str) -> notify_rust::Notification {
    let mut notification = notify_rust::Notification::new();
    notification.appname("Linger").summary(title).body(body);
    // Windows' notify-rust backend sets Toast::sound(None), which requests
    // silent playback. macOS receives no sound name. Linux needs the hint:
    // https://docs.rs/notify-rust/latest/notify_rust/enum.Hint.html
    #[cfg(target_os = "linux")]
    notification
        .icon("linger-client")
        .hint(notify_rust::Hint::SuppressSound(true));
    notification
}

/// A message's words as a freedesktop daemon must be sent them to show them
/// as typed (#489). A daemon that advertises `body-markup` (mako, dunst,
/// GNOME, KDE) reads the body as Pango or HTML markup, so `<b>` in a message
/// would restyle the banner and, on KDE, `<a href>` would become a link.
/// Escaping the three characters markup is made of shows the words as they
/// are. Quotes and apostrophes mean nothing outside a tag, so they're left
/// alone. A daemon without the capability shows the body as it comes, and
/// gets it untouched.
///
/// Only the body: the spec gives the summary no markup, and GNOME, KDE, mako
/// and dunst all show it as plain text, so escaping a title would print
/// `&amp;` in somebody's name. Windows' toast library escapes on its own, and
/// macOS takes plain text.
#[cfg(target_os = "linux")]
fn body_as_typed(body: &str, daemon_reads_markup: bool) -> String {
    if !daemon_reads_markup {
        return body.to_owned();
    }
    let mut escaped = String::with_capacity(body.len());
    for character in body.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// Whether the running daemon reads a banner's body as markup. Asked for
/// every banner, which is one more message on the session bus: mako only
/// says so while its `markup` setting is on, and the person may change that,
/// or their daemon, while Linger runs. A daemon that can't be asked is
/// treated as reading markup, since a stray `&amp;` is better than a message
/// that can restyle the banner.
#[cfg(target_os = "linux")]
fn daemon_reads_markup() -> bool {
    notify_rust::get_capabilities().map_or(true, |capabilities| {
        capabilities
            .iter()
            .any(|capability| capability == "body-markup")
    })
}

/// A freedesktop notification only reports a click on its body when it offers
/// the `default` action. Daemons don't draw it as a button.
#[cfg(target_os = "linux")]
fn clickable(notification: &mut notify_rust::Notification) {
    notification.action("default", "Open");
}

/// Whether the person clicked the banner itself, rather than closing it or it
/// timing out. Windows reports a body click as `Default`; freedesktop reports
/// the `default` action, which notify-rust may pass through by name.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn clicked(response: &notify_rust::NotificationResponse) -> bool {
    match response {
        notify_rust::NotificationResponse::Default => true,
        notify_rust::NotificationResponse::Action(action) => action == "default",
        _ => false,
    }
}

/// Keep banner delivery off the reactor, and keep sound policy in one player.
///
/// With `open`, a click on the banner is handed to the list window as
/// `next:banner`, which opens the conversation there (decision 20). On
/// Windows that works while the banner is on screen; once it has gone to the
/// notification centre, Windows opens Linger rather than telling it.
#[tauri::command]
pub async fn show_notification(
    app: AppHandle,
    title: String,
    body: String,
    open: Option<BannerTarget>,
) -> Result<(), String> {
    let identifier = app.config().identifier.clone();
    tokio::task::spawn_blocking(move || {
        let waits = cfg!(any(target_os = "linux", target_os = "windows"))
            && open.is_some()
            && WAITING.load(Ordering::Relaxed) < MAX_WAITING;
        #[cfg(target_os = "linux")]
        let body = body_as_typed(&body, daemon_reads_markup());
        #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
        let mut notification = silent_banner(&title, &body);
        #[cfg(target_os = "linux")]
        if waits {
            clickable(&mut notification);
        }
        #[cfg(target_os = "windows")]
        if !tauri::is_dev() {
            notification.app_id(&identifier);
        }
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &identifier
        });
        #[cfg(target_os = "linux")]
        let _ = identifier;
        let handle = notification.show().map_err(|error| error.to_string())?;
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if let (true, Some(target)) = (waits, open) {
            WAITING.fetch_add(1, Ordering::Relaxed);
            std::thread::spawn(move || {
                let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                    if clicked(response) {
                        let _ = app.emit_to("main", "next:banner", &target);
                    }
                });
                WAITING.fetch_sub(1, Ordering::Relaxed);
            });
        }
        #[cfg(not(any(target_os = "linux", target_os = "windows")))]
        let _ = (handle, waits, open, app);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn linux_banner_explicitly_suppresses_the_daemons_sound() {
        let banner = silent_banner("a room", "a message");
        assert_eq!(banner.appname, "Linger");
        assert_eq!(banner.icon, "linger-client");
        assert!(banner
            .hints
            .contains(&notify_rust::Hint::SuppressSound(true)));
    }

    #[test]
    fn a_markup_daemon_shows_the_words_as_typed() {
        // mako, dunst, GNOME and KDE read the body as markup: unescaped, the
        // first would turn bold, the second huge, and on KDE the third would
        // become a link to wherever it points (#489).
        let typed = r#"<b>loud</b> & <span size="xx-large">big</span> <a href="file:///home">look</a> &amp;"#;
        assert_eq!(
            body_as_typed(typed, true),
            r#"&lt;b&gt;loud&lt;/b&gt; &amp; &lt;span size="xx-large"&gt;big&lt;/span&gt; &lt;a href="file:///home"&gt;look&lt;/a&gt; &amp;amp;"#
        );
        // Apostrophes and quotes mean nothing outside a tag, so "don't"
        // reaches every daemon as it is.
        assert_eq!(body_as_typed(r#"don't "go""#, true), r#"don't "go""#);
    }

    #[test]
    fn a_daemon_without_markup_gets_the_words_untouched() {
        // It shows the body as it comes, so escaping would print `&amp;`.
        let typed = "<b>loud</b> & clear";
        assert_eq!(body_as_typed(typed, false), typed);
    }

    #[test]
    fn the_title_goes_as_it_is() {
        // The spec gives the summary no markup, and GNOME, KDE, mako and
        // dunst all show it as plain text, so escaping it would print
        // `&amp;` in a name like this one.
        let banner = silent_banner("Tom & Jerry in #general", "hello");
        assert_eq!(banner.summary, "Tom & Jerry in #general");
    }

    #[test]
    fn a_banner_that_leads_somewhere_offers_the_click() {
        let mut banner = silent_banner("a room", "a message");
        assert!(banner.actions.is_empty());
        clickable(&mut banner);
        assert_eq!(
            banner.actions,
            vec!["default".to_owned(), "Open".to_owned()]
        );
    }

    #[test]
    fn only_a_click_on_the_banner_opens_it() {
        use notify_rust::{CloseReason, NotificationResponse};
        assert!(clicked(&NotificationResponse::Default));
        assert!(clicked(&NotificationResponse::Action("default".into())));
        assert!(!clicked(&NotificationResponse::Action("other".into())));
        assert!(!clicked(&NotificationResponse::Closed(
            CloseReason::Dismissed
        )));
        assert!(!clicked(&NotificationResponse::Closed(
            CloseReason::Expired
        )));
    }

    #[test]
    fn the_target_reads_what_the_list_window_sends() {
        let target: BannerTarget =
            serde_json::from_str(r#"{"server":"https://a.example","room":"r-1","message":"m-1"}"#)
                .expect("a target");
        assert_eq!(
            serde_json::to_value(&target).expect("json"),
            serde_json::json!({"server":"https://a.example","room":"r-1","message":"m-1"})
        );
    }
}
