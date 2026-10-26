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
use futures_util::{Stream, StreamExt};
use linger_core::wire::{CompletedPart, UploadPart, UploadSlot};
use linger_core::{AttachmentId, UploadId};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use tokio::io::{AsyncWrite, AsyncWriteExt};

use super::{ObjectBody, ObjectStore, OversizedPart, ServeAs, Staged};
use crate::config::{Config, S3Config};

/// How long a presigned URL is good for. Matches the local backend: long enough
/// that an upload interrupted overnight can still be resumed in the morning,
/// and well inside SigV4's seven-day ceiling.
///
/// Not shorter for part URLs, although one can still be written to after its
/// upload has finished: the client is handed every part's URL at once and uses
/// them for the whole upload, however slow. A late write holds no more than its
/// part's signed length, nothing reads it, and the bucket lifecycle rule in the
/// host guide deletes `uploads/` after two days (#505).
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
        let (bucket, credentials) = bucket_for(s3, "LINGER_S3_ENDPOINT")?;

        std::fs::create_dir_all(config.staging_dir())?;

        Ok(Self {
            bucket,
            credentials,
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

    /// A presigned PUT for one part, good for a body of exactly `len` bytes.
    ///
    /// Left to itself a presigned URL signs only the host, and the bucket then
    /// takes up to 5 GB on it whatever the upload declared (#505). Signing
    /// `content-length` too makes the bucket refuse any other length as a
    /// signature mismatch, before it stores a byte. The client never sets the
    /// header: a browser sends it from the body, which is a slice of exactly
    /// this length, and it is not a header CORS asks the bucket about.
    fn part_url(&self, upload_id: UploadId, part: u32, len: u64) -> String {
        let key = Self::part_key(upload_id, part);
        let mut action = self.bucket.put_object(Some(&self.credentials), &key);
        action
            .headers_mut()
            .insert("content-length", len.to_string());
        action.sign(URL_TTL).to_string()
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

    /// Every part stored so far under an upload's prefix.
    async fn parts(&self, upload_id: UploadId) -> anyhow::Result<Vec<Listed>> {
        list(
            &self.http,
            &self.bucket,
            &self.credentials,
            &format!("uploads/{upload_id}/"),
            "listing an upload's parts",
        )
        .await
    }
}

type Listed = rusty_s3::actions::list_objects_v2::ListObjectsContent;

/// The bucket a set of S3 settings names, and the keys to it. `endpoint_var`
/// is the setting a bad endpoint is blamed on.
fn bucket_for(s3: &S3Config, endpoint_var: &str) -> anyhow::Result<(Bucket, Credentials)> {
    let endpoint = s3
        .endpoint
        .parse()
        .map_err(|err| anyhow::anyhow!("{endpoint_var} is not a URL: {err}"))?;
    let style = if s3.path_style {
        UrlStyle::Path
    } else {
        UrlStyle::VirtualHost
    };
    let bucket = Bucket::new(endpoint, style, s3.bucket.clone(), s3.region.clone())?;
    Ok((
        bucket,
        Credentials::new(s3.access_key_id.clone(), s3.secret_access_key.clone()),
    ))
}

/// Every object under `prefix`, a page of a thousand at a time.
async fn list(
    http: &reqwest::Client,
    bucket: &Bucket,
    credentials: &Credentials,
    prefix: &str,
    doing: &str,
) -> anyhow::Result<Vec<Listed>> {
    let mut objects = Vec::new();
    let mut continuation: Option<String> = None;
    loop {
        let mut action = bucket.list_objects_v2(Some(credentials));
        action.with_prefix(prefix.to_string());
        if let Some(token) = &continuation {
            action.with_continuation_token(token.clone());
        }
        let resp = http.get(action.sign(INTERNAL_TTL)).send().await?;
        let body = check(resp, doing).await?.text().await?;
        let listed = rusty_s3::actions::ListObjectsV2::parse_response(&body)?;
        objects.extend(listed.contents);
        continuation = listed.next_continuation_token;
        if continuation.is_none() {
            return Ok(objects);
        }
    }
}

/// The bucket the nightly copies of the database also go to (#614,
/// `crate::backup`). Separate from [`S3Store`]: it has its own settings,
/// and it stores, lists and deletes under its prefix and nothing else. A
/// copy is sent whole, as one PUT, and a PUT that fails leaves nothing
/// behind, so a copy in the bucket is always a whole one.
pub struct BackupBucket {
    bucket: Bucket,
    credentials: Credentials,
    http: reqwest::Client,
    prefix: String,
    /// The bucket's name, for the host's Settings to say where copies go.
    pub name: String,
}

/// One copy in the bucket: its name under the prefix, and when the bucket
/// says it arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sent {
    pub name: String,
    pub at: Option<i64>,
}

/// S3 takes one PUT of up to 5 GB. A database bigger than that is past
/// anything a group of friends writes; the copy stays on the machine and the
/// log says why.
const MAX_SINGLE_PUT: u64 = 5 * 1024 * 1024 * 1024;

impl BackupBucket {
    /// No network call, as with [`S3Store::open`]: a wrong name or key shows
    /// at the first copy, in the log and in the host's Settings.
    pub fn open(config: &crate::config::BackupBucketConfig) -> anyhow::Result<Self> {
        let (bucket, credentials) = bucket_for(&config.s3, "LINGER_BACKUP_S3_ENDPOINT")?;
        Ok(Self {
            bucket,
            credentials,
            http: reqwest::Client::builder()
                // A big server's database is minutes of upload on a slow line.
                .timeout(Duration::from_secs(60 * 60))
                .build()?,
            prefix: config.prefix.clone(),
            name: config.s3.bucket.clone(),
        })
    }

    fn key(&self, name: &str) -> String {
        format!("{}{name}", self.prefix)
    }

    /// The copies in the bucket: whatever sits directly under the prefix.
    /// Anything further down (a folder of the host's own) isn't ours.
    pub async fn sent(&self) -> anyhow::Result<Vec<Sent>> {
        let listed = list(
            &self.http,
            &self.bucket,
            &self.credentials,
            &self.prefix,
            "listing the backups in the bucket",
        )
        .await?;
        Ok(listed
            .into_iter()
            .filter_map(|object| {
                let name = object.key.strip_prefix(&self.prefix)?;
                (!name.is_empty() && !name.contains('/')).then(|| Sent {
                    name: name.to_string(),
                    at: last_modified_ms(&object.last_modified),
                })
            })
            .collect())
    }

    /// Send one copy from disk under `name`.
    pub async fn send(&self, name: &str, from: &Path) -> anyhow::Result<()> {
        let file = tokio::fs::File::open(from).await?;
        let len = file.metadata().await?.len();
        if len > MAX_SINGLE_PUT {
            anyhow::bail!(
                "the copy is {len} bytes, more than the 5 GB one upload to a bucket can be"
            );
        }
        let url = self
            .bucket
            .put_object(Some(&self.credentials), &self.key(name))
            .sign(INTERNAL_TTL);
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
        let resp = self
            .http
            .put(url)
            .header(reqwest::header::CONTENT_LENGTH, len)
            .header(reqwest::header::CONTENT_TYPE, "application/vnd.sqlite3")
            .body(body)
            .send()
            .await?;
        check(resp, "sending a backup to the bucket").await?;
        Ok(())
    }

    /// Delete one copy, by its name under the prefix.
    pub async fn drop_copy(&self, name: &str) -> anyhow::Result<()> {
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), &self.key(name))
            .sign(INTERNAL_TTL);
        let resp = self.http.delete(url).send().await?;
        check(resp, "deleting an old backup from the bucket").await?;
        Ok(())
    }
}

/// A listing's `LastModified`, `2026-10-10T21:04:05.000Z`, in Unix ms.
fn last_modified_ms(text: &str) -> Option<i64> {
    text.parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
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

/// Copy one part into the assembled file, stopping the moment it runs past
/// the `planned` bytes it was meant to hold.
///
/// The bytes are counted here, not only the bucket's `Content-Length` checked:
/// this is the one place the server writes what a member sent to its own disk,
/// and a part must not be able to fill that disk whatever a header said (#505).
/// The chunk that crosses the line is never written.
async fn copy_part<S, B, E, W>(
    number: u32,
    planned: u64,
    mut stream: S,
    out: &mut W,
) -> anyhow::Result<u64>
where
    S: Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::error::Error + Send + Sync + 'static,
    W: AsyncWrite + Unpin,
{
    let mut written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let chunk = chunk.as_ref();
        written += chunk.len() as u64;
        if written > planned {
            return Err(OversizedPart {
                part: number,
                planned,
            }
            .into());
        }
        out.write_all(chunk).await?;
    }
    Ok(written)
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
        let url_for = |number: u32| {
            super::part_len(size_bytes, number)
                .map(|len| self.part_url(upload_id, number, len))
                .ok_or_else(|| anyhow::anyhow!("part {number} is not in the plan"))
        };
        // Part one is signed once and used twice. Signing it a second time for
        // `url` produced a *different* URL whenever the clock ticked between
        // the two calls — both valid, but not equal, which is a promise this
        // type makes ("url is the first part") and an intermittent test
        // failure nobody could reproduce on purpose.
        let first = url_for(1)?;
        let parts = if count > 1 {
            Some(
                (1..=count)
                    .map(|number| {
                        Ok(UploadPart {
                            number,
                            url: if number == 1 {
                                first.clone()
                            } else {
                                url_for(number)?
                            },
                        })
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?,
            )
        } else {
            None
        };
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
        declared_bytes: u64,
    ) -> anyhow::Result<Staged> {
        let (expected_parts, _) = super::part_plan(declared_bytes);
        if let Some(parts) = parts {
            if u32::try_from(parts.len()) != Ok(expected_parts) {
                anyhow::bail!("expected {expected_parts} parts, got {}", parts.len());
            }
        }
        let dir = self.staging_dir(upload_id);
        tokio::fs::create_dir_all(&dir).await?;
        let assembled = dir.join("assembled");
        let mut out = tokio::fs::File::create(&assembled).await?;
        let mut size_bytes = 0u64;

        for number in 1..=expected_parts {
            let planned = super::part_len(declared_bytes, number)
                .ok_or_else(|| anyhow::anyhow!("part {number} is not in the plan"))?;
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
            // The bucket says how long the part is before sending any of it,
            // and a part that is too long is refused on that alone.
            if resp.content_length().is_some_and(|len| len > planned) {
                return Err(OversizedPart {
                    part: number,
                    planned,
                }
                .into());
            }
            size_bytes += copy_part(number, planned, resp.bytes_stream(), &mut out).await?;
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

    async fn download(&self, url: &str) -> anyhow::Result<reqwest::Response> {
        check(self.http.get(url).send().await?, "fetching a stored file").await
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
        for part in self.parts(upload_id).await? {
            self.delete_object(&part.key).await?;
        }
        Ok(())
    }

    /// The newest part's `LastModified`. S3 writes it when a part's PUT
    /// finishes, so an 8 MB part counts once it has all arrived; at any speed
    /// an upload could finish at, that is well inside the hour.
    async fn last_received(&self, upload_id: UploadId) -> anyhow::Result<Option<i64>> {
        let mut newest: Option<i64> = None;
        for part in self.parts(upload_id).await? {
            // A time this cannot read counts as now: keeping a reservation a
            // little longer is the safe mistake, and the day-long signatures
            // end it either way (`unsent::CEILING_MS`).
            let at = last_modified_ms(&part.last_modified).unwrap_or_else(crate::db::now_ms);
            newest = newest.max(Some(at));
        }
        Ok(newest)
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
            file_expiry: crate::config::FileExpiry::WhenFull,
            turn: None,
            voice_forwarding: None,
            voice_from_domain: None,
            voice_line_after: std::time::Duration::from_millis(
                linger_core::limits::VOICE_JOIN_LINE_AFTER_MS,
            ),
            presence_grace: std::time::Duration::from_millis(
                linger_core::limits::PRESENCE_GRACE_MS,
            ),
            trusted_proxies: crate::config::TrustedProxies::default(),
            signups_per_hour: Some(linger_core::limits::DEFAULT_SIGNUPS_PER_HOUR),
            password_checks_at_once: crate::auth::DEFAULT_PASSWORD_CHECKS_AT_ONCE,
            backups: true,
            backup_bucket: None,
            screens: true,
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

    /// The bucket refuses a body whose length is not the one signed (#505),
    /// so every part URL has to sign one. Which length is proven against a
    /// real bucket in `tests/s3.rs`: a URL shows that a length was signed,
    /// not what it was.
    #[test]
    fn every_part_url_signs_a_length() {
        let store = store(true);
        let upload = UploadId::new();
        let attachment = AttachmentId(upload.0);

        let single = store.slot(upload, attachment, 1000).unwrap();
        let cut_up = store
            .slot(upload, attachment, 2 * 8 * 1024 * 1024 + 4096)
            .unwrap();
        let urls = std::iter::once(single.url).chain(
            cut_up
                .parts
                .expect("a 16 MB upload is cut into parts")
                .into_iter()
                .map(|part| part.url),
        );
        for url in urls {
            assert!(
                url.contains("X-Amz-SignedHeaders=content-length%3Bhost"),
                "signs only the host: {url}"
            );
        }
    }

    #[test]
    fn virtual_host_style_puts_the_bucket_in_the_hostname() {
        let url = store(false).part_url(UploadId::new(), 1, 1000);
        assert!(url.starts_with("https://linger-test.objects.example/uploads/"));
    }

    /// A part longer than planned stops the copy where it crosses the line,
    /// rather than landing on this server's disk in full first (#505).
    #[tokio::test]
    async fn a_part_past_its_length_stops_where_it_crosses_it() {
        // Far more than planned: a thousand chunks of a kilobyte, where four
        // were planned. Without the cap all of it would be written.
        let chunks = futures_util::stream::iter(
            std::iter::repeat_with(|| Ok::<_, std::io::Error>(vec![7u8; 1024])).take(1000),
        );
        let mut out = Vec::new();
        let err = copy_part(2, 4096, chunks, &mut out)
            .await
            .expect_err("a part four times past its length");
        let oversized = err
            .downcast_ref::<OversizedPart>()
            .expect("the route tells this apart from a missing part");
        assert_eq!((oversized.part, oversized.planned), (2, 4096));
        assert_eq!(
            out.len(),
            4096,
            "nothing past the planned length is written"
        );

        // One byte over is over.
        let chunks = futures_util::stream::iter([
            Ok::<_, std::io::Error>(vec![0u8; 4096]),
            Ok(vec![0u8; 1]),
        ]);
        assert!(copy_part(1, 4096, chunks, &mut Vec::new()).await.is_err());

        // Exactly the plan is fine, and so is less: a short file is the size
        // check's to refuse, after assembly.
        for len in [4096, 100] {
            let chunks = futures_util::stream::iter([Ok::<_, std::io::Error>(vec![0u8; len])]);
            let mut out = Vec::new();
            assert_eq!(
                copy_part(1, 4096, chunks, &mut out).await.unwrap(),
                len as u64
            );
            assert_eq!(out.len(), len);
        }
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

    /// The form AWS, R2 and MinIO all list a part's time in (#503). A time
    /// read wrong would keep every reservation or release a live one.
    #[test]
    fn a_listed_parts_time_is_read_to_the_millisecond() {
        assert_eq!(
            last_modified_ms("2026-10-10T21:04:05.123Z"),
            Some(1_791_666_245_123)
        );
        assert_eq!(last_modified_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(last_modified_ms("yesterday"), None);
    }
}
