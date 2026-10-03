//! What a server accepts as an upload, and how it is allowed to serve it back
//! (PROTOCOL §6, ARCHITECTURE §7/§8).
//!
//! This is a closed vocabulary like [`crate::PALETTE`] and [`crate::FONTS`]: the
//! server validates every declared MIME type against it at slot creation, and
//! again against the *sniffed* type at complete. Two rules shape the lists.
//!
//! First, active content never gets in. `image/svg+xml`, `text/html` and their
//! relatives are scripts wearing a file extension, and the only reliable defence
//! is not to store them at all (ARCHITECTURE §7 "user content is hostile").
//!
//! Second, only the image/video/audio types below are ever served inline. Every
//! other type is handed to the browser as a download with `nosniff`, so a file
//! this list does not recognise cannot become a page.

/// Image types the server takes. Every one of these is re-encoded on upload,
/// which strips EXIF (SPEC §4.10) and neutralises polyglots in the same step.
pub const IMAGE_MIME: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/// Video types. No transcoding in V1 — the server generates a poster frame and
/// a blurhash and stores the bytes as they arrived.
pub const VIDEO_MIME: [&str; 3] = ["video/mp4", "video/webm", "video/quicktime"];

/// Audio types. `audio/webm` is a voice message (#401): Opus in WebM, which
/// every engine Linger runs in plays.
pub const AUDIO_MIME: [&str; 7] = [
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/flac",
    "audio/aac",
    "audio/mp4",
    "audio/webm",
];

/// Everything else a person might reasonably hand a friend: documents and
/// archives. Served as downloads, never inline.
///
/// Executables are deliberately absent. `application/octet-stream` is the
/// catch-all for a format nothing recognises — a project file, a save game —
/// and it is served as a download like the rest of this list.
pub const FILE_MIME: [&str; 20] = [
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/x-rar-compressed",
    "application/x-bzip2",
    "application/x-xz",
    "application/epub+zip",
    "application/json",
    "application/rtf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/octet-stream",
    "text/plain",
    "text/csv",
];

/// The media-grid bucket a type belongs to (PROTOCOL §6 `kind=`).
/// `link` and `pin` are message properties, not upload types, so they are not
/// produced here.
#[must_use]
pub fn kind_of(mime: &str) -> &'static str {
    let mime = canonical_mime(mime);
    if IMAGE_MIME.contains(&mime) {
        "image"
    } else if VIDEO_MIME.contains(&mime) {
        "video"
    } else if AUDIO_MIME.contains(&mime) {
        "audio"
    } else {
        "file"
    }
}

/// Whether this server will store a file of this type at all.
#[must_use]
pub fn is_allowed_mime(mime: &str) -> bool {
    let mime = canonical_mime(mime);
    IMAGE_MIME.contains(&mime)
        || VIDEO_MIME.contains(&mime)
        || AUDIO_MIME.contains(&mime)
        || FILE_MIME.contains(&mime)
}

/// Whether an object of this type may be served with its own content type and
/// shown in place. Everything else gets `Content-Disposition: attachment` and
/// `X-Content-Type-Options: nosniff` (ARCHITECTURE §7).
#[must_use]
pub fn is_inline_mime(mime: &str) -> bool {
    let mime = canonical_mime(mime);
    IMAGE_MIME.contains(&mime) || VIDEO_MIME.contains(&mime) || AUDIO_MIME.contains(&mime)
}

/// One spelling per type. Browsers, phones and magic-byte sniffers disagree
/// about the same format often enough that comparing raw strings would reject
/// perfectly ordinary files — a WAV is `audio/wav` here whatever the uploader
/// or the sniffer called it.
#[must_use]
pub fn canonical_mime(mime: &str) -> &str {
    match mime {
        "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => "audio/wav",
        "audio/x-flac" => "audio/flac",
        "audio/m4a" | "audio/x-m4a" | "audio/mp4a-latm" => "audio/mp4",
        "audio/mp3" | "audio/x-mpeg" => "audio/mpeg",
        "audio/x-aac" => "audio/aac",
        "audio/x-vorbis+ogg" | "audio/opus" => "audio/ogg",
        "image/jpg" => "image/jpeg",
        "video/x-quicktime" => "video/quicktime",
        "application/vnd.rar" | "application/x-rar" => "application/x-rar-compressed",
        "application/x-gzip" => "application/gzip",
        "application/x-zip-compressed" => "application/zip",
        "text/markdown" | "text/x-markdown" | "text/x-log" => "text/plain",
        other => other,
    }
}

/// The usual extension for a stored type, used when re-encoding changes the
/// format out from under a filename (a WebP that came back as a PNG).
#[must_use]
pub fn extension_for(mime: &str) -> Option<&'static str> {
    Some(match canonical_mime(mime) {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_content_is_never_allowed() {
        for hostile in [
            "image/svg+xml",
            "text/html",
            "application/xhtml+xml",
            "text/javascript",
            "application/javascript",
            "application/x-msdownload",
            "application/x-executable",
            "application/vnd.microsoft.portable-executable",
        ] {
            assert!(!is_allowed_mime(hostile), "{hostile} must be refused");
            assert!(!is_inline_mime(hostile), "{hostile} must never go inline");
        }
    }

    #[test]
    fn kinds_bucket_the_way_the_media_grid_expects() {
        assert_eq!(kind_of("image/png"), "image");
        assert_eq!(kind_of("video/mp4"), "video");
        assert_eq!(kind_of("audio/x-wav"), "audio");
        assert_eq!(kind_of("application/pdf"), "file");
        assert_eq!(kind_of("application/x-executable"), "file");
    }

    #[test]
    fn spelling_differences_do_not_reject_ordinary_files() {
        assert!(is_allowed_mime("audio/x-flac"));
        assert!(is_allowed_mime("image/jpg"));
        assert!(is_allowed_mime("application/vnd.rar"));
        assert_eq!(canonical_mime("audio/m4a"), "audio/mp4");
    }

    #[test]
    fn only_media_is_served_in_place() {
        assert!(is_inline_mime("image/gif"));
        assert!(is_inline_mime("video/webm"));
        assert!(!is_inline_mime("application/pdf"));
        assert!(!is_inline_mime("text/plain"));
    }
}
