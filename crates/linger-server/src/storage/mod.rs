//! Where uploaded bytes live (ARCHITECTURE §8).
//!
//! **The app server never proxies bytes.** The client is handed a URL and PUTs
//! straight at it; the JSON API only ever sees the paperwork. That is the rule
//! this module exists to keep, and it is why the local backend runs its own
//! listener path outside `/api/v1` instead of accepting a body on an API route.
//!
//! One trait, two backends: `local` (the default — correct for a home server)
//! and `s3` (any S3-compatible endpoint). The seam is drawn so a backend
//! changes only *how* the four operations happen:
//!
//! - hand out a slot: local signs its own URLs, S3 presigns
//! - assemble the parts into one file the server can look at: local
//!   concatenates them off its own disk, S3 downloads them into scratch space
//! - store, read and delete a finished object
//! - throw away the parts of an upload that was cancelled or failed
//!
//! Everything that decides *whether* bytes are acceptable lives in
//! [`crate::media`], not here. This layer moves bytes; it does not judge them.

pub mod local;
pub mod s3;

use std::path::PathBuf;

use async_trait::async_trait;
use linger_core::wire::{CompletedPart, UploadSlot};
use linger_core::{AttachmentId, UploadId};

pub use local::LocalStore;
pub use s3::S3Store;

/// An upload's parts, gathered into one local file so the server can verify the
/// size, sniff the real type and re-encode it. For S3 this is a temp download;
/// for local it is the assembled object itself.
#[derive(Debug)]
pub struct Staged {
    pub path: PathBuf,
    pub size_bytes: u64,
}

/// How to read one stored object back out.
///
/// Local streams the file off disk. S3 hands back a presigned URL to redirect
/// to, so that backend never touches the bytes on the way out either.
pub enum ObjectBody {
    /// A file on this machine, and its length.
    File(PathBuf, u64),
    /// Somewhere else; send the client there.
    Redirect(String),
}

/// The two headers that decide whether a hostile upload can do anything
/// (ARCHITECTURE §7): what this file will be called, and whether a browser is
/// allowed to display it rather than download it.
///
/// They travel with the bytes rather than being a property of one route,
/// because a backend that answers with a redirect cannot set a header on a
/// response it never sends. The local backend's route sets them itself; the S3
/// backend both stores them on the object and signs them into every presigned
/// URL, so the bucket sends the right thing however the object is reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeAs {
    pub content_type: String,
    pub disposition: String,
}

impl ServeAs {
    /// How an object of this type, under this name, may be served.
    ///
    /// Only the image, video and audio types on the `linger-core::media` inline
    /// list keep their own content type. Everything else is
    /// `application/octet-stream` with `Content-Disposition: attachment` —
    /// deliberately refusing to repeat the uploader's claim about what the file
    /// is, because a browser told nothing useful cannot be talked into running
    /// it, and one told to download it never renders it at all.
    #[must_use]
    pub fn for_object(mime: &str, filename: &str) -> Self {
        let inline = linger_core::media::is_inline_mime(mime);
        Self {
            content_type: if inline {
                linger_core::media::canonical_mime(mime).to_string()
            } else {
                "application/octet-stream".to_string()
            },
            disposition: content_disposition(inline, filename),
        }
    }

    /// A generated video poster frame: this server's own JPEG, not the upload.
    #[must_use]
    pub fn poster(filename: &str) -> Self {
        Self::for_object("image/jpeg", &format!("{filename}.jpg"))
    }
}

/// `Content-Disposition`, with the filename twice: a plain ASCII version every
/// browser understands, and the real one percent-encoded for the rest of the
/// alphabet (RFC 6266).
fn content_disposition(inline: bool, filename: &str) -> String {
    let kind = if inline { "inline" } else { "attachment" };
    let ascii: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = filename
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8\'\'{encoded}")
}

#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// Where the client PUTs the bytes of this upload, part by part.
    ///
    /// `part_size_bytes` and the part count are a pure function of the declared
    /// size (see [`part_plan`]), so nothing about the plan has to be persisted:
    /// a resumed upload recomputes the identical layout.
    fn slot(
        &self,
        upload_id: UploadId,
        attachment_id: AttachmentId,
        size_bytes: u64,
    ) -> anyhow::Result<UploadSlot>;

    /// Gather the uploaded parts into one file. Fails if a part is missing or
    /// its etag does not match what actually landed — a half-arrived upload
    /// must not become an attachment.
    async fn assemble(
        &self,
        upload_id: UploadId,
        parts: Option<&[CompletedPart]>,
        expected_parts: u32,
    ) -> anyhow::Result<Staged>;

    /// Move a staged file into place under its permanent key.
    ///
    /// `serve` travels with the object so a backend that can store headers
    /// alongside the bytes does: an object that carries its own
    /// `Content-Disposition` is safe even when it is reached by a URL this
    /// server did not sign.
    async fn put_object(
        &self,
        key: &str,
        from: &std::path::Path,
        serve: &ServeAs,
    ) -> anyhow::Result<()>;

    /// Store a small object the server produced itself (a video poster frame).
    async fn put_bytes(&self, key: &str, bytes: &[u8], serve: &ServeAs) -> anyhow::Result<()>;

    async fn read_object(&self, key: &str, serve: &ServeAs) -> anyhow::Result<Option<ObjectBody>>;

    async fn delete_object(&self, key: &str) -> anyhow::Result<()>;

    /// Drop everything belonging to an upload that will never complete.
    async fn discard(&self, upload_id: UploadId) -> anyhow::Result<()>;
}

/// How many parts an upload of this size is cut into, and how big each is.
///
/// Under the multipart threshold it is one PUT and the client is done. Over it,
/// fixed 8 MB parts — which is the whole resumability story: a connection that
/// dies costs you one part, not the file.
#[must_use]
pub fn part_plan(size_bytes: u64) -> (u32, u64) {
    let part_size = linger_core::limits::MULTIPART_THRESHOLD_BYTES;
    if size_bytes <= part_size {
        return (1, part_size);
    }
    #[allow(clippy::cast_possible_truncation)]
    let count = size_bytes.div_ceil(part_size) as u32;
    (count, part_size)
}

/// The permanent key an attachment's bytes live under.
///
/// Sharded two levels by the first bytes of the id so a server with a hundred
/// thousand files is still a directory a person can `ls`. The id is a UUIDv7
/// with 74 random bits, which is what makes the served URL unguessable.
#[must_use]
pub fn object_key(id: AttachmentId) -> String {
    let hex = id.to_string();
    format!("{}/{}/{}", &hex[0..2], &hex[2..4], hex)
}

/// The key of a video's generated poster frame.
#[must_use]
pub fn poster_key(id: AttachmentId) -> String {
    format!("{}.poster.jpg", object_key(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_files_are_one_put_and_large_ones_are_cut_up() {
        assert_eq!(part_plan(1).0, 1);
        assert_eq!(part_plan(8 * 1024 * 1024).0, 1);
        assert_eq!(part_plan(8 * 1024 * 1024 + 1).0, 2);
        // The milestone check's 400 MB video.
        assert_eq!(part_plan(400 * 1024 * 1024).0, 50);
        assert_eq!(part_plan(500 * 1024 * 1024).0, 63);
    }

    #[test]
    fn only_media_keeps_its_own_content_type() {
        let image = ServeAs::for_object("image/png", "holiday.png");
        assert_eq!(image.content_type, "image/png");
        assert!(image.disposition.starts_with("inline;"));

        // A PDF is a perfectly ordinary file and still never renders in place.
        let doc = ServeAs::for_object("application/pdf", "lease.pdf");
        assert_eq!(doc.content_type, "application/octet-stream");
        assert!(doc.disposition.starts_with("attachment;"));

        // Nothing off the allowlist can be stored, but if a row ever said one
        // of these, serving it must still be inert.
        let hostile = ServeAs::for_object("text/html", "page.html");
        assert_eq!(hostile.content_type, "application/octet-stream");
        assert!(hostile.disposition.starts_with("attachment;"));
    }

    #[test]
    fn a_download_header_cannot_be_talked_into_a_second_line() {
        let header = content_disposition(false, "report \"final\".pdf");
        assert!(header.starts_with("attachment; "));
        assert!(!header.contains('\n') && !header.contains('\r'));
        assert_eq!(header.matches("filename=\"").count(), 1);
        assert!(header.contains("filename=\"report _final_.pdf\""));
    }

    #[test]
    fn non_ascii_names_survive_in_the_encoded_form() {
        let header = content_disposition(true, "na\u{ef}ve.png");
        assert!(header.starts_with("inline; "));
        assert!(header.contains("filename*=UTF-8\'\'na%C3%AFve.png"));
    }

    #[test]
    fn object_keys_shard_and_stay_inside_their_own_tree() {
        let id = AttachmentId::new();
        let key = object_key(id);
        let hex = id.to_string();
        assert_eq!(key, format!("{}/{}/{}", &hex[0..2], &hex[2..4], hex));
        assert!(!key.contains(".."));
        assert!(poster_key(id).ends_with(".poster.jpg"));
    }
}
