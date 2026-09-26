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
    "voice_volume",
    "show_notification",
    "next_open_chat",
    "next_open_conversation",
    "next_open_settings",
    "next_open_tool",
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
];

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

/// The app commands each window is granted, as command names.
fn granted() -> Vec<(String, Vec<String>, BTreeSet<String>)> {
    CAPABILITIES
        .iter()
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

#[test]
fn every_registered_command_is_declared_and_nothing_else() {
    let declared = listed(include_str!("../build.rs"), "const COMMANDS: &[&str] = &[");
    let registered = listed(include_str!("lib.rs"), "tauri::generate_handler![");
    assert_eq!(
        declared, registered,
        "build.rs COMMANDS and generate_handler! in lib.rs must name the same commands"
    );
}

#[test]
fn the_list_window_may_call_every_command() {
    let declared = listed(include_str!("../build.rs"), "const COMMANDS: &[&str] = &[");
    let mains: BTreeSet<String> = granted()
        .into_iter()
        .filter(|(_, windows, _)| windows.iter().any(|window| window == "main"))
        .flat_map(|(_, _, commands)| commands)
        .collect();
    assert_eq!(mains, declared);
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
