//! How big the phone draws text (SPEC §4.15): its text size setting, Font
//! size on Android and Text Size on an iPhone, as a factor of the usual. The
//! page applies it to Linger's text, lines, rows and controls together, with
//! the Text size chosen in Linger's Settings on top (`followTextSize` in
//! core/phone.ts, styles/tokens.css, #690).
//!
//! Android's web view would otherwise enlarge fonts and line spacing by
//! itself and nothing around them: rows and controls kept the usual size and
//! cut the words in half (the emulator at its largest Font size,
//! 2026-10-03). So MainActivity turns that off (`textZoom` 100), and Linger
//! sizes everything from this one number instead. An iPhone's web view
//! enlarges nothing by itself: Text Size reaches only text set in the
//! system's own text styles, and Linger's sizes are pixels. So the shell
//! reads the size of the body text style instead.

/// The phone's text size as a factor of the usual: from 1 up to 2, the
/// largest Android offers. A phone set smaller than the usual shrinks
/// nothing, and one that can't be asked is the usual. An iPhone's largest
/// sizes, under Accessibility's Larger Text, go past twice the usual and stop
/// at it.
#[cfg(mobile)]
#[tauri::command]
pub fn phone_text_scale() -> f32 {
    #[cfg(target_os = "android")]
    {
        android::font_scale().map_or(1.0, bounded)
    }
    #[cfg(target_os = "ios")]
    {
        bounded(ios::text_size())
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
                .call_method(
                    app,
                    "getResources",
                    "()Landroid/content/res/Resources;",
                    &[],
                )
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

#[cfg(target_os = "ios")]
mod ios {
    use objc2_ui_kit::{UIFont, UIFontTextStyleBody};

    /// The body text style's size at the usual Text Size, in points.
    const USUAL_POINTS: f64 = 17.0;

    /// The body text style's size against the usual, which follows the
    /// iPhone's Text Size and Accessibility's Larger Text as they change.
    pub fn text_size() -> f32 {
        // SAFETY: UIKit's own constant, alive as long as the app.
        let body = unsafe { UIFontTextStyleBody };
        let font = UIFont::preferredFontForTextStyle(body);
        // SAFETY: only reads the size of the font UIKit just made.
        let points = unsafe { font.pointSize() };
        (points / USUAL_POINTS) as f32
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
