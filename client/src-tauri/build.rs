/// The app's own commands. Declaring them turns on Tauri's access checks for
/// them: a window can call only what its capability file grants
/// (`capabilities/`), so the chat and Settings windows can't reach the
/// keyring, the connections or voice, which are the list window's alone
/// (docs/design/architecture.md). Every command in either `generate_handler!`
/// in `src/lib.rs`, the desktop's or the phone's, must be listed here;
/// `src/acl.rs` tests that. `phone_sound_mode`, `phone_buzz` and
/// `phone_call_bar` are the phone's alone (`capabilities/phone.json`), and so is
/// `phone_save`, which only an iPhone uses (#703), and the three `shared_`
/// commands that read files shared to Linger from the phone's share sheet
/// (#785, `shared.rs`).
const COMMANDS: &[&str] = &[
    "sessions_load",
    "session_save",
    "session_forget",
    "gateway_connect",
    "gateway_disconnect",
    "gateway_token",
    "gateway_send",
    "gateway_retry",
    "voice_join",
    "voice_leave",
    "voice_frame",
    "voice_controls",
    "voice_push_to_talk",
    "voice_volume",
    "voice_choose_devices",
    "voice_devices",
    "voice_talk_key",
    "voice_talk_key_reach",
    "sound_play",
    "show_notification",
    "app_version",
    "link_offered",
    "update_check",
    "newest_version",
    "update_install",
    "graphics_started",
    "next_open_conversation",
    "next_open_settings",
    "next_open_tool",
    "next_close_to_tray",
    "next_tray_voice",
    "next_show_list",
    "next_request_attention",
    "autostart_state",
    "autostart_set",
    "clipboard_image",
    "dropped_files",
    "dropped_file",
    "phone_sound_mode",
    "phone_buzz",
    "phone_call_bar",
    "phone_text_scale",
    "phone_save",
    "shared_files",
    "shared_file",
    "shared_done",
    "clip_start",
    "clip_stop",
    "clip_cancel",
    "screen_share_available",
    "screen_watch_available",
    "screen_share_start",
    "screen_share_keyframe",
    "screen_share_want",
    "screen_share_preview",
    "screen_share_stop",
    "screen_sound_available",
    "screen_sound_start",
    "screen_sound_stop",
    "screen_sound_play",
    "screen_sound_volume",
    "screen_sound_end",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
