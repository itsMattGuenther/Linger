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
//! The phone app keeps the same entries in the phone's own store (T-1602).
//! On the iPhone that's the Keychain, through the same keyring crate. On
//! Android it's `keyring-core` with `android-native-keyring-store`, from the
//! keyring crate's maintainers, which keeps each one in the app's private
//! SharedPreferences encrypted with a key held in the Android Keystore. The
//! key never leaves the Keystore and isn't in any backup, so a copy of the
//! file is useless anywhere else.
//!
//! On the iPhone the same has to be asked for (SPEC §4.15, #790). A Keychain
//! entry written with no protection named gets `kSecAttrAccessibleWhenUnlocked`,
//! and Apple's documentation says entries with that one "migrate to a new
//! device when using encrypted backups". So the shell writes each entry
//! itself with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, which the
//! keyring crate has no way to ask for, and moves the ones an older build
//! wrote the first time it reads them (`keep_on_this_phone`). Reading and
//! deleting still go through the crate, which finds an entry whatever its
//! protection. Why that protection and not another is on
//! `ios::this_phone_only`.

#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as StoreError};
#[cfg(target_os = "android")]
use keyring_core::{Entry, Error as StoreError};
use serde::{Deserialize, Serialize};

/// Keyring service name. Matches the bundle identifier so entries are
/// recognisable in Seahorse / KWalletManager / Keychain Access.
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

/// Why a keyring call failed, in the system's own words. Those are D-Bus and
/// platform jargon, so nobody is shown them as a sentence: the frontend says
/// what it means in plain words (`core/signin.ts` `keyringWords`, and the
/// list's foot) and keeps this for the line's tooltip (#702). It goes in the
/// log too, for whoever is looking into why sign-ins aren't kept.
fn explain(err: &StoreError) -> String {
    noted(err.to_string())
}

/// Write a reason the keyring couldn't be used to the log (standard error, as
/// the rest of the shell does) and hand it back. A reason is the keyring's own
/// text or ours, never a token: none of the store's errors carry the secret.
fn noted(reason: String) -> String {
    eprintln!("linger: sign-ins aren't kept: {reason}");
    reason
}

/// Open the Android store, once: Tauri has already handed the app's context
/// to `ndk-context`, which is all it needs. A failure is kept, so every call
/// after it says the same thing rather than trying again mid-sign-in.
#[cfg(target_os = "android")]
fn android_store() -> Result<(), String> {
    static OPENED: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    OPENED
        .get_or_init(|| {
            android_native_keyring_store::Store::new()
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|err| explain(&err))
        })
        .clone()
}

/// One account's entry, in this device's store.
fn entry(account: &str) -> Result<Entry, String> {
    #[cfg(target_os = "android")]
    android_store()?;
    Entry::new(SERVICE, account).map_err(|err| explain(&err))
}

/// One account's contents. `Missing` and `Unavailable` are different answers:
/// the first means the keyring works and has nothing, the second means we could
/// not ask.
enum Held {
    Found(String),
    Missing,
    Unavailable(String),
}

fn read(account: &str) -> Held {
    let entry = match entry(account) {
        Ok(entry) => entry,
        Err(reason) => return Held::Unavailable(reason),
    };
    match entry.get_password() {
        Ok(value) => Held::Found(value),
        Err(StoreError::NoEntry) => Held::Missing,
        Err(err) => Held::Unavailable(explain(&err)),
    }
}

fn write(account: &str, value: &str) -> SessionWrite {
    match put(account, value) {
        Ok(()) => SessionWrite::Done,
        Err(reason) => SessionWrite::Unavailable { reason },
    }
}

/// Store one account's contents through the keyring crate.
#[cfg(not(target_os = "ios"))]
fn put(account: &str, value: &str) -> Result<(), String> {
    entry(account)?
        .set_password(value)
        .map_err(|err| explain(&err))
}

/// Store one account's contents on an iPhone: in the Keychain, kept to this
/// phone (#790), which the keyring crate can't ask for.
#[cfg(target_os = "ios")]
fn put(account: &str, value: &str) -> Result<(), String> {
    ios::put(SERVICE, account, value.as_bytes()).map_err(|err| noted(err.to_string()))
}

fn delete(account: &str) -> SessionWrite {
    let entry = match entry(account) {
        Ok(entry) => entry,
        Err(reason) => return SessionWrite::Unavailable { reason },
    };
    match entry.delete_credential() {
        // Deleting nothing is a success: the caller wanted no stored session
        // and there is none.
        Ok(()) | Err(StoreError::NoEntry) => SessionWrite::Done,
        Err(err) => SessionWrite::Unavailable {
            reason: explain(&err),
        },
    }
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
            reason: noted(format!(
                "Couldn't prepare the server list for storage ({err})."
            )),
        },
    }
}

pub fn load() -> SessionsLoad {
    // Sign-ins an older iPhone build wrote go to this phone only first
    // (#790). Every launch, so one that couldn't be moved is tried again.
    #[cfg(target_os = "ios")]
    ios::keep_on_this_phone(SERVICE);
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
                reason: noted(format!("Couldn't prepare the session for storage ({err}).")),
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

/// One of the app's entries in an iPhone's Keychain, as the Keychain lists
/// it: its account, and its protection (`kSecAttrAccessible`) if it said.
#[cfg(any(target_os = "ios", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct Kept {
    account: String,
    protection: Option<String>,
}

/// Which entries to move to this phone only (#790): every one not already
/// kept with `this_phone_only`, the protection as the Keychain spells it.
/// That takes in what an older build wrote (the Keychain's default), any
/// other protection, and an entry whose protection wasn't said, since naming
/// it is the way to be sure. Plain strings in and out, so it's tested on any
/// computer; the Keychain's half is `ios::keep_on_this_phone`.
#[cfg(any(target_os = "ios", test))]
fn to_move<'a>(held: &'a [Kept], this_phone_only: &str) -> Vec<&'a str> {
    held.iter()
        .filter(|kept| kept.protection.as_deref() != Some(this_phone_only))
        .map(|kept| kept.account.as_str())
        .collect()
}

/// The iPhone's Keychain, called directly for the one thing the keyring
/// crate can't do: name how an entry is protected (#790). Through
/// `security-framework`, the same release the keyring crate itself uses on
/// an iPhone. Every `unsafe` is here, each with what makes it sound.
#[cfg(target_os = "ios")]
mod ios {
    use core_foundation::base::{CFType, OSStatus, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use security_framework::base::Error;
    use security_framework::item::{add_item, ItemClass, ItemSearchOptions, Limit, SearchResult};
    use security_framework_sys::access_control::kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
    use security_framework_sys::base::{errSecDuplicateItem, errSecItemNotFound, errSecSuccess};
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecValueData,
    };
    use security_framework_sys::keychain_item::SecItemUpdate;

    use super::{to_move, Kept};

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        /// The attribute holding an entry's protection. Security.framework
        /// has exported it since iOS 4; `security-framework-sys` doesn't
        /// name it.
        static kSecAttrAccessible: CFStringRef;
    }

    /// One of Security.framework's constants, as a CFString.
    ///
    /// # Safety
    ///
    /// `constant` must be one of the CFString constants the framework
    /// exports, which are alive as long as the app is.
    unsafe fn named(constant: CFStringRef) -> CFString {
        // SAFETY: a live CFString, by this function's contract; the get rule
        // retains it.
        unsafe { CFString::wrap_under_get_rule(constant) }
    }

    /// The protection every entry gets:
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
    ///
    /// *This device only* keeps it off other phones. Apple's documentation:
    /// such entries "do not migrate to a new device. Thus, after restoring
    /// from a backup of a different device, these items will not be
    /// present." (Restoring this same phone from its own backup does bring
    /// them back.)
    ///
    /// *After first unlock* is when it can be read: from the first unlock
    /// after the phone starts until it's turned off, locked or not. Linger
    /// only starts when somebody opens it, which needs the phone unlocked,
    /// so reading at launch works as it always has. The default that older
    /// builds got, `WhenUnlocked`, closes a few seconds after the phone
    /// locks, and a refresh landing then couldn't be written. The server
    /// hands out a new sign-in with every refresh and refuses the old one
    /// once it's used (PROTOCOL §2), so a lost write signs you out at the next
    /// start. It also keeps a call's sign-in fresh with the phone locked, if
    /// iPhone voice ever runs in the background (T-1604).
    /// `WhenPasscodeSetThisDeviceOnly` was ruled out: it stores nothing on a
    /// phone without a passcode, and deletes it if the passcode is turned off.
    fn this_phone_only() -> CFString {
        // SAFETY: one of the framework's constants.
        unsafe { named(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) }
    }

    /// The protection, as an attribute to write.
    fn protection() -> (CFString, CFType) {
        // SAFETY: one of the framework's constants.
        let key = unsafe { named(kSecAttrAccessible) };
        (key, this_phone_only().into_CFType())
    }

    /// The attributes that pick out one entry: the three the keyring crate
    /// looks an entry up by, so it reads and deletes what this writes.
    fn entry(service: &str, account: &str) -> Vec<(CFString, CFType)> {
        // SAFETY: the framework's constants.
        let (class, generic, service_key, account_key) = unsafe {
            (
                named(kSecClass),
                named(kSecClassGenericPassword),
                named(kSecAttrService),
                named(kSecAttrAccount),
            )
        };
        vec![
            (class, generic.into_CFType()),
            (service_key, CFString::new(service).into_CFType()),
            (account_key, CFString::new(account).into_CFType()),
        ]
    }

    /// Write one entry, kept to this phone. The way the keyring crate writes
    /// (add it, or replace it if it's there), with the protection named both
    /// times, so replacing an older build's entry moves it as well. If the
    /// Keychain won't change the protection while replacing, the contents
    /// are still replaced, as before #790: a refreshed sign-in must never be
    /// lost, and the move is tried again at the next start.
    pub fn put(service: &str, account: &str, secret: &[u8]) -> Result<(), Error> {
        // SAFETY: one of the framework's constants.
        let contents = (
            unsafe { named(kSecValueData) },
            CFData::from_buffer(secret).into_CFType(),
        );
        let mut new = entry(service, account);
        new.push(contents.clone());
        new.push(protection());
        match add_item(CFDictionary::from_CFType_pairs(&new).to_untyped()) {
            Err(err) if err.code() == errSecDuplicateItem => {
                update(service, account, &[contents.clone(), protection()])
                    .or_else(|_| update(service, account, &[contents]))
            }
            added => added,
        }
    }

    /// Change some attributes of one entry, leaving the rest as they are.
    fn update(service: &str, account: &str, changes: &[(CFString, CFType)]) -> Result<(), Error> {
        let query = CFDictionary::from_CFType_pairs(&entry(service, account));
        let changes = CFDictionary::from_CFType_pairs(changes);
        // SAFETY: both dictionaries are alive for the whole call, which only
        // reads them.
        let status: OSStatus =
            unsafe { SecItemUpdate(query.as_concrete_TypeRef(), changes.as_concrete_TypeRef()) };
        if status == errSecSuccess {
            Ok(())
        } else {
            Err(Error::from_code(status))
        }
    }

    /// Every one of the app's entries, with its protection as the Keychain
    /// spells it. None at all is an empty list, not a failure.
    fn held(service: &str) -> Result<Vec<Kept>, Error> {
        let found = ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .service(service)
            .load_attributes(true)
            .limit(Limit::All)
            .search();
        let results = match found {
            Ok(results) => results,
            Err(err) if err.code() == errSecItemNotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        // SAFETY: the framework's constants.
        let (account, protection) = unsafe {
            (
                named(kSecAttrAccount).to_string(),
                named(kSecAttrAccessible).to_string(),
            )
        };
        Ok(results
            .iter()
            .filter_map(SearchResult::simplify_dict)
            .filter_map(|attributes| {
                Some(Kept {
                    account: attributes.get(&account)?.clone(),
                    protection: attributes.get(&protection).cloned(),
                })
            })
            .collect())
    }

    /// Move each entry an older build wrote to this phone only, where it
    /// is. Only its protection changes: it isn't deleted and written again,
    /// so if a move fails the entry stays exactly as it was and still signs
    /// you in, and the next start tries again. Said in the log either way,
    /// without the account, which names the server.
    pub fn keep_on_this_phone(service: &str) {
        let held = match held(service) {
            Ok(held) => held,
            Err(err) => {
                eprintln!("linger: couldn't check where sign-ins are kept: {err}");
                return;
            }
        };
        let this_phone_only = this_phone_only().to_string();
        for account in to_move(&held, &this_phone_only) {
            match update(service, account, &[protection()]) {
                Ok(()) => eprintln!("linger: a sign-in is now kept on this phone only"),
                Err(err) => eprintln!(
                    "linger: a sign-in isn't kept to this phone yet ({err}); it still works, \
                     and the next start tries again"
                ),
            }
        }
    }
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

    /// The frontend builds the sentence a person reads (#702), so a failure
    /// comes back as the store's own text with no sentence wrapped round it,
    /// for the tooltip and the log.
    #[test]
    fn a_failure_is_the_stores_own_words() {
        let err = StoreError::NoEntry;
        assert_eq!(explain(&err), err.to_string());
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

    /// How the Keychain spells the protections, as it lists them back:
    /// `kSecAttrAccessibleWhenUnlocked` (what an entry written without one
    /// gets, which older iPhone builds' are), `…WhenUnlockedThisDeviceOnly`
    /// and `…AfterFirstUnlockThisDeviceOnly`. The iPhone code compares with
    /// the framework's own constants; these only make the tests read true.
    const WHEN_UNLOCKED: &str = "ak";
    const WHEN_UNLOCKED_HERE: &str = "aku";
    const THIS_PHONE_ONLY: &str = "cku";

    fn kept(account: &str, protection: Option<&str>) -> Kept {
        Kept {
            account: account.into(),
            protection: protection.map(str::to_string),
        }
    }

    /// #790: updating to this build moves an iPhone's sign-ins to this phone
    /// only, all of them, the server list included, the first time.
    #[test]
    fn an_older_builds_sign_ins_are_moved_to_this_phone() {
        let index = index_account(NS);
        let home = server_account(NS, "https://home.test");
        let work = server_account(NS, "https://work.test");
        let held = [
            kept(&index, Some(WHEN_UNLOCKED)),
            kept(&home, Some(WHEN_UNLOCKED)),
            kept(&work, Some(WHEN_UNLOCKED)),
        ];
        assert_eq!(
            to_move(&held, THIS_PHONE_ONLY),
            vec![index.as_str(), home.as_str(), work.as_str()]
        );
    }

    /// Once moved, nothing is: the next start leaves the Keychain alone. A
    /// sign-in written since (`ios::put`) is already this phone's only.
    #[test]
    fn what_is_already_kept_here_stays_put() {
        let held = [
            kept(&index_account(NS), Some(THIS_PHONE_ONLY)),
            kept(
                &server_account(NS, "https://home.test"),
                Some(THIS_PHONE_ONLY),
            ),
        ];
        assert!(to_move(&held, THIS_PHONE_ONLY).is_empty());
        assert!(to_move(&[], THIS_PHONE_ONLY).is_empty());
    }

    /// Only the one protection counts as done. Another this-device-only one
    /// closes when the phone locks, and an entry whose protection wasn't said
    /// can't be known to be safe, so both are moved; a mix moves only what
    /// needs it.
    #[test]
    fn anything_else_is_moved_too() {
        let index = index_account(NS);
        let home = server_account(NS, "https://home.test");
        let work = server_account(NS, "https://work.test");
        let held = [
            kept(&index, Some(THIS_PHONE_ONLY)),
            kept(&home, Some(WHEN_UNLOCKED_HERE)),
            kept(&work, None),
        ];
        assert_eq!(
            to_move(&held, THIS_PHONE_ONLY),
            vec![home.as_str(), work.as_str()]
        );
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
