//! Tests for who may call the app's own commands (build.rs declares them;
//! `capabilities/` grants them per window). The list window, `main`, is the
//! owner (docs/design/architecture.md): it alone holds the sign-ins, the
//! connections, voice, notifications and the opening of other windows. The
//! chat and Settings windows render other people's messages and links, so
//! they are held to what they need.

use std::collections::BTreeSet;

/// Commands only the owner may call, whatever else changes.
const OWNER_ONLY: &[&str] = &[
    "sessions_load",
    "session_save",
    "session_forget",
    "gateway_connect",
    "gateway_disconnect",
    "gateway_token",
    "voice_join",
    "voice_leave",
    "voice_frame",
    "voice_controls",
    "voice_push_to_talk",
    "voice_volume",
    "voice_choose_devices",
    "show_notification",
    "next_open_conversation",
    "next_open_settings",
    "next_open_tool",
    "next_close_to_tray",
    "next_tray_voice",
    "next_request_attention",
];

const CAPABILITIES: &[(&str, &str)] = &[
    ("default.json", include_str!("../capabilities/default.json")),
    ("next.json", include_str!("../capabilities/next.json")),
    (
        "next-chat.json",
        include_str!("../capabilities/next-chat.json"),
    ),
    (
        "next-settings.json",
        include_str!("../capabilities/next-settings.json"),
    ),
    (
        "next-tools.json",
        include_str!("../capabilities/next-tools.json"),
    ),
    ("owner.json", include_str!("../capabilities/owner.json")),
    ("phone.json", include_str!("../capabilities/phone.json")),
];

/// The platforms a desktop capability names, and a phone one. Each file names
/// exactly one of the two sets, so a phone's grants never stand in for a
/// desktop one in these tests, or the other way round.
const DESKTOP: &[&str] = &["linux", "macOS", "windows"];
const PHONE: &[&str] = &["android", "iOS"];

/// Commands a phone never gets (SPEC §4.15): no voice, no notifications, no
/// in-app updates, no other windows, no tray, nothing started at sign-in, no
/// Linux clipboard workaround. Its chimes it does play (`phone_sound.rs`), and
/// it reads its own version (`app_version`), which installs nothing.
fn never_on_a_phone(command: &str) -> bool {
    command.starts_with("voice_")
        || command.starts_with("update_")
        || command.starts_with("next_")
        || command.starts_with("autostart_")
        || matches!(
            command,
            "show_notification" | "newest_version" | "clipboard_image"
        )
}

fn platforms(text: &str) -> Vec<String> {
    let capability: serde_json::Value = serde_json::from_str(text).expect("a capability is JSON");
    capability["platforms"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|platform| platform.as_str().unwrap_or("").to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The quoted names inside the first `[ … ]` after `start`.
fn listed(source: &str, start: &str) -> BTreeSet<String> {
    let from = source.find(start).expect("the list's start") + start.len();
    let body = &source[from..];
    let end = body.find(']').expect("the list's end");
    body[..end]
        .split(',')
        .map(|item| {
            item.trim()
                .trim_matches('"')
                .rsplit("::")
                .next()
                .unwrap_or("")
                .to_string()
        })
        .filter(|name| !name.is_empty())
        .collect()
}

/// The app commands each desktop window is granted, as command names.
fn granted() -> Vec<(String, Vec<String>, BTreeSet<String>)> {
    granted_on(DESKTOP)
}

/// The same, from the files for one set of platforms.
fn granted_on(set: &[&str]) -> Vec<(String, Vec<String>, BTreeSet<String>)> {
    CAPABILITIES
        .iter()
        .filter(|(_, text)| platforms(text) == set)
        .map(|(file, text)| {
            let capability: serde_json::Value =
                serde_json::from_str(text).expect("a capability is JSON");
            let windows = capability["windows"]
                .as_array()
                .expect("windows")
                .iter()
                .map(|window| window.as_str().unwrap_or("").to_string())
                .collect();
            let commands = capability["permissions"]
                .as_array()
                .expect("permissions")
                .iter()
                .filter_map(|permission| permission.as_str())
                .filter_map(|permission| permission.strip_prefix("allow-"))
                .map(|command| command.replace('-', "_"))
                .collect();
            ((*file).to_string(), windows, commands)
        })
        .collect()
}

/// What the desktop registers (`desktop_app`, the first `generate_handler!`).
fn desktop_registered() -> BTreeSet<String> {
    listed(include_str!("lib.rs"), "tauri::generate_handler![")
}

/// What the phone registers (`phone_app`).
fn phone_registered() -> BTreeSet<String> {
    let lib = include_str!("lib.rs");
    listed(
        &lib[lib.find("fn phone_app()").expect("phone_app in lib.rs")..],
        "tauri::generate_handler![",
    )
}

#[test]
fn every_registered_command_is_declared_and_nothing_else() {
    let declared = listed(include_str!("../build.rs"), "const COMMANDS: &[&str] = &[");
    let registered: BTreeSet<String> = desktop_registered()
        .union(&phone_registered())
        .cloned()
        .collect();
    assert_eq!(
        declared, registered,
        "build.rs COMMANDS must name every command either generate_handler! in lib.rs registers, and nothing else"
    );
}

#[test]
fn the_list_window_may_call_every_command() {
    let mains: BTreeSet<String> = granted()
        .into_iter()
        .filter(|(_, windows, _)| windows.iter().any(|window| window == "main"))
        .flat_map(|(_, _, commands)| commands)
        .collect();
    assert_eq!(mains, desktop_registered());
}

#[test]
fn no_other_window_may_touch_the_keyring_the_connections_voice_or_windows() {
    for (file, windows, commands) in granted() {
        if windows.iter().all(|window| window == "main") {
            continue;
        }
        for command in OWNER_ONLY {
            assert!(
                !commands.contains(*command),
                "{file} grants {command} to {windows:?}; only the list window (main) may call it"
            );
        }
    }
}

#[test]
fn only_settings_and_the_list_window_change_what_starts_at_sign_in() {
    // What runs when somebody signs in to their computer is theirs to choose
    // in Settings (#228). A chat, search or media window renders other
    // people's words and has no reason to ask, let alone change it.
    for (file, windows, commands) in granted() {
        if !commands.contains("autostart_set") && !commands.contains("autostart_state") {
            continue;
        }
        assert!(
            windows
                .iter()
                .all(|window| window == "main" || window == "settings"),
            "{file} grants starting at sign-in to {windows:?}"
        );
    }
    let settings: BTreeSet<String> = granted()
        .into_iter()
        .filter(|(_, windows, _)| windows.iter().any(|window| window == "settings"))
        .flat_map(|(_, _, commands)| commands)
        .collect();
    assert!(settings.contains("autostart_state") && settings.contains("autostart_set"));
}

#[test]
fn only_the_chat_windows_and_the_list_window_read_the_clipboard() {
    // What somebody copied is theirs until they paste it (#276). The chat
    // windows ask for an image only when a paste lands in the message box;
    // Settings, Search and Media have no box to paste into.
    for (file, windows, commands) in granted() {
        if !commands.contains("clipboard_image") {
            continue;
        }
        assert!(
            windows
                .iter()
                .all(|window| window == "main" || window == "chat-*"),
            "{file} grants reading the clipboard to {windows:?}"
        );
    }
    let chats: BTreeSet<String> = granted()
        .into_iter()
        .filter(|(_, windows, _)| windows.iter().any(|window| window == "chat-*"))
        .flat_map(|(_, _, commands)| commands)
        .collect();
    assert!(chats.contains("clipboard_image"));
}

#[test]
fn only_the_chat_windows_and_the_list_window_record_a_voice_message() {
    // The microphone is recorded only from a message box (#401): Settings,
    // Search and Media have none, and never get the recorder.
    for (file, windows, commands) in granted() {
        if !["clip_start", "clip_stop", "clip_cancel"]
            .iter()
            .any(|command| commands.contains(*command))
        {
            continue;
        }
        assert!(
            windows
                .iter()
                .all(|window| window == "main" || window == "chat-*"),
            "{file} grants recording to {windows:?}"
        );
    }
    let chats: BTreeSet<String> = granted()
        .into_iter()
        .filter(|(_, windows, _)| windows.iter().any(|window| window == "chat-*"))
        .flat_map(|(_, _, commands)| commands)
        .collect();
    for command in ["clip_start", "clip_stop", "clip_cancel"] {
        assert!(chats.contains(command), "the chat windows can't {command}");
    }
}

#[test]
fn a_capability_for_main_names_no_other_window() {
    // Granting the owner's commands in a file that also names a viewer would
    // hand them to that viewer too.
    for (file, windows, commands) in granted() {
        let owner_commands = commands
            .iter()
            .any(|command| OWNER_ONLY.contains(&command.as_str()));
        if owner_commands {
            assert_eq!(
                windows,
                vec!["main".to_string()],
                "{file} grants owner commands to {windows:?}"
            );
        }
    }
}

#[test]
fn every_capability_file_is_checked_here() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let on_disk: BTreeSet<String> = std::fs::read_dir(dir)
        .expect("the capabilities folder")
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    let checked: BTreeSet<String> = CAPABILITIES
        .iter()
        .map(|(file, _)| (*file).to_string())
        .collect();
    assert_eq!(
        on_disk, checked,
        "add a new capability file to CAPABILITIES in src/acl.rs"
    );
}

#[test]
fn every_capability_file_is_for_the_desktop_or_the_phone() {
    // A file without "platforms" applies everywhere, and a desktop grant
    // would reach the phone with it.
    for (file, text) in CAPABILITIES {
        let named = platforms(text);
        assert!(
            named == DESKTOP || named == PHONE,
            "{file} must name exactly {DESKTOP:?} or {PHONE:?}, not {named:?}"
        );
    }
}

#[test]
fn the_phone_may_call_exactly_what_phone_app_registers() {
    let registered = phone_registered();
    let phone: BTreeSet<String> = granted_on(PHONE)
        .into_iter()
        .flat_map(|(_, _, commands)| commands)
        .collect();
    assert_eq!(phone, registered);
    let declared = listed(include_str!("../build.rs"), "const COMMANDS: &[&str] = &[");
    assert!(
        registered.is_subset(&declared),
        "phone_app registers a command build.rs doesn't declare"
    );
}

#[test]
fn a_phone_gets_no_voice_notifications_updates_or_other_windows() {
    for (file, _, commands) in granted_on(PHONE) {
        for command in &commands {
            assert!(
                !never_on_a_phone(command),
                "{file} grants {command}, which the phone app doesn't have (SPEC §4.15)"
            );
        }
    }
}
