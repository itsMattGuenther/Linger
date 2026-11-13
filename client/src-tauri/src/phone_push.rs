//! Phone notifications, the phone's side (#830, SPEC §4.15, PROTOCOL §5
//! "Phone notifications").
//!
//! The page decides everything (`client/src/next/core/push.ts`): which
//! servers notify this phone and about what. This is what only the phone can
//! do for it:
//!
//! - **Permission:** whether the phone lets Linger show notifications, and
//!   asking once, when the person turns them on (Android 13 and later).
//! - **Address:** the push address Apple or Google gives this copy of the
//!   app. The page has the relay seal it before any server sees it.
//! - **Keys:** a P-256 key pair and a 16-byte secret per server (RFC 8291).
//!   The public half goes to the server; the private half stays on the
//!   phone, where the part of the app that shows a notification can read it
//!   with the app closed: Kotlin's messaging service on Android, the
//!   notification service extension on an iPhone (#889).
//! - **Opened:** the conversation a tapped notification is about, for the
//!   page to open.
//!
//! On Android all of it is Kotlin's (`PushBridge.kt`), reached through one
//! method that takes a small JSON request and answers JSON, so one name
//! crosses between Rust and Kotlin (`scripts/android-jni.mjs`). On an iPhone
//! it's here, in Rust (`phone_push/ios.rs`), and the notification extension
//! that opens and shows each notification is Swift
//! (`gen/apple/NotificationService/`). They share the keys through one
//! Keychain entry, whose table is `kept` below.

use serde::Serialize;

/// The push address this phone was given, and whose it is: `PushService` on
/// the wire (`apns`, `apns_sandbox` or `fcm`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PushAddress {
    pub service: String,
    pub address: String,
}

/// What a server encrypts this phone's notifications to, base64url.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PushKeys {
    pub public_key: String,
    pub auth_secret: String,
}

/// The conversation a tapped notification is about: no room for a knock.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PushOpened {
    pub server: String,
    pub room: Option<String>,
    pub message: Option<String>,
}

/// A server's base address, as the page names servers: https, short, and
/// nothing a key could be stored under by mistake.
fn server_ok(server: &str) -> bool {
    server.starts_with("https://")
        && server.len() <= 512
        && !server.chars().any(char::is_whitespace)
}

const NOT_HERE: &str = "This phone can't get Linger's notifications yet.";

/// Whether the phone lets Linger notify it: `granted`, `denied`, or `ask`
/// when it hasn't been asked. With `ask`, asks now, once; the answer comes
/// as `linger:push-permission` on the page, and this answers `asking`.
#[cfg(mobile)]
#[tauri::command]
pub async fn push_permission(ask: bool) -> String {
    crate::off_thread(move || platform::permission(ask), || "denied".to_string()).await
}

/// This phone's push address, asked of Apple or Google now. Taking a few
/// seconds the first time.
#[cfg(mobile)]
#[tauri::command]
pub async fn push_address() -> Result<PushAddress, String> {
    crate::off_thread(platform::address, || Err(NOT_HERE.to_string())).await
}

/// This phone's keys for `server`, made the first time they're asked for.
#[cfg(mobile)]
#[tauri::command]
pub async fn push_keys(server: String) -> Result<PushKeys, String> {
    if !server_ok(&server) {
        return Err("That isn't a server's address.".to_string());
    }
    crate::off_thread(
        move || platform::keys(&server),
        || Err(NOT_HERE.to_string()),
    )
    .await
}

/// Forget this phone's keys for `server`: "Nothing", or signing out. With no
/// server left, the push address goes too, so Apple or Google stop holding
/// one for an app that wants nothing.
#[cfg(mobile)]
#[tauri::command]
pub async fn push_forget(server: String) {
    if server_ok(&server) {
        crate::off_thread(move || platform::forget(&server), || ()).await;
    }
}

/// The conversation the last tapped notification is about, once: asking
/// again answers nothing until another is tapped.
#[cfg(mobile)]
#[tauri::command]
pub async fn push_opened() -> Option<PushOpened> {
    crate::off_thread(platform::opened, || None).await
}

#[cfg(target_os = "android")]
use android as platform;

#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
use ios as platform;
#[cfg(target_os = "ios")]
pub use ios::install;

/// What an iPhone keeps and hands over (#889), in plain Rust so it's tested
/// here: the table of each server's keys in the Keychain entry the
/// notification extension reads (`PushNote.table` in
/// `gen/apple/NotificationService`), and Apple's answers in the words the
/// page uses.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
mod kept {
    use std::collections::{BTreeMap, BTreeSet};

    use serde::{Deserialize, Serialize};

    use super::{server_ok, PushKeys, PushOpened};

    /// The Keychain entry the keys are kept in, as a service and an account.
    /// `NotificationService.swift` (`PushKeyStore`) reads the same.
    pub const SERVICE: &str = "im.linger.push";
    pub const ACCOUNT: &str = "keys";

    /// What a shown notification carries for a tap, as the extension writes
    /// it (`PushNote.opens`): the server, the room and the message.
    pub const TAP_SERVER: &str = "linger_server";
    pub const TAP_ROOM: &str = "linger_room";
    pub const TAP_MESSAGE: &str = "linger_message";

    /// One server's keys, base64url: the P-256 private scalar (32 bytes),
    /// the public point (65, uncompressed) and the secret (16). The
    /// extension reads the same names.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct Keys {
        pub private_key: String,
        pub public_key: String,
        pub auth_secret: String,
    }

    impl Keys {
        /// Keys from a new P-256 private key as Security.framework hands it
        /// over (`SecKeyCopyExternalRepresentation`: 04, X, Y, then the
        /// scalar), and a new secret. `None` for anything else.
        pub fn from_x963(whole: &[u8], auth: &[u8; 16]) -> Option<Self> {
            if whole.len() != 97 || whole[0] != 4 {
                return None;
            }
            Some(Self {
                private_key: base64url(&whole[65..]),
                public_key: base64url(&whole[..65]),
                auth_secret: base64url(auth),
            })
        }

        /// What a server is given: everything but the private key.
        pub fn handed_over(&self) -> PushKeys {
            PushKeys {
                public_key: self.public_key.clone(),
                auth_secret: self.auth_secret.clone(),
            }
        }
    }

    /// Every server's keys, by the server's address.
    pub type Table = BTreeMap<String, Keys>;

    /// Where the table is kept: the Keychain entry the extension reads, on
    /// an iPhone (`phone_push/ios.rs`), and memory in tests.
    pub trait Entry {
        /// The entry's bytes, `Ok(None)` when there's no entry yet, and `Err`
        /// when it's there and couldn't be read: told apart, since only no
        /// entry at all means no keys.
        fn read(&self) -> Result<Option<Vec<u8>>, ()>;
        /// Replace the entry's bytes, answering whether that was saved.
        fn write(&self, bytes: &[u8]) -> bool;
    }

    /// The keys' table, changed one server at a time, and the servers whose
    /// keys are to go but couldn't be saved gone yet (#897 review).
    ///
    /// A table that couldn't be read is never written over: that would keep
    /// only the server being changed and lose every other server's keys,
    /// whose notifications would then all show the fallback words. And
    /// forgetting a server whose removal can't be saved is owed until the
    /// next change saves: the page doesn't ask again (its server has already
    /// forgotten the phone), so the shell remembers. Owed only while the app
    /// runs; keys left after that are the ones a server gets again if it's
    /// turned back on.
    #[derive(Debug, Default)]
    pub struct Book {
        owed: BTreeSet<String>,
    }

    impl Book {
        /// None owed, as the app starts.
        pub const fn new() -> Self {
            Self {
                owed: BTreeSet::new(),
            }
        }

        /// What's kept, with the removals still owed taken out, and whether
        /// that took anything out. `None` when it couldn't be read.
        fn current(&self, entry: &dyn Entry) -> Option<(Table, bool)> {
            let mut table: Table = match entry.read() {
                Ok(None) => Table::new(),
                Ok(Some(bytes)) => serde_json::from_slice(&bytes).ok()?,
                Err(()) => return None,
            };
            let before = table.len();
            table.retain(|server, _| !self.owed.contains(server));
            let changed = table.len() != before;
            Some((table, changed))
        }

        fn save(&mut self, entry: &dyn Entry, table: &Table) -> bool {
            let saved = serde_json::to_vec(table).is_ok_and(|bytes| entry.write(&bytes));
            if saved {
                self.owed.clear();
            }
            saved
        }

        /// `server`'s keys, made with `make` and kept the first time they're
        /// asked for, so a server is given the same keys each time it
        /// registers this phone again. `None` when they couldn't be read,
        /// made or kept.
        pub fn keys(
            &mut self,
            entry: &dyn Entry,
            server: &str,
            make: impl FnOnce() -> Option<Keys>,
        ) -> Option<Keys> {
            let (mut table, changed) = self.current(entry)?;
            if let Some(keys) = table.get(server).cloned() {
                if changed {
                    // A removal still owed: now's a chance to save it.
                    self.save(entry, &table);
                }
                return Some(keys);
            }
            let keys = make()?;
            table.insert(server.to_string(), keys.clone());
            self.save(entry, &table).then_some(keys)
        }

        /// Forget `server`'s keys, so nothing it sends can be opened here.
        /// Answers whether that's saved; when it isn't, it's owed, and the
        /// next change saves it.
        pub fn forget(&mut self, entry: &dyn Entry, server: &str) -> bool {
            self.owed.insert(server.to_string());
            let Some((table, changed)) = self.current(entry) else {
                return false;
            };
            if !changed {
                // Nothing kept for it, or for any server owed: nothing to write.
                self.owed.clear();
                return true;
            }
            self.save(entry, &table)
        }
    }

    /// base64url without padding, as the server and the relay write it.
    pub fn base64url(bytes: &[u8]) -> String {
        const LETTERS: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let block = chunk.iter().enumerate().fold(0u32, |block, (i, byte)| {
                block | u32::from(*byte) << (16 - 8 * i)
            });
            for i in 0..=chunk.len() {
                let letter = (block >> (18 - 6 * i)) & 63;
                text.push(char::from(LETTERS[letter as usize]));
            }
        }
        text
    }

    /// An APNs device token as the relay takes it: lowercase hex.
    pub fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write;
        bytes.iter().fold(String::new(), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
    }

    /// iOS's `UNAuthorizationStatus` in the page's words: not asked yet is
    /// `ask`; allowed, quietly or not, is `granted`; anything else, or no
    /// answer, is `denied`.
    pub fn permission(status: Option<isize>) -> &'static str {
        match status {
            Some(0) => "ask",
            Some(2..=4) => "granted",
            _ => "denied",
        }
    }

    /// Which of Apple's push services this build's address is for
    /// (`PushService`): a build from TestFlight or the App Store, which
    /// `ios.yml` makes in release, talks to Apple's own; one run from Xcode,
    /// a debug build, to Apple's sandbox. `aps-environment` in each one's
    /// signature says the same.
    pub fn service(debug: bool) -> &'static str {
        if debug {
            "apns_sandbox"
        } else {
            "apns"
        }
    }

    /// What a tapped notification handed the app (`PushNote.opens` in the
    /// extension), read back. Nothing without a server that's one.
    pub fn opened(
        server: Option<String>,
        room: Option<String>,
        message: Option<String>,
    ) -> Option<PushOpened> {
        let server = server.filter(|server| server_ok(server))?;
        Some(PushOpened {
            server,
            room,
            message,
        })
    }
}

/// Read Kotlin's answer to a request (`PushBridge.answer`): JSON, with an
/// `error` in words when it couldn't. Kept off Android so it's tested here.
#[cfg_attr(not(any(target_os = "android", test)), allow(dead_code))]
mod answers {
    use serde_json::Value;

    use super::{PushAddress, PushKeys, PushOpened, NOT_HERE};

    fn field<'a>(answer: &'a Value, name: &str) -> Option<&'a str> {
        answer.get(name).and_then(Value::as_str)
    }

    fn failed(answer: &Value) -> String {
        field(answer, "error").map_or_else(|| NOT_HERE.to_string(), str::to_string)
    }

    pub fn permission(answer: &Value) -> String {
        match field(answer, "state") {
            Some(state @ ("granted" | "denied" | "ask" | "asking")) => state.to_string(),
            _ => "denied".to_string(),
        }
    }

    pub fn address(answer: &Value) -> Result<PushAddress, String> {
        match field(answer, "address") {
            Some(address) if !address.is_empty() => Ok(PushAddress {
                service: "fcm".to_string(),
                address: address.to_string(),
            }),
            _ => Err(failed(answer)),
        }
    }

    pub fn keys(answer: &Value) -> Result<PushKeys, String> {
        match (field(answer, "public_key"), field(answer, "auth_secret")) {
            (Some(public_key), Some(auth_secret)) => Ok(PushKeys {
                public_key: public_key.to_string(),
                auth_secret: auth_secret.to_string(),
            }),
            _ => Err(failed(answer)),
        }
    }

    pub fn opened(answer: &Value) -> Option<PushOpened> {
        let server = field(answer, "server")?;
        Some(PushOpened {
            server: server.to_string(),
            room: field(answer, "room").map(str::to_string),
            message: field(answer, "message").map(str::to_string),
        })
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JClass, JString, JValue};
    use serde_json::{json, Value};

    use super::{answers, PushAddress, PushKeys, PushOpened};
    use crate::phone_sound::android::with_env;

    /// One request to `PushBridge.answer`, through the app's class loader
    /// (a thread Rust attached sees only the system's classes by name).
    fn ask(request: &Value) -> Value {
        let answer = with_env(|env, app| {
            let loader = env
                .call_method(app, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
                .ok()?
                .l()
                .ok()?;
            let name = env
                .new_string("io.github.itsmattguenther.linger.PushBridge")
                .ok()?;
            let class = env
                .call_method(
                    &loader,
                    "loadClass",
                    "(Ljava/lang/String;)Ljava/lang/Class;",
                    &[JValue::Object(&name)],
                )
                .ok()?
                .l()
                .ok()?;
            let class = JClass::from(class);
            let text = env.new_string(request.to_string()).ok()?;
            let answer = env
                .call_static_method(
                    &class,
                    "answer",
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(app), JValue::Object(&text)],
                )
                .ok()?
                .l()
                .ok()?;
            let answer: String = env.get_string(&JString::from(answer)).ok()?.into();
            Some(answer)
        });
        answer
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null)
    }

    pub fn permission(asking: bool) -> String {
        answers::permission(&ask(
            &json!({ "do": if asking { "ask" } else { "permission" } }),
        ))
    }

    pub fn address() -> Result<PushAddress, String> {
        answers::address(&ask(&json!({ "do": "address" })))
    }

    pub fn keys(server: &str) -> Result<PushKeys, String> {
        answers::keys(&ask(&json!({ "do": "keys", "server": server })))
    }

    pub fn forget(server: &str) {
        let _ = ask(&json!({ "do": "forget", "server": server }));
    }

    pub fn opened() -> Option<PushOpened> {
        answers::opened(&ask(&json!({ "do": "opened" })))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{answers, kept, server_ok, PushAddress, PushKeys, PushOpened, NOT_HERE};

    #[test]
    fn a_server_is_an_https_address_and_nothing_else() {
        assert!(server_ok("https://linger.example"));
        assert!(!server_ok("http://linger.example"));
        assert!(!server_ok("https://linger.example/ a"));
        assert!(!server_ok(&format!("https://{}", "a".repeat(600))));
        assert!(!server_ok(""));
    }

    #[test]
    fn kotlin_s_answers_are_read_and_anything_else_is_a_no() {
        assert_eq!(
            answers::permission(&json!({ "state": "granted" })),
            "granted"
        );
        assert_eq!(answers::permission(&json!({ "state": "asking" })), "asking");
        assert_eq!(answers::permission(&json!({ "state": "maybe" })), "denied");
        assert_eq!(answers::permission(&json!(null)), "denied");

        assert_eq!(
            answers::address(&json!({ "address": "fcm-token" })),
            Ok(PushAddress {
                service: "fcm".into(),
                address: "fcm-token".into()
            })
        );
        assert_eq!(
            answers::address(&json!({ "error": "Google Play services isn't on this phone." })),
            Err("Google Play services isn't on this phone.".to_string())
        );
        assert_eq!(
            answers::address(&json!({ "address": "" })),
            Err(NOT_HERE.to_string())
        );

        assert_eq!(
            answers::keys(&json!({ "public_key": "BPub", "auth_secret": "aSec" })),
            Ok(PushKeys {
                public_key: "BPub".into(),
                auth_secret: "aSec".into()
            })
        );
        assert!(answers::keys(&json!({ "public_key": "BPub" })).is_err());

        assert_eq!(
            answers::opened(&json!({ "server": "https://s", "room": "r", "message": "m" })),
            Some(PushOpened {
                server: "https://s".into(),
                room: Some("r".into()),
                message: Some("m".into())
            })
        );
        assert_eq!(
            answers::opened(&json!({ "server": "https://s" })),
            Some(PushOpened {
                server: "https://s".into(),
                room: None,
                message: None
            })
        );
        assert_eq!(answers::opened(&json!({})), None);
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    // RFC 8291 Appendix A's keys: the public point, the private scalar and
    // the secret.
    const UA_PUBLIC: &str = "042571b2becdfde360551aaf1ed0f4cd366c11cebe555f89bcb7b186a53339173168ece2ebe018597bd30479b86e3c8f8eced577ca59187e9246990db682008b0e";
    const UA_PRIVATE: &str = "ab5757a70dd4a53e553a6bbf71ffefea2874ec07a6b379e3c48f895a02dc33de";
    const AUTH: &str = "05305932a1c7eabe13b6cec9fda48882";

    #[test]
    fn an_iphone_s_keys_are_written_as_its_notification_extension_reads_them() {
        // The file the extension's own test reads too.
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../gen/apple/NotificationServiceTests/keys-table.json"
        ))
        .unwrap();
        let table: kept::Table = serde_json::from_value(fixture["table"].clone()).unwrap();
        assert_eq!(table.len(), 2);
        let again = serde_json::to_value(&table).unwrap();
        assert_eq!(
            again, fixture["table"],
            "written back the same, field for field"
        );

        // Keys made from Security.framework's form of a key are the RFC's own
        // when it's the RFC's key.
        let whole = [unhex(UA_PUBLIC), unhex(UA_PRIVATE)].concat();
        let auth: [u8; 16] = unhex(AUTH).try_into().unwrap();
        let keys = kept::Keys::from_x963(&whole, &auth).unwrap();
        assert_eq!(&keys, &table["https://linger.example"]);
        assert_eq!(
            keys.handed_over(),
            PushKeys {
                public_key: keys.public_key.clone(),
                auth_secret: keys.auth_secret.clone()
            },
            "a server never gets the private key"
        );
        assert!(kept::Keys::from_x963(&whole[1..], &auth).is_none());
        assert!(kept::Keys::from_x963(&[&[2u8][..], &whole[1..]].concat(), &auth).is_none());
    }

    /// The Keychain entry, in memory: what it holds, and whether reading or
    /// writing it fails.
    #[derive(Default)]
    struct Memory {
        bytes: std::cell::RefCell<Option<Vec<u8>>>,
        unreadable: std::cell::Cell<bool>,
        unwritable: std::cell::Cell<bool>,
        writes: std::cell::Cell<usize>,
    }

    impl kept::Entry for Memory {
        fn read(&self) -> Result<Option<Vec<u8>>, ()> {
            if self.unreadable.get() {
                return Err(());
            }
            Ok(self.bytes.borrow().clone())
        }
        fn write(&self, bytes: &[u8]) -> bool {
            if self.unwritable.get() {
                return false;
            }
            self.writes.set(self.writes.get() + 1);
            *self.bytes.borrow_mut() = Some(bytes.to_vec());
            true
        }
    }

    impl Memory {
        fn servers(&self) -> Vec<String> {
            let bytes = self
                .bytes
                .borrow()
                .clone()
                .unwrap_or_else(|| b"{}".to_vec());
            let table: kept::Table = serde_json::from_slice(&bytes).unwrap();
            table.into_keys().collect()
        }
    }

    fn made(n: u8) -> impl FnOnce() -> Option<kept::Keys> {
        move || {
            let mut whole = [n; 97];
            whole[0] = 4;
            kept::Keys::from_x963(&whole, &[n; 16])
        }
    }

    const A: &str = "https://a.example";
    const B: &str = "https://b.example";

    #[test]
    fn an_iphone_s_keys_are_made_once_and_kept_per_server() {
        let entry = Memory::default();
        let mut book = kept::Book::new();
        let a = book.keys(&entry, A, made(1)).unwrap();
        assert_eq!(
            book.keys(&entry, A, made(2)),
            Some(a.clone()),
            "the same keys again"
        );
        let b = book.keys(&entry, B, made(3)).unwrap();
        assert_ne!(a, b, "each server its own");
        assert_eq!(entry.servers(), [A, B]);

        assert!(book.forget(&entry, A));
        assert_eq!(entry.servers(), [B]);
        assert_ne!(
            book.keys(&entry, A, made(4)),
            Some(a),
            "new keys once forgotten"
        );

        // Signing out of a server that never had keys writes nothing.
        let writes = entry.writes.get();
        assert!(book.forget(&entry, "https://never.example"));
        assert_eq!(entry.writes.get(), writes);
    }

    #[test]
    fn keys_that_can_t_be_read_are_never_written_over() {
        let entry = Memory::default();
        let mut book = kept::Book::new();
        book.keys(&entry, A, made(1)).unwrap();

        // Locked away for a moment: no keys for B, and A's survive.
        entry.unreadable.set(true);
        assert_eq!(book.keys(&entry, B, made(2)), None);
        assert!(!book.forget(&entry, B));
        entry.unreadable.set(false);
        assert_eq!(entry.servers(), [A]);

        // Not a table at all: the same.
        *entry.bytes.borrow_mut() = Some(b"not json".to_vec());
        assert_eq!(book.keys(&entry, B, made(2)), None);
        assert_eq!(entry.bytes.borrow().as_deref(), Some(&b"not json"[..]));

        // No entry yet is the only empty table.
        let fresh = Memory::default();
        assert!(kept::Book::new().keys(&fresh, B, made(2)).is_some());
    }

    #[test]
    fn a_removal_that_can_t_be_saved_is_owed_until_the_next_change_saves() {
        let entry = Memory::default();
        let mut book = kept::Book::new();
        let a = book.keys(&entry, A, made(1)).unwrap();
        book.keys(&entry, B, made(2)).unwrap();

        entry.unwritable.set(true);
        assert!(!book.forget(&entry, A), "said not saved");
        assert_eq!(entry.servers(), [A, B], "still there");
        entry.unwritable.set(false);

        // The next change carries it: B asked for again.
        book.keys(&entry, B, made(3)).unwrap();
        assert_eq!(entry.servers(), [B], "A's went with it");

        // And A turned back on after a failed forget gets new keys.
        entry.unwritable.set(true);
        assert!(!book.forget(&entry, B));
        entry.unwritable.set(false);
        assert_ne!(book.keys(&entry, A, made(4)), Some(a));
        assert_eq!(
            entry.servers(),
            [A],
            "B's owed removal saved with A's new keys"
        );
    }

    #[test]
    fn the_names_the_extension_shares_are_the_ones_it_uses() {
        let note = include_str!("../gen/apple/NotificationService/PushNote.swift");
        for name in [kept::TAP_SERVER, kept::TAP_ROOM, kept::TAP_MESSAGE] {
            assert!(
                note.contains(&format!("\"{name}\"")),
                "PushNote.swift writes {name}"
            );
        }
        let service = include_str!("../gen/apple/NotificationService/NotificationService.swift");
        assert!(service.contains(&format!("static let service = \"{}\"", kept::SERVICE)));
        assert!(service.contains(&format!("static let account = \"{}\"", kept::ACCOUNT)));
    }

    #[test]
    fn base64url_and_hex_are_written_as_the_server_and_the_relay_read_them() {
        assert_eq!(kept::base64url(b""), "");
        assert_eq!(kept::base64url(b"f"), "Zg");
        assert_eq!(kept::base64url(b"fo"), "Zm8");
        assert_eq!(kept::base64url(b"foo"), "Zm9v");
        assert_eq!(kept::base64url(b"foob"), "Zm9vYg");
        assert_eq!(kept::base64url(&[0xfb, 0xff]), "-_8");
        assert_eq!(kept::hex(&[0x00, 0xab, 0x10, 0xff]), "00ab10ff");
        assert_eq!(kept::hex(&[]), "");
    }

    #[test]
    fn apple_s_answers_are_the_page_s_words() {
        assert_eq!(kept::permission(Some(0)), "ask");
        assert_eq!(kept::permission(Some(1)), "denied");
        for allowed in 2..=4 {
            assert_eq!(kept::permission(Some(allowed)), "granted");
        }
        assert_eq!(kept::permission(Some(9)), "denied");
        assert_eq!(kept::permission(None), "denied");

        assert_eq!(kept::service(false), "apns");
        assert_eq!(kept::service(true), "apns_sandbox");

        assert_eq!(
            kept::opened(Some("https://s".into()), Some("r".into()), None),
            Some(PushOpened {
                server: "https://s".into(),
                room: Some("r".into()),
                message: None
            })
        );
        assert_eq!(kept::opened(None, Some("r".into()), None), None);
        assert_eq!(kept::opened(Some("http://s".into()), None, None), None);
    }
}
