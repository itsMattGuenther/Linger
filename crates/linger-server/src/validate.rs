//! Input validation with the PROTOCOL §2/§3 shapes. Kept dependency-free (no
//! regex crate for three character classes) and returning `ApiError` directly
//! so handlers read as straight-line code.

use linger_core::limits::{
    MAX_DISPLAY_NAME_CHARS, MAX_FILENAME_CHARS, MAX_MESSAGE_CHARS, MAX_STATUS_FIELDS,
    MAX_STATUS_FIELD_CHARS, MAX_STATUS_LABEL_CHARS, MAX_STATUS_LINE_CHARS, MIN_PASSWORD_CHARS,
};
use linger_core::wire::{Fill, StatusField, Style, UserStatus};

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

pub fn display_name(s: &str) -> Result<(), ApiError> {
    let len = s.trim().chars().count();
    if (1..=MAX_DISPLAY_NAME_CHARS).contains(&len) {
        Ok(())
    } else {
        Err(ApiError::validation("Display names are 1–32 characters."))
    }
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

/// A filename is stored and echoed back in a download header, so it is stripped
/// of anything that could steer a filesystem or forge a header line: directory
/// components, control characters, quotes.
pub fn filename(s: &str) -> Result<String, ApiError> {
    let base = s.rsplit(['/', '\\']).next().unwrap_or(s).trim();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '\\'))
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
pub fn status(status: &UserStatus) -> Result<(), ApiError> {
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
    Ok(())
}

/// The labelled fields a status is saved with (#270), trimmed.
///
/// At most three. A label is 1–24 characters and a value 1–80, counted after
/// trimming, and neither may hold a control character: both are drawn on one
/// line of a card, and a tab or a line break there is a way to push text
/// somewhere it was not written. No two fields share a label, ignoring case,
/// so each of the three classic labels names at most one field. An empty
/// value is refused rather than dropped: an app leaves out a field nobody
/// filled in.
pub fn status_fields(fields: &[StatusField]) -> Result<Vec<StatusField>, ApiError> {
    if fields.len() > MAX_STATUS_FIELDS {
        return Err(ApiError::validation("A status has three fields at most."));
    }
    let mut out: Vec<StatusField> = Vec::with_capacity(fields.len());
    for field in fields {
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

    #[test]
    fn username_shapes() {
        assert!(username("matt").is_ok());
        assert!(username("m_42").is_ok());
        assert!(username("m").is_err());
        assert!(username("Matt").is_err());
        assert!(username("matt guenther").is_err());
        assert!(username(&"x".repeat(25)).is_err());
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
