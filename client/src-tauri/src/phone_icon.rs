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

/// Puts a look on the Home Screen: true once the phone has taken it (an
/// iPhone makes the change just after). A name `LOOKS` doesn't have changes
/// nothing.
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_icon_set(look: String) -> bool {
    match place(&look) {
        Some(at) => platform::set(at).await == Some(1),
        None => false,
    }
}

/// How Swift answers: the ask's number back, then the answer.
#[cfg(target_os = "ios")]
type AppleAnswer = extern "C" fn(i32, i32);

/// Asks Swift for the look in use, with the ask's number, and has it call
/// back with its place.
#[cfg(target_os = "ios")]
type AppleCurrent = extern "C" fn(i32, AppleAnswer);

/// Asks Swift to put a look on the Home Screen, with the ask's number, and
/// has it call back at once with 1 when the look is one the phone can show,
/// 0 when it isn't. iOS makes the change afterwards, in Swift's own order.
#[cfg(target_os = "ios")]
type AppleSet = extern "C" fn(i32, i32, AppleAnswer);

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

/// One ask at a time, answered by a callback that sends its number back (the
/// iPhone's Swift, which answers straight from the main thread and never
/// waits on iOS first). An answer with any other number finds nobody.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
struct Ask {
    turn: tokio::sync::Mutex<()>,
    waiting: std::sync::Mutex<Option<(i32, tokio::sync::oneshot::Sender<i32>)>>,
    next: std::sync::atomic::AtomicI32,
}

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
impl Ask {
    const fn new() -> Self {
        Self {
            turn: tokio::sync::Mutex::const_new(()),
            waiting: std::sync::Mutex::new(None),
            next: std::sync::atomic::AtomicI32::new(1),
        }
    }

    /// Asks once the one before has its answer: `start` gets this ask's
    /// number to hand over, and the answer waited for is the one that comes
    /// back with it.
    async fn ask(&self, start: impl FnOnce(i32)) -> Option<i32> {
        let _turn = self.turn.lock().await;
        let number = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (sender, answer) = tokio::sync::oneshot::channel();
        *self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((number, sender));
        start(number);
        answer.await.ok()
    }

    /// An answer: for the ask waiting with this number, or for nobody.
    fn answer(&self, number: i32, value: i32) {
        let mut waiting = self
            .waiting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if waiting.as_ref().is_some_and(|(asked, _)| *asked == number) {
            if let Some((_, sender)) = waiting.take() {
                let _ = sender.send(value);
            }
        }
    }
}

#[cfg(target_os = "ios")]
mod platform {
    //! Each way one ask at a time, answered by Swift calling back from the
    //! main thread with the ask's number.

    use super::{Ask, APPLE};

    static CURRENT: Ask = Ask::new();
    static SET: Ask = Ask::new();

    extern "C" fn current_answered(number: i32, place: i32) {
        CURRENT.answer(number, place);
    }

    extern "C" fn set_answered(number: i32, done: i32) {
        SET.answer(number, done);
    }

    pub async fn current() -> Option<i32> {
        CURRENT
            .ask(|number| match APPLE.get() {
                Some((current, _)) => current(number, current_answered),
                // Not handed over: the app's own icon is all there is.
                None => current_answered(number, 0),
            })
            .await
    }

    pub async fn set(place: i32) -> Option<i32> {
        SET.ask(|number| match APPLE.get() {
            Some((_, set)) => set(place, number, set_answered),
            None => set_answered(number, 0),
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
    use std::cell::Cell;

    use super::{look_at, place, Ask, LOOKS};

    #[tokio::test]
    async fn an_ask_gets_the_answer_that_comes_back_with_its_number() {
        let ask = Ask::new();
        let handed = Cell::new(0);
        let (got, ()) = tokio::join!(ask.ask(|number| handed.set(number)), async {
            tokio::task::yield_now().await;
            // Another number's answer first: not this ask's.
            ask.answer(handed.get() + 7, 0);
            ask.answer(handed.get(), 1);
        });
        assert_eq!(got, Some(1));
    }

    #[tokio::test]
    async fn the_next_ask_waits_for_the_one_before_and_gets_its_own_answer() {
        let ask = Ask::new();
        let (first, second) = (Cell::new(0), Cell::new(0));
        let (one, two, ()) = tokio::join!(
            ask.ask(|number| first.set(number)),
            ask.ask(|number| second.set(number)),
            async {
                tokio::task::yield_now().await;
                assert_eq!(second.get(), 0, "the second hasn't started yet");
                ask.answer(first.get(), 1);
                for _ in 0..10 {
                    tokio::task::yield_now().await;
                }
                assert_ne!(
                    second.get(),
                    0,
                    "the second started once the first had its answer"
                );
                // The first's number again: nobody's now.
                ask.answer(first.get(), 1);
                ask.answer(second.get(), 0);
            }
        );
        assert_eq!((one, two), (Some(1), Some(0)));
    }

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
