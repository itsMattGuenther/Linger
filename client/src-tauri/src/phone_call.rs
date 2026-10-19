//! The phone's call bar (#429, SPEC §4.15): while you're in voice, the one
//! notification Linger ever shows.
//!
//! The call itself runs in the page (`src/lib/pageVoice.ts`), on the web
//! engine's own WebRTC. What the page can't do is keep running once the
//! phone is locked: Android stops a background app's microphone and network
//! within seconds, unless a foreground service holds the app up, and a
//! foreground service must show a notification. So the page says when it's
//! in voice and where, and Android's half (`VoiceCallService.kt`) shows the
//! bar, with Mute and Leave, and holds the call up until the page says it's
//! over. The iPhone needs no bar: its own call indicator does that job.

use serde::Deserialize;

/// What the bar says: where the call is, and whether you're muted or
/// deafened, which its Mute button and its line follow.
#[derive(Debug, Deserialize)]
pub struct CallBar {
    /// "#general", or a DM's people, as the voice bar says it.
    #[serde(rename = "where")]
    place: String,
    muted: bool,
    deafened: bool,
}

/// Show the call bar, or redraw it, or (`None`) take it away: the call
/// ended. Does nothing off Android.
#[cfg(mobile)]
#[tauri::command]
pub fn phone_call_bar(bar: Option<CallBar>) {
    #[cfg(target_os = "android")]
    {
        if android::update(bar.as_ref()).is_none() {
            eprintln!("phone: the call bar couldn't be shown or taken away");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bar;
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JClass, JObject, JValue};

    use super::CallBar;
    use crate::phone_sound::android::with_env;

    /// `VoiceCallService.update(context, place, muted, deafened)`. The class
    /// is the app's own, so it's found through the app's class loader: a
    /// thread Rust attached sees only Android's classes by name.
    pub fn update(bar: Option<&CallBar>) -> Option<()> {
        with_env(|env, app| {
            let loader = env
                .call_method(app, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
                .ok()?
                .l()
                .ok()?;
            let name = env
                .new_string("io.github.itsmattguenther.linger.VoiceCallService")
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
            let place = match bar {
                Some(bar) => JObject::from(env.new_string(&bar.place).ok()?),
                None => JObject::null(),
            };
            env.call_static_method(
                &class,
                "update",
                "(Landroid/content/Context;Ljava/lang/String;ZZ)V",
                &[
                    JValue::Object(app),
                    JValue::Object(&place),
                    JValue::Bool(u8::from(bar.is_some_and(|bar| bar.muted))),
                    JValue::Bool(u8::from(bar.is_some_and(|bar| bar.deafened))),
                ],
            )
            .ok()?;
            Some(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::CallBar;

    /// The page's words for it (`app/list/ListWindow.tsx`), as they arrive.
    #[test]
    fn reads_the_bar_the_page_sends() {
        let bar: CallBar =
            serde_json::from_str(r##"{"where":"#general","muted":true,"deafened":false}"##)
                .expect("a call bar");
        assert_eq!(bar.place, "#general");
        assert!(bar.muted);
        assert!(!bar.deafened);
    }
}
