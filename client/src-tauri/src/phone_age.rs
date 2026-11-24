//! The age the phone's app store holds for the person, where a law makes the
//! store share it with apps (#953, SPEC §4.15). Texas's law has been in force
//! since 2026-06-04, and Apple and Google both say an app must check where it
//! applies, whatever its age rating. Linger is for people 13 and older on
//! both stores, so the one question is whether the person is under 13.
//!
//! The store decides where the check applies: Linger asks it only there, so
//! nobody anywhere else is asked to share an age. Every way the check can't
//! happen (an iPhone before iOS 26.2, a copy not installed from Google Play,
//! the store not answering, any error) answers `ok`: a check that failed
//! must never lock everybody out. The page waits a few seconds for the
//! answer at most (`core/ageCheck.ts`). The age range itself never leaves
//! this module: only `child` or `ok` reaches the page, nothing is stored,
//! and nothing is logged but which way the check went.

use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::oneshot;

/// What the page is told: `child` when the store says the person is under 13,
/// `ok` for everybody else and every failure.
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_age_check() -> &'static str {
    verdict(platform::ask().await)
}

/// The platform's answer as the page reads it: 1 is a person under 13, and
/// anything else (0 for anybody else, -1 for "couldn't tell", none at all)
/// isn't.
#[cfg_attr(not(mobile), allow(dead_code))]
fn verdict(answer: Option<i32>) -> &'static str {
    if answer == Some(1) {
        "child"
    } else {
        "ok"
    }
}

/// Everybody waiting for one answer from the store. The page asks once a
/// start, but a page the phone reloaded asks again while the first ask may
/// still be out. Only the first goes to the store, and its answer answers
/// them all: a second request failing first (a sheet already showing, Play
/// refusing a second at once) must not answer `ok` for everybody and leave
/// the real answer nobody to tell. And one that never answers is given up
/// on, so it can't keep every later ask waiting.
#[cfg_attr(not(mobile), allow(dead_code))]
struct OneAsk {
    waiting: Mutex<Vec<oneshot::Sender<i32>>>,
}

#[cfg_attr(not(mobile), allow(dead_code))]
impl OneAsk {
    const fn new() -> Self {
        Self {
            waiting: Mutex::new(Vec::new()),
        }
    }

    /// Waits with the others for the store's answer, for `within` at most:
    /// the first to wait calls `start`, which has `answer` called once the
    /// store has answered. Giving up answers -1, "couldn't tell", to
    /// everybody waiting, and the next to ask asks the store again.
    async fn ask(&self, start: impl FnOnce(), within: Duration) -> Option<i32> {
        let (sender, answer) = oneshot::channel();
        let first = {
            let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
            waiting.push(sender);
            waiting.len() == 1
        };
        if first {
            start();
        }
        match tokio::time::timeout(within, answer).await {
            Ok(answer) => answer.ok(),
            Err(_) => {
                self.answer(-1);
                None
            }
        }
    }

    /// The store's answer, for everybody waiting.
    fn answer(&self, answer: i32) {
        let waiting =
            std::mem::take(&mut *self.waiting.lock().unwrap_or_else(PoisonError::into_inner));
        for each in waiting {
            let _ = each.send(answer);
        }
    }
}

#[cfg(target_os = "ios")]
mod platform {
    //! Apple's Declared Age Range is Swift only, so the asking is in Swift,
    //! in the app (`gen/apple/linger-client_iOS/AgeCheck.swift`), behind one
    //! C function. It answers once, by calling back, from any thread.

    use std::time::Duration;

    use super::OneAsk;

    extern "C" {
        /// Asks Apple, where Apple says the app must, and calls `done` once:
        /// 1 for a person under 13, 0 for anybody else, -1 when it couldn't
        /// tell.
        fn linger_age_check(done: extern "C" fn(i32));
    }

    static ONE: OneAsk = OneAsk::new();

    /// Where the check applies Apple may answer by itself, or show its sheet,
    /// which a person reads: giving up while they do would let a child in.
    /// Nothing waits on this past the page's own few seconds, so it's long,
    /// as on Android.
    const WITHIN: Duration = Duration::from_secs(15 * 60);

    extern "C" fn answered(answer: i32) {
        ONE.answer(answer);
    }

    pub async fn ask() -> Option<i32> {
        ONE.ask(
            || {
                // SAFETY: `linger_age_check` is defined in the app's Swift
                // with this signature, takes nothing but a plain C function
                // pointer to a function that lives as long as the program,
                // and may be called from any thread: it hops to the main
                // thread itself.
                unsafe { linger_age_check(answered) };
            },
            WITHIN,
        )
        .await
    }
}

#[cfg(target_os = "android")]
mod platform {
    //! Google Play's Age Signals, in Kotlin (`AgeCheck.kt`). It waits for
    //! Play's answers on the thread that asks, so it's asked from a thread
    //! kept for blocking work, never Android's main thread.

    use std::time::Duration;

    use jni::objects::JValue;

    use super::OneAsk;
    use crate::phone_sound::android::{app_class, with_env};

    static ONE: OneAsk = OneAsk::new();

    /// Longer than the longest `AgeCheck.kt` waits for Play itself, so its
    /// own limits are the ones that end a slow check.
    const WITHIN: Duration = Duration::from_secs(16 * 60);

    pub async fn ask() -> Option<i32> {
        ONE.ask(
            || {
                tokio::task::spawn_blocking(|| {
                    let answer = with_env(|env, app| {
                        let class =
                            app_class(env, app, "io.github.itsmattguenther.linger.AgeCheck")?;
                        env.call_static_method(
                            &class,
                            "ask",
                            "(Landroid/content/Context;)I",
                            &[JValue::Object(app)],
                        )
                        .ok()?
                        .i()
                        .ok()
                    });
                    ONE.answer(answer.unwrap_or(-1));
                });
            },
            WITHIN,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::time::Duration;

    use super::{verdict, OneAsk};

    #[test]
    fn only_a_definite_under_13_is_a_child() {
        assert_eq!(verdict(Some(1)), "child");
        for answer in [Some(0), Some(-1), Some(2), None] {
            assert_eq!(verdict(answer), "ok");
        }
    }

    #[tokio::test]
    async fn a_second_ask_while_the_first_is_out_waits_for_the_first_answer() {
        let one = OneAsk::new();
        let started = Cell::new(0);
        let start = || started.set(started.get() + 1);
        let within = Duration::from_secs(5);
        let (first, second, ()) =
            tokio::join!(one.ask(start, within), one.ask(start, within), async {
                tokio::task::yield_now().await;
                one.answer(1);
            });
        assert_eq!(started.get(), 1, "only the first asks the store");
        assert_eq!(
            (first, second),
            (Some(1), Some(1)),
            "the real answer reaches both"
        );
        // Answered: the next one asks again.
        let (next, ()) = tokio::join!(one.ask(start, within), async {
            tokio::task::yield_now().await;
            one.answer(0);
        });
        assert_eq!((started.get(), next), (2, Some(0)));
    }

    #[tokio::test]
    async fn a_store_that_never_answers_is_given_up_on_and_asked_again() {
        let one = OneAsk::new();
        let started = Cell::new(0);
        let start = || started.set(started.get() + 1);
        let gave_up = one.ask(start, Duration::from_millis(20)).await;
        assert_eq!(gave_up, None, "couldn't tell, which is ok");
        let (again, ()) = tokio::join!(one.ask(start, Duration::from_secs(5)), async {
            tokio::task::yield_now().await;
            one.answer(1);
        });
        assert_eq!(
            (started.get(), again),
            (2, Some(1)),
            "the next ask goes to the store again"
        );
    }
}
