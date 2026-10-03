//! Where the client keeps its long-lived secrets.
//!
//! A refresh token is the only credential on this machine worth stealing, so
//! they live in the OS keyring (Keychain, Credential Manager, Secret Service)
//! and never touch a file of ours.
//!
//! Since T-412 the client can be signed into several servers at once, so there
//! is **one keyring entry per server** plus a small index listing which servers
//! we have. Signing out of one deletes that one entry and drops it from the
//! index; the others are not touched. Keyrings cannot be enumerated, which is
//! the only reason the index exists.
//!
//! ARCHITECTURE §7.3 requires the no-wallet case to be handled explicitly: a
//! headless Linux box, or a session where KWallet/gnome-keyring is locked or
//! absent, must degrade to a clear "sign in again" prompt instead of a crash.
//! That is why nothing here returns `Err` — every outcome, including "this
//! computer has no keyring", is a value the frontend can render.
//!
//! The phone app has no keyring crate behind it yet (T-1602): phones keep
//! secrets in their own stores, Keychain on iPhone and the Android Keystore.
//! Until it does, it takes the no-wallet path above, so a phone asks for a
//! sign-in each time the app starts, and nothing is written anywhere.

#[cfg(desktop)]
use keyring::Entry;
use serde::{Deserialize, Serialize};

/// Keyring service name. Matches the bundle identifier so entries are
/// recognisable in Seahorse / KWalletManager / Keychain Access.
#[cfg(desktop)]
const SERVICE: &str = "com.linger.desktop";

/// Namespace every account name is built from. A parameter rather than a
/// constant so tests can write to accounts that can never collide with a real
/// sign-in.
const NS: &str = "session";

/// The account holding the list of servers, oldest first.
fn index_account(ns: &str) -> String {
    format!("{ns}-servers")
}

/// The account holding one server's session.
fn server_account(ns: &str, base_url: &str) -> String {
    format!("{ns}-server:{base_url}")
}

/// What single-server builds wrote, before T-412. Read once and migrated.
fn legacy_account(ns: &str) -> String {
    ns.to_string()
}

/// What a cold start needs to get back to a signed-in state: which server, and
/// the refresh token to trade for a fresh access token.
///
/// The access token is deliberately not stored. It expires in 15 minutes, so
/// keeping it would buy almost nothing and would widen what a stolen keyring
/// entry is worth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredSession {
    /// Origin of the server, e.g. `https://linger.example`. No trailing slash.
    pub base_url: String,
    pub refresh_token: String,
}

/// Result of reading the stored sessions. `Unavailable` is the no-wallet path
/// and is a normal, expected answer — not an error.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionsLoad {
    /// At least one server, in the order they were added.
    Found {
        sessions: Vec<StoredSession>,
    },
    Empty,
    Unavailable {
        reason: String,
    },
}

/// Result of writing or forgetting one server's session.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionWrite {
    Done,
    Unavailable { reason: String },
}

/// Turn a keyring failure into something a person can act on. The underlying
/// messages are D-Bus and platform jargon, so they go in parentheses after a
/// plain sentence rather than being shown raw.
#[cfg(desktop)]
fn explain(err: &keyring::Error) -> String {
    format!("No usable keyring on this computer ({err}).")
}

/// One account's contents. `Missing` and `Unavailable` are different answers:
/// the first means the keyring works and has nothing, the second means we could
/// not ask.
// A phone only ever answers `Unavailable` until T-1602 gives it a store.
#[cfg_attr(mobile, allow(dead_code))]
enum Held {
    Found(String),
    Missing,
    Unavailable(String),
}

#[cfg(desktop)]
fn read(account: &str) -> Held {
    let entry = match Entry::new(SERVICE, account) {
        Ok(entry) => entry,
        Err(err) => return Held::Unavailable(explain(&err)),
    };
    match entry.get_password() {
        Ok(value) => Held::Found(value),
        Err(keyring::Error::NoEntry) => Held::Missing,
        Err(err) => Held::Unavailable(explain(&err)),
    }
}

#[cfg(desktop)]
fn write(account: &str, value: &str) -> SessionWrite {
    let entry = match Entry::new(SERVICE, account) {
        Ok(entry) => entry,
        Err(err) => {
            return SessionWrite::Unavailable {
                reason: explain(&err),
            }
        }
    };
    match entry.set_password(value) {
        Ok(()) => SessionWrite::Done,
        Err(err) => SessionWrite::Unavailable {
            reason: explain(&err),
        },
    }
}

#[cfg(desktop)]
fn delete(account: &str) -> SessionWrite {
    let entry = match Entry::new(SERVICE, account) {
        Ok(entry) => entry,
        Err(err) => {
            return SessionWrite::Unavailable {
                reason: explain(&err),
            }
        }
    };
    match entry.delete_credential() {
        // Deleting nothing is a success: the caller wanted no stored session
        // and there is none.
        Ok(()) | Err(keyring::Error::NoEntry) => SessionWrite::Done,
        Err(err) => SessionWrite::Unavailable {
            reason: explain(&err),
        },
    }
}

/// Why a phone can't keep a sign-in yet, in the words the app shows.
#[cfg(mobile)]
const NOT_ON_PHONES: &str = "Linger can't remember sign-ins on a phone yet.";

#[cfg(mobile)]
fn read(_account: &str) -> Held {
    Held::Unavailable(NOT_ON_PHONES.to_string())
}

#[cfg(mobile)]
fn write(_account: &str, _value: &str) -> SessionWrite {
    SessionWrite::Unavailable {
        reason: NOT_ON_PHONES.to_string(),
    }
}

#[cfg(mobile)]
fn delete(_account: &str) -> SessionWrite {
    // Nothing was stored, so there is nothing to forget.
    SessionWrite::Done
}

/// The server list, or an empty one if it is missing or unreadable.
fn index(ns: &str) -> Vec<String> {
    match read(&index_account(ns)) {
        Held::Found(json) => serde_json::from_str::<Vec<String>>(&json).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn put_index(ns: &str, urls: &[String]) -> SessionWrite {
    match serde_json::to_string(urls) {
        Ok(json) => write(&index_account(ns), &json),
        Err(err) => SessionWrite::Unavailable {
            reason: format!("Couldn't prepare the server list for storage ({err})."),
        },
    }
}

pub fn load() -> SessionsLoad {
    load_in(NS)
}

pub fn save(session: &StoredSession) -> SessionWrite {
    save_in(NS, session)
}

pub fn forget(base_url: &str) -> SessionWrite {
    forget_in(NS, base_url)
}

fn load_in(ns: &str) -> SessionsLoad {
    let urls = match read(&index_account(ns)) {
        Held::Unavailable(reason) => return SessionsLoad::Unavailable { reason },
        // No index at all is either a fresh machine or a build from before the
        // server list existed. The old single entry is worth one look.
        Held::Missing => return adopt_legacy(ns),
        Held::Found(json) => serde_json::from_str::<Vec<String>>(&json).unwrap_or_default(),
    };

    let mut sessions = Vec::new();
    for url in urls {
        // A listed server whose entry has gone is skipped rather than treated
        // as a failure: the worst case is one server asking to be added again.
        if let Held::Found(json) = read(&server_account(ns, &url)) {
            if let Ok(session) = serde_json::from_str::<StoredSession>(&json) {
                sessions.push(session);
            }
        }
    }
    if sessions.is_empty() {
        SessionsLoad::Empty
    } else {
        SessionsLoad::Found { sessions }
    }
}

/// Carry a pre-T-412 sign-in forward, so upgrading the app does not sign
/// anybody out. Best effort in both directions: if the rewrite fails we still
/// hand the session back and this launch works.
fn adopt_legacy(ns: &str) -> SessionsLoad {
    let Held::Found(json) = read(&legacy_account(ns)) else {
        return SessionsLoad::Empty;
    };
    let Ok(session) = serde_json::from_str::<StoredSession>(&json) else {
        return SessionsLoad::Empty;
    };
    let _ = save_in(ns, &session);
    let _ = delete(&legacy_account(ns));
    SessionsLoad::Found {
        sessions: vec![session],
    }
}

fn save_in(ns: &str, session: &StoredSession) -> SessionWrite {
    let json = match serde_json::to_string(session) {
        Ok(json) => json,
        Err(err) => {
            return SessionWrite::Unavailable {
                reason: format!("Couldn't prepare the session for storage ({err})."),
            }
        }
    };
    // The token first, the index second. That order can leave an entry nothing
    // points at, which is invisible; the other order would list a server whose
    // token never landed, which shows up as a sign-in that cannot be restored.
    if let SessionWrite::Unavailable { reason } =
        write(&server_account(ns, &session.base_url), &json)
    {
        return SessionWrite::Unavailable { reason };
    }
    let mut urls = index(ns);
    if urls.iter().any(|url| url == &session.base_url) {
        return SessionWrite::Done;
    }
    urls.push(session.base_url.clone());
    put_index(ns, &urls)
}

fn forget_in(ns: &str, base_url: &str) -> SessionWrite {
    if let SessionWrite::Unavailable { reason } = delete(&server_account(ns, base_url)) {
        return SessionWrite::Unavailable { reason };
    }
    let urls = index(ns);
    let kept: Vec<String> = urls
        .iter()
        .filter(|url| url.as_str() != base_url)
        .cloned()
        .collect();
    if kept.len() == urls.len() {
        return SessionWrite::Done;
    }
    if kept.is_empty() {
        return delete(&index_account(ns));
    }
    put_index(ns, &kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(base_url: &str) -> StoredSession {
        StoredSession {
            base_url: base_url.into(),
            refresh_token: format!("token-for-{base_url}"),
        }
    }

    /// The contract that matters on a machine with no wallet: reading answers
    /// with a variant instead of panicking or hanging. This test passes both on
    /// a desktop with a keyring and on a bare CI box without one — which is the
    /// whole point.
    #[test]
    fn load_answers_without_panicking() {
        match load() {
            SessionsLoad::Found { .. } | SessionsLoad::Empty => {}
            SessionsLoad::Unavailable { reason } => assert!(!reason.is_empty()),
        }
    }

    #[test]
    fn stored_session_round_trips_as_json() {
        let one = session("https://linger.example");
        let json = serde_json::to_string(&one).expect("serialize");
        let back: StoredSession = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(one, back);
    }

    /// Account names have to be stable and distinct per server, because they
    /// are the only thing keeping two sign-ins from overwriting each other.
    #[test]
    fn each_server_gets_its_own_account() {
        assert_eq!(index_account("session"), "session-servers");
        assert_eq!(
            server_account("session", "https://a.example"),
            "session-server:https://a.example"
        );
        assert_ne!(
            server_account("session", "https://a.example"),
            server_account("session", "https://b.example")
        );
        // The pre-T-412 account must not collide with either of the new ones.
        assert_ne!(legacy_account("session"), index_account("session"));
    }

    /// The real thing, against this machine's actual keyring. Ignored by
    /// default because it needs an unlocked wallet, which CI does not have —
    /// run it with `cargo test -- --ignored` on a desktop session. Everything
    /// here writes under its own namespace so it can never clobber a real
    /// sign-in.
    #[test]
    #[ignore = "needs an unlocked OS keyring"]
    fn two_servers_live_side_by_side() {
        const NS: &str = "selftest-two";
        let home = session("https://home.test");
        let work = session("https://work.test");

        assert!(matches!(save_in(NS, &home), SessionWrite::Done));
        assert!(matches!(save_in(NS, &work), SessionWrite::Done));
        match load_in(NS) {
            SessionsLoad::Found { sessions } => {
                assert_eq!(sessions, vec![home.clone(), work.clone()])
            }
            other => panic!("expected both servers back, got {other:?}"),
        }

        // The accept criterion in prose: signing out of one leaves the other
        // exactly where it was.
        assert!(matches!(forget_in(NS, &home.base_url), SessionWrite::Done));
        match load_in(NS) {
            SessionsLoad::Found { sessions } => assert_eq!(sessions, vec![work.clone()]),
            other => panic!("expected only work back, got {other:?}"),
        }

        assert!(matches!(forget_in(NS, &work.base_url), SessionWrite::Done));
        assert!(matches!(load_in(NS), SessionsLoad::Empty));
        // Forgetting twice is still success — sign-out must be idempotent.
        assert!(matches!(forget_in(NS, &work.base_url), SessionWrite::Done));
    }

    /// Saving the same server twice replaces its token and does not list it
    /// twice, which is what a token refresh does on every launch.
    #[test]
    #[ignore = "needs an unlocked OS keyring"]
    fn saving_the_same_server_again_replaces_it() {
        const NS: &str = "selftest-again";
        let first = session("https://home.test");
        let second = StoredSession {
            base_url: first.base_url.clone(),
            refresh_token: "rotated".into(),
        };
        assert!(matches!(save_in(NS, &first), SessionWrite::Done));
        assert!(matches!(save_in(NS, &second), SessionWrite::Done));
        match load_in(NS) {
            SessionsLoad::Found { sessions } => assert_eq!(sessions, vec![second]),
            other => panic!("expected one rotated session, got {other:?}"),
        }
        assert!(matches!(forget_in(NS, &first.base_url), SessionWrite::Done));
    }

    /// Upgrading from a single-server build keeps you signed in.
    #[test]
    #[ignore = "needs an unlocked OS keyring"]
    fn an_old_single_sign_in_is_carried_forward() {
        const NS: &str = "selftest-legacy";
        let old = session("https://home.test");
        let json = serde_json::to_string(&old).expect("serialize");
        assert!(matches!(
            write(&legacy_account(NS), &json),
            SessionWrite::Done
        ));

        match load_in(NS) {
            SessionsLoad::Found { sessions } => assert_eq!(sessions, vec![old.clone()]),
            other => panic!("expected the old sign-in back, got {other:?}"),
        }
        // Migrated once and then gone, so a later sign-out really forgets it.
        assert!(matches!(read(&legacy_account(NS)), Held::Missing));
        match load_in(NS) {
            SessionsLoad::Found { sessions } => assert_eq!(sessions, vec![old.clone()]),
            other => panic!("expected the migrated sign-in back, got {other:?}"),
        }
        assert!(matches!(forget_in(NS, &old.base_url), SessionWrite::Done));
    }

    /// The frontend switches on `kind`, so the tag spelling is part of the
    /// contract with `client/src/lib/ipc.ts`.
    #[test]
    fn outcomes_are_tagged_in_snake_case() {
        let empty = serde_json::to_string(&SessionsLoad::Empty).expect("serialize");
        assert_eq!(empty, r#"{"kind":"empty"}"#);
        let done = serde_json::to_string(&SessionWrite::Done).expect("serialize");
        assert_eq!(done, r#"{"kind":"done"}"#);
        let missing = serde_json::to_string(&SessionsLoad::Unavailable {
            reason: "no wallet".into(),
        })
        .expect("serialize");
        assert_eq!(missing, r#"{"kind":"unavailable","reason":"no wallet"}"#);
        let found = serde_json::to_string(&SessionsLoad::Found {
            sessions: vec![session("https://home.test")],
        })
        .expect("serialize");
        assert!(found.starts_with(r#"{"kind":"found","sessions":[{"base_url""#));
    }
}
