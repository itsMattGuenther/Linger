//! Display names that look the same (#574, SPEC §4.5, PROTOCOL §2).
//!
//! Linger has no avatars (SPEC §5.1): a name is how people tell each other
//! apart, so a name that only looks like somebody else's is a way to pretend
//! to be them, in a DM most of all. Two names look alike when they come out
//! the same once each is made [`plain`] and Unicode's confusables list
//! (UTS #39) has swapped every letter for the one it is easily taken for:
//! Cyrillic а for Latin a, `rn` for `m`, `1` and capital `I` for `l`.
//!
//! "Looks the same" is not tidy. Capital `I` is taken for `l`, but its lower
//! case `i` is not; Cyrillic `М` is a Latin `M`, but its lower case `м` is a
//! small capital. So a name is read three ways ([`Shapes`]), and two names look
//! alike when any reading of one is a reading of the other.

use unicode_normalization::UnicodeNormalization;

use crate::validate::BLANK_LETTERS;

/// The three ways a name is read, each in Unicode's look-alike letters (a
/// "skeleton", UTS #39 §4): as written, in lower case, and its look-alike
/// letters put in lower case and read again. The last is what catches a
/// Cyrillic `Маtt` beside a Latin `matt`.
#[derive(Debug)]
pub struct Shapes([String; 3]);

impl Shapes {
    /// Worked out each time a name is checked rather than stored, so a newer
    /// Unicode list applies to every name at once (`repo::users::refuse_look_alike`).
    pub fn of(name: &str) -> Self {
        let plain = plain(name);
        let as_written = skeleton(&plain);
        let lower = skeleton(&plain.to_lowercase());
        let lowered = skeleton(&as_written.to_lowercase());
        Self([as_written, lower, lowered])
    }

    /// Whether the two names could be taken for each other.
    pub fn meet(&self, other: &Shapes) -> bool {
        self.0.iter().any(|shape| other.0.contains(shape))
    }
}

fn skeleton(s: &str) -> String {
    unicode_security::skeleton(s).collect()
}

/// A name in one standard form, so that what only differs in how it is stored
/// compares equal: NFKC (full-width `Ｍ`, a styled `𝐌` and a ligature `ﬁ` become
/// `M`, `M` and `fi`), every character that draws nothing dropped, every run
/// of space one plain space, and none at either end.
///
/// A blank letter ([`BLANK_LETTERS`]) is as wide as a space and shows as one,
/// so it counts as one. The display-name rules (#296) refuse most of what is
/// dropped here, but a name saved before them can still hold it.
fn plain(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut space = false;
    for c in name.nfkc() {
        if c.is_whitespace() || BLANK_LETTERS.contains(&c) {
            space = !out.is_empty();
        } else if !draws_nothing(c) {
            if space {
                out.push(' ');
                space = false;
            }
            out.push(c);
        }
    }
    out
}

/// Unicode's Default_Ignorable_Code_Point (DerivedCoreProperties.txt), which
/// UTS #39 drops before comparing: the zero-width space and joiners, the
/// direction controls, the soft hyphen, variation selectors, the tag
/// characters and the like. The Hangul fillers are in it too, but are caught
/// first as blank letters.
fn draws_nothing(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'..='\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFF8}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E0FFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn look_alike(a: &str, b: &str) -> bool {
        Shapes::of(a).meet(&Shapes::of(b))
    }

    /// Pairs that must be taken for each other.
    const ALIKE: &[(&str, &str, &str)] = &[
        ("Matt", "Matt", "the same name"),
        ("Matt", "matt", "only the capitals differ"),
        ("Matt", "MATT", "only the capitals differ"),
        ("Matt", "\u{041C}\u{0430}tt", "Cyrillic М and а"),
        (
            "matt",
            "\u{041C}\u{0430}tt",
            "Cyrillic М and а, against lower case",
        ),
        ("Bob", "B\u{043E}b", "a Cyrillic о"),
        (
            "Matt",
            "\u{FF2D}\u{FF41}\u{FF54}\u{FF54}",
            "full-width letters",
        ),
        ("Matt", "\u{1D40C}att", "a mathematical bold M"),
        ("Matt", "rnatt", "rn for m"),
        ("Ilya", "llya", "capital I for l"),
        ("Bill", "Bi11", "1 for l"),
        ("Matt", "Ma\u{200B}tt", "a zero-width space"),
        ("Matt", "Matt\u{FE0F}", "a variation selector"),
        ("Matt", "\u{00AD}Matt", "a soft hyphen"),
        ("Matt G", "Matt  G", "two spaces for one"),
        ("Matt G", "Matt\u{00A0}G", "a no-break space"),
        ("Matt G", "Matt\u{3000}G", "an ideographic space"),
        ("Matt G", "Matt\u{3164}G", "a blank letter for a space"),
        ("Matt", " Matt ", "spaces at the ends"),
        ("José", "Jose\u{0301}", "an accent written as its own mark"),
        ("mguenther", "MGuenther", "a username, capitalised"),
    ];

    /// Pairs that must not be.
    const UNALIKE: &[(&str, &str)] = &[
        ("Matt", "Mat"),
        ("Matt", "Matt G"),
        ("Matt", "Matty"),
        ("Matt", "Matt 🎮"),
        ("Matt G", "MattG"),
        ("José", "Jose"),
        ("Zoë", "Zoe"),
        ("Justin B", "Justin R"),
        ("李小龍", "李小龙"),
        ("Dan", "Dān"),
        ("Eli", "Ell"),
        ("🎮", "🕹️"),
    ];

    #[test]
    fn names_that_look_the_same_are_taken_for_each_other() {
        for (a, b, why) in ALIKE {
            assert!(look_alike(a, b), "{a:?} and {b:?} should look alike: {why}");
            assert!(look_alike(b, a), "{b:?} and {a:?} should look alike: {why}");
        }
    }

    #[test]
    fn names_that_look_different_are_not() {
        for (a, b) in UNALIKE {
            assert!(!look_alike(a, b), "{a:?} and {b:?} should look different");
            assert!(!look_alike(b, a), "{b:?} and {a:?} should look different");
        }
    }

    #[test]
    fn a_name_made_plain_keeps_its_letters_and_one_space_between_words() {
        assert_eq!(plain("  Ｊｕｓｔｉｎ\u{200B}　 B  "), "Justin B");
        assert_eq!(plain("\u{2800}Matt\u{1D159}"), "Matt");
        assert_eq!(plain(""), "");
    }
}
