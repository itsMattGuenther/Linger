//! The local backend: uploads land in `data/objects/`, which with `linger.db`
//! is the entire server (ARCHITECTURE §9 "Backup").
//!
//! # Why there is a listener path and not an API route
//!
//! Bytes must never travel through the app routes (ARCHITECTURE §8). With S3
//! that falls out for free: the client PUTs at Amazon. With a filesystem there
//! is no second machine to PUT at, so this backend hands out URLs under
//! `/upload/...` — outside `/api/v1`, no JSON, no `Authorization` header, no
//! session, no database write. A part arrives, gets streamed to disk, and the
//! response is an etag.
//!
//! # Why the URL carries its own authority
//!
//! Each part URL is signed with an HMAC over the upload id, the part number and
//! an expiry. That is what an S3 presigned URL is, and building the local
//! backend the same way means the client does one thing in both deployments:
//! PUT the bytes where you were told, with no credentials attached.
//!
//! The key is kept in the data directory next to the JWT key. It has to
//! survive a restart, or a resumed upload would find every URL it was holding
//! suddenly invalid — which is the exact case resumability exists for.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use futures_util::StreamExt;
use linger_core::wire::{CompletedPart, UploadPart, UploadSlot};
use linger_core::{AttachmentId, UploadId};
use ring::hmac;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::{ObjectBody, ObjectStore, ServeAs, Staged};
use crate::config::Config;
use crate::db::now_ms;

/// How long a signed part URL is good for. Long enough that an upload
/// interrupted overnight can still be resumed in the morning.
const URL_TTL_MS: i64 = 24 * 60 * 60 * 1000;

pub struct LocalStore {
    root: PathBuf,
    key: hmac::Key,
    config: Arc<Config>,
}

impl LocalStore {
    /// Open the object root, generating the URL-signing key on first boot.
    pub fn open(config: Arc<Config>) -> anyhow::Result<Self> {
        let root = config.objects_dir();
        std::fs::create_dir_all(root.join("uploads"))?;

        let key_path = config.data_dir.join("upload_hmac.key");
        let bytes = if key_path.exists() {
            std::fs::read(&key_path)?
        } else {
            let mut fresh = [0u8; 32];
            ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut fresh)
                .map_err(|_| anyhow::anyhow!("upload key generation failed"))?;
            std::fs::write(&key_path, fresh)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600))?;
            }
            fresh.to_vec()
        };

        Ok(Self {
            root,
            key: hmac::Key::new(hmac::HMAC_SHA256, &bytes),
            config,
        })
    }

    fn upload_dir(&self, upload_id: UploadId) -> PathBuf {
        self.root.join("uploads").join(upload_id.to_string())
    }

    fn part_path(&self, upload_id: UploadId, part: u32) -> PathBuf {
        self.upload_dir(upload_id).join(format!("{part:05}.part"))
    }

    fn signed_message(upload_id: UploadId, part: u32, expires_at: i64) -> String {
        format!("{upload_id}:{part}:{expires_at}")
    }

    fn part_url(&self, upload_id: UploadId, part: u32, expires_at: i64) -> String {
        let tag = hmac::sign(
            &self.key,
            Self::signed_message(upload_id, part, expires_at).as_bytes(),
        );
        let sig = hex::encode(tag.as_ref());
        format!(
            "{}/upload/{upload_id}/{part}?exp={expires_at}&sig={sig}",
            self.config.public_origin()
        )
    }

    /// Whether this signature really was issued by this server for this part,
    /// and has not expired. Compared in constant time by `ring`.
    #[must_use]
    pub fn verify_part_url(
        &self,
        upload_id: UploadId,
        part: u32,
        expires_at: i64,
        sig: &str,
    ) -> bool {
        if expires_at <= now_ms() {
            return false;
        }
        let Ok(sig) = hex::decode(sig) else {
            return false;
        };
        hmac::verify(
            &self.key,
            Self::signed_message(upload_id, part, expires_at).as_bytes(),
            &sig,
        )
        .is_ok()
    }

    /// Stream one part to disk and return its etag (sha256 of the bytes).
    ///
    /// The body is written to a temp file and renamed only once it is whole, so
    /// a connection that dies halfway leaves no part behind that `assemble`
    /// could mistake for a finished one. Re-PUTting a part you already sent is
    /// allowed and simply overwrites it — that is what resuming looks like.
    pub async fn write_part(
        &self,
        upload_id: UploadId,
        part: u32,
        max_bytes: u64,
        body: Body,
    ) -> Result<String, PartError> {
        let dir = self.upload_dir(upload_id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(PartError::Io)?;
        let temp = dir.join(format!("{part:05}.part.incoming"));

        let mut file = tokio::fs::File::create(&temp)
            .await
            .map_err(PartError::Io)?;
        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        let mut stream = body.into_data_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(err) => {
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(PartError::Aborted(err.to_string()));
                }
            };
            written += chunk.len() as u64;
            if written > max_bytes {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(PartError::TooLarge);
            }
            hasher.update(&chunk);
            if let Err(err) = file.write_all(&chunk).await {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(PartError::Io(err));
            }
        }
        file.sync_all().await.map_err(PartError::Io)?;
        drop(file);
        tokio::fs::rename(&temp, self.part_path(upload_id, part))
            .await
            .map_err(PartError::Io)?;

        Ok(hex::encode(hasher.finalize()))
    }

    /// Reject anything that is not a key this server minted, before it reaches
    /// the filesystem. Path traversal dies here.
    fn object_path(&self, key: &str) -> Option<PathBuf> {
        let shaped = !key.is_empty()
            && key.len() <= 128
            && !key.starts_with('/')
            && !key.contains("..")
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'-' | b'_'));
        if !shaped {
            return None;
        }
        Some(self.root.join(key))
    }
}

/// Why one part did not land. Kept separate from `ApiError` so the storage
/// layer stays free of HTTP.
#[derive(Debug, thiserror::Error)]
pub enum PartError {
    #[error("part is larger than the slot allows")]
    TooLarge,
    #[error("the connection went away: {0}")]
    Aborted(String),
    #[error(transparent)]
    Io(std::io::Error),
}

#[async_trait]
impl ObjectStore for LocalStore {
    fn slot(
        &self,
        upload_id: UploadId,
        attachment_id: AttachmentId,
        size_bytes: u64,
    ) -> anyhow::Result<UploadSlot> {
        let (count, part_size) = super::part_plan(size_bytes);
        let expires_at = now_ms() + URL_TTL_MS;
        let parts = (count > 1).then(|| {
            (1..=count)
                .map(|number| UploadPart {
                    number,
                    url: self.part_url(upload_id, number, expires_at),
                })
                .collect()
        });
        Ok(UploadSlot {
            upload_id,
            attachment_id,
            method: "PUT".to_string(),
            url: self.part_url(upload_id, 1, expires_at),
            headers: std::collections::HashMap::new(),
            part_size_bytes: part_size,
            parts,
        })
    }

    async fn assemble(
        &self,
        upload_id: UploadId,
        parts: Option<&[CompletedPart]>,
        expected_parts: u32,
    ) -> anyhow::Result<Staged> {
        if let Some(parts) = parts {
            if parts.len() as u32 != expected_parts {
                anyhow::bail!("expected {expected_parts} parts, got {}", parts.len());
            }
        }
        let dir = self.upload_dir(upload_id);
        let assembled = dir.join("assembled");
        let mut out = tokio::fs::File::create(&assembled).await?;
        let mut size_bytes = 0u64;

        for number in 1..=expected_parts {
            let path = self.part_path(upload_id, number);
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| anyhow::anyhow!("part {number} never arrived"))?;
            // The etag is checked against what is actually on disk, so a part
            // that arrived corrupted is caught here rather than becoming a
            // broken attachment nobody can open.
            if let Some(claimed) = parts.and_then(|p| p.iter().find(|p| p.number == number)) {
                let actual = hex::encode(Sha256::digest(&bytes));
                if !claimed.etag.trim_matches('"').eq_ignore_ascii_case(&actual) {
                    anyhow::bail!("part {number} does not match the etag it was sent with");
                }
            }
            size_bytes += bytes.len() as u64;
            out.write_all(&bytes).await?;
        }
        out.sync_all().await?;
        Ok(Staged {
            path: assembled,
            size_bytes,
        })
    }

    async fn put_object(&self, key: &str, from: &Path, _serve: &ServeAs) -> anyhow::Result<()> {
        let dest = self
            .object_path(key)
            .ok_or_else(|| anyhow::anyhow!("refusing to write object key {key:?}"))?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Rename first: same filesystem in the normal case, and atomic. Falls
        // back to a copy when the data dir spans mounts.
        if tokio::fs::rename(from, &dest).await.is_err() {
            tokio::fs::copy(from, &dest).await?;
            let _ = tokio::fs::remove_file(from).await;
        }
        Ok(())
    }

    async fn put_bytes(&self, key: &str, bytes: &[u8], _serve: &ServeAs) -> anyhow::Result<()> {
        let dest = self
            .object_path(key)
            .ok_or_else(|| anyhow::anyhow!("refusing to write object key {key:?}"))?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(dest, bytes).await?;
        Ok(())
    }

    /// `serve` is ignored: this backend answers with the bytes, so the route
    /// that worked those headers out is the thing that sends them.
    async fn read_object(&self, key: &str, _serve: &ServeAs) -> anyhow::Result<Option<ObjectBody>> {
        let Some(path) = self.object_path(key) else {
            return Ok(None);
        };
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => Ok(Some(ObjectBody::File(path, meta.len()))),
            _ => Ok(None),
        }
    }

    async fn delete_object(&self, key: &str) -> anyhow::Result<()> {
        if let Some(path) = self.object_path(key) {
            let _ = tokio::fs::remove_file(path).await;
        }
        Ok(())
    }

    async fn discard(&self, upload_id: UploadId) -> anyhow::Result<()> {
        let _ = tokio::fs::remove_dir_all(self.upload_dir(upload_id)).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Storage;

    fn store(dir: &Path) -> LocalStore {
        LocalStore::open(Arc::new(Config {
            data_dir: dir.to_path_buf(),
            bind: "127.0.0.1:0".parse().unwrap(),
            domain: None,
            media_domain: None,
            storage: Storage::Local,
            s3: None,
            pool_bytes: linger_core::limits::DEFAULT_POOL_BYTES,
            file_expiry_days: Some(linger_core::limits::DEFAULT_FILE_EXPIRY_DAYS),
            turn: None,
            voice_forwarding: None,
        }))
        .unwrap()
    }

    #[test]
    fn a_signature_is_good_for_exactly_one_part_of_one_upload() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let upload = UploadId::new();
        let other = UploadId::new();
        let exp = now_ms() + 60_000;
        let url = store.part_url(upload, 3, exp);
        let sig = url.split("sig=").nth(1).unwrap().to_string();

        assert!(store.verify_part_url(upload, 3, exp, &sig));
        assert!(
            !store.verify_part_url(upload, 4, exp, &sig),
            "part is signed"
        );
        assert!(
            !store.verify_part_url(other, 3, exp, &sig),
            "upload is signed"
        );
        assert!(
            !store.verify_part_url(upload, 3, exp + 1, &sig),
            "expiry is signed"
        );
        assert!(
            !store.verify_part_url(upload, 3, now_ms() - 1, &sig),
            "expired"
        );
        assert!(!store.verify_part_url(upload, 3, exp, "not-hex"));
    }

    #[test]
    fn the_signing_key_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let upload = UploadId::new();
        let exp = now_ms() + 60_000;
        let sig = {
            let first = store(dir.path());
            first
                .part_url(upload, 1, exp)
                .split("sig=")
                .nth(1)
                .unwrap()
                .to_string()
        };
        assert!(store(dir.path()).verify_part_url(upload, 1, exp, &sig));
    }

    #[test]
    fn object_keys_cannot_climb_out_of_the_object_root() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        assert!(store.object_path("ab/cd/abcd").is_some());
        assert!(store.object_path("../linger.db").is_none());
        assert!(store.object_path("ab/../../linger.db").is_none());
        assert!(store.object_path("/etc/passwd").is_none());
        assert!(store.object_path("ab/cd/abcd.poster.jpg").is_some());
        assert!(store.object_path("ab/cd/ef;rm -rf").is_none());
    }
}
