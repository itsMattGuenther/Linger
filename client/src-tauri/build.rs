/// The app's own commands. Declaring them turns on Tauri's access checks for
/// them: a window can call only what its capability file grants
/// (`capabilities/`), so the chat and Settings windows can't reach the
/// keyring, the connections or voice, which are the list window's alone
/// (docs/design/architecture.md). Every command in `generate_handler!` in
/// `src/lib.rs` must be listed here; `src/acl.rs` tests that.
const COMMANDS: &[&str] = &[
    "sessions_load",
    "session_save",
    "session_forget",
    "gateway_connect",
    "gateway_disconnect",
    "gateway_token",
    "gateway_send",
    "voice_join",
    "voice_leave",
    "voice_frame",
    "voice_controls",
    "voice_volume",
    "voice_devices",
    "show_notification",
    "app_version",
    "update_check",
    "update_install",
    "graphics_started",
    "next_open_chat",
    "next_open_conversation",
    "next_open_settings",
    "next_open_tool",
    "next_close_to_tray",
    "next_tray_voice",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
