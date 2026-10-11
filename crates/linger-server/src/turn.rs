//! Short-lived passwords for the voice relay (SPEC §4.14, PROTOCOL §7, T-1403).
//!
//! coturn's "REST API" scheme, which is not a REST API: the relay and this
//! server share one secret, and a password is `HMAC-SHA1(secret, username)`
//! where the username is `<unix expiry>:<who>`. coturn recomputes the HMAC
//! and checks the clock; nothing is stored on either side and nothing is
//! looked up. A member asks on every join and gets a password that dies on
//! its own. The relay carries voice to this server's voice address and
//! nowhere else (deploy/compose.yaml, #501), so a leaked one is a day of
//! sending to this server's voice port, a few relay ports at a time, not a
//! key to anything.
//!
//! SHA-1 is what coturn speaks and nothing here depends on it being a good
//! hash: the secret is long and random and the message is public, so this is
//! a MAC over a timestamp, not a signature anybody has to trust for long.

use base64::Engine as _;
use linger_core::wire::{IceServer, IceServers};
use linger_core::UserId;

use crate::config::TurnConfig;

/// The username coturn expects: when the password stops working, and who
/// it was for. The second half is for the relay's log, and it is the user's
/// opaque id rather than their name because a relay log is not a place a
/// person's name has to be.
#[must_use]
pub fn username(expires_at: u64, user: UserId) -> String {
    format!("{expires_at}:{user}")
}

/// The password for a username, as coturn will compute it.
#[must_use]
pub fn password(secret: &str, username: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret.as_bytes());
    let tag = ring::hmac::sign(&key, username.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(tag.as_ref())
}

/// How often a member's relay username changes (#501). Every ask within the
/// same hour gets the same username, and so the same password, which is what
/// lets coturn's `--user-quota` (deploy/compose.yaml) count a person rather
/// than a request: asking again doesn't buy more relay ports.
pub const NAME_STEP_SECS: u64 = 60 * 60;

/// When a password asked for at `now_unix` stops working: at least `ttl_secs`
/// from now, rounded up to the next [`NAME_STEP_SECS`], so that it's the same
/// moment, and the same username, for every ask within one step.
#[must_use]
pub fn expiry(now_unix: u64, ttl_secs: u64) -> u64 {
    now_unix.saturating_add(ttl_secs).div_ceil(NAME_STEP_SECS) * NAME_STEP_SECS
}

/// Everything a client puts in its peer connections right now.
///
/// One entry carrying every URI, with the credentials on it. STUN ignores
/// them and TURN needs them, and a client that got them as one list hands
/// them on as one list.
#[must_use]
pub fn ice_servers(turn: &TurnConfig, user: UserId, now_unix: u64) -> IceServers {
    let expires_at = expiry(now_unix, turn.ttl_secs);
    let username = username(expires_at, user);
    let credential = password(&turn.secret, &username);
    IceServers {
        servers: vec![IceServer {
            urls: turn.urls.clone(),
            username: Some(username),
            credential: Some(credential),
        }],
        ttl_secs: expires_at - now_unix,
    }
}

/// Seconds since the epoch, by this machine's clock. coturn checks the expiry
/// against its own, so the two hosts have to agree to within the TTL — which
/// is a day, and a box that far off has bigger problems than voice.
#[must_use]
pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "correct horse battery staple";

    /// Computed independently (python: `hmac.new(secret, username, sha1)`,
    /// base64). If this ever disagrees, coturn will refuse every call.
    #[test]
    fn the_password_is_what_coturn_computes() {
        let user: UserId = "01a06dc4aab77c31b33252e025111a76".parse().expect("a uuid");
        let name = username(1_700_003_600, user);
        assert_eq!(name, "1700003600:01a06dc4aab77c31b33252e025111a76");
        assert_eq!(password(SECRET, &name), "RsyZfOxxNUxMkeEW3E6QK5TmlsU=");
    }

    #[test]
    fn a_member_gets_one_entry_with_every_url_and_a_dated_name() {
        let turn = TurnConfig {
            secret: SECRET.into(),
            urls: vec!["stun:r:3478".into(), "turn:r:3478?transport=udp".into()],
            ttl_secs: 3600,
        };
        let user = UserId::new();
        let ice = ice_servers(&turn, user, 1_700_000_000);
        // An hour from now is 1_700_003_600, and the hour after that starts
        // at 1_700_006_400: the password lasts until then.
        assert_eq!(ice.ttl_secs, 6400);
        assert_eq!(ice.servers.len(), 1);
        let server = &ice.servers[0];
        assert_eq!(server.urls, turn.urls);
        assert_eq!(
            server.username.as_deref(),
            Some(format!("1700006400:{user}").as_str())
        );
        let credential = server.credential.as_deref().expect("a credential");
        assert_eq!(
            credential,
            password(SECRET, server.username.as_deref().unwrap())
        );
        // Two members never share a password, because the name is in it.
        let other = ice_servers(&turn, UserId::new(), 1_700_000_000);
        assert_ne!(other.servers[0].credential, server.credential);
    }

    /// The relay's per-person limit only means something if a person has
    /// one name (#501): asking again an instant later, or ten minutes later,
    /// must not mint a fresh username with a fresh allowance of relay ports.
    #[test]
    fn asking_again_within_the_hour_gets_the_same_password() {
        let turn = TurnConfig {
            secret: SECRET.into(),
            urls: vec!["turn:r:3478?transport=udp".into()],
            ttl_secs: 24 * 60 * 60,
        };
        let user = UserId::new();
        // 1_699_999_200 is on the hour.
        let first = ice_servers(&turn, user, 1_699_999_200 + 60);
        let again = ice_servers(&turn, user, 1_699_999_200 + 59 * 60);
        assert_eq!(first.servers, again.servers);
        let next_hour = ice_servers(&turn, user, 1_699_999_200 + 60 * 60 + 1);
        assert_ne!(first.servers, next_hour.servers);
    }

    #[test]
    fn a_password_always_lasts_at_least_its_ttl_and_less_than_an_hour_more() {
        let ttl = 24 * 60 * 60;
        for now in [1_699_999_200, 1_699_999_201, 1_700_000_000, 1_700_002_799] {
            let expires = expiry(now, ttl);
            assert!(expires >= now + ttl, "{now}");
            assert!(expires < now + ttl + NAME_STEP_SECS, "{now}");
            assert_eq!(expires % NAME_STEP_SECS, 0, "{now}");
        }
    }
}
