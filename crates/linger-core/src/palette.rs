//! The 16-color name palette (SPEC §5.4) — the replacement for free color picking.
//!
//! Colors travel as *named keys* (`"azure"`), never as hex or OKLCH literals. Each
//! key maps to one OKLCH hue at one lightness, so contrast against the background is
//! guaranteed by construction and nothing is clamped at runtime.
//!
//! Two sets of the same 16 hues (SPEC §5.3, §5.4): the dark themes' names at
//! lightness 0.76, and Daylight's (#965), the light theme, at 0.50 so they read on
//! paper. A key is the same person's color in both; only the shade a theme draws it
//! in changes. The property tests at the bottom assert ≥4.5:1 for all 16 keys of
//! each set against its grounds, and run in CI: they are the guard against
//! someone "improving" a value later.

/// oklch(0.76 0.13 hue) · slate: chroma 0.02.
const LIGHTNESS: f64 = 0.76;
const CHROMA: f64 = 0.13;
const SLATE_C: f64 = 0.02;

/// Daylight's names (#965): oklch(0.50 0.13 hue), slate at chroma 0.025, with
/// the chroma of some hues capped (`PaletteColor::light_chroma`).
const LIGHT_LIGHTNESS: f64 = 0.5;
const LIGHT_SLATE_C: f64 = 0.025;

/// The theme the light set is for: the client's `[data-theme="daylight"]`
/// (`client/src/next/core/theme.ts`).
const LIGHT_THEME: &str = "daylight";

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

/// Daylight's window (`--surface-window` there, #965): the paper the light set
/// must hold ≥4.5:1 against.
pub const LIGHT_BG: &str = "#F6F8FB";

/// Daylight's hovered or selected row, the darkest ground a name sits on there.
/// `client/src/next/styles/contrast.test.ts` checks every ground and the card
/// washes; this keeps the guarantee here too, where the values are.
pub const LIGHT_BG_HOVER: &str = "#E4EAF5";

/// One named palette entry: a key and its OKLCH hue.
#[derive(Debug, Clone, Copy)]
pub struct PaletteColor {
    pub key: &'static str,
    pub hue: f64,
    /// slate is the one desaturated entry (chroma 0.02 instead of 0.13).
    pub muted: bool,
    /// Its chroma in the light set. 0.13 where the screen can show the hue
    /// that strong at lightness 0.50; where it can't, the most it can, to
    /// three places, so the hue stays true. Asked for more, the screen would
    /// clip it toward a neighbour: amber at 0.13 comes out rust.
    pub light_chroma: f64,
}

const fn c(key: &'static str, hue: f64) -> PaletteColor {
    capped(key, hue, CHROMA)
}

/// A hue whose light shade is weaker than 0.13 (see `light_chroma`).
const fn capped(key: &'static str, hue: f64, light_chroma: f64) -> PaletteColor {
    PaletteColor {
        key,
        hue,
        muted: false,
        light_chroma,
    }
}

/// The IRC 16, remapped through OKLCH. Order matters only for the picker UI.
pub const PALETTE: [PaletteColor; 16] = [
    c("ember", 32.0),
    c("rust", 50.0),
    capped("amber", 68.0, 0.109),
    capped("brass", 90.0, 0.102),
    capped("lime", 118.0, 0.116),
    c("fern", 145.0),
    capped("mint", 162.0, 0.109),
    capped("teal", 180.0, 0.09),
    capped("cyan", 200.0, 0.085),
    capped("sky", 230.0, 0.099),
    c("azure", 255.0),
    c("indigo", 275.0),
    c("violet", 295.0),
    c("orchid", 320.0),
    c("rose", 350.0),
    PaletteColor {
        key: "slate",
        hue: 250.0,
        muted: true,
        light_chroma: LIGHT_SLATE_C,
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
    /// The OKLCH components for this color, as the dark themes draw it.
    #[must_use]
    pub fn oklch(&self) -> (f64, f64, f64) {
        let chroma = if self.muted { SLATE_C } else { CHROMA };
        (LIGHTNESS, chroma, self.hue)
    }

    /// The OKLCH components for this color in the light set, as Daylight
    /// draws it (#965): the same hue, dark enough to read on paper.
    #[must_use]
    pub fn light_oklch(&self) -> (f64, f64, f64) {
        (LIGHT_LIGHTNESS, self.light_chroma, self.hue)
    }

    /// sRGB hex fallback (`#rrggbb`), gamut-clipped. The build ships these in case
    /// the target WebKitGTK's `oklch()` support falls through (SPEC §5.4).
    #[must_use]
    pub fn hex(&self) -> String {
        hex_of(self.oklch())
    }

    /// The light set's hex (`#rrggbb`), as `hex` is the dark set's.
    #[must_use]
    pub fn light_hex(&self) -> String {
        hex_of(self.light_oklch())
    }

    /// The `oklch()` CSS literal for this color.
    #[must_use]
    pub fn css_oklch(&self) -> String {
        css_of(self.oklch())
    }

    /// The light set's `oklch()` CSS literal.
    #[must_use]
    pub fn css_light_oklch(&self) -> String {
        css_of(self.light_oklch())
    }
}

fn hex_of((l, ch, h): (f64, f64, f64)) -> String {
    let (r, g, b) = oklch_to_srgb(l, ch, h);
    format!(
        "#{:02X}{:02X}{:02X}",
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8
    )
}

fn css_of((l, ch, h): (f64, f64, f64)) -> String {
    format!("oklch({l} {ch} {h})")
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

/// The same for the light set (#965), `--name-azure: oklch(0.5 0.13 255);`,
/// which Daylight declares over the dark set.
#[must_use]
pub fn css_light_variables() -> String {
    PALETTE
        .iter()
        .map(|p| format!("--name-{}: {};", p.key, p.css_light_oklch()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The whole generated stylesheet, one file: every key on `:root`, as the
/// dark themes draw them, and again on `[data-theme="daylight"]`, as the
/// light one does (#965). A theme on one element, as in the Theme picker,
/// takes its block too.
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
 *
 * Two shades of each key: the dark themes' on `:root`, and Daylight's, the
 * light theme, darker so they read on paper (#965, SPEC §5.4).
 */"#;

    let indent = |css: String| {
        css.lines()
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let dark = indent(css_variables());
    let light = indent(css_light_variables());
    format!("{HEADER}\n\n:root {{\n{dark}\n}}\n\n[data-theme=\"{LIGHT_THEME}\"] {{\n{light}\n}}\n")
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
    let (r, g, b) = oklch_to_linear(l, chroma, hue_deg);
    (
        gamma(r.clamp(0.0, 1.0)),
        gamma(g.clamp(0.0, 1.0)),
        gamma(b.clamp(0.0, 1.0)),
    )
}

/// Linear sRGB, unclamped: a channel outside 0–1 is a color the screen can't
/// show, which `oklch_to_srgb` would clip.
fn oklch_to_linear(l: f64, chroma: f64, hue_deg: f64) -> (f64, f64, f64) {
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

    (r, g, b)
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

    /// The same guard for the light set (#965): every key at ≥4.5:1 on
    /// Daylight's paper, and on its hovered row, the darkest ground a name
    /// sits on there.
    #[test]
    fn all_16_keys_hold_contrast_on_paper() {
        for color in &PALETTE {
            for bg in [LIGHT_BG, LIGHT_BG_HOVER] {
                let hex = color.light_hex();
                let ratio = contrast_ratio(&hex, bg);
                assert!(
                    ratio >= 4.5,
                    "{} is {hex} in the light set → {ratio:.2}:1 against {bg}, below 4.5:1",
                    color.key
                );
            }
        }
    }

    /// Whether the screen can show a color without clipping it. A hair of
    /// leeway for rounding: cyan's cap is 0.000003 inside the edge.
    fn on_screen((l, ch, h): (f64, f64, f64)) -> bool {
        let (r, g, b) = oklch_to_linear(l, ch, h);
        [r, g, b].iter().all(|c| (-1e-9..=1.0 + 1e-9).contains(c))
    }

    /// A light shade the screen can't show would be clipped toward another
    /// hue (amber into rust), so each is on the screen, and a capped hue's
    /// chroma is the most it can show, to three places: 0.001 more is off it.
    #[test]
    fn the_light_set_keeps_its_hues() {
        for color in &PALETTE {
            let (l, ch, h) = color.light_oklch();
            assert!(
                on_screen((l, ch, h)),
                "{} at chroma {ch} is clipped",
                color.key
            );
            if !color.muted && ch < CHROMA {
                assert!(
                    !on_screen((l, ch + 0.001, h)),
                    "{} could be stronger than {ch} and still on the screen",
                    color.key
                );
            }
            if !color.muted && on_screen((l, CHROMA, h)) {
                assert!(
                    (ch - CHROMA).abs() < f64::EPSILON,
                    "{} is capped at {ch} though 0.13 is on the screen",
                    color.key
                );
            }
        }
    }

    /// The light set is the one Matt approved in the Daylight mockup
    /// (2026-11-26): lightness 0.50, the same hues, the caps above.
    #[test]
    fn the_light_set_is_the_approved_one() {
        let expected = [
            "--name-ember: oklch(0.5 0.13 32);",
            "--name-rust: oklch(0.5 0.13 50);",
            "--name-amber: oklch(0.5 0.109 68);",
            "--name-brass: oklch(0.5 0.102 90);",
            "--name-lime: oklch(0.5 0.116 118);",
            "--name-fern: oklch(0.5 0.13 145);",
            "--name-mint: oklch(0.5 0.109 162);",
            "--name-teal: oklch(0.5 0.09 180);",
            "--name-cyan: oklch(0.5 0.085 200);",
            "--name-sky: oklch(0.5 0.099 230);",
            "--name-azure: oklch(0.5 0.13 255);",
            "--name-indigo: oklch(0.5 0.13 275);",
            "--name-violet: oklch(0.5 0.13 295);",
            "--name-orchid: oklch(0.5 0.13 320);",
            "--name-rose: oklch(0.5 0.13 350);",
            "--name-slate: oklch(0.5 0.025 250);",
        ];
        assert_eq!(css_light_variables().lines().collect::<Vec<_>>(), expected);
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

    /// Two blocks, the dark set on `:root` and the light set on Daylight,
    /// each defining every key once, and nothing else.
    #[test]
    fn stylesheet_defines_every_key_once_in_each_set() {
        let css = stylesheet();
        let (dark, light) = css
            .split_once("[data-theme=\"daylight\"] {")
            .expect("the light set's block");
        let dark = &dark[dark.find(":root {").expect("the dark set's block")..];
        assert_eq!(css.matches('{').count(), 2, "two blocks and no more");
        for (set, block) in [("dark", dark), ("light", light)] {
            for color in &PALETTE {
                let count = block.matches(&format!("--name-{}:", color.key)).count();
                assert_eq!(
                    count, 1,
                    "{} is not defined exactly once in the {set} set",
                    color.key
                );
            }
        }
        assert!(dark.contains("--name-azure: oklch(0.76 0.13 255);"));
        assert!(light.contains("--name-azure: oklch(0.5 0.13 255);"));
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
