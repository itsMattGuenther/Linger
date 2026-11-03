//! What the app keeps for the iPhone's share window (#820, SPEC §4.15).
//!
//! Sharing to Linger on an iPhone happens in a program of its own inside the
//! share sheet (`gen/apple/ShareExtension/`), which picks a conversation,
//! uploads and posts. It reads two things the app keeps for it, through the
//! App Group the two share:
//!
//! - **Its sign-ins**: on each server, a sign-in of its own
//!   (`POST /auth/share-sign-in`, PROTOCOL §2), so it never spends the app's
//!   refresh token. All of them are one Keychain entry, a table from each
//!   server's address to its refresh token and when it was last saved
//!   (`Kept`), in the App Group's access group so the window can read it and
//!   write back what it renews, and kept to this phone, as the app's own
//!   sign-ins are (`secrets.rs`, #790). One entry rather than one per server,
//!   so neither side has to list the Keychain. Both change it only holding a
//!   lock on `share-window/sign-ins.lock` (`while_locked`), so neither writes
//!   back a table read before the other's change (#822).
//! - **The list it picks from**, with Linger's colours, as the page makes it
//!   (`core/shareWindow.ts`): `share-window/list.json` in the App Group's
//!   folder, marked "don't back up". The page reads it back when it starts,
//!   so a server it hasn't connected to yet is written as it was (#825).
//!
//! The page decides when to ask for, renew and drop a sign-in; this only keeps
//! them. Off an iPhone nothing shares this way, so every command answers as if
//! nothing were kept.
// Only the phone app registers the commands; tests build it on a computer too.
#![cfg_attr(not(mobile), allow(dead_code))]

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The App Group the app and its share extension share. The same name is in
/// both entitlements files, `shared.rs` and `ShareStore.swift`.
#[cfg(target_os = "ios")]
const APP_GROUP: &str = "group.io.github.itsmattguenther.linger";

/// The Keychain entry's service and account. `ShareStore.swift` reads the same.
#[cfg(target_os = "ios")]
const SERVICE: &str = "im.linger.share-window";
#[cfg(target_os = "ios")]
const ACCOUNT: &str = "sign-ins";

/// The folder in the App Group the list goes in, and its name.
const FOLDER: &str = "share-window";
const LIST: &str = "list.json";
/// The file both programs lock to change the sign-ins; `ShareList.swift`
/// locks the same one.
const LOCK: &str = "sign-ins.lock";

/// The longest list kept: far more than any list of conversations, and short
/// of anything a page could fill the phone with.
const MOST_LIST_BYTES: usize = 2 * 1024 * 1024;

/// One server's sign-in for the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kept {
    pub refresh_token: String,
    /// When it was last saved, by the app or the window renewing it, in Unix
    /// milliseconds.
    pub saved_at: u64,
}

/// Every server's, by address.
pub type SignIns = BTreeMap<String, Kept>;

/// Where the table is kept: the Keychain on an iPhone, memory in tests.
pub trait Store {
    fn read(&self) -> Option<Vec<u8>>;
    fn write(&self, bytes: &[u8]) -> bool;
}

/// The table as kept; empty when there's none or it can't be read.
pub fn load(store: &dyn Store) -> SignIns {
    store
        .read()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn keep(store: &dyn Store, sign_ins: &SignIns) -> bool {
    serde_json::to_vec(sign_ins).is_ok_and(|bytes| store.write(&bytes))
}

/// When `base_url`'s sign-in was last saved, if there is one.
pub fn saved_at(store: &dyn Store, base_url: &str) -> Option<u64> {
    load(store).get(base_url).map(|kept| kept.saved_at)
}

/// Keep `refresh_token` as `base_url`'s sign-in, answering with the one it
/// replaced, for the page to sign out. `None` too when it couldn't be kept,
/// with nothing replaced.
pub fn save(store: &dyn Store, base_url: &str, refresh_token: String, now: u64) -> Option<String> {
    let mut sign_ins = load(store);
    let replaced = sign_ins.insert(
        base_url.to_string(),
        Kept {
            refresh_token,
            saved_at: now,
        },
    );
    if keep(store, &sign_ins) {
        replaced.map(|kept| kept.refresh_token)
    } else {
        None
    }
}

/// Stop keeping `base_url`'s sign-in, answering with it, for the page to sign
/// out.
pub fn forget(store: &dyn Store, base_url: &str) -> Option<String> {
    let mut sign_ins = load(store);
    let gone = sign_ins.remove(base_url)?;
    keep(store, &sign_ins).then_some(gone.refresh_token)
}

/// Every server a sign-in is kept for.
pub fn kept(store: &dyn Store) -> Vec<String> {
    load(store).into_keys().collect()
}

/// Run `change` holding the lock on `folder`'s `sign-ins.lock`, which the
/// window takes too (`whileLocked` in `ShareList.swift`, #822). Each side reads
/// the table, changes one server and writes it back; without the lock, one
/// could write back a table read just before the other's write, and undo it:
/// a renewed token lost is the window's sign-in lost. Held only for the read
/// and write, never while asking a server. Without a folder, or a lock to be
/// had, it runs anyway, as it did before there was one.
pub fn while_locked<T>(folder: Option<&Path>, change: impl FnOnce() -> T) -> T {
    let held = folder.and_then(|folder| {
        std::fs::create_dir_all(folder).ok()?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(folder.join(LOCK))
            .ok()?;
        file.lock().ok()?;
        Some(file)
    });
    let answer = change();
    // Closing the file lets go of the lock.
    drop(held);
    answer
}

/// The folder whose lock guards the sign-ins: the App Group's on an iPhone.
fn lock_folder() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "ios")]
    {
        ios::folder()
    }
    #[cfg(not(target_os = "ios"))]
    {
        None
    }
}

/// Write the list for the window into `folder`, whole or not at all: to a
/// file beside it first, then moved into place, so the window never reads half
/// of one. Refused when it isn't the list's shape, or is far too big.
pub fn write_list(folder: &Path, list: &str) -> Result<(), String> {
    if list.len() > MOST_LIST_BYTES {
        return Err("the list is too big".into());
    }
    let parsed: serde_json::Value = serde_json::from_str(list).map_err(|err| err.to_string())?;
    if !parsed.get("version").is_some_and(serde_json::Value::is_u64)
        || !parsed
            .get("servers")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err("that isn't the share window's list".into());
    }
    std::fs::create_dir_all(folder).map_err(|err| err.to_string())?;
    let partial = folder.join(format!(".{LIST}.writing"));
    std::fs::write(&partial, list).map_err(|err| err.to_string())?;
    std::fs::rename(&partial, folder.join(LIST)).map_err(|err| err.to_string())
}

/// The list as last written into `folder`, for the app to start from (#825):
/// a server the app hasn't connected to yet this time is kept as it was.
/// `None` when there's none, or it's far too big to be one.
pub fn read_list(folder: &Path) -> Option<String> {
    let path = folder.join(LIST);
    let size = std::fs::metadata(&path).ok()?.len();
    if size > MOST_LIST_BYTES as u64 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// The store the commands use: the Keychain on an iPhone, and nothing
/// anywhere else.
fn store() -> Option<Box<dyn Store + Send>> {
    #[cfg(target_os = "ios")]
    {
        Some(Box::new(ios::Keychain))
    }
    #[cfg(not(target_os = "ios"))]
    {
        None
    }
}

/// When this server's window sign-in was last saved; `None` when there's none.
#[tauri::command]
pub async fn share_sign_in_saved_at(base_url: String) -> Option<u64> {
    crate::off_thread(move || saved_at(store()?.as_ref(), &base_url), || None).await
}

/// Keep a new window sign-in for this server, answering with the one it
/// replaced.
#[tauri::command]
pub async fn share_sign_in_save(base_url: String, refresh_token: String) -> Option<String> {
    crate::off_thread(
        move || {
            let store = store()?;
            while_locked(lock_folder().as_deref(), || {
                save(store.as_ref(), &base_url, refresh_token, now_ms())
            })
        },
        || None,
    )
    .await
}

/// Stop keeping this server's window sign-in, answering with it.
#[tauri::command]
pub async fn share_sign_in_forget(base_url: String) -> Option<String> {
    crate::off_thread(
        move || {
            let store = store()?;
            while_locked(lock_folder().as_deref(), || {
                forget(store.as_ref(), &base_url)
            })
        },
        || None,
    )
    .await
}

/// Every server a window sign-in is kept for.
#[tauri::command]
pub async fn share_sign_ins_kept() -> Vec<String> {
    crate::off_thread(
        || {
            store()
                .map(|store| kept(store.as_ref()))
                .unwrap_or_default()
        },
        Vec::new,
    )
    .await
}

/// The list the window picks from, as last written. Off an iPhone, none.
#[tauri::command]
pub async fn share_window_list_read() -> Option<String> {
    crate::off_thread(
        || {
            #[cfg(target_os = "ios")]
            {
                read_list(&ios::folder()?)
            }
            #[cfg(not(target_os = "ios"))]
            {
                None
            }
        },
        || None,
    )
    .await
}

/// Write the list the window picks from. Off an iPhone, nothing to write to.
#[tauri::command]
pub async fn share_window_list_save(list: String) -> Result<(), String> {
    crate::off_thread(
        move || {
            #[cfg(target_os = "ios")]
            {
                let folder = ios::folder().ok_or("the App Group's folder isn't there")?;
                write_list(&folder, &list)
            }
            #[cfg(not(target_os = "ios"))]
            {
                let _ = list;
                Ok(())
            }
        },
        || Err("the list wasn't written".into()),
    )
    .await
}

/// The iPhone's half: the Keychain entry, through Security.framework, and the
/// App Group's folder. Every `unsafe` is here, each with what makes it sound.
#[cfg(target_os = "ios")]
mod ios {
    use std::path::PathBuf;

    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::{CFData, CFDataRef};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use objc2_foundation::{NSFileManager, NSString};
    use security_framework_sys::access_control::kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
    use security_framework_sys::base::{errSecDuplicateItem, errSecSuccess};
    use security_framework_sys::item::{
        kSecAttrAccessGroup, kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword,
        kSecMatchLimit, kSecReturnData, kSecValueData,
    };
    use security_framework_sys::keychain_item::{SecItemAdd, SecItemCopyMatching, SecItemUpdate};

    use super::{Store, ACCOUNT, APP_GROUP, FOLDER, SERVICE};

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        /// An entry's protection; `security-framework-sys` doesn't name it
        /// (as in `secrets.rs`).
        static kSecAttrAccessible: CFStringRef;
        /// "One entry at most", for `kSecMatchLimit`; `security-framework-sys`
        /// names the key but not this value.
        static kSecMatchLimitOne: CFStringRef;
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

    /// What picks out the entry: a generic password with this service and
    /// account, in the App Group's access group, so the share extension finds
    /// the same one. The app's own sign-ins are in its default group, and
    /// this never touches them.
    fn entry() -> Vec<(CFString, CFType)> {
        // SAFETY: the framework's constants.
        unsafe {
            vec![
                (
                    named(kSecClass),
                    named(kSecClassGenericPassword).into_CFType(),
                ),
                (named(kSecAttrService), CFString::new(SERVICE).into_CFType()),
                (named(kSecAttrAccount), CFString::new(ACCOUNT).into_CFType()),
                (
                    named(kSecAttrAccessGroup),
                    CFString::new(APP_GROUP).into_CFType(),
                ),
            ]
        }
    }

    /// Kept to this phone, readable from the first unlock after it starts:
    /// as the app's own sign-ins are, and for the same reasons
    /// (`secrets.rs`, `ios::this_phone_only`). Somebody shares with the
    /// phone unlocked, so the window can always read it.
    fn protection() -> (CFString, CFType) {
        // SAFETY: the framework's constants.
        unsafe {
            (
                named(kSecAttrAccessible),
                named(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).into_CFType(),
            )
        }
    }

    pub struct Keychain;

    impl Store for Keychain {
        fn read(&self) -> Option<Vec<u8>> {
            let mut query = entry();
            // SAFETY: the framework's constants.
            unsafe {
                query.push((named(kSecReturnData), CFBoolean::true_value().into_CFType()));
                query.push((
                    named(kSecMatchLimit),
                    named(kSecMatchLimitOne).into_CFType(),
                ));
            }
            let query = CFDictionary::from_CFType_pairs(&query);
            let mut found: CFTypeRef = std::ptr::null();
            // SAFETY: the query is alive for the call, and `found` is where
            // the framework writes what it found.
            let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut found) };
            if status != errSecSuccess || found.is_null() {
                return None;
            }
            // SAFETY: asked for one entry's data, the framework hands back a
            // CFData the caller owns (Apple's "Create Rule" for Copy functions).
            let data = unsafe { CFData::wrap_under_create_rule(found as CFDataRef) };
            Some(data.bytes().to_vec())
        }

        fn write(&self, bytes: &[u8]) -> bool {
            // SAFETY: one of the framework's constants.
            let contents = (
                unsafe { named(kSecValueData) },
                CFData::from_buffer(bytes).into_CFType(),
            );
            let mut new = entry();
            new.push(contents.clone());
            new.push(protection());
            let new = CFDictionary::from_CFType_pairs(&new);
            // SAFETY: the dictionary is alive for the call; no result is asked for.
            let added = unsafe { SecItemAdd(new.as_concrete_TypeRef(), std::ptr::null_mut()) };
            if added != errSecDuplicateItem {
                return added == errSecSuccess;
            }
            let query = CFDictionary::from_CFType_pairs(&entry());
            let changes = CFDictionary::from_CFType_pairs(&[contents, protection()]);
            // SAFETY: both dictionaries are alive for the call, which only reads them.
            let updated = unsafe {
                SecItemUpdate(query.as_concrete_TypeRef(), changes.as_concrete_TypeRef())
            };
            updated == errSecSuccess
        }
    }

    /// `<App Group>/share-window`, marked "don't back up"; `None` when the
    /// app wasn't signed into the group, or it can't be marked.
    pub fn folder() -> Option<PathBuf> {
        let group = NSFileManager::defaultManager()
            .containerURLForSecurityApplicationGroupIdentifier(&NSString::from_str(APP_GROUP))?;
        let folder = PathBuf::from(group.path()?.to_string()).join(FOLDER);
        crate::phone_backup::mark(&folder).ok()?;
        Some(folder)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// A store in memory, as the Keychain would keep it, or one that refuses.
    #[derive(Default)]
    struct Memory {
        bytes: RefCell<Option<Vec<u8>>>,
        refuses: bool,
    }

    impl Store for Memory {
        fn read(&self) -> Option<Vec<u8>> {
            self.bytes.borrow().clone()
        }
        fn write(&self, bytes: &[u8]) -> bool {
            if !self.refuses {
                *self.bytes.borrow_mut() = Some(bytes.to_vec());
            }
            !self.refuses
        }
    }

    const GOOD: &str = "https://good.example";
    const OTHER: &str = "https://other.example";

    /// A change waits while the other program holds the lock, and goes ahead
    /// once it lets go (#822). Two opens of one file are two locks, so a
    /// handle held here stands in for the window's.
    #[test]
    fn a_change_waits_for_the_lock_the_window_holds() {
        use std::sync::mpsc;
        use std::time::Duration;

        let folder = std::env::temp_dir().join(format!(
            "linger-share-lock-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&folder).expect("a folder");
        let window = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(folder.join(LOCK))
            .expect("the lock file");
        window.lock().expect("the window's lock");
        let (changed, change) = mpsc::channel();
        let app = {
            let folder = folder.clone();
            std::thread::spawn(move || {
                while_locked(Some(&folder), || changed.send(()).expect("told"));
            })
        };
        assert!(
            change.recv_timeout(Duration::from_millis(300)).is_err(),
            "changed while the window held the lock"
        );
        drop(window);
        change
            .recv_timeout(Duration::from_secs(5))
            .expect("changed once the window let go");
        app.join().expect("the app's side");
        // Without a folder, it runs at once, as before there was a lock.
        assert_eq!(while_locked(None, || 7), 7);
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_sign_in_is_kept_with_when_and_replacing_one_answers_the_old() {
        let store = Memory::default();
        assert_eq!(saved_at(&store, GOOD), None);
        assert_eq!(save(&store, GOOD, "one".into(), 10), None);
        assert_eq!(saved_at(&store, GOOD), Some(10));
        assert_eq!(save(&store, OTHER, "other".into(), 11), None);
        assert_eq!(save(&store, GOOD, "two".into(), 20), Some("one".into()));
        assert_eq!(saved_at(&store, GOOD), Some(20));
        assert_eq!(kept(&store), vec![GOOD.to_string(), OTHER.to_string()]);
    }

    #[test]
    fn forgetting_one_answers_it_and_leaves_the_others() {
        let store = Memory::default();
        save(&store, GOOD, "one".into(), 10);
        save(&store, OTHER, "other".into(), 10);
        assert_eq!(forget(&store, GOOD), Some("one".into()));
        assert_eq!(forget(&store, GOOD), None);
        assert_eq!(kept(&store), vec![OTHER.to_string()]);
    }

    /// The table is what `ShareStore.swift` reads and writes back: the
    /// address, then the token and when, in milliseconds.
    #[test]
    fn the_table_is_what_the_swift_side_reads() {
        let store = Memory::default();
        save(&store, GOOD, "one".into(), 1_730_000_000_000);
        let json: serde_json::Value =
            serde_json::from_slice(&store.read().expect("kept")).expect("JSON");
        assert_eq!(
            json,
            serde_json::json!({ GOOD: { "refresh_token": "one", "saved_at": 1_730_000_000_000_u64 } })
        );
    }

    /// A table the window wrote back that can't be read starts afresh rather
    /// than failing every share for good.
    #[test]
    fn an_unreadable_table_is_an_empty_one() {
        let store = Memory::default();
        store.write(b"not json");
        assert!(kept(&store).is_empty());
        assert_eq!(save(&store, GOOD, "one".into(), 1), None);
        assert_eq!(saved_at(&store, GOOD), Some(1));
    }

    /// A store that won't keep it: nothing replaced is said, so the page
    /// signs nothing out that's still kept.
    #[test]
    fn a_store_that_refuses_replaces_nothing() {
        let store = Memory {
            refuses: true,
            ..Memory::default()
        };
        assert_eq!(save(&store, GOOD, "one".into(), 1), None);
        assert_eq!(forget(&store, GOOD), None);
    }

    fn folder(name: &str) -> std::path::PathBuf {
        let folder =
            std::env::temp_dir().join(format!("linger-share-window-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder
    }

    #[test]
    fn the_list_is_written_whole_and_replaced_whole() {
        let at = folder("whole");
        write_list(&at, r#"{"version":1,"servers":[]}"#).expect("written");
        write_list(&at, r#"{"version":1,"servers":[{"base_url":"x"}]}"#).expect("replaced");
        let read = std::fs::read_to_string(at.join(LIST)).expect("there");
        assert_eq!(read, r#"{"version":1,"servers":[{"base_url":"x"}]}"#);
        // And read back as written, for the app to start from (#825).
        assert_eq!(read_list(&at).as_deref(), Some(read.as_str()));
        assert_eq!(read_list(&folder("none")), None);
        // Nothing half-written is left beside it.
        let names: Vec<_> = std::fs::read_dir(&at)
            .expect("folder")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(LIST)]);
        let _ = std::fs::remove_dir_all(&at);
    }

    #[test]
    fn what_isnt_the_list_is_refused() {
        let at = folder("refused");
        assert!(write_list(&at, "not json").is_err());
        assert!(write_list(&at, r#"{"servers":[]}"#).is_err());
        assert!(write_list(&at, r#"{"version":1}"#).is_err());
        assert!(write_list(
            &at,
            &format!(
                r#"{{"version":1,"servers":[],"pad":"{}"}}"#,
                "x".repeat(MOST_LIST_BYTES)
            )
        )
        .is_err());
        assert!(!at.join(LIST).exists());
        let _ = std::fs::remove_dir_all(&at);
    }
}
