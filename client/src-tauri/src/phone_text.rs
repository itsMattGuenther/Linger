//! How big the phone draws text (SPEC §4.15): its Font size setting, as a
//! factor of the usual. The page applies it to Linger's text, lines, rows and
//! controls together (`followTextSize` in core/phone.ts, styles/tokens.css).
//!
//! Android's web view would otherwise enlarge fonts and line spacing by
//! itself and nothing around them: rows and controls kept the usual size and
//! cut the words in half (the emulator at its largest Font size,
//! 2026-10-03). So MainActivity turns that off (`textZoom` 100), and Linger
//! sizes everything from this one number instead.

/// The phone's Font size as a factor of the usual: from 1 up to 2, the
/// largest Android offers. A phone set smaller than the usual shrinks
/// nothing, and one that can't be asked, or an iPhone, whose web view doesn't
/// follow its text size by itself either, is the usual.
#[cfg(mobile)]
#[tauri::command]
pub fn phone_text_scale() -> f32 {
    #[cfg(target_os = "android")]
    {
        android::font_scale().map_or(1.0, bounded)
    }
    #[cfg(not(target_os = "android"))]
    {
        1.0
    }
}

/// Between the usual and twice it, and the usual for anything that isn't a
/// number.
fn bounded(scale: f32) -> f32 {
    if scale.is_finite() {
        scale.clamp(1.0, 2.0)
    } else {
        1.0
    }
}

#[cfg(target_os = "android")]
mod android {
    use crate::phone_sound::android::with_env;

    /// `Configuration.fontScale`, read from the application's resources,
    /// which follow the phone's setting as it changes.
    pub fn font_scale() -> Option<f32> {
        with_env(|env, app| {
            let resources = env
                .call_method(app, "getResources", "()Landroid/content/res/Resources;", &[])
                .ok()?
                .l()
                .ok()?;
            let configuration = env
                .call_method(
                    &resources,
                    "getConfiguration",
                    "()Landroid/content/res/Configuration;",
                    &[],
                )
                .ok()?
                .l()
                .ok()?;
            env.get_field(&configuration, "fontScale", "F")
                .ok()?
                .f()
                .ok()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::bounded;

    #[test]
    fn keeps_the_phones_text_size_between_the_usual_and_twice_it() {
        assert!((bounded(1.3) - 1.3).abs() < f32::EPSILON);
        assert!((bounded(2.0) - 2.0).abs() < f32::EPSILON);
        assert!((bounded(0.85) - 1.0).abs() < f32::EPSILON);
        assert!((bounded(3.5) - 2.0).abs() < f32::EPSILON);
        assert!((bounded(f32::NAN) - 1.0).abs() < f32::EPSILON);
        assert!((bounded(f32::INFINITY) - 1.0).abs() < f32::EPSILON);
    }
}
