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
//! must never lock everybody out. The page doesn't wait for the answer
//! (`core/ageCheck.ts`). The age range itself never leaves this module: only
//! `child` or `ok` reaches the page, nothing is stored, and nothing is
//! logged but which way the check went.

/// What the page is told: `child` when the store says the person is under 13,
/// `ok` for everybody else and every failure.
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_age_check() -> &'static str {
    verdict(platform::ask().await)
}

/// The platform's answer as the page reads it: only a definite "under 13" is
/// a child.
#[cfg_attr(not(mobile), allow(dead_code))]
fn verdict(under_13: Option<bool>) -> &'static str {
    if under_13 == Some(true) {
        "child"
    } else {
        "ok"
    }
}

#[cfg(target_os = "ios")]
mod platform {
    //! Apple's Declared Age Range is Swift only, so the asking is in Swift,
    //! in the app (`gen/apple/linger-client_iOS/AgeCheck.swift`), behind one
    //! C function. It answers once, by calling back, from any thread.

    use std::sync::{Mutex, PoisonError};

    use tokio::sync::oneshot;

    extern "C" {
        /// Asks Apple, where Apple says the app must, and calls `done` once:
        /// 1 for a person under 13, 0 for anybody else, -1 when it couldn't
        /// tell.
        fn linger_age_check(done: extern "C" fn(i32));
    }

    /// The pages waiting for an answer. The page asks once a start, but a
    /// second ask while the first is out is answered by the same call back.
    static WAITING: Mutex<Vec<oneshot::Sender<i32>>> = Mutex::new(Vec::new());

    extern "C" fn answered(answer: i32) {
        let waiting = std::mem::take(&mut *WAITING.lock().unwrap_or_else(PoisonError::into_inner));
        for each in waiting {
            let _ = each.send(answer);
        }
    }

    pub async fn ask() -> Option<bool> {
        let (sender, answer) = oneshot::channel();
        WAITING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(sender);
        // SAFETY: `linger_age_check` is defined in the app's Swift with this
        // signature, takes nothing but a plain C function pointer to a
        // function that lives as long as the program, and may be called from
        // any thread: it hops to the main thread itself.
        unsafe { linger_age_check(answered) };
        match answer.await {
            Ok(1) => Some(true),
            Ok(0) => Some(false),
            _ => None,
        }
    }
}

#[cfg(target_os = "android")]
mod platform {
    //! Google Play's Age Signals, in Kotlin (`AgeCheck.kt`). It waits for
    //! Play's answers on the thread that asks, so it's asked from a thread
    //! kept for blocking work, never Android's main thread.

    use jni::objects::JValue;

    use crate::phone_sound::android::{app_class, with_env};

    pub async fn ask() -> Option<bool> {
        let answer = tokio::task::spawn_blocking(|| {
            with_env(|env, app| {
                let class = app_class(env, app, "io.github.itsmattguenther.linger.AgeCheck")?;
                env.call_static_method(
                    &class,
                    "ask",
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
        .flatten()?;
        match answer {
            1 => Some(true),
            0 => Some(false),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::verdict;

    #[test]
    fn only_a_definite_under_13_is_a_child() {
        assert_eq!(verdict(Some(true)), "child");
        assert_eq!(verdict(Some(false)), "ok");
        assert_eq!(verdict(None), "ok");
    }
}
