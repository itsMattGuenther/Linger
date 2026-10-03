//! The phone app's sounds (SPEC §4.15). Linger's chimes follow the phone's own
//! sound setting: its ringer at sound, vibrate or silent, with Do Not Disturb
//! counting as silent. The page asks before every chime (`lib/sound.ts`,
//! `followDeviceSound`) and, on vibrate, buzzes instead.
//!
//! On Android a chime and a buzz go out the way a message app's should, as
//! notification sounds, through Android's own player rather than the web
//! view's: they follow the notification volume and the phone's notification
//! vibration setting, not the media volume and touch feedback, and they play
//! without the page having been touched first, which a web view asks before
//! it makes any sound. `sound_play` answers the same call the desktop's does
//! (`voice_commands.rs`).
//!
//! An iPhone's silent switch already mutes the web view's sounds, and it has
//! no ringer setting an app can read, so there it's all the page's.

use serde::Serialize;

/// What a chime may do right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SoundMode {
    Sound,
    Vibrate,
    Silent,
}

/// Android's own numbers, as `NotificationManager.getCurrentInterruptionFilter`
/// and `AudioManager.getRingerMode` answer them. Any Do Not Disturb (priority
/// only, alarms only, total silence) is silent: a chime is never one of the
/// interruptions somebody let through. An answer Android doesn't document
/// plays, as a phone that couldn't be asked does.
fn from_android(interruption_filter: i32, ringer_mode: i32) -> SoundMode {
    const FILTER_PRIORITY: i32 = 2;
    const FILTER_NONE: i32 = 3;
    const FILTER_ALARMS: i32 = 4;
    const RINGER_SILENT: i32 = 0;
    const RINGER_VIBRATE: i32 = 1;
    if matches!(
        interruption_filter,
        FILTER_PRIORITY | FILTER_NONE | FILTER_ALARMS
    ) {
        return SoundMode::Silent;
    }
    match ringer_mode {
        RINGER_SILENT => SoundMode::Silent,
        RINGER_VIBRATE => SoundMode::Vibrate,
        _ => SoundMode::Sound,
    }
}

/// The longest buzz the page may ask for, each part, and how many parts.
const MAX_BUZZ_MS: u32 = 400;
const MAX_BUZZ_PARTS: usize = 8;

/// A buzz as the page asked for it, made safe: on and off in turn, starting
/// on, each part at most [`MAX_BUZZ_MS`], at most [`MAX_BUZZ_PARTS`] of them.
/// `None` for nothing to buzz.
fn buzz_timings(pattern: &[u32]) -> Option<Vec<i64>> {
    if pattern.is_empty() || pattern.len() > MAX_BUZZ_PARTS {
        return None;
    }
    // Android's waveform starts with a wait.
    let mut timings = vec![0];
    timings.extend(pattern.iter().map(|ms| i64::from((*ms).min(MAX_BUZZ_MS))));
    Some(timings)
}

/// Asked before every chime on the phone. Off a phone, or when Android can't
/// be asked, everything plays as before.
#[tauri::command]
pub async fn phone_sound_mode() -> SoundMode {
    #[cfg(target_os = "android")]
    {
        android::mode().unwrap_or(SoundMode::Sound)
    }
    #[cfg(not(target_os = "android"))]
    {
        SoundMode::Sound
    }
}

/// A chime's buzz, with the phone on vibrate: milliseconds on and off in turn.
#[tauri::command]
pub async fn phone_buzz(pattern: Vec<u32>) {
    let Some(timings) = buzz_timings(&pattern) else {
        return;
    };
    #[cfg(target_os = "android")]
    {
        let _ = android::buzz(&timings);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = timings;
    }
}

/// One of Linger's own sounds (`lib/chimes.ts`): mono samples at
/// [`crate::cue::RATE`], already at the sound volume. Answers whether it
/// played; the page plays it through Web Audio when it didn't. `output` is
/// the desktop's speaker choice, which a phone doesn't have.
// Phone builds only: the desktop's `sound_play` has the same name.
#[cfg(mobile)]
#[tauri::command]
pub async fn sound_play(samples: Vec<i16>, output: Option<String>) -> bool {
    let _ = output;
    let Some(samples) = crate::cue::checked(samples) else {
        return false;
    };
    #[cfg(target_os = "android")]
    {
        android::play(&samples).is_some()
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = samples;
        false
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::objects::{JObject, JValue};
    use jni::{AttachGuard, JNIEnv, JavaVM};

    use super::{from_android, SoundMode};

    // AudioAttributes.USAGE_NOTIFICATION and CONTENT_TYPE_SONIFICATION.
    const USAGE_NOTIFICATION: i32 = 5;
    const CONTENT_SONIFICATION: i32 = 4;
    // AudioFormat.ENCODING_PCM_16BIT and CHANNEL_OUT_MONO.
    const PCM_16BIT: i32 = 2;
    const CHANNEL_MONO: i32 = 4;
    // AudioTrack.MODE_STATIC, and AudioManager.AUDIO_SESSION_ID_GENERATE.
    const MODE_STATIC: i32 = 0;
    const NEW_SESSION: i32 = 0;

    /// The JavaVM, and the application context MainActivity handed to
    /// `ndk-context` at startup (`secrets.rs` needs it too).
    fn app() -> Option<(JavaVM, JObject<'static>)> {
        let context = ndk_context::android_context();
        // SAFETY: ndk-context holds the process's JavaVM and a global
        // reference to the application context for as long as the app runs;
        // JObject doesn't delete the reference it wraps.
        let vm = unsafe { JavaVM::from_raw(context.vm().cast()) }.ok()?;
        let app = unsafe { JObject::from_raw(context.context().cast()) };
        Some((vm, app))
    }

    /// Run `work` on this thread, attached to the VM, clearing any Java
    /// exception it leaves so the next call isn't refused.
    fn with_env<T>(work: impl FnOnce(&mut AttachGuard<'_>, &JObject) -> Option<T>) -> Option<T> {
        let (vm, app) = app()?;
        let mut env = vm.attach_current_thread().ok()?;
        let answer = work(&mut env, &app);
        if answer.is_none() {
            let _ = env.exception_clear();
        }
        answer
    }

    fn service<'local>(
        env: &mut JNIEnv<'local>,
        app: &JObject,
        name: &str,
    ) -> Option<JObject<'local>> {
        let name = env.new_string(name).ok()?;
        let found = env
            .call_method(
                app,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[JValue::Object(&name)],
            )
            .ok()?
            .l()
            .ok()?;
        (!found.is_null()).then_some(found)
    }

    fn sdk(env: &mut JNIEnv) -> Option<i32> {
        env.get_static_field("android/os/Build$VERSION", "SDK_INT", "I")
            .ok()?
            .i()
            .ok()
    }

    /// Notification sound attributes, for the player and the buzz alike.
    fn notification_attributes<'local>(env: &mut JNIEnv<'local>) -> Option<JObject<'local>> {
        let builder = env
            .new_object("android/media/AudioAttributes$Builder", "()V", &[])
            .ok()?;
        let builder = env
            .call_method(
                &builder,
                "setUsage",
                "(I)Landroid/media/AudioAttributes$Builder;",
                &[JValue::Int(USAGE_NOTIFICATION)],
            )
            .ok()?
            .l()
            .ok()?;
        let builder = env
            .call_method(
                &builder,
                "setContentType",
                "(I)Landroid/media/AudioAttributes$Builder;",
                &[JValue::Int(CONTENT_SONIFICATION)],
            )
            .ok()?
            .l()
            .ok()?;
        env.call_method(&builder, "build", "()Landroid/media/AudioAttributes;", &[])
            .ok()?
            .l()
            .ok()
    }

    pub fn mode() -> Option<SoundMode> {
        with_env(|env, app| {
            let notifications = service(env, app, "notification")?;
            let filter = env
                .call_method(&notifications, "getCurrentInterruptionFilter", "()I", &[])
                .ok()?
                .i()
                .ok()?;
            let audio = service(env, app, "audio")?;
            let ringer = env
                .call_method(&audio, "getRingerMode", "()I", &[])
                .ok()?
                .i()
                .ok()?;
            Some(from_android(filter, ringer))
        })
    }

    pub fn buzz(timings: &[i64]) -> Option<()> {
        with_env(|env, app| {
            let vibrator = service(env, app, "vibrator")?;
            let length = i32::try_from(timings.len()).ok()?;
            let waveform = env.new_long_array(length).ok()?;
            env.set_long_array_region(&waveform, 0, timings).ok()?;
            if sdk(env)? >= 26 {
                let effect = env
                    .call_static_method(
                        "android/os/VibrationEffect",
                        "createWaveform",
                        "([JI)Landroid/os/VibrationEffect;",
                        &[JValue::Object(&waveform), JValue::Int(-1)],
                    )
                    .ok()?
                    .l()
                    .ok()?;
                let attributes = notification_attributes(env)?;
                env.call_method(
                    &vibrator,
                    "vibrate",
                    "(Landroid/os/VibrationEffect;Landroid/media/AudioAttributes;)V",
                    &[JValue::Object(&effect), JValue::Object(&attributes)],
                )
                .ok()?;
            } else {
                env.call_method(
                    &vibrator,
                    "vibrate",
                    "([JI)V",
                    &[JValue::Object(&waveform), JValue::Int(-1)],
                )
                .ok()?;
            }
            Some(())
        })
    }

    /// Play the samples once through an AudioTrack of their own, then let it go
    /// once they're done.
    pub fn play(samples: &[i16]) -> Option<()> {
        let length = i32::try_from(samples.len()).ok()?;
        let track = with_env(|env, _| {
            let attributes = notification_attributes(env)?;
            let format = env
                .new_object("android/media/AudioFormat$Builder", "()V", &[])
                .ok()?;
            let rate = i32::try_from(crate::cue::RATE).ok()?;
            let format = env
                .call_method(
                    &format,
                    "setSampleRate",
                    "(I)Landroid/media/AudioFormat$Builder;",
                    &[JValue::Int(rate)],
                )
                .ok()?
                .l()
                .ok()?;
            let format = env
                .call_method(
                    &format,
                    "setEncoding",
                    "(I)Landroid/media/AudioFormat$Builder;",
                    &[JValue::Int(PCM_16BIT)],
                )
                .ok()?
                .l()
                .ok()?;
            let format = env
                .call_method(
                    &format,
                    "setChannelMask",
                    "(I)Landroid/media/AudioFormat$Builder;",
                    &[JValue::Int(CHANNEL_MONO)],
                )
                .ok()?
                .l()
                .ok()?;
            let format = env
                .call_method(&format, "build", "()Landroid/media/AudioFormat;", &[])
                .ok()?
                .l()
                .ok()?;
            let track = env
                .new_object(
                    "android/media/AudioTrack",
                    "(Landroid/media/AudioAttributes;Landroid/media/AudioFormat;III)V",
                    &[
                        JValue::Object(&attributes),
                        JValue::Object(&format),
                        JValue::Int(length.checked_mul(2)?),
                        JValue::Int(MODE_STATIC),
                        JValue::Int(NEW_SESSION),
                    ],
                )
                .ok()?;
            let pcm = env.new_short_array(length).ok()?;
            env.set_short_array_region(&pcm, 0, samples).ok()?;
            let written = env
                .call_method(
                    &track,
                    "write",
                    "([SII)I",
                    &[JValue::Object(&pcm), JValue::Int(0), JValue::Int(length)],
                )
                .ok()?
                .i()
                .ok()?;
            if written != length {
                let _ = env.call_method(&track, "release", "()V", &[]);
                return None;
            }
            env.call_method(&track, "play", "()V", &[]).ok()?;
            env.new_global_ref(track).ok()
        })?;
        // Let it go once it has played: its length, and a little over.
        let lasts = std::time::Duration::from_millis(
            u64::try_from(samples.len()).ok()? * 1000 / u64::from(crate::cue::RATE) + 250,
        );
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(lasts).await;
            let _ = with_env(|env, _| env.call_method(track.as_obj(), "release", "()V", &[]).ok().map(|_| ()));
        });
        Some(())
    }
}

#[cfg(test)]
mod tests {
    use super::{buzz_timings, from_android, SoundMode};

    #[test]
    fn follows_the_ringer() {
        assert_eq!(from_android(1, 2), SoundMode::Sound);
        assert_eq!(from_android(1, 1), SoundMode::Vibrate);
        assert_eq!(from_android(1, 0), SoundMode::Silent);
    }

    #[test]
    fn do_not_disturb_is_silent_whatever_the_ringer() {
        for filter in [2, 3, 4] {
            assert_eq!(from_android(filter, 2), SoundMode::Silent);
        }
    }

    #[tokio::test]
    async fn off_a_phone_everything_plays() {
        assert_eq!(super::phone_sound_mode().await, SoundMode::Sound);
        super::phone_buzz(vec![40]).await;
    }

    #[test]
    fn an_answer_android_doesnt_document_plays() {
        assert_eq!(from_android(0, 2), SoundMode::Sound);
        assert_eq!(from_android(1, 7), SoundMode::Sound);
    }

    #[test]
    fn a_buzz_is_kept_short() {
        assert_eq!(buzz_timings(&[40]), Some(vec![0, 40]));
        assert_eq!(buzz_timings(&[60, 90, 60]), Some(vec![0, 60, 90, 60]));
        assert_eq!(buzz_timings(&[5_000]), Some(vec![0, 400]));
        assert_eq!(buzz_timings(&[]), None);
        assert_eq!(buzz_timings(&[40; 9]), None);
    }
}
