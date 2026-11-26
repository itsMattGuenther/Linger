//! The Home Screen icon a person picks on a phone (#961, SPEC §4.15), in
//! Settings › Appearance: the door with its light on, which the app has to
//! start, or one of five more looks the app carries. The page says a look by
//! its name; the phone gets its place in `LOOKS`, which is the same on every
//! platform (scripts/app-icon-looks.mjs, whose test checks this list, the
//! Swift and the Kotlin agree).
//!
//! On an iPhone they're Apple's alternate icons (`AppIcon.swift`), and iOS
//! says each change itself. On Android each look is a launcher entry of its
//! own and one is on (`AppIcon.kt`), so a change restarts the app, which the
//! page says first. Nothing about it leaves the phone.

/// The looks, in the order every platform numbers them.
const LOOKS: [&str; 6] = [
    "door",
    "after-dark",
    "porch-light",
    "daylight",
    "dusk",
    "original",
];

/// A look's place in `LOOKS`, or none for a name it doesn't have.
#[cfg_attr(not(mobile), allow(dead_code))]
fn place(look: &str) -> Option<i32> {
    LOOKS
        .iter()
        .position(|known| *known == look)
        .and_then(|at| i32::try_from(at).ok())
}

/// The look at a place: the door for any place `LOOKS` doesn't have, as
/// for a phone that couldn't say.
#[cfg_attr(not(mobile), allow(dead_code))]
fn look_at(place: i32) -> &'static str {
    usize::try_from(place)
        .ok()
        .and_then(|at| LOOKS.get(at))
        .copied()
        .unwrap_or(LOOKS[0])
}

/// The look on the Home Screen now.
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_icon() -> &'static str {
    look_at(platform::current().await.unwrap_or(0))
}

/// Puts a look on the Home Screen: true once the phone has it. A name
/// `LOOKS` doesn't have changes nothing.
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_icon_set(look: String) -> bool {
    match place(&look) {
        Some(at) => platform::set(at).await == Some(1),
        None => false,
    }
}

/// Asks Swift for the look in use, and has it call back with its place.
#[cfg(target_os = "ios")]
type AppleCurrent = extern "C" fn(extern "C" fn(i32));

/// Asks Swift to put a look on the Home Screen, and has it call back with 1
/// once iOS has, 0 if it didn't.
#[cfg(target_os = "ios")]
type AppleSet = extern "C" fn(i32, extern "C" fn(i32));

/// The app's Swift (`gen/apple/linger-client_iOS/AppIcon.swift`), handed
/// over by the app's `main.mm` before the app starts, as the age check's is
/// (`phone_age.rs`): this library is also linked on its own, where the
/// app's Swift isn't.
#[cfg(target_os = "ios")]
static APPLE: std::sync::OnceLock<(AppleCurrent, AppleSet)> = std::sync::OnceLock::new();

/// Called once, by the app's `main.mm`, with Swift's two functions.
#[cfg(target_os = "ios")]
#[no_mangle]
pub extern "C" fn linger_register_icon(current: AppleCurrent, set: AppleSet) {
    let _ = APPLE.set((current, set));
}

#[cfg(target_os = "ios")]
mod platform {
    //! One ask at a time each way, answered by Swift calling back from the
    //! main thread, which it does on every path (`AppIcon.swift`). Each ask
    //! waits for its own answer, with no time limit: one given up on would
    //! leave its answer to arrive late and answer the next ask instead.

    use std::sync::{Mutex, PoisonError};

    use tokio::sync::oneshot;

    use super::APPLE;

    struct Ask {
        turn: tokio::sync::Mutex<()>,
        waiting: Mutex<Option<oneshot::Sender<i32>>>,
    }

    impl Ask {
        const fn new() -> Self {
            Self {
                turn: tokio::sync::Mutex::const_new(()),
                waiting: Mutex::new(None),
            }
        }

        async fn ask(&self, start: impl FnOnce()) -> Option<i32> {
            let _turn = self.turn.lock().await;
            let (sender, answer) = oneshot::channel();
            *self.waiting.lock().unwrap_or_else(PoisonError::into_inner) = Some(sender);
            start();
            answer.await.ok()
        }

        fn answer(&self, value: i32) {
            if let Some(waiting) = self
                .waiting
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
            {
                let _ = waiting.send(value);
            }
        }
    }

    static CURRENT: Ask = Ask::new();
    static SET: Ask = Ask::new();

    extern "C" fn current_answered(place: i32) {
        CURRENT.answer(place);
    }

    extern "C" fn set_answered(done: i32) {
        SET.answer(done);
    }

    pub async fn current() -> Option<i32> {
        CURRENT
            .ask(|| match APPLE.get() {
                Some((current, _)) => current(current_answered),
                // Not handed over: the app's own icon is all there is.
                None => current_answered(0),
            })
            .await
    }

    pub async fn set(place: i32) -> Option<i32> {
        SET.ask(|| match APPLE.get() {
            Some((_, set)) => set(place, set_answered),
            None => set_answered(0),
        })
        .await
    }
}

#[cfg(target_os = "android")]
mod platform {
    //! `AppIcon.kt`, asked from a thread kept for blocking work: the
    //! package manager answers on the thread that asks.

    use jni::objects::JValue;

    use crate::phone_sound::android::{app_class, with_env};

    const CLASS: &str = "io.github.itsmattguenther.linger.AppIcon";

    pub async fn current() -> Option<i32> {
        tokio::task::spawn_blocking(|| {
            with_env(|env, app| {
                let class = app_class(env, app, CLASS)?;
                env.call_static_method(
                    &class,
                    "current",
                    "(Landroid/content/Context;)I",
                    &[JValue::Object(app)],
                )
                .ok()?
                .i()
                .ok()
            })
        })
        .await
        .ok()
        .flatten()
    }

    pub async fn set(place: i32) -> Option<i32> {
        tokio::task::spawn_blocking(move || {
            with_env(|env, app| {
                let class = app_class(env, app, CLASS)?;
                env.call_static_method(
                    &class,
                    "set",
                    "(Landroid/content/Context;I)I",
                    &[JValue::Object(app), JValue::Int(place)],
                )
                .ok()?
                .i()
                .ok()
            })
        })
        .await
        .ok()
        .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::{look_at, place, LOOKS};

    #[test]
    fn every_look_has_its_place_and_back() {
        for (at, look) in LOOKS.iter().enumerate() {
            let at = i32::try_from(at).unwrap();
            assert_eq!(place(look), Some(at));
            assert_eq!(look_at(at), *look);
        }
    }

    #[test]
    fn a_name_it_does_not_have_changes_nothing() {
        for look in ["", "Door", "porch", "../door", "door ", "6"] {
            assert_eq!(place(look), None, "{look:?}");
        }
    }

    #[test]
    fn a_place_a_phone_gets_wrong_is_the_door() {
        for at in [-1, 6, i32::MAX, i32::MIN] {
            assert_eq!(look_at(at), "door");
        }
    }
}
