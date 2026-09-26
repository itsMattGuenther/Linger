//! Server configuration. Environment variables only — a server is configured by
//! its compose file, not a config-file format to document and version.

use std::net::SocketAddr;
use std::path::PathBuf;

use linger_core::limits::{DEFAULT_FILE_EXPIRY_DAYS, DEFAULT_POOL_BYTES, MAX_FILE_BYTES};

/// Where uploaded objects live (ARCHITECTURE §8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Storage {
    /// Filesystem under the data dir. Default; correct for a home server.
    Local,
    /// Any S3-compatible endpoint (R2 recommended for cloud: zero egress).
    S3,
}

/// Everything the S3 backend needs, all of it from the environment.
///
/// There is no default that could work: a bucket nobody named is not a bucket,
/// so `LINGER_STORAGE=s3` without these is a startup error rather than a server
/// that boots and then cannot take a single file.
#[derive(Clone)]
pub struct S3Config {
    /// `LINGER_S3_BUCKET`.
    pub bucket: String,
    /// `LINGER_S3_REGION` — default `us-east-1`, which is also what MinIO
    /// answers to. Cloudflare R2 wants `auto`.
    pub region: String,
    /// `LINGER_S3_ENDPOINT` — the S3 API host. Unset means real AWS, and the
    /// endpoint is derived from the region.
    pub endpoint: String,
    /// `LINGER_S3_PATH_STYLE` — `bucket.host` (virtual-host) or `host/bucket`
    /// (path). Defaults to path style when an endpoint is configured, because
    /// that is what MinIO and every other self-hosted implementation expect,
    /// and to virtual-host on real AWS.
    pub path_style: bool,
    /// `LINGER_S3_ACCESS_KEY_ID`.
    pub access_key_id: String,
    /// `LINGER_S3_SECRET_ACCESS_KEY`.
    pub secret_access_key: String,
}

// The secret is a secret. Debug output of `Config` gets logged, and a key that
// only leaks into a log file is still a key that leaked.
impl std::fmt::Debug for S3Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Config")
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("endpoint", &self.endpoint)
            .field("path_style", &self.path_style)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// `LINGER_DATA_DIR` — holds `linger.db` and `objects/`. Default `./data`.
    pub data_dir: PathBuf,
    /// `LINGER_BIND` — default `0.0.0.0:8420` (the reverse proxy terminates TLS).
    pub bind: SocketAddr,
    /// `LINGER_DOMAIN` — public domain of this server; used in absolute URLs.
    pub domain: Option<String>,
    /// `LINGER_MEDIA_DOMAIN` — the origin uploaded files are served from.
    /// Defaults to `cdn.<LINGER_DOMAIN>`; `None` only when this server has no
    /// domain at all (ARCHITECTURE §7).
    pub media_domain: Option<String>,
    /// `LINGER_STORAGE` — `local` (default) or `s3`.
    pub storage: Storage,
    /// Set iff `storage` is [`Storage::S3`].
    pub s3: Option<S3Config>,
    /// `LINGER_POOL_BYTES` — the storage ceiling for the whole server, default
    /// 50 GB (SPEC §4.10). Accepts a plain byte count or a size like `250GB`.
    pub pool_bytes: u64,
    /// `LINGER_FILE_EXPIRY_DAYS` — how long a file stands before the sweeper
    /// takes it, default 365 (SPEC §4.10). `off` (or `0`) means never, and a
    /// starred or pinned file never expires whatever this says.
    pub file_expiry_days: Option<u32>,
    /// `LINGER_TURN_SECRET` (+ `LINGER_TURN_URLS`) — the voice relay. `None`
    /// means no relay: voice works between machines on one network and nowhere
    /// else, and the server says so at startup (SPEC §4.14, T-1403).
    pub turn: Option<TurnConfig>,
    /// `LINGER_VOICE_ADDRESS` (+ `LINGER_VOICE_BIND`): voice forwarding
    /// (#197). `None` keeps every voice room on the mesh.
    pub voice_forwarding: Option<VoiceForwarding>,
}

/// Where the voice forwarding server listens, and where clients are told to
/// reach it (#197). One UDP port carries every voice connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceForwarding {
    /// `LINGER_VOICE_BIND`, default `0.0.0.0:3479`.
    pub bind: SocketAddr,
    /// `LINGER_VOICE_ADDRESS`: this server's public IP, with the port if it
    /// isn't the bound one (a router forwarding 3479 to another port, say).
    pub public: SocketAddr,
}

/// The UDP port voice forwarding binds when `LINGER_VOICE_BIND` isn't set.
pub const DEFAULT_VOICE_PORT: u16 = 3479;

/// The relay that lets two people on different networks hear each other
/// (SPEC §4.14, T-1403).
///
/// Nothing about a call passes through Linger's server, but two clients
/// behind two home routers cannot find each other without help: a STUN
/// server tells each its public address, and a TURN server carries the
/// packets when even that is not enough (carrier-grade NAT, a strict office
/// network). Both are coturn, run by the host beside this server. The only
/// thing this server does is hand a member a short-lived password for it,
/// computed from `secret` — which coturn also holds — so nothing is stored
/// and nothing is looked up (see `crate::turn`).
#[derive(Clone, PartialEq, Eq)]
pub struct TurnConfig {
    /// Shared with coturn (`static-auth-secret`). Never logged.
    pub secret: String,
    /// The `turn:` / `stun:` URIs a client is told to use.
    pub urls: Vec<String>,
    /// How long a handed-out password stays valid. It is checked when the
    /// relay is allocated and on every refresh, so it has to outlast the
    /// longest call anybody will have.
    pub ttl_secs: u64,
}

// Same reason `S3Config` has one: `Config` is logged, and a relay secret in a
// log file is a relay anybody with the file can use.
impl std::fmt::Debug for TurnConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnConfig")
            .field("secret", &"<redacted>")
            .field("urls", &self.urls)
            .field("ttl_secs", &self.ttl_secs)
            .finish()
    }
}

/// Fewer characters than this is a secret somebody typed rather than
/// generated, guarding a relay that is open to the internet on a well-known
/// port. `openssl rand -hex 32` is 64.
pub const MIN_TURN_SECRET_LEN: usize = 16;

/// A day: longer than any call, short enough that a leaked password is not a
/// standing key to the host's bandwidth.
pub const DEFAULT_TURN_TTL_SECS: u64 = 24 * 60 * 60;

/// Where to point a client on first run — see [`Config::setup_origin`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupOrigin {
    /// The base URL, with no trailing slash.
    pub url: String,
    /// Whether an *installed* desktop client can reach that URL. False means
    /// http, which only a development build is allowed to talk to.
    pub reachable: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("LINGER_BIND is not a valid socket address: {0}")]
    Bind(String),
    #[error("LINGER_VOICE_BIND is not a valid socket address: {0}")]
    VoiceBind(String),
    #[error("LINGER_VOICE_ADDRESS must be this server's public IP address, optionally with a port, got {0:?}")]
    VoiceAddress(String),
    #[error("LINGER_STORAGE must be 'local' or 's3', got {0:?}")]
    Storage(String),
    #[error("LINGER_STORAGE=s3 needs {0} set")]
    S3Missing(&'static str),
    #[error("LINGER_S3_PATH_STYLE must be 'true' or 'false', got {0:?}")]
    S3PathStyle(String),
    #[error("LINGER_MEDIA_DOMAIN is a bare hostname, not a URL: got {0:?}")]
    MediaDomainNotAHost(String),
    #[error(
        "LINGER_POOL_BYTES is {0:?}. It wants a size: a plain number of bytes, or one \
         with a unit on it like 250GB, 500MB or 2TB."
    )]
    PoolBytes(String),
    #[error(
        "LINGER_FILE_EXPIRY_DAYS is {0:?}. It wants a whole number of days, or `off` \
         to keep every file forever."
    )]
    FileExpiryDays(String),
    #[error(
        "LINGER_POOL_BYTES is {0:?}, which is smaller than the 500 MB one file may be. \
         A server that cannot hold a single upload refuses every one of them."
    )]
    PoolTooSmall(String),
    #[error(
        "LINGER_MEDIA_DOMAIN is {0:?}, which is also LINGER_DOMAIN. Uploaded files are \
         served from their own host so a hostile file cannot touch the app (ARCHITECTURE \
         §7); pointing both names at one origin gives that up. Use cdn.{0} — the default \
         if you leave LINGER_MEDIA_DOMAIN unset."
    )]
    MediaDomainIsAppDomain(String),
    #[error(
        "LINGER_TURN_SECRET is shorter than {MIN_TURN_SECRET_LEN} characters. The relay is \
         open to the internet on a well-known port and this is its only lock; generate one \
         with `openssl rand -hex 32` and give the same value to coturn."
    )]
    TurnSecretShort,
    #[error(
        "LINGER_TURN_SECRET is set but there is no LINGER_DOMAIN and no LINGER_TURN_URLS, so \
         there is no address to hand clients for the relay. Set LINGER_DOMAIN (the relay is \
         `turn:<domain>:3478` by default) or list the URIs in LINGER_TURN_URLS."
    )]
    TurnUrlsUnknown,
    #[error("LINGER_TURN_URLS has an entry that is not a turn:, turns: or stun: URI: {0:?}")]
    TurnUrl(String),
    #[error("LINGER_TURN_URLS is set but LINGER_TURN_SECRET is not; a relay needs both")]
    TurnSecretMissing,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let data_dir = std::env::var("LINGER_DATA_DIR")
            .map_or_else(|_| PathBuf::from("./data"), PathBuf::from);

        let bind_raw = std::env::var("LINGER_BIND").unwrap_or_else(|_| "0.0.0.0:8420".to_string());
        let bind = bind_raw
            .parse()
            .map_err(|_| ConfigError::Bind(bind_raw.clone()))?;

        let storage = match std::env::var("LINGER_STORAGE").as_deref() {
            Err(_) | Ok("local") => Storage::Local,
            Ok("s3") => Storage::S3,
            Ok(other) => return Err(ConfigError::Storage(other.to_string())),
        };

        let s3 = match storage {
            Storage::Local => None,
            Storage::S3 => Some(Self::s3_from_env()?),
        };

        let domain = std::env::var("LINGER_DOMAIN").ok();
        let media_domain =
            media_domain(domain.as_deref(), std::env::var("LINGER_MEDIA_DOMAIN").ok())?;

        let turn = turn_config(
            domain.as_deref(),
            std::env::var("LINGER_TURN_SECRET").ok(),
            std::env::var("LINGER_TURN_URLS").ok(),
        )?;

        Ok(Self {
            data_dir,
            bind,
            domain,
            media_domain,
            storage,
            s3,
            pool_bytes: pool_bytes(std::env::var("LINGER_POOL_BYTES").ok())?,
            file_expiry_days: file_expiry_days(std::env::var("LINGER_FILE_EXPIRY_DAYS").ok())?,
            turn,
            voice_forwarding: voice_forwarding(
                std::env::var("LINGER_VOICE_ADDRESS").ok(),
                std::env::var("LINGER_VOICE_BIND").ok(),
            )?,
        })
    }

    fn s3_from_env() -> Result<S3Config, ConfigError> {
        fn required(name: &'static str) -> Result<String, ConfigError> {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or(ConfigError::S3Missing(name))
        }

        let bucket = required("LINGER_S3_BUCKET")?;
        let region = std::env::var("LINGER_S3_REGION").unwrap_or_else(|_| "us-east-1".to_string());
        let endpoint = std::env::var("LINGER_S3_ENDPOINT")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let path_style = match std::env::var("LINGER_S3_PATH_STYLE").as_deref() {
            Ok("true") => true,
            Ok("false") => false,
            Ok(other) => return Err(ConfigError::S3PathStyle(other.to_string())),
            Err(_) => endpoint.is_some(),
        };

        Ok(S3Config {
            bucket,
            region: region.clone(),
            endpoint: endpoint.unwrap_or_else(|| format!("https://s3.{region}.amazonaws.com")),
            path_style,
            access_key_id: required("LINGER_S3_ACCESS_KEY_ID")?,
            secret_access_key: required("LINGER_S3_SECRET_ACCESS_KEY")?,
        })
    }

    /// Path of the one SQLite file that (with `objects/`) is the entire server.
    #[must_use]
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("linger.db")
    }

    /// Root of locally stored uploads.
    #[must_use]
    pub fn objects_dir(&self) -> PathBuf {
        self.data_dir.join("objects")
    }

    /// Scratch space for uploads on their way through.
    ///
    /// Even with S3, an upload has to touch this disk once: the server cannot
    /// sniff a type or strip EXIF from bytes it has never seen. Parts are
    /// gathered here, cleaned in place, and pushed to the bucket, and nothing
    /// is left behind afterwards.
    #[must_use]
    pub fn staging_dir(&self) -> PathBuf {
        self.data_dir.join("staging")
    }

    /// Where this server is reachable from outside, for URLs it hands the
    /// client (upload slots, attachment links).
    ///
    /// A configured `LINGER_DOMAIN` means the documented deployment has Caddy
    /// terminating TLS in front (ARCHITECTURE §9), so it is `https`. Without
    /// one we are a bare bind address with no name and no certificate, and the
    /// only honest answer is a root-relative URL the client resolves against
    /// whatever address it reached us on.
    #[must_use]
    pub fn public_origin(&self) -> String {
        match &self.domain {
            Some(domain) => format!("https://{domain}"),
            None => String::new(),
        }
    }

    /// Where uploaded files are served from — a different host from the app
    /// (ARCHITECTURE §7 "user content is hostile").
    ///
    /// An upload is somebody else's bytes. Served from the app's own origin it
    /// would be same-origin with the app; served from `cdn.<domain>` it is a
    /// stranger, and a stranger is what it is. `/objects` answers on this host
    /// and nowhere else, and the rest of the server answers everywhere else —
    /// see `routes::media_origin_gate`.
    ///
    /// A server with no `LINGER_DOMAIN` has no second name to use, so it falls
    /// back to the one origin it has. That is honest for a box on a LAN and it
    /// is what every test server runs as; the split needs DNS.
    #[must_use]
    pub fn media_origin(&self) -> String {
        match &self.media_domain {
            Some(domain) => format!("https://{domain}"),
            None => self.public_origin(),
        }
    }

    /// The address to print on first run, and whether an installed client can
    /// actually reach it.
    ///
    /// These are two separate facts because they disagree exactly when it
    /// matters. A shipped desktop build's content-security policy allows
    /// `https` and nothing else, so a server with no `LINGER_DOMAIN` — no
    /// name, no certificate — is unreachable from every installed copy, even
    /// though the server itself runs fine and every test server runs this way.
    /// Printing a link that cannot work, with nothing said about it, is how a
    /// host spends an evening on a problem the server already knew about.
    ///
    /// With no domain the address is `localhost` rather than the bind address:
    /// `0.0.0.0` means "listen on everything" and is not somewhere anybody can
    /// visit, and a development build on the same machine is the one client
    /// that *can* reach a plain-http server. A bind address with a real IP in
    /// it was chosen deliberately, so it is left alone.
    #[must_use]
    pub fn setup_origin(&self) -> SetupOrigin {
        match &self.domain {
            Some(domain) => SetupOrigin {
                url: format!("https://{domain}"),
                reachable: true,
            },
            None => {
                let host = if self.bind.ip().is_unspecified() {
                    format!("localhost:{}", self.bind.port())
                } else {
                    self.bind.to_string()
                };
                SetupOrigin {
                    url: format!("http://{host}"),
                    reachable: false,
                }
            }
        }
    }

    /// The hostname `/objects` is served on, when it is a host of its own.
    #[must_use]
    pub fn media_host(&self) -> Option<&str> {
        self.media_domain.as_deref()
    }

    /// The URL an uploaded object is served from.
    #[must_use]
    pub fn object_url(&self, key: &str) -> String {
        format!("{}/objects/{key}", self.media_origin())
    }
}

/// Read `LINGER_POOL_BYTES`: a plain byte count, or a number with a unit on it.
///
/// The unit is the concession. The default written out is `53687091200`, and a
/// host who wants a quarter of that has to be able to type `250GB` and be
/// right — asking somebody to multiply by 1024 three times to change one
/// number in a compose file is how the number ends up wrong.
///
/// Kept a free function so it can be tested without touching the process
/// environment, which every other test in the workspace is also using.
fn pool_bytes(configured: Option<String>) -> Result<u64, ConfigError> {
    let Some(raw) = configured.filter(|value| !value.trim().is_empty()) else {
        return Ok(DEFAULT_POOL_BYTES);
    };
    let text = raw.trim();
    let upper = text.to_ascii_uppercase();
    // Longest suffix first: `GB` has to win over `B`.
    let (digits, scale) = [
        ("TB", 1u64 << 40),
        ("GB", 1 << 30),
        ("MB", 1 << 20),
        ("KB", 1 << 10),
    ]
    .into_iter()
    .find_map(|(suffix, scale)| upper.strip_suffix(suffix).map(|rest| (rest, scale)))
    .or_else(|| upper.strip_suffix('B').map(|rest| (rest, 1)))
    .unwrap_or((upper.as_str(), 1));

    let count: u64 = digits
        .trim()
        .parse()
        .map_err(|_| ConfigError::PoolBytes(text.to_string()))?;
    let bytes = count
        .checked_mul(scale)
        .ok_or_else(|| ConfigError::PoolBytes(text.to_string()))?;
    // A pool that cannot hold one file is a server that refuses every upload
    // with "storage is full", which reads as a broken server rather than a
    // misconfigured one.
    if bytes < MAX_FILE_BYTES {
        return Err(ConfigError::PoolTooSmall(text.to_string()));
    }
    Ok(bytes)
}

/// Read `LINGER_FILE_EXPIRY_DAYS`: a whole number of days, or off.
///
/// `off` and `0` are the same answer and both are spelled out, because a host
/// turning expiry off should not have to guess which one this build wants.
fn file_expiry_days(configured: Option<String>) -> Result<Option<u32>, ConfigError> {
    let Some(raw) = configured.filter(|value| !value.trim().is_empty()) else {
        return Ok(Some(DEFAULT_FILE_EXPIRY_DAYS));
    };
    let text = raw.trim();
    if text.eq_ignore_ascii_case("off") || text.eq_ignore_ascii_case("never") {
        return Ok(None);
    }
    match text.parse::<u32>() {
        Ok(0) => Ok(None),
        Ok(days) => Ok(Some(days)),
        Err(_) => Err(ConfigError::FileExpiryDays(text.to_string())),
    }
}

/// Work out the media origin's hostname: what was asked for, or `cdn.` in
/// front of the app's domain.
///
/// Kept a free function so it can be tested without touching the process
/// environment, which every other test in the workspace is also using.
fn media_domain(
    domain: Option<&str>,
    configured: Option<String>,
) -> Result<Option<String>, ConfigError> {
    let app = domain.map(|d| d.trim().trim_end_matches('/').to_ascii_lowercase());

    let Some(raw) = configured.filter(|value| !value.trim().is_empty()) else {
        // The default is a subdomain of the app's, because one extra DNS record
        // pointing at the same machine is the whole setup cost.
        return Ok(app.map(|domain| format!("cdn.{domain}")));
    };

    let media = raw.trim().trim_end_matches('/').to_ascii_lowercase();
    // A hostname, not a URL: it is compared against the `Host` header of every
    // request, and `https://cdn.example` never equals a `Host` header.
    if media.contains("://") || media.contains('/') || media.contains(':') {
        return Err(ConfigError::MediaDomainNotAHost(media));
    }
    if app.as_deref() == Some(media.as_str()) {
        return Err(ConfigError::MediaDomainIsAppDomain(media));
    }
    Ok(Some(media))
}

/// The relay's addresses when the host has not listed them: coturn on the
/// server's own name, on the standard port, over UDP and TCP, plus STUN on
/// the same. TCP is there for the networks that eat UDP; it is slower and
/// ICE will not pick it unless it has to.
/// `LINGER_VOICE_ADDRESS` and `LINGER_VOICE_BIND` into a [`VoiceForwarding`],
/// or `None` when no public address is set. The address has to be an IP:
/// it goes into every offer as the one place clients send voice, and a name
/// would need resolving on every client in a way SDP doesn't allow.
fn voice_forwarding(
    address: Option<String>,
    bind: Option<String>,
) -> Result<Option<VoiceForwarding>, ConfigError> {
    let Some(address) = address.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let bind = match bind.filter(|value| !value.trim().is_empty()) {
        Some(raw) => raw
            .parse()
            .map_err(|_| ConfigError::VoiceBind(raw.clone()))?,
        None => SocketAddr::from(([0, 0, 0, 0], DEFAULT_VOICE_PORT)),
    };
    let address = address.trim();
    let public = match address.parse::<SocketAddr>() {
        Ok(public) => public,
        Err(_) => match address.parse::<std::net::IpAddr>() {
            Ok(ip) => SocketAddr::new(ip, bind.port()),
            Err(_) => return Err(ConfigError::VoiceAddress(address.to_string())),
        },
    };
    if public.ip().is_unspecified() {
        return Err(ConfigError::VoiceAddress(address.to_string()));
    }
    Ok(Some(VoiceForwarding { bind, public }))
}

fn default_turn_urls(domain: &str) -> Vec<String> {
    vec![
        format!("stun:{domain}:3478"),
        format!("turn:{domain}:3478?transport=udp"),
        format!("turn:{domain}:3478?transport=tcp"),
    ]
}

/// `LINGER_TURN_SECRET` and `LINGER_TURN_URLS` into a [`TurnConfig`], or
/// `None` when neither is set.
///
/// Half a relay is refused rather than guessed at: URIs without a secret is a
/// relay nobody can use, and a secret without any address to hand out is a
/// lock with no door. A short secret is refused too — see
/// [`MIN_TURN_SECRET_LEN`].
fn turn_config(
    domain: Option<&str>,
    secret: Option<String>,
    urls: Option<String>,
) -> Result<Option<TurnConfig>, ConfigError> {
    let secret = secret.filter(|value| !value.trim().is_empty());
    let urls = urls.filter(|value| !value.trim().is_empty());
    let Some(secret) = secret else {
        return match urls {
            Some(_) => Err(ConfigError::TurnSecretMissing),
            None => Ok(None),
        };
    };
    if secret.chars().count() < MIN_TURN_SECRET_LEN {
        return Err(ConfigError::TurnSecretShort);
    }
    let urls = match urls {
        Some(list) => {
            let parsed: Vec<String> = list
                .split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect();
            if let Some(bad) = parsed.iter().find(|entry| {
                !(entry.starts_with("turn:")
                    || entry.starts_with("turns:")
                    || entry.starts_with("stun:"))
            }) {
                return Err(ConfigError::TurnUrl(bad.clone()));
            }
            if parsed.is_empty() {
                return Err(ConfigError::TurnUrlsUnknown);
            }
            parsed
        }
        None => match domain {
            Some(domain) => default_turn_urls(domain),
            None => return Err(ConfigError::TurnUrlsUnknown),
        },
    };
    Ok(Some(TurnConfig {
        secret,
        urls,
        ttl_secs: DEFAULT_TURN_TTL_SECS,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "correct horse battery staple";

    #[test]
    fn no_relay_is_none_and_half_a_relay_is_refused() {
        assert_eq!(
            turn_config(Some("linger.example"), None, None).unwrap(),
            None
        );
        assert!(matches!(
            turn_config(Some("linger.example"), None, Some("turn:x:3478".into())),
            Err(ConfigError::TurnSecretMissing)
        ));
        assert!(matches!(
            turn_config(None, Some(SECRET.into()), None),
            Err(ConfigError::TurnUrlsUnknown)
        ));
        assert!(matches!(
            turn_config(Some("linger.example"), Some("short".into()), None),
            Err(ConfigError::TurnSecretShort)
        ));
    }

    #[test]
    fn a_domain_alone_gives_the_standard_relay_addresses() {
        let turn = turn_config(Some("linger.example"), Some(SECRET.into()), None)
            .unwrap()
            .unwrap();
        assert_eq!(
            turn.urls,
            vec![
                "stun:linger.example:3478",
                "turn:linger.example:3478?transport=udp",
                "turn:linger.example:3478?transport=tcp",
            ]
        );
        assert_eq!(turn.ttl_secs, DEFAULT_TURN_TTL_SECS);
        assert_eq!(turn.secret, SECRET);
    }

    #[test]
    fn listed_urls_win_and_are_checked() {
        let turn = turn_config(
            Some("linger.example"),
            Some(SECRET.into()),
            Some(" turns:relay.example:5349 , stun:relay.example:3478 ".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            turn.urls,
            vec!["turns:relay.example:5349", "stun:relay.example:3478"]
        );
        assert!(matches!(
            turn_config(
                None,
                Some(SECRET.into()),
                Some("https://relay.example".into())
            ),
            Err(ConfigError::TurnUrl(_))
        ));
    }

    #[test]
    fn the_secret_never_reaches_a_log_line() {
        let turn = turn_config(Some("linger.example"), Some(SECRET.into()), None)
            .unwrap()
            .unwrap();
        let shown = format!("{turn:?}");
        assert!(!shown.contains(SECRET));
        assert!(shown.contains("<redacted>"));
    }

    fn config(domain: Option<&str>, media: Option<&str>) -> Config {
        Config {
            data_dir: PathBuf::from("/tmp/linger"),
            bind: "0.0.0.0:8420".parse().unwrap(),
            domain: domain.map(str::to_string),
            media_domain: media_domain(domain, media.map(str::to_string)).unwrap(),
            storage: Storage::Local,
            s3: None,
            pool_bytes: DEFAULT_POOL_BYTES,
            file_expiry_days: Some(DEFAULT_FILE_EXPIRY_DAYS),
            turn: None,
            voice_forwarding: None,
        }
    }

    #[test]
    fn a_domain_prints_an_address_an_installed_client_can_reach() {
        let origin = config(Some("linger.example"), None).setup_origin();
        assert_eq!(origin.url, "https://linger.example");
        assert!(origin.reachable);
    }

    #[test]
    fn no_domain_prints_localhost_rather_than_the_bind_address() {
        // `0.0.0.0` means "listen on everything" and is not somewhere anybody
        // can visit, so printing it sends a host looking for a problem in the
        // wrong place. A development build on this machine can reach
        // localhost, and it is the only client that can reach plain http.
        let origin = config(None, None).setup_origin();
        assert_eq!(origin.url, "http://localhost:8420");
        assert!(!origin.reachable);
    }

    #[test]
    fn a_bind_address_somebody_chose_is_left_alone() {
        let mut config = config(None, None);
        config.bind = "192.168.1.50:9000".parse().unwrap();
        let origin = config.setup_origin();
        assert_eq!(origin.url, "http://192.168.1.50:9000");
        assert!(!origin.reachable);
    }

    #[test]
    fn files_are_served_from_their_own_host_by_default() {
        let config = config(Some("linger.example"), None);
        assert_eq!(config.public_origin(), "https://linger.example");
        assert_eq!(config.media_origin(), "https://cdn.linger.example");
        assert_eq!(
            config.object_url("ab/cd/abcd"),
            "https://cdn.linger.example/objects/ab/cd/abcd"
        );
    }

    #[test]
    fn a_host_can_name_the_media_origin_itself() {
        let config = config(Some("linger.example"), Some("Files.Example "));
        assert_eq!(config.media_host(), Some("files.example"));
        assert_eq!(config.media_origin(), "https://files.example");
    }

    #[test]
    fn a_server_with_no_domain_has_one_origin_and_relative_urls() {
        let config = config(None, None);
        assert_eq!(config.media_host(), None);
        assert_eq!(config.object_url("ab/cd/abcd"), "/objects/ab/cd/abcd");
    }

    #[test]
    fn serving_files_from_the_app_origin_is_refused() {
        let err =
            media_domain(Some("linger.example"), Some("LINGER.example".to_string())).unwrap_err();
        assert!(matches!(err, ConfigError::MediaDomainIsAppDomain(_)));
    }

    #[test]
    fn a_url_where_a_hostname_belongs_is_refused() {
        for wrong in ["https://cdn.linger.example", "cdn.linger.example/files"] {
            assert!(
                matches!(
                    media_domain(Some("linger.example"), Some(wrong.to_string())),
                    Err(ConfigError::MediaDomainNotAHost(_))
                ),
                "{wrong} should not be accepted"
            );
        }
    }

    #[test]
    fn a_pool_size_can_be_written_the_way_a_person_would_write_it() {
        assert_eq!(pool_bytes(None).unwrap(), DEFAULT_POOL_BYTES);
        assert_eq!(
            pool_bytes(Some("  ".to_string())).unwrap(),
            DEFAULT_POOL_BYTES
        );
        assert_eq!(pool_bytes(Some("2TB".to_string())).unwrap(), 2 * (1 << 40));
        assert_eq!(
            pool_bytes(Some("250gb".to_string())).unwrap(),
            250 * (1 << 30)
        );
        assert_eq!(
            pool_bytes(Some("800 MB".to_string())).unwrap(),
            800 * (1 << 20)
        );
        assert_eq!(
            pool_bytes(Some("53687091200".to_string())).unwrap(),
            DEFAULT_POOL_BYTES
        );
    }

    #[test]
    fn a_pool_size_that_is_not_a_size_is_a_startup_error() {
        // The last one overflows the multiply rather than the parse, which is
        // the case a `checked_mul` is there for.
        for wrong in ["fifty gigs", "50 GiB", "-1", "99999999TB"] {
            assert!(
                matches!(
                    pool_bytes(Some(wrong.to_string())),
                    Err(ConfigError::PoolBytes(_))
                ),
                "{wrong:?} should not be accepted"
            );
        }
    }

    #[test]
    fn a_pool_too_small_for_one_file_is_refused() {
        assert!(matches!(
            pool_bytes(Some("100MB".to_string())),
            Err(ConfigError::PoolTooSmall(_))
        ));
    }

    #[test]
    fn expiry_defaults_to_a_year_and_can_be_turned_off() {
        assert_eq!(
            file_expiry_days(None).unwrap(),
            Some(DEFAULT_FILE_EXPIRY_DAYS)
        );
        assert_eq!(file_expiry_days(Some("30".to_string())).unwrap(), Some(30));
        for off in ["off", "OFF", "never", "0"] {
            assert_eq!(
                file_expiry_days(Some(off.to_string())).unwrap(),
                None,
                "{off}"
            );
        }
        assert!(matches!(
            file_expiry_days(Some("a year".to_string())),
            Err(ConfigError::FileExpiryDays(_))
        ));
    }
}
