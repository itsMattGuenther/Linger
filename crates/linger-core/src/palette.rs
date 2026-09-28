//! The 16-color name palette (SPEC §5.4) — the replacement for free color picking.
//!
//! Colors travel as *named keys* (`"azure"`), never as hex or OKLCH literals. Each
//! key maps to one OKLCH hue at one lightness, so contrast against the background is
//! guaranteed by construction and nothing is clamped at runtime. The app is dark
//! only (SPEC §5.3). The property test at the bottom asserts ≥4.5:1 for all 16 keys,
//! against the background and its evening version, and runs in CI — it is the guard
//! against someone "improving" a value later.

/// oklch(0.76 0.13 hue) · slate: chroma 0.02.
const LIGHTNESS: f64 = 0.76;
const CHROMA: f64 = 0.13;
const SLATE_C: f64 = 0.02;

/// The background the palette must hold ≥4.5:1 against (SPEC §5.3 surface-0).
pub const DARK_BG: &str = "#16181C";

/// The same surface after the post-sunset warmth shift (SPEC §4.7).
///
/// It is here for one reason: warmth changes what the palette is read against,
/// so the contrast guarantee has to be checked against it too or it is only
/// true until dusk. The shift keeps each token's OKLab lightness and rotates
/// its hue to the amber side, which is exactly why the guarantee survives it —
/// a temperature change, not a brightness change.
pub const DARK_BG_WARM: &str = "#1A1714";

/// One named palette entry: a key and its OKLCH hue.
#[derive(Debug, Clone, Copy)]
pub struct PaletteColor {
    pub key: &'static str,
    pub hue: f64,
    /// slate is the one desaturated entry (chroma 0.02 instead of 0.13).
    pub muted: bool,
}

const fn c(key: &'static str, hue: f64) -> PaletteColor {
    PaletteColor {
        key,
        hue,
        muted: false,
    }
}

/// The IRC 16, remapped through OKLCH. Order matters only for the picker UI.
pub const PALETTE: [PaletteColor; 16] = [
    c("ember", 32.0),
    c("rust", 50.0),
    c("amber", 68.0),
    c("brass", 90.0),
    c("lime", 118.0),
    c("fern", 145.0),
    c("mint", 162.0),
    c("teal", 180.0),
    c("cyan", 200.0),
    c("sky", 230.0),
    c("azure", 255.0),
    c("indigo", 275.0),
    c("violet", 295.0),
    c("orchid", 320.0),
    c("rose", 350.0),
    PaletteColor {
        key: "slate",
        hue: 250.0,
        muted: true,
    },
];

/// Whether `key` names a palette color. This is what the server validates wire
/// `ColorKey` values against — client-side validation alone is a defect.
pub fn is_valid_color_key(key: &str) -> bool {
    PALETTE.iter().any(|p| p.key == key)
}

/// Look up a palette entry by key.
pub fn get(key: &str) -> Option<&'static PaletteColor> {
    PALETTE.iter().find(|p| p.key == key)
}

impl PaletteColor {
    /// The OKLCH components for this color.
    #[must_use]
    pub fn oklch(&self) -> (f64, f64, f64) {
        let chroma = if self.muted { SLATE_C } else { CHROMA };
        (LIGHTNESS, chroma, self.hue)
    }

    /// sRGB hex fallback (`#rrggbb`), gamut-clipped. The build ships these in case
    /// the target WebKitGTK's `oklch()` support falls through (SPEC §5.4).
    #[must_use]
    pub fn hex(&self) -> String {
        let (l, ch, h) = self.oklch();
        let (r, g, b) = oklch_to_srgb(l, ch, h);
        format!(
            "#{:02X}{:02X}{:02X}",
            (r * 255.0).round() as u8,
            (g * 255.0).round() as u8,
            (b * 255.0).round() as u8
        )
    }

    /// The `oklch()` CSS literal for this color.
    #[must_use]
    pub fn css_oklch(&self) -> String {
        let (l, ch, h) = self.oklch();
        format!("oklch({l} {ch} {h})")
    }
}

/// CSS custom properties for every palette entry, e.g.
/// `--name-azure: oklch(0.76 0.13 255);`. This is what the client build emits,
/// so the palette is defined exactly once — here.
///
/// The values are `oklch()` literals rather than the hex fallbacks because T-002
/// answered that question against a real engine: WebKitGTK 2.52.3 rendered all
/// 16 keys byte-identically to [`PaletteColor::hex`]. Hex would also
/// have been safe, but it is clipped to sRGB, and a custom property cannot carry
/// a fallback declaration the way a normal property can — an unparsable value in
/// `--name-azure` is not dropped at parse time, it fails later at substitution.
/// So there is exactly one value per key and it is the wider-gamut one.
#[must_use]
pub fn css_variables() -> String {
    PALETTE
        .iter()
        .map(|p| format!("--name-{}: {};", p.key, p.css_oklch()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The whole generated stylesheet: every key, on `:root`, one file.
///
/// The client imports the result as `palette.generated.css`.
#[must_use]
pub fn stylesheet() -> String {
    const HEADER: &str = r#"/*
 * The 16-color name palette (SPEC §5.4). Generated — do not edit.
 *
 * Source of truth: `linger-core::palette::PALETTE`. Rewritten by
 * `cargo test -p linger-core`, committed, and checked for drift in CI alongside
 * the TypeScript bindings. Editing this file by hand is a defect: the next test
 * run throws the edit away.
 *
 * Colors are palette *keys* everywhere else in this codebase (AGENTS rule 12).
 * This file is the one place a key becomes a color, and these values are the
 * only reason `var(--name-azure)` draws anything.
 */"#;

    let body = css_variables()
        .lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{HEADER}\n\n:root {{\n{body}\n}}\n")
}

/// Where the generated stylesheet is written, next to the ts-rs bindings.
///
/// `TS_RS_EXPORT_DIR` is set in `.cargo/config.toml` and is the directory CI's
/// drift check watches, so pointing at it means the palette gets that check for
/// free rather than needing a second one.
#[cfg(test)]
fn generated_dir() -> std::path::PathBuf {
    match std::env::var("TS_RS_EXPORT_DIR") {
        Ok(dir) => std::path::PathBuf::from(dir),
        // A toolchain invoked without the workspace config still lands in the
        // right place rather than writing the file somewhere nobody looks.
        Err(_) => {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../client/src/generated")
        }
    }
}

// ---------------------------------------------------------------------------
// Color math. OKLCH → OKLab → linear sRGB → gamma sRGB, then WCAG contrast.
// Matrices from Björn Ottosson's OKLab reference implementation.
// ---------------------------------------------------------------------------

fn oklch_to_srgb(l: f64, chroma: f64, hue_deg: f64) -> (f64, f64, f64) {
    let hr = hue_deg.to_radians();
    let a = chroma * hr.cos();
    let b = chroma * hr.sin();

    let l_ = l + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
    let m_ = l - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
    let s_ = l - 0.089_484_177_5 * a - 1.291_485_548_0 * b;

    let l3 = l_ * l_ * l_;
    let m3 = m_ * m_ * m_;
    let s3 = s_ * s_ * s_;

    let r = 4.076_741_662_1 * l3 - 3.307_711_591_3 * m3 + 0.230_969_929_2 * s3;
    let g = -1.268_438_004_6 * l3 + 2.609_757_401_1 * m3 - 0.341_319_396_5 * s3;
    let b = -0.004_196_086_3 * l3 - 0.703_418_614_7 * m3 + 1.707_614_701_0 * s3;

    (
        gamma(r.clamp(0.0, 1.0)),
        gamma(g.clamp(0.0, 1.0)),
        gamma(b.clamp(0.0, 1.0)),
    )
}

fn gamma(linear: f64) -> f64 {
    if linear <= 0.003_130_8 {
        12.92 * linear
    } else {
        1.055 * linear.powf(1.0 / 2.4) - 0.055
    }
}

fn linearize(channel: f64) -> f64 {
    if channel <= 0.040_45 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn hex_to_rgb(hex: &str) -> (f64, f64, f64) {
    let h = hex.trim_start_matches('#');
    let parse = |i: usize| f64::from(u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0)) / 255.0;
    (parse(0), parse(2), parse(4))
}

fn relative_luminance((r, g, b): (f64, f64, f64)) -> f64 {
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/// WCAG contrast ratio between two `#rrggbb` colors.
#[must_use]
pub fn contrast_ratio(hex_a: &str, hex_b: &str) -> f64 {
    let la = relative_luminance(hex_to_rgb(hex_a));
    let lb = relative_luminance(hex_to_rgb(hex_b));
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CI guard from PROTOCOL §5 / AGENTS.md: every palette key must hold
    /// ≥4.5:1 against the background. If this fails, a palette value was
    /// changed in a way that breaks structural contrast safety — fix the value,
    /// never this test.
    ///
    /// The ratios here are only as trustworthy as [`PaletteColor::hex`], so that
    /// conversion was checked against a real engine during T-002: all 16 keys
    /// were rendered as `oklch()` by WebKitGTK 2.52.3 and read back from a
    /// canvas, agreeing with this code exactly (0/255 per channel).
    #[test]
    fn all_16_keys_hold_contrast() {
        for color in &PALETTE {
            // Both surfaces: the neutral one and the one after dusk (SPEC
            // §4.7). A guarantee that lapses at sunset is not a guarantee.
            for bg in [DARK_BG, DARK_BG_WARM] {
                let hex = color.hex();
                let ratio = contrast_ratio(&hex, bg);
                assert!(
                    ratio >= 4.5,
                    "{} is {hex} → {ratio:.2}:1 against {bg}, below 4.5:1",
                    color.key
                );
            }
        }
    }

    #[test]
    fn palette_is_exactly_the_named_16() {
        assert_eq!(PALETTE.len(), 16);
        for key in [
            "ember", "rust", "amber", "brass", "lime", "fern", "mint", "teal", "cyan", "sky",
            "azure", "indigo", "violet", "orchid", "rose", "slate",
        ] {
            assert!(is_valid_color_key(key), "missing palette key {key}");
        }
        assert!(!is_valid_color_key("hotpink"));
        assert!(!is_valid_color_key("#ff00ff"));
    }

    #[test]
    fn known_conversion_sanity() {
        // oklch(1 0 0) is white; oklch(0 0 0) is black.
        let (r, g, b) = oklch_to_srgb(1.0, 0.0, 0.0);
        assert!(r > 0.999 && g > 0.999 && b > 0.999);
        let (r, g, b) = oklch_to_srgb(0.0, 0.0, 0.0);
        assert!(r < 0.001 && g < 0.001 && b < 0.001);
    }

    #[test]
    fn css_variables_emit_all_keys() {
        let css = css_variables();
        assert_eq!(css.lines().count(), 16);
        assert!(css.contains("--name-azure: oklch(0.76 0.13 255);"));
        assert!(css.contains("--name-slate: oklch(0.76 0.02 250);"));
        // A hex literal in this file would mean somebody re-introduced the
        // sRGB-clipped values as the shipped ones. `hex()` stays, for contrast.
        assert!(!css.contains('#'));
    }

    #[test]
    fn stylesheet_defines_every_key_once() {
        let css = stylesheet();
        assert!(css.contains(":root {"));
        assert!(!css.contains("data-theme"));
        for color in &PALETTE {
            let count = css.matches(&format!("--name-{}:", color.key)).count();
            assert_eq!(count, 1, "{} is not defined exactly once", color.key);
        }
    }

    /// Writing a source file from a test is the same trick ts-rs plays next
    /// door, and for the same reason: `cargo test --workspace` is what everyone
    /// already runs, and CI's `git diff --exit-code client/src/generated` then
    /// fails the moment a palette change lands without its stylesheet. The
    /// alternative — a build script, or a step people have to remember — is a
    /// palette that silently drifts from the one place it is defined.
    #[test]
    fn emit_palette_stylesheet() {
        let dir = generated_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("palette.generated.css");
        let css = stylesheet();
        // Only write when it actually changed: an unconditional write churns
        // the file's mtime on every test run and makes watchers rebuild.
        if std::fs::read_to_string(&path).ok().as_deref() != Some(css.as_str()) {
            std::fs::write(&path, css).unwrap();
        }
    }
}
