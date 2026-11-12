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
//! crosses between Rust and Kotlin (`scripts/android-jni.mjs`).

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
    server.starts_with("https://") && server.len() <= 512 && !server.chars().any(char::is_whitespace)
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
    crate::off_thread(move || platform::keys(&server), || Err(NOT_HERE.to_string())).await
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

#[cfg(all(mobile, not(target_os = "android")))]
mod platform {
    //! The iPhone's comes with #889. Until then it says it can't.
    use super::{PushAddress, PushKeys, PushOpened, NOT_HERE};

    pub fn permission(_ask: bool) -> String {
        "denied".to_string()
    }
    pub fn address() -> Result<PushAddress, String> {
        Err(NOT_HERE.to_string())
    }
    pub fn keys(_server: &str) -> Result<PushKeys, String> {
        Err(NOT_HERE.to_string())
    }
    pub fn forget(_server: &str) {}
    pub fn opened() -> Option<PushOpened> {
        None
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
        answers::permission(&ask(&json!({ "do": if asking { "ask" } else { "permission" } })))
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

    use super::{answers, server_ok, PushAddress, PushKeys, PushOpened, NOT_HERE};

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
        assert_eq!(answers::permission(&json!({ "state": "granted" })), "granted");
        assert_eq!(answers::permission(&json!({ "state": "asking" })), "asking");
        assert_eq!(answers::permission(&json!({ "state": "maybe" })), "denied");
        assert_eq!(answers::permission(&json!(null)), "denied");

        assert_eq!(
            answers::address(&json!({ "address": "fcm-token" })),
            Ok(PushAddress { service: "fcm".into(), address: "fcm-token".into() })
        );
        assert_eq!(
            answers::address(&json!({ "error": "Google Play services isn't on this phone." })),
            Err("Google Play services isn't on this phone.".to_string())
        );
        assert_eq!(answers::address(&json!({ "address": "" })), Err(NOT_HERE.to_string()));

        assert_eq!(
            answers::keys(&json!({ "public_key": "BPub", "auth_secret": "aSec" })),
            Ok(PushKeys { public_key: "BPub".into(), auth_secret: "aSec".into() })
        );
        assert!(answers::keys(&json!({ "public_key": "BPub" })).is_err());

        assert_eq!(
            answers::opened(&json!({ "server": "https://s", "room": "r", "message": "m" })),
            Some(PushOpened { server: "https://s".into(), room: Some("r".into()), message: Some("m".into()) })
        );
        assert_eq!(
            answers::opened(&json!({ "server": "https://s" })),
            Some(PushOpened { server: "https://s".into(), room: None, message: None })
        );
        assert_eq!(answers::opened(&json!({})), None);
    }
}
