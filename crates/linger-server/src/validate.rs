//! Input validation with the PROTOCOL §2/§3 shapes. No regex crate for three
//! character classes, and returning `ApiError` directly so handlers read as
//! straight-line code. The one dependency is Unicode's character data, which
//! display names need (#296) and a hand-written table would not keep current.

use linger_core::limits::{
    MAX_ACCENT_MARKS_PER_LETTER, MAX_DISPLAY_NAME_CHARS, MAX_FILENAME_CHARS, MAX_MARKS_PER_LETTER,
    MAX_MESSAGE_CHARS, MAX_MOTD_CHARS, MAX_STATUS_FIELDS, MAX_STATUS_FIELD_CHARS,
    MAX_STATUS_LABEL_CHARS, MAX_STATUS_LINE_CHARS, MIN_PASSWORD_CHARS,
};
use linger_core::wire::{Fill, StatusField, Style, UserStatus};
use unicode_properties::{GeneralCategory, UnicodeEmoji, UnicodeGeneralCategory};

use crate::error::ApiError;

/// `[a-z0-9_]{2,24}` — lowercase on the way in is the caller's job; we reject,
/// not normalize, so people see exactly what their username is.
pub fn username(s: &str) -> Result<(), ApiError> {
    let ok = (2..=24).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(ApiError::validation(
            "Usernames are 2–24 characters: lowercase letters, digits, underscore.",
        ))
    }
}

/// `[a-z0-9-]{1,32}`.
/// The prefix a DM's generated slug carries (`repo::dms`). Reserved here so a
/// host cannot make a public room whose slug collides with one — the collision
/// would be a `409` at worst, but a room called `dm-anything` drawn in the rail
/// next to real DMs is a way to mislead people that costs one line to close.
pub const DM_SLUG_PREFIX: &str = "dm-";

pub fn room_slug(s: &str) -> Result<(), ApiError> {
    if s.starts_with(DM_SLUG_PREFIX) {
        return Err(ApiError::validation(
            "Room slugs cannot start with `dm-`; that prefix belongs to direct messages.",
        ));
    }
    let ok = (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(ApiError::validation(
            "Room slugs are 1–32 characters: lowercase letters, digits, hyphen.",
        ))
    }
}

/// A room's name, trimmed: 1–48 characters, without the characters that
/// change the direction of text (#488).
pub fn room_name(s: &str) -> Result<String, ApiError> {
    name_of_a_place(s, "Room names are 1–48 characters.")
}

/// The server's name, held to what a room's name is.
pub fn server_name(s: &str) -> Result<String, ApiError> {
    name_of_a_place(s, "Server names are 1–48 characters.")
}

fn name_of_a_place(s: &str, refusal: &'static str) -> Result<String, ApiError> {
    let straight = without_direction_controls(s);
    let name = straight.trim();
    if name.is_empty() || name.chars().count() > 48 {
        return Err(ApiError::validation(refusal));
    }
    Ok(name.to_string())
}

/// A display name (PROTOCOL §2, #296): 1–32 characters after trimming, in any
/// script, with emoji, accents, spaces and punctuation, and nothing that hides,
/// breaks the line, turns the text around, or paints over its neighbours.
///
/// Refused, not cleaned up, so people see exactly what their name is (as
/// [`username`] does). The name is stored trimmed, so the trimmed name is what
/// is checked. The checks run in a fixed order, and the first to fail is the
/// sentence the person sees. `client/src/lib/account.ts` mirrors them for
/// early feedback; this is the answer that counts.
///
/// They apply when a name is set or changed. A name saved before them is left
/// as it is, so nobody's account breaks (`routes::users::patch_me`).
pub fn display_name(s: &str) -> Result<(), ApiError> {
    let name = s.trim();
    if name.is_empty() && !s.is_empty() {
        return Err(ApiError::validation(NAME_UNSEEN));
    }
    let chars: Vec<char> = name.chars().collect();
    if !(1..=MAX_DISPLAY_NAME_CHARS).contains(&chars.len()) {
        return Err(ApiError::validation("Display names are 1–32 characters."));
    }
    if chars.iter().copied().any(breaks_the_line) {
        return Err(ApiError::validation(
            "Names can't have tabs, line breaks or other control characters.",
        ));
    }
    if chars.iter().copied().any(changes_direction) {
        return Err(ApiError::validation(
            "Names can't have characters that change the direction of text.",
        ));
    }
    if (0..chars.len()).any(|at| is_invisible(chars[at]) && !joins_here(&chars, at)) {
        return Err(ApiError::validation(
            "Names can't have invisible characters.",
        ));
    }
    marks_per_letter(&chars)?;
    if !chars.iter().copied().any(is_seen) {
        return Err(ApiError::validation(NAME_UNSEEN));
    }
    Ok(())
}

/// A name made of nothing anybody can see: only spaces, blank letters, or
/// marks with no letter under them.
const NAME_UNSEEN: &str = "That name has no letters anyone can see.";

/// A control character (tab, line break, bell…), or one of the line and
/// paragraph separators, which break a line without being control characters.
fn breaks_the_line(c: char) -> bool {
    c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')
}

/// The bidirectional controls: the embeddings and overrides (U+202A–U+202E)
/// and isolates (U+2066–U+2069), which turn the text after them around, and
/// the three direction marks (U+200E, U+200F, U+061C), which move the
/// punctuation and numbers beside them. A name in Arabic or Hebrew needs none
/// of them: its letters carry their own direction.
fn changes_direction(c: char) -> bool {
    matches!(
        c,
        '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

/// The text without the characters that change the direction of text
/// ([`changes_direction`], #488), for the short text the app draws beside its
/// own words and other people's: a file's name, a status, a room's name and
/// topic, its message of the day, a poll, the server's name. One override can
/// make `invoice` + U+202E + `fdp.exe` read as "invoiceexe.pdf", or turn the
/// words after it around.
///
/// Taken out, not refused as they are in a display name. They can't be seen,
/// so a refusal would ask somebody to find and delete a character they have
/// no way to find, and they mostly arrive by pasting (a song title, a file
/// from somebody's disk). Nobody loses anything they could read: Arabic and
/// Hebrew letters carry their own direction. A display name is still refused
/// (#296), so people see exactly what their name is. A message's words keep
/// them: somebody writing a paragraph in Hebrew or Arabic may want them, and
/// the app keeps each message to itself.
pub fn without_direction_controls(s: &str) -> String {
    s.chars().filter(|&c| !changes_direction(c)).collect()
}

/// Characters that draw nothing: every format character (Unicode category Cf:
/// the zero-width space and joiners, the word joiner, the byte-order mark, the
/// soft hyphen and the rest), and three combining marks Unicode itself says
/// draw nothing (the combining grapheme joiner and Khmer's two inherent
/// vowels). Mixed into a name, they make it look like somebody else's.
fn is_invisible(c: char) -> bool {
    c.general_category() == GeneralCategory::Format
        || matches!(c, '\u{034F}' | '\u{17B4}' | '\u{17B5}')
}

/// Where an invisible character is part of how something is written, and so
/// allowed. Three places:
///
/// - U+200D, the zero-width joiner, between two emoji: it is what joins 👨 👩
///   👧 into 👨‍👩‍👧, and 🏳️ 🌈 into 🏳️‍🌈.
/// - U+200C and U+200D inside a word in a script that spells with them
///   ([`JOINING_SCRIPTS`]): the non-joiner Persian writes in علی‌رضا, or the
///   joiner in Sinhala's ශ්‍රී ("Sri").
/// - The tag characters (U+E0020–U+E007F) after 🏴, which spell out the flags
///   of England, Scotland and Wales.
fn joins_here(chars: &[char], at: usize) -> bool {
    let before = at.checked_sub(1).map(|i| chars[i]);
    let after = chars.get(at + 1).copied();
    match chars[at] {
        '\u{200D}'
            if before.is_some_and(|c| is_emoji(c) || c == '\u{FE0F}')
                && after.is_some_and(is_emoji) =>
        {
            true
        }
        '\u{200C}' | '\u{200D}' => {
            before.is_some_and(in_joining_word) && after.is_some_and(in_joining_word)
        }
        '\u{E0020}'..='\u{E007F}' => {
            before.is_some_and(|c| c == '\u{1F3F4}' || ('\u{E0020}'..='\u{E007E}').contains(&c))
        }
        _ => false,
    }
}

/// One emoji, as a reaction is (SPEC §4.8, #485): what the picker gives, and
/// never a word, two emoji, or a stray joiner. A server's own emoji is not this
/// shape; it's `emoji:<id>` and checked against the set instead.
pub fn reaction_emoji(key: &str) -> Result<(), ApiError> {
    if is_one_emoji(key) {
        Ok(())
    } else {
        Err(ApiError::validation("A reaction is one emoji."))
    }
}

/// Unicode's shapes for one emoji (UTS #51), by hand rather than from a list,
/// so an emoji newer than this server is still one: a flag (two regional
/// indicators), a keycap (1️⃣), a tag flag (🏴 and its tags, England's), or one
/// or more emoji joined by U+200D, each with an optional U+FE0F and skin tone
/// (👍🏽, 👩🏽‍💻, 🏳️‍🌈).
fn is_one_emoji(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    // The longest in Unicode 16 (a family with skin tones) is 10.
    if chars.is_empty() || chars.len() > 16 {
        return false;
    }
    let regional = |c: char| ('\u{1F1E6}'..='\u{1F1FF}').contains(&c);
    if chars.len() == 2 && chars.iter().all(|&c| regional(c)) {
        return true;
    }
    if let [c, rest @ ..] = chars.as_slice() {
        let keycap = c.is_ascii_digit() || *c == '#' || *c == '*';
        if keycap && matches!(rest, ['\u{20E3}'] | ['\u{FE0F}', '\u{20E3}']) {
            return true;
        }
    }
    if let [first, tags @ .., last] = chars.as_slice() {
        if *first == '\u{1F3F4}'
            && *last == '\u{E007F}'
            && !tags.is_empty()
            && tags.iter().all(|c| ('\u{E0020}'..='\u{E007E}').contains(c))
        {
            return true;
        }
    }
    let skin = |c: char| ('\u{1F3FB}'..='\u{1F3FF}').contains(&c);
    let mut at = 0;
    loop {
        match chars.get(at) {
            Some(&c) if is_emoji(c) && !skin(c) && !regional(c) => at += 1,
            _ => return false,
        }
        if chars.get(at) == Some(&'\u{FE0F}') {
            at += 1;
        }
        if chars.get(at).is_some_and(|&c| skin(c)) {
            at += 1;
        }
        match chars.get(at) {
            None => return true,
            Some('\u{200D}') => at += 1,
            Some(_) => return false,
        }
    }
}

/// An emoji, skin tones included. The ASCII digits, `#` and `*` are emoji to
/// Unicode too, as the start of a keycap (1️⃣), but a joiner between two of
/// them joins nothing: it only hides in the middle of a number.
fn is_emoji(c: char) -> bool {
    c.is_emoji_char() && !c.is_ascii()
}

/// Scripts that spell with U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH
/// JOINER: the joined ones (Arabic, Syriac, N'Ko, Mandaic, Mongolian, Adlam),
/// where a non-joiner keeps two letters from joining (Persian writes one inside
/// many words), and those that draw consonant clusters (Devanagari through
/// Sinhala, Myanmar, Khmer), where the pair decides how a cluster is drawn.
///
/// By block rather than by the Unicode Script property, which the crate does
/// not carry. A block answers "is this letter from one of those scripts?" well
/// enough, since the question is only ever asked of the letters either side of
/// a joiner. `client/src/lib/account.ts` mirrors the list.
const JOINING_SCRIPTS: &[(char, char)] = &[
    ('\u{0600}', '\u{06FF}'),   // Arabic
    ('\u{0700}', '\u{074F}'),   // Syriac
    ('\u{0750}', '\u{077F}'),   // Arabic Supplement
    ('\u{07C0}', '\u{07FF}'),   // N'Ko
    ('\u{0840}', '\u{086F}'),   // Mandaic, Syriac Supplement
    ('\u{0870}', '\u{08FF}'),   // Arabic Extended-B and -A
    ('\u{0900}', '\u{0DFF}'),   // Devanagari, Bengali … Malayalam, Sinhala
    ('\u{1000}', '\u{109F}'),   // Myanmar
    ('\u{1780}', '\u{17FF}'),   // Khmer
    ('\u{1800}', '\u{18AF}'),   // Mongolian
    ('\u{FB50}', '\u{FDFF}'),   // Arabic Presentation Forms-A
    ('\u{FE70}', '\u{FEFE}'),   // Arabic Presentation Forms-B (not U+FEFF)
    ('\u{1E900}', '\u{1E95F}'), // Adlam
];

/// A letter or mark from one of [`JOINING_SCRIPTS`].
fn in_joining_word(c: char) -> bool {
    use GeneralCategory as G;
    let letter_or_mark = matches!(
        c.general_category(),
        G::UppercaseLetter
            | G::LowercaseLetter
            | G::TitlecaseLetter
            | G::ModifierLetter
            | G::OtherLetter
            | G::NonspacingMark
            | G::SpacingMark
            | G::EnclosingMark
    );
    letter_or_mark
        && JOINING_SCRIPTS
            .iter()
            .any(|&(first, last)| (first..=last).contains(&c))
}

/// No letter piled high with marks ("zalgo" text, which paints far above and
/// below its line and over the messages around it).
///
/// A mark here is one that stacks on the letter before it: Unicode categories
/// Mn (non-spacing) and Me (enclosing). Spacing marks (Mc), such as the vowel
/// signs of Hindi, Tamil and Burmese, sit beside a letter rather than on it,
/// so they count as a new letter. Two limits: the accent marks every script
/// shares ([`is_accent`]), which are what zalgo is made of, at
/// [`MAX_ACCENT_MARKS_PER_LETTER`]; and marks of any kind at
/// [`MAX_MARKS_PER_LETTER`], which leaves room for scripts that write three or
/// four marks on a letter as ordinary spelling (Tibetan's stacked consonants,
/// as in སྒྲོལ་མ, "Dolma").
fn marks_per_letter(chars: &[char]) -> Result<(), ApiError> {
    let (mut marks, mut accents) = (0, 0);
    for &c in chars {
        if !matches!(
            c.general_category(),
            GeneralCategory::NonspacingMark | GeneralCategory::EnclosingMark
        ) {
            (marks, accents) = (0, 0);
            continue;
        }
        marks += 1;
        if is_accent(c) {
            accents += 1;
        }
        if accents > MAX_ACCENT_MARKS_PER_LETTER {
            return Err(ApiError::validation(
                "Names can't have more than two accent marks on one letter.",
            ));
        }
        if marks > MAX_MARKS_PER_LETTER {
            return Err(ApiError::validation(
                "Names can't stack that many marks on one letter.",
            ));
        }
    }
    Ok(())
}

/// The combining accents that belong to no one script: the Combining
/// Diacritical Marks block with its Extended and Supplement blocks, the marks
/// for symbols, and the half marks. They are the accents of Latin, Greek and
/// Cyrillic written as separate characters, and what zalgo text is built from.
fn is_accent(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036F}'
            | '\u{1AB0}'..='\u{1AFF}'
            | '\u{1DC0}'..='\u{1DFF}'
            | '\u{20D0}'..='\u{20FF}'
            | '\u{FE20}'..='\u{FE2F}'
    )
}

/// Letters that are blank on purpose: the Hangul fillers (U+115F, U+1160,
/// U+3164, U+FFA0), the empty braille cell (U+2800) and the musical null
/// notehead (U+1D159). Unicode calls them letters or symbols, so nothing above
/// catches them, and a name made only of them looks empty. Mixed in with
/// letters they read as a space, and are allowed.
const BLANK_LETTERS: [char; 6] = [
    '\u{115F}',
    '\u{1160}',
    '\u{3164}',
    '\u{FFA0}',
    '\u{2800}',
    '\u{1D159}',
];

/// A character that shows something by itself: not a space, a control or
/// format character, a mark (which needs a letter under it), or a blank
/// letter. An unassigned code point counts as seen, since it is most likely an
/// emoji newer than the Unicode tables this server was built with.
fn is_seen(c: char) -> bool {
    use GeneralCategory as G;
    !c.is_whitespace()
        && !matches!(
            c.general_category(),
            G::Control
                | G::Format
                | G::SpaceSeparator
                | G::LineSeparator
                | G::ParagraphSeparator
                | G::NonspacingMark
                | G::SpacingMark
                | G::EnclosingMark
        )
        && !BLANK_LETTERS.contains(&c)
}

/// Minimum length only — composition rules are explicitly banned (PROTOCOL §2).
///
/// The message counts off the constant rather than spelling the number out, so
/// lowering the floor cannot leave the copy claiming the old one.
pub fn password(s: &str) -> Result<(), ApiError> {
    if s.chars().count() >= MIN_PASSWORD_CHARS {
        Ok(())
    } else {
        Err(ApiError::validation(format!(
            "Passwords need at least {MIN_PASSWORD_CHARS} characters."
        )))
    }
}

/// Trimmed message body, 1..=8000 chars (PROTOCOL §4).
pub fn message_body(s: &str) -> Result<String, ApiError> {
    let trimmed = caption(s)?;
    if trimmed.is_empty() {
        return Err(ApiError::validation("Say something."));
    }
    Ok(trimmed)
}

/// The same body, but allowed to be empty because the message carries files.
///
/// Handing somebody a photo without typing a caption over it is the ordinary
/// way to share a photo, so a message with an attachment on it does not have to
/// say anything as well (PROTOCOL §4).
pub fn caption(s: &str) -> Result<String, ApiError> {
    let trimmed = s.trim();
    if trimmed.chars().count() > MAX_MESSAGE_CHARS {
        return Err(ApiError::validation("That's too long for one message."));
    }
    Ok(trimmed.to_string())
}

/// A room's message of the day, trimmed (PROTOCOL §3, #464). Empty is allowed:
/// it's how one is cleared. It's drawn over the room as well as in it, so it
/// loses the characters that change the direction of text (#488).
pub fn motd(s: &str) -> Result<String, ApiError> {
    let straight = without_direction_controls(s);
    let trimmed = straight.trim();
    if trimmed.chars().count() > MAX_MOTD_CHARS {
        return Err(ApiError::validation(format!(
            "A message of the day is at most {MAX_MOTD_CHARS} characters."
        )));
    }
    Ok(trimmed.to_string())
}

/// A filename is stored and echoed back in a download header, so it is stripped
/// of anything that could steer a filesystem or forge a header line: directory
/// components, control characters, quotes. And of the characters that change
/// the direction of text, which can make a program look like a document:
/// `invoice` + U+202E + `fdp.exe` reads as "invoiceexe.pdf" (#488).
pub fn filename(s: &str) -> Result<String, ApiError> {
    let base = s.rsplit(['/', '\\']).next().unwrap_or(s).trim();
    let cleaned: String = base
        .chars()
        .filter(|&c| !c.is_control() && !changes_direction(c) && !matches!(c, '"' | '\\'))
        .collect();
    let cleaned = cleaned.trim_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned.chars().count() > MAX_FILENAME_CHARS {
        return Err(ApiError::validation(
            "That file needs a name, and a shorter one.",
        ));
    }
    Ok(cleaned)
}

/// The AGENTS.md hard rule: palette and font keys are validated server-side
/// against the closed sets in linger-core. Client-side validation alone is a
/// defect.
pub fn style(style: &Style) -> Result<(), ApiError> {
    if !linger_core::is_valid_font_key(&style.font_key) {
        return Err(ApiError::validation("That font isn't in the bundled set."));
    }
    if let Some(msg_font) = &style.msg_font_key {
        if !linger_core::is_valid_font_key(msg_font) {
            return Err(ApiError::validation(
                "That message font isn't in the bundled set.",
            ));
        }
    }
    if ![400u16, 500, 700].contains(&style.weight) {
        return Err(ApiError::validation("Weight must be 400, 500, or 700."));
    }
    let colors_ok = match &style.fill {
        Fill::Solid { color } => color.is_valid(),
        Fill::Gradient { from, to } => from.is_valid() && to.is_valid(),
    };
    if !colors_ok {
        return Err(ApiError::validation(
            "Colors are picked from the named palette.",
        ));
    }
    Ok(())
}

/// A status (SPEC §4.6, PROTOCOL §5): every text in it capped, and the short
/// fields free of control characters, whether they arrive labelled in
/// `fields` (#270) or under the three keys older apps send.
///
/// What comes back is the status to save: every text in it without the
/// characters that change the direction of text (#488), which are taken out
/// before anything is counted.
pub fn status(status: &UserStatus) -> Result<UserStatus, ApiError> {
    let straight = |text: &Option<String>| text.as_deref().map(without_direction_controls);
    let status = UserStatus {
        line: straight(&status.line),
        reading: straight(&status.reading),
        listening: straight(&status.listening),
        working_on: straight(&status.working_on),
        fields: status
            .fields
            .as_ref()
            .map(|fields| fields.iter().map(straight_field).collect()),
        away_message: straight(&status.away_message),
        ..status.clone()
    };
    let cap = |field: &Option<String>, max: usize, what: &str| -> Result<(), ApiError> {
        match field {
            Some(v) if v.chars().count() > max => Err(ApiError::validation(format!(
                "{what} is capped at {max} characters."
            ))),
            _ => Ok(()),
        }
    };
    cap(&status.line, MAX_STATUS_LINE_CHARS, "The status line")?;
    cap(&status.reading, MAX_STATUS_FIELD_CHARS, "Reading")?;
    cap(&status.listening, MAX_STATUS_FIELD_CHARS, "Listening")?;
    cap(&status.working_on, MAX_STATUS_FIELD_CHARS, "Working on")?;
    cap(
        &status.away_message,
        MAX_STATUS_LINE_CHARS,
        "The away message",
    )?;
    // The three keys become fields (`status_fields::apply_classic`), so they
    // are held to what a field's value may hold.
    for (value, what) in [
        (&status.reading, "Reading"),
        (&status.listening, "Listening"),
        (&status.working_on, "Working on"),
    ] {
        if let Some(value) = value {
            plain_text(value, what)?;
        }
    }
    if let Some(fields) = &status.fields {
        status_fields(fields)?;
    }
    Ok(status)
}

/// A field without the characters that change the direction of text (#488).
fn straight_field(field: &StatusField) -> StatusField {
    StatusField {
        label: without_direction_controls(&field.label),
        value: without_direction_controls(&field.value),
    }
}

/// The labelled fields a status is saved with (#270), trimmed.
///
/// At most three. A label is 1–24 characters and a value 1–80, counted after
/// trimming, and neither may hold a control character: both are drawn on one
/// line of a card, and a tab or a line break there is a way to push text
/// somewhere it was not written. The characters that change the direction of
/// text are taken out first, for the same reason (#488). No two fields share
/// a label, ignoring case, so each of the three classic labels names at most
/// one field. An empty value is refused rather than dropped: an app leaves
/// out a field nobody filled in.
pub fn status_fields(fields: &[StatusField]) -> Result<Vec<StatusField>, ApiError> {
    if fields.len() > MAX_STATUS_FIELDS {
        return Err(ApiError::validation("A status has three fields at most."));
    }
    let mut out: Vec<StatusField> = Vec::with_capacity(fields.len());
    for field in fields.iter().map(straight_field) {
        let label = field.label.trim();
        let value = field.value.trim();
        if label.is_empty() {
            return Err(ApiError::validation("Each field needs a label."));
        }
        if label.chars().count() > MAX_STATUS_LABEL_CHARS {
            return Err(ApiError::validation(format!(
                "A field's label is capped at {MAX_STATUS_LABEL_CHARS} characters."
            )));
        }
        plain_text(label, "A field's label")?;
        if value.is_empty() {
            return Err(ApiError::validation(format!(
                "“{label}” needs something written beside it."
            )));
        }
        if value.chars().count() > MAX_STATUS_FIELD_CHARS {
            return Err(ApiError::validation(format!(
                "“{label}” is capped at {MAX_STATUS_FIELD_CHARS} characters."
            )));
        }
        plain_text(value, &format!("“{label}”"))?;
        if out
            .iter()
            .any(|held| held.label.to_lowercase() == label.to_lowercase())
        {
            return Err(ApiError::validation(format!(
                "Two fields are labelled “{label}”. Give each its own label."
            )));
        }
        out.push(StatusField {
            label: label.to_string(),
            value: value.to_string(),
        });
    }
    Ok(out)
}

/// One line of words: no tabs, line breaks or other control characters.
fn plain_text(text: &str, what: &str) -> Result<(), ApiError> {
    if text.chars().any(char::is_control) {
        return Err(ApiError::validation(format!(
            "{what} can't have tabs, line breaks or other control characters."
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use linger_core::wire::ColorKey;

    use super::*;

    /// Every shape an emoji takes is one reaction; words, two emoji and stray
    /// parts aren't (#485).
    #[test]
    fn a_reaction_is_one_emoji_of_any_shape() {
        for one in [
            "👍",
            "❤️",
            "❤",
            "👍🏽",
            "👩🏽‍💻",
            "🏳️‍🌈",
            "👨‍👩‍👧‍👦",
            "🧑🏿‍🤝‍🧑🏻",
            "🇨🇦",
            "1️⃣",
            "#⃣",
            "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
            "🫠",
        ] {
            assert!(reaction_emoji(one).is_ok(), "{one:?} was refused");
        }
        for not in [
            "",
            "a",
            "heart",
            ":gg:",
            "emoji:0123",
            "😀😀",
            "👍 ",
            " 👍",
            "🏽",
            "\u{200D}",
            "👍\u{200D}",
            "\u{200D}👍",
            "🇨",
            "🇨🇦🇨🇦",
            "1",
            "12⃣",
            "👍a",
        ] {
            assert!(reaction_emoji(not).is_err(), "{not:?} was allowed");
        }
    }

    #[test]
    fn username_shapes() {
        assert!(username("matt").is_ok());
        assert!(username("m_42").is_ok());
        assert!(username("m").is_err());
        assert!(username("Matt").is_err());
        assert!(username("matt guenther").is_err());
        assert!(username(&"x".repeat(25)).is_err());
    }

    /// The sentence a display name is refused with.
    fn refusal(name: &str) -> String {
        display_name(name)
            .map(|()| format!("{name:?} was allowed"))
            .unwrap_or_else(|err| err.message)
    }

    fn allowed(name: &str) {
        assert!(display_name(name).is_ok(), "{name:?}: {}", refusal(name));
    }

    const CONTROL: &str = "Names can't have tabs, line breaks or other control characters.";
    const DIRECTION: &str = "Names can't have characters that change the direction of text.";
    const INVISIBLE: &str = "Names can't have invisible characters.";
    const ACCENTS: &str = "Names can't have more than two accent marks on one letter.";
    const MARKS: &str = "Names can't stack that many marks on one letter.";
    const LENGTH: &str = "Display names are 1–32 characters.";

    #[test]
    fn real_names_in_any_script_are_allowed() {
        for name in [
            "Justin B",
            "Matt 💾",
            "José",
            "Zoë",
            "李小龍",
            "محمد",
            "Ωmega",
            "Дмитрий",
            "שרה",
            "Nguyễn Thị Ánh",
            "O'Brien-Smith (she/her)",
            "Ana_42!",
            // Accents typed as separate characters: two on one letter, as
            // Vietnamese writes ễ decomposed.
            "Nguye\u{0302}\u{0303}n",
            // Written out, so each mark is its own character. Hebrew with its
            // points, שִּׁמְעוֹן: three marks on the shin.
            "\u{05E9}\u{05BC}\u{05B4}\u{05C1}\u{05DE}\u{05B0}\u{05E2}\u{05D5}\u{05B9}\u{05DF}",
            // Hindi, ज़ेंडाया: a dot, a vowel sign and a nasal mark on one
            // consonant.
            "\u{091C}\u{093C}\u{0947}\u{0902}\u{0921}\u{093E}\u{092F}\u{093E}",
            // Tibetan's stacked consonants, སྒྲོལ་མ: three marks on one letter.
            "\u{0F66}\u{0F92}\u{0FB2}\u{0F7C}\u{0F63}\u{0F0B}\u{0F58}",
            // Burmese, မြို့: a spacing vowel sign, then three marks.
            "\u{1019}\u{103C}\u{102D}\u{102F}\u{1037}",
            // A letter from a blank-looking set, with real letters beside it.
            "Matt\u{3164}B",
        ] {
            allowed(name);
        }
        allowed(&"x".repeat(MAX_DISPLAY_NAME_CHARS));
        // Trimmed before it is checked, as it is before it is stored.
        allowed("  Matt\n");
    }

    #[test]
    fn emoji_and_their_joiners_are_allowed() {
        for name in [
            "💾",
            "👨‍👩‍👧",
            "👩🏽‍💻 Callie",
            "🏳️‍🌈",
            "❤️‍🔥",
            "🏃‍♀️",
            "1️⃣",
            // The flag of England: 🏴 and the tag characters that spell "gbeng".
            "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
        ] {
            allowed(name);
        }
        // Counted as characters, not bytes: 32 floppy disks fit.
        allowed(&"💾".repeat(MAX_DISPLAY_NAME_CHARS));
    }

    #[test]
    fn joiners_are_allowed_inside_words_of_scripts_that_spell_with_them() {
        // Persian, علی‌رضا (Alireza): a non-joiner keeps ی from joining ر.
        allowed("\u{0639}\u{0644}\u{06CC}\u{200C}\u{0631}\u{0636}\u{0627}");
        // Sinhala, ශ්‍රී ("Sri"): a joiner draws the cluster as one shape.
        allowed("\u{0DC1}\u{0DCA}\u{200D}\u{0DBB}\u{0DD3}");
        // Hindi, क्‍ष: the half form of क.
        allowed("\u{0915}\u{094D}\u{200D}\u{0937}");
        // …but not between Latin or Chinese letters, where they only hide.
        assert_eq!(refusal("Ma\u{200C}tt"), INVISIBLE);
        assert_eq!(refusal("Ma\u{200D}tt"), INVISIBLE);
        assert_eq!(refusal("李\u{200C}小龍"), INVISIBLE);
    }

    #[test]
    fn a_name_must_be_one_to_thirty_two_characters() {
        assert_eq!(refusal(""), LENGTH);
        assert_eq!(refusal(&"x".repeat(MAX_DISPLAY_NAME_CHARS + 1)), LENGTH);
        assert_eq!(refusal(&"💾".repeat(MAX_DISPLAY_NAME_CHARS + 1)), LENGTH);
    }

    #[test]
    fn control_characters_line_breaks_and_tabs_are_refused() {
        for name in [
            "Matt\tB",
            "Matt\nB",
            "Matt\r\nB",
            "Matt\u{0007}",
            "Matt\u{0085}B",
            "Matt\u{2028}B",
            "Matt\u{2029}B",
            "Matt\u{001B}[31m",
        ] {
            assert_eq!(refusal(name), CONTROL, "{name:?}");
        }
    }

    #[test]
    fn characters_that_change_the_direction_of_text_are_refused() {
        for name in [
            "\u{202E}ttaM",
            "Matt\u{202A}B",
            "Matt\u{202B}B",
            "Matt\u{202C}",
            "Matt\u{202D}B",
            "Matt\u{2066}B\u{2069}",
            "Matt\u{2067}B",
            "Matt\u{2068}B",
            "Matt\u{200E}",
            "محمد\u{200F}",
            "محمد\u{061C}",
        ] {
            assert_eq!(refusal(name), DIRECTION, "{name:?}");
        }
    }

    #[test]
    fn invisible_characters_are_refused() {
        for name in [
            "Ma\u{200B}tt",
            "Matt\u{2060}",
            "\u{FEFF}Matt",
            "Ma\u{00AD}tt",
            "Ma\u{2062}tt",
            "Ma\u{034F}tt",
            "Ma\u{180E}tt",
            // A joiner only joins between two emoji, never at either end.
            "\u{200D}💾",
            "💾\u{200D}",
            "💾\u{200D}Matt",
            // Digits are emoji to Unicode, but a joiner between them hides.
            "Matt1\u{200D}2",
            // Tag characters with no 🏴 in front of them.
            "Matt\u{E0067}\u{E0062}",
            "\u{E0001}Matt",
        ] {
            assert_eq!(refusal(name), INVISIBLE, "{name:?}");
        }
    }

    #[test]
    fn a_letter_piled_with_marks_is_refused() {
        allowed("a\u{0301}\u{0302}");
        assert_eq!(refusal("a\u{0301}\u{0302}\u{0303}"), ACCENTS);
        // Zalgo as generators make it.
        assert_eq!(
            refusal("M\u{0334}\u{0321}\u{031B}\u{0317}\u{031D}att"),
            ACCENTS
        );
        // Accents count across other marks on the same letter.
        assert_eq!(refusal("a\u{0301}\u{0E49}\u{0302}\u{0303}"), ACCENTS);
        // Each letter has its own count.
        allowed("a\u{0301}\u{0302}b\u{0301}\u{0302}");
        // Script marks go to four, and stop there: Thai tone marks piled up.
        allowed("ก\u{0E49}\u{0E49}\u{0E49}\u{0E49}");
        assert_eq!(refusal("ก\u{0E49}\u{0E49}\u{0E49}\u{0E49}\u{0E49}"), MARKS);
        // Enclosing marks count too.
        assert_eq!(refusal("a\u{0488}\u{0489}\u{0488}\u{0489}\u{0488}"), MARKS);
    }

    #[test]
    fn a_name_nobody_can_see_is_refused() {
        for name in [
            "   ",
            "\u{3000}",
            "\u{3164}",
            "\u{3164} \u{3164}",
            "\u{2800}",
            "\u{115F}\u{1160}",
            "\u{FFA0}",
            "\u{1D159}",
            "\u{0301}",
            "\u{FE0F}",
        ] {
            assert_eq!(refusal(name), NAME_UNSEEN, "{name:?}");
        }
    }

    #[test]
    fn filenames_lose_paths_and_anything_that_could_forge_a_header() {
        assert_eq!(filename("holiday.jpg").unwrap(), "holiday.jpg");
        assert_eq!(filename("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(filename("C:\\Users\\me\\notes.txt").unwrap(), "notes.txt");
        assert_eq!(
            filename("a\"; filename=\"evil.html").unwrap(),
            "a; filename=evil.html"
        );
        assert!(filename("   ").is_err());
        assert!(filename("...").is_err());
        assert!(filename(&"x".repeat(300)).is_err());
    }

    /// Every character `changes_direction` names, one at a time.
    const DIRECTION_CONTROLS: [char; 12] = [
        '\u{061C}', '\u{200E}', '\u{200F}', '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}',
        '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}',
    ];

    /// A program can't dress up as a document (#488): `invoice` + U+202E +
    /// `fdp.exe` would read "invoiceexe.pdf".
    #[test]
    fn filenames_lose_the_characters_that_change_the_direction_of_text() {
        assert_eq!(
            filename("invoice\u{202E}fdp.exe").unwrap(),
            "invoicefdp.exe"
        );
        for c in DIRECTION_CONTROLS {
            assert_eq!(filename(&format!("a{c}b.pdf")).unwrap(), "ab.pdf", "{c:?}");
        }
        // Nothing but them is no name at all.
        assert!(filename("\u{202E}\u{2066}").is_err());
        // Words in Hebrew and Arabic carry their own direction, and stay.
        assert_eq!(filename("שלום.pdf").unwrap(), "שלום.pdf");
        assert_eq!(filename("ملف.txt").unwrap(), "ملف.txt");
    }

    /// The short text drawn beside other words loses them too, before it is
    /// trimmed and counted (#488); a message's words keep them.
    #[test]
    fn short_text_loses_the_characters_that_change_the_direction_of_text() {
        for c in DIRECTION_CONTROLS {
            assert_eq!(without_direction_controls(&format!("a{c}b")), "ab", "{c:?}");
        }
        assert_eq!(without_direction_controls("محمد שרה"), "محمد שרה");

        assert_eq!(motd(" \u{202E}back at 8 ").unwrap(), "back at 8");
        assert!(motd(&format!("{}\u{202E}", "x".repeat(MAX_MOTD_CHARS))).is_ok());
        assert_eq!(room_name(" \u{2067}garage\u{2069} ").unwrap(), "garage");
        assert!(room_name("\u{202E}").is_err());
        assert_eq!(server_name("\u{202D}porch").unwrap(), "porch");

        // A message keeps what was written.
        assert_eq!(caption("שלום\u{200F}!").unwrap(), "שלום\u{200F}!");
    }

    #[test]
    fn a_status_loses_the_characters_that_change_the_direction_of_text() {
        let held = status(&UserStatus {
            line: Some("reading \u{202E}koob".into()),
            reading: Some("\u{2066}Piranesi\u{2069}".into()),
            fields: Some(vec![field("Play\u{202E}ing", "Outer \u{202B}Wilds")]),
            away_message: Some("\u{200F}back soon".into()),
            ..UserStatus::default()
        })
        .unwrap();
        assert_eq!(held.line.as_deref(), Some("reading koob"));
        assert_eq!(held.reading.as_deref(), Some("Piranesi"));
        assert_eq!(held.fields, Some(vec![field("Playing", "Outer Wilds")]));
        assert_eq!(held.away_message.as_deref(), Some("back soon"));

        assert_eq!(
            status_fields(&[field("\u{202E}Reading", "Piranesi\u{202C}")]).unwrap(),
            vec![field("Reading", "Piranesi")]
        );
        // Taken out before counting: 80 letters and an override fit.
        let long = format!("{}\u{202E}", "x".repeat(MAX_STATUS_FIELD_CHARS));
        assert!(status_fields(&[field("Reading", &long)]).is_ok());
        // A value of nothing but them is a field nobody filled in.
        assert!(status_fields(&[field("Reading", "\u{202E}")]).is_err());
    }

    #[test]
    fn a_message_with_a_file_on_it_does_not_have_to_say_anything() {
        assert!(message_body("   ").is_err());
        assert_eq!(caption("   ").unwrap(), "");
        assert_eq!(caption(" hello ").unwrap(), "hello");
        assert!(caption(&"x".repeat(MAX_MESSAGE_CHARS + 1)).is_err());
    }

    #[test]
    fn style_rejects_off_palette_and_off_list_fonts() {
        let mut s = Style::default();
        assert!(style(&s).is_ok());
        s.font_key = "comic-sans".into();
        assert!(style(&s).is_err());
        s.font_key = "geist-sans".into();
        s.fill = Fill::Solid {
            color: ColorKey("#ff00ff".into()),
        };
        assert!(style(&s).is_err());
        s.fill = Fill::Gradient {
            from: ColorKey("teal".into()),
            to: ColorKey("nope".into()),
        };
        assert!(style(&s).is_err());
        s.fill = Fill::Gradient {
            from: ColorKey("teal".into()),
            to: ColorKey("violet".into()),
        };
        s.weight = 600;
        assert!(style(&s).is_err());
    }

    fn field(label: &str, value: &str) -> StatusField {
        StatusField {
            label: label.into(),
            value: value.into(),
        }
    }

    #[test]
    fn status_fields_are_trimmed_capped_and_plain() {
        assert_eq!(
            status_fields(&[field("  GitHub ", " github.com/you  ")]).unwrap(),
            vec![field("GitHub", "github.com/you")]
        );
        assert!(status_fields(&[]).unwrap().is_empty());
        let three = [field("A", "1"), field("B", "2"), field("C", "3")];
        assert_eq!(status_fields(&three).unwrap().len(), 3);
        let four = [three.as_slice(), &[field("D", "4")]].concat();
        assert!(status_fields(&four).is_err());

        assert!(status_fields(&[field(&"x".repeat(24), "ok")]).is_ok());
        assert!(status_fields(&[field(&"x".repeat(25), "ok")]).is_err());
        // Counted in characters, not bytes.
        assert!(status_fields(&[field(&"é".repeat(24), &"ü".repeat(80))]).is_ok());
        assert!(status_fields(&[field("Reading", &"x".repeat(81))]).is_err());
        assert!(status_fields(&[field("   ", "ok")]).is_err());
        assert!(status_fields(&[field("Reading", "  ")]).is_err());
        assert!(status_fields(&[field("Read\ting", "ok")]).is_err());
        assert!(status_fields(&[field("Reading", "one\ntwo")]).is_err());
        assert!(status_fields(&[field("Reading", "bell\u{7}")]).is_err());
        // Emoji sequences are words, not control characters.
        assert!(status_fields(&[field("Playing", "👨‍👩‍👧 ⛺")]).is_ok());
        assert!(status_fields(&[field("Reading", "a"), field("reading", "b")]).is_err());
    }

    #[test]
    fn a_status_holds_its_classic_three_to_what_a_field_may_hold() {
        let mut s = UserStatus {
            reading: Some("Piranesi".into()),
            ..UserStatus::default()
        };
        assert!(status(&s).is_ok());
        s.reading = Some("Pira\nnesi".into());
        assert!(status(&s).is_err());
        s.reading = None;
        s.fields = Some(vec![field("Playing", "Outer Wilds"); 4]);
        assert!(status(&s).is_err());
    }
}
