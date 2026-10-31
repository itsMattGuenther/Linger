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
pub mod screen;
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

/// The oldest app release this server works with (#793, PROTOCOL §9), sent as
/// `oldest_app` on `GET /health`. An app older than this doesn't connect to the
/// server: it says so in plain words and offers the update instead of failing
/// in some confusing way. The app decides, from its own version; the server
/// never learns which version anybody runs (hard rule 4).
///
/// It's about what the code can do, so hosts can't change it. It's raised only
/// for a change that leaves older apps behind, with a line in
/// `docs/decisions.md`, and the release before says so in its notes
/// (`docs/releasing.md` says how). A break is rare and chosen (PROTOCOL §9,
/// "Which apps and servers work together"), not something every release does.
///
/// `0.4.1` is the last break there was: voice goes through the server from
/// 0.4.1 on, and an app from before it can't join voice at all (#197, #306).
/// It blocks nothing today, since only apps from the release that ships this
/// field read it, and they're all newer.
///
/// Never newer than the version this is built as
/// (`a_server_works_with_its_own_app`): a server that turned away its own
/// release's app would turn away everybody, and an app built from the same
/// commit couldn't use it either.
pub const OLDEST_APP: &str = "0.4.1";

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

    /// `1.2.3` as three numbers, the only shape the app compares.
    fn release(version: &str) -> Option<(u64, u64, u64)> {
        let mut parts = version.split('.').map(str::parse::<u64>);
        let parsed = (
            parts.next()?.ok()?,
            parts.next()?.ok()?,
            parts.next()?.ok()?,
        );
        parts.next().is_none().then_some(parsed)
    }

    #[test]
    fn a_server_works_with_its_own_app() {
        // A plain release number: anything else, the app ignores (#793), and
        // the block would silently never happen.
        let oldest = release(OLDEST_APP).expect("OLDEST_APP is a plain release number");
        let this = release(env!("CARGO_PKG_VERSION"))
            .expect("the crate's version is a plain release number");
        assert!(
            oldest <= this,
            "OLDEST_APP ({OLDEST_APP}) is newer than this release ({}): its server would turn away its own app. \
             Raise it no further than the version this is built as: bump the version in the same pull request \
             (docs/releasing.md).",
            env!("CARGO_PKG_VERSION"),
        );
    }

    #[test]
    fn vocabularies_are_closed_and_sized() {
        assert_eq!(FONTS.len(), 12);
        assert!(is_valid_font_key("geist-sans"));
        assert!(!is_valid_font_key("comic-sans"));
    }
}
