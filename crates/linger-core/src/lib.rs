//! linger-core is the contract.
//!
//! Every type that crosses the client/server boundary is defined here and exported
//! to TypeScript via `ts-rs` (`cargo test -p linger-core` regenerates
//! `client/src/generated/`). The frontend never hand-writes a wire type.
//!
//! This crate also owns the closed vocabularies the server validates against:
//! the 16-color name palette and the curated font set.

pub mod gateway;
pub mod id;
pub mod limits;
pub mod media;
pub mod palette;
pub mod wire;

pub use id::{AttachmentId, EmojiId, ExportId, MessageId, ReportId, RoomId, UploadId, UserId};
pub use palette::PALETTE;

/// The curated bundled font set (SPEC §5.7). `font_key` / `msg_font_key` on the wire
/// must be one of these; the server rejects anything else with `VALIDATION_FAILED`.
/// No arbitrary fonts: remote font URLs are a fingerprinting vector.
pub const FONTS: [&str; 12] = [
    "geist-sans",
    "geist-mono",
    "ibm-plex-sans",
    "ibm-plex-mono",
    "jetbrains-mono",
    "inter",
    "space-grotesk",
    "commit-mono",
    "newsreader",
    "instrument-serif",
    "departure-mono",
    "silkscreen",
];

/// Bundled entrance-sound keys (SPEC §4.1). Provisional until T-903 curates the
/// actual audio; the keys are chosen to match the curation directions so files
/// can land without a contract change. Custom uploads (M4) use object keys and
/// are validated separately.
pub const ENTRANCE_SOUNDS: [&str; 12] = [
    "woodblock",
    "rimshot",
    "brush",
    "marimba",
    "vibraphone",
    "typewriter-ding",
    "latch-click",
    "cassette-clunk",
    "soft-blip",
    "small-chime",
    "screen-door",
    "double-knock",
];

/// Whether `key` names a bundled font.
pub fn is_valid_font_key(key: &str) -> bool {
    FONTS.contains(&key)
}

/// Whether `key` names a bundled entrance sound.
pub fn is_valid_entrance_sound_key(key: &str) -> bool {
    ENTRANCE_SOUNDS.contains(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabularies_are_closed_and_sized() {
        assert_eq!(FONTS.len(), 12);
        assert!(is_valid_font_key("geist-sans"));
        assert!(!is_valid_font_key("comic-sans"));
    }
}
