//! Visual desktop banners with no second, OS-selected chime.
//! The notification plugin still owns permission; the app sound player owns audio.

use tauri::AppHandle;

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

/// Keep banner delivery off the reactor, and keep sound policy in one player.
#[tauri::command]
pub async fn show_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let identifier = app.config().identifier.clone();
    tokio::task::spawn_blocking(move || {
        let notification = silent_banner(&title, &body);
        #[cfg(target_os = "windows")]
        let notification = {
            let mut notification = notification;
            if !tauri::is_dev() {
                notification.app_id(&identifier);
            }
            notification
        };
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &identifier
        });
        #[cfg(target_os = "linux")]
        let _ = identifier;
        notification
            .show()
            .map(|_| ())
            .map_err(|error| error.to_string())
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
}
