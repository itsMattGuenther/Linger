//! The S3 backend: any S3-compatible endpoint — AWS, Cloudflare R2, Backblaze
//! B2, MinIO (ARCHITECTURE §8).
//!
//! # Why the parts are ordinary objects, not an S3 multipart upload
//!
//! S3 has its own multipart protocol, and the obvious reading of "resumable
//! upload" is to use it. It would be the wrong shape here, for two reasons.
//!
//! The first is that this server has to *look* at every file. Sniffing the real
//! type and re-encoding an image to strip EXIF (SPEC §4.10) both need the bytes
//! on a local disk. Completing an S3 multipart upload would assemble the object
//! inside the bucket, and the very next thing we would do is download it,
//! rewrite it, and upload it again — the whole file over the wire three times.
//!
//! The second is that S3's multipart upload has an id of its own, handed out by
//! a network call, which would have to be stored and looked up on resume. That
//! is exactly the table ARCHITECTURE §8 says an upload does not need. Writing
//! each part to `uploads/{upload_id}/{part}` keeps the local backend's promise:
//! **an upload id is an attachment id**, and the part layout is a pure function
//! of the declared size, so a resumed upload recomputes it rather than asking.
//!
//! So a part is one presigned PUT to its own key, `assemble` streams those keys
//! down into one local file, and the finished object goes up as a single PUT.
//! Files are capped at 500 MB (`linger_core::limits::MAX_FILE_BYTES`), well
//! under S3's 5 GB limit for a single PUT.
//!
//! # What the app server still never does
//!
//! Proxy bytes. The client PUTs at the bucket and reads from the bucket: a
//! download is a redirect to a presigned URL, so the response body never
//! crosses this process. The one exception is `assemble`, which is the server
//! deliberately fetching what it is about to inspect.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use linger_core::wire::{CompletedPart, UploadPart, UploadSlot};
use linger_core::{AttachmentId, UploadId};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use tokio::io::AsyncWriteExt;

use super::{ObjectBody, ObjectStore, ServeAs, Staged};
use crate::config::Config;

/// How long a presigned URL is good for. Matches the local backend: long enough
/// that an upload interrupted overnight can still be resumed in the morning,
/// and well inside SigV4's seven-day ceiling.
const URL_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Presigned URLs the server uses itself are short-lived — they are signed and
/// then used immediately, and never handed to anybody.
const INTERNAL_TTL: Duration = Duration::from_secs(60);

pub struct S3Store {
    bucket: Bucket,
    credentials: Credentials,
    http: reqwest::Client,
    staging: PathBuf,
}

impl S3Store {
    /// Build the client from config. No network call: `rusty_s3` only signs
    /// URLs, so a wrong bucket name is found on first use, not at boot.
    pub fn open(config: &Arc<Config>) -> anyhow::Result<Self> {
        let s3 = config
            .s3
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("LINGER_STORAGE=s3 with no S3 settings"))?;

        let endpoint = s3
            .endpoint
            .parse()
            .map_err(|err| anyhow::anyhow!("LINGER_S3_ENDPOINT is not a URL: {err}"))?;
        let style = if s3.path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(endpoint, style, s3.bucket.clone(), s3.region.clone())?;

        std::fs::create_dir_all(config.staging_dir())?;

        Ok(Self {
            bucket,
            credentials: Credentials::new(s3.access_key_id.clone(), s3.secret_access_key.clone()),
            http: reqwest::Client::builder()
                // Uploading a 500 MB object is not a 30-second request.
                .timeout(Duration::from_secs(15 * 60))
                .build()?,
            staging: config.staging_dir(),
        })
    }

    /// Where one part of an in-flight upload lives until it is assembled.
    fn part_key(upload_id: UploadId, part: u32) -> String {
        format!("uploads/{upload_id}/{part:05}")
    }

    fn part_url(&self, upload_id: UploadId, part: u32) -> String {
        self.bucket
            .put_object(Some(&self.credentials), &Self::part_key(upload_id, part))
            .sign(URL_TTL)
            .to_string()
    }

    fn staging_dir(&self, upload_id: UploadId) -> PathBuf {
        self.staging.join(upload_id.to_string())
    }

    /// PUT a body of known length at a key.
    ///
    /// The length is passed explicitly because S3 refuses a chunked PUT: a
    /// streamed file body has no size of its own, so the header has to carry it.
    ///
    /// `serve` is stored *on the object*, not only signed into the URLs that
    /// read it back. S3 keeps `Content-Type` and `Content-Disposition` as object
    /// metadata and sends them on any GET, so a file reached by some other route
    /// to the bucket — a CDN in front of it, a bucket somebody made public —
    /// still arrives as a download rather than a page (ARCHITECTURE §7).
    async fn put(
        &self,
        key: &str,
        len: u64,
        serve: &ServeAs,
        body: reqwest::Body,
    ) -> anyhow::Result<()> {
        let url = self
            .bucket
            .put_object(Some(&self.credentials), key)
            .sign(INTERNAL_TTL);
        let resp = self
            .http
            .put(url)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .header(reqwest::header::CONTENT_TYPE, &serve.content_type)
            .header(reqwest::header::CONTENT_DISPOSITION, &serve.disposition)
            .body(body)
            .send()
            .await?;
        check(resp, "storing an object").await?;
        Ok(())
    }
}

/// Turn a non-2xx S3 response into an error that says what the bucket said.
///
/// S3's failures arrive as an XML document in the body, and the status alone
/// ("403") is the difference between a wrong key and a wrong clock. Keep it.
async fn check(resp: reqwest::Response, doing: &str) -> anyhow::Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    anyhow::bail!(
        "{doing}: the object store answered {status}: {}",
        body.trim()
    );
}

#[async_trait]
impl ObjectStore for S3Store {
    fn slot(
        &self,
        upload_id: UploadId,
        attachment_id: AttachmentId,
        size_bytes: u64,
    ) -> anyhow::Result<UploadSlot> {
        let (count, part_size) = super::part_plan(size_bytes);
        // Part one is signed once and used twice. Signing it a second time for
        // `url` produced a *different* URL whenever the clock ticked between
        // the two calls — both valid, but not equal, which is a promise this
        // type makes ("url is the first part") and an intermittent test
        // failure nobody could reproduce on purpose.
        let first = self.part_url(upload_id, 1);
        let parts = (count > 1).then(|| {
            (1..=count)
                .map(|number| UploadPart {
                    number,
                    url: if number == 1 {
                        first.clone()
                    } else {
                        self.part_url(upload_id, number)
                    },
                })
                .collect()
        });
        Ok(UploadSlot {
            upload_id,
            attachment_id,
            method: "PUT".to_string(),
            url: first,
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
        let dir = self.staging_dir(upload_id);
        tokio::fs::create_dir_all(&dir).await?;
        let assembled = dir.join("assembled");
        let mut out = tokio::fs::File::create(&assembled).await?;
        let mut size_bytes = 0u64;

        for number in 1..=expected_parts {
            let key = Self::part_key(upload_id, number);
            let url = self
                .bucket
                .get_object(Some(&self.credentials), &key)
                .sign(INTERNAL_TTL);
            let resp = self.http.get(url).send().await?;
            if !resp.status().is_success() {
                anyhow::bail!("part {number} never arrived");
            }
            // The etag the client reports is checked against the one the bucket
            // holds, so a part that arrived corrupted is caught here rather than
            // becoming a broken attachment nobody can open.
            if let Some(claimed) = parts.and_then(|p| p.iter().find(|p| p.number == number)) {
                let actual = resp
                    .headers()
                    .get(reqwest::header::ETAG)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string();
                if !claimed.etag.trim_matches('"').eq_ignore_ascii_case(&actual) {
                    anyhow::bail!("part {number} does not match the etag it was sent with");
                }
            }

            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                size_bytes += chunk.len() as u64;
                out.write_all(&chunk).await?;
            }
        }
        out.sync_all().await?;
        Ok(Staged {
            path: assembled,
            size_bytes,
        })
    }

    async fn put_object(&self, key: &str, from: &Path, serve: &ServeAs) -> anyhow::Result<()> {
        let file = tokio::fs::File::open(from).await?;
        let len = file.metadata().await?.len();
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
        self.put(key, len, serve, body).await?;
        // The local copy was scratch space, not storage. `discard` takes the
        // directory; this takes the file, so a cancelled upload and a finished
        // one both leave nothing behind.
        let _ = tokio::fs::remove_file(from).await;
        Ok(())
    }

    async fn put_bytes(&self, key: &str, bytes: &[u8], serve: &ServeAs) -> anyhow::Result<()> {
        self.put(key, bytes.len() as u64, serve, bytes.to_vec().into())
            .await
    }

    async fn read_object(&self, key: &str, serve: &ServeAs) -> anyhow::Result<Option<ObjectBody>> {
        let mut action = self.bucket.get_object(Some(&self.credentials), key);
        // The download-forcing headers are not this server's to send once the
        // client is talking to the bucket, so they are signed into the URL:
        // S3 echoes these back as the response headers (ARCHITECTURE §7).
        action
            .query_mut()
            .insert("response-content-type", serve.content_type.clone());
        action
            .query_mut()
            .insert("response-content-disposition", serve.disposition.clone());
        Ok(Some(ObjectBody::Redirect(action.sign(URL_TTL).to_string())))
    }

    async fn delete_object(&self, key: &str) -> anyhow::Result<()> {
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), key)
            .sign(INTERNAL_TTL);
        let resp = self.http.delete(url).send().await?;
        check(resp, "deleting an object").await?;
        Ok(())
    }

    async fn discard(&self, upload_id: UploadId) -> anyhow::Result<()> {
        let _ = tokio::fs::remove_dir_all(self.staging_dir(upload_id)).await;

        // Listed rather than counted down from the part plan: `discard` is also
        // what the stale-upload sweep calls, and by then the declared size is
        // gone. Whatever is under the prefix goes.
        let prefix = format!("uploads/{upload_id}/");
        let mut continuation: Option<String> = None;
        loop {
            let mut action = self.bucket.list_objects_v2(Some(&self.credentials));
            action.with_prefix(prefix.clone());
            if let Some(token) = &continuation {
                action.with_continuation_token(token.clone());
            }
            let resp = self.http.get(action.sign(INTERNAL_TTL)).send().await?;
            let body = check(resp, "listing an upload's parts")
                .await?
                .text()
                .await?;
            let listed = rusty_s3::actions::ListObjectsV2::parse_response(&body)?;
            for object in &listed.contents {
                self.delete_object(&object.key).await?;
            }
            continuation = listed.next_continuation_token;
            if continuation.is_none() {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{S3Config, Storage};

    fn store(path_style: bool) -> S3Store {
        let dir = tempfile::tempdir().unwrap();
        let store = S3Store::open(&Arc::new(Config {
            data_dir: dir.path().to_path_buf(),
            bind: "127.0.0.1:0".parse().unwrap(),
            domain: None,
            media_domain: None,
            storage: Storage::S3,
            s3: Some(S3Config {
                bucket: "linger-test".to_string(),
                region: "us-east-1".to_string(),
                endpoint: "https://objects.example".to_string(),
                path_style,
                access_key_id: "key".to_string(),
                secret_access_key: "secret".to_string(),
            }),
            pool_bytes: linger_core::limits::DEFAULT_POOL_BYTES,
            file_expiry_days: Some(linger_core::limits::DEFAULT_FILE_EXPIRY_DAYS),
            turn: None,
            voice_forwarding: None,
        }))
        .unwrap();
        store
    }

    #[test]
    fn a_slot_is_one_presigned_put_per_part() {
        let store = store(true);
        let upload = UploadId::new();
        let attachment = AttachmentId(upload.0);
        let slot = store.slot(upload, attachment, 20 * 1024 * 1024).unwrap();

        let parts = slot.parts.expect("a 20 MB upload is cut into parts");
        assert_eq!(parts.len(), 3);
        assert_eq!(slot.url, parts[0].url, "url is the first part");
        for (index, part) in parts.iter().enumerate() {
            assert_eq!(part.number as usize, index + 1);
            assert!(part.url.starts_with(&format!(
                "https://objects.example/linger-test/uploads/{upload}/"
            )));
            // Signed, and with no credentials for the client to hold.
            assert!(part.url.contains("X-Amz-Signature="));
            assert!(!part.url.contains("secret"));
        }
        assert!(
            store
                .slot(upload, attachment, 1024)
                .unwrap()
                .parts
                .is_none(),
            "a small upload is a single PUT"
        );
    }

    #[test]
    fn virtual_host_style_puts_the_bucket_in_the_hostname() {
        let url = store(false).part_url(UploadId::new(), 1);
        assert!(url.starts_with("https://linger-test.objects.example/uploads/"));
    }

    #[tokio::test]
    async fn a_download_url_carries_the_headers_the_bucket_must_send() {
        let body = store(true)
            .read_object(
                "ab/cd/abcd",
                &ServeAs {
                    content_type: "application/octet-stream".to_string(),
                    disposition: "attachment; filename=\"x.bin\"".to_string(),
                },
            )
            .await
            .unwrap()
            .expect("a redirect");
        let ObjectBody::Redirect(url) = body else {
            panic!("S3 objects are served by redirect");
        };
        assert!(url.contains("response-content-type=application%2Foctet-stream"));
        assert!(url.contains("response-content-disposition=attachment"));
    }
}
