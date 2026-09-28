//! A status's labelled fields and the three keys older apps know (SPEC §4.6,
//! PROTOCOL §5, #270).
//!
//! A status has up to three fields, each a label the person chose and a value.
//! Apps from before #270 know three fixed ones instead, `listening`, `reading`
//! and `working_on`, and they keep working both ways:
//!
//! - **Reading.** Every status still carries the three keys, each filled from
//!   the field whose label is exactly "Listening to", "Reading" or
//!   "Working on" ([`classic_of`]). Any other field is left out of them.
//! - **Saving.** A save with no `fields` is from such an app. It changes only
//!   the fields with those three labels and keeps every other one
//!   ([`apply_classic`]), so a friend on an older app going away doesn't wipe
//!   the "Playing" they set in a newer one.

use linger_core::limits::MAX_STATUS_FIELDS;
use linger_core::wire::{
    StatusField, UserStatus, STATUS_LABEL_LISTENING, STATUS_LABEL_READING, STATUS_LABEL_WORKING_ON,
};

use crate::error::ApiError;

/// The three keys an older app reads, filled from the fields.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Classic {
    pub listening: Option<String>,
    pub reading: Option<String>,
    pub working_on: Option<String>,
}

/// The value of each field whose label is exactly one of the classic three.
///
/// Exactly means exactly: "reading" in lower case is somebody's own label, and
/// an older app doesn't see it. The server never stores two fields with one
/// label (`validate::status_fields`), so there is one answer for each.
#[must_use]
pub fn classic_of(fields: &[StatusField]) -> Classic {
    let find = |label: &str| {
        fields
            .iter()
            .find(|field| field.label == label)
            .map(|field| field.value.clone())
    };
    Classic {
        listening: find(STATUS_LABEL_LISTENING),
        reading: find(STATUS_LABEL_READING),
        working_on: find(STATUS_LABEL_WORKING_ON),
    }
}

/// The fields after a save from an app that predates them (`fields` absent).
///
/// For each classic key, in the order a card shows them:
///
/// - a field with that label takes the value sent, in its place, or goes
///   when the value is empty or null;
/// - with no such field, a value sent adds one at the end.
///
/// Every other field is kept as it was. Replacing and removing happen before
/// adding, so a save that swaps one classic field for another fits. A value
/// that would make a fourth field is refused: the older app can't show the
/// fields it would have to push out, so it doesn't get to drop one.
pub fn apply_classic(
    mut fields: Vec<StatusField>,
    status: &UserStatus,
) -> Result<Vec<StatusField>, ApiError> {
    let sent = [
        (STATUS_LABEL_LISTENING, &status.listening),
        (STATUS_LABEL_READING, &status.reading),
        (STATUS_LABEL_WORKING_ON, &status.working_on),
    ]
    .map(|(label, value)| {
        let value = value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        (label, value)
    });

    let mut adding = Vec::new();
    for (label, value) in sent {
        let held = fields.iter().position(|field| field.label == label);
        match (held, value) {
            (Some(at), Some(value)) => value.clone_into(&mut fields[at].value),
            (Some(at), None) => {
                fields.remove(at);
            }
            (None, Some(value)) => adding.push(StatusField {
                label: label.to_string(),
                value: value.to_string(),
            }),
            (None, None) => {}
        }
    }
    if fields.len() + adding.len() > MAX_STATUS_FIELDS {
        return Err(ApiError::validation(
            "Your status already has three fields. Clear one in a newer version of Linger first.",
        ));
    }
    fields.extend(adding);
    Ok(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(label: &str, value: &str) -> StatusField {
        StatusField {
            label: label.into(),
            value: value.into(),
        }
    }

    fn classic(
        listening: Option<&str>,
        reading: Option<&str>,
        working_on: Option<&str>,
    ) -> UserStatus {
        UserStatus {
            listening: listening.map(Into::into),
            reading: reading.map(Into::into),
            working_on: working_on.map(Into::into),
            ..UserStatus::default()
        }
    }

    #[test]
    fn the_classic_keys_come_from_labels_that_match_exactly() {
        let fields = [
            field("Playing", "Outer Wilds"),
            field("Reading", "Piranesi"),
            field("working on", "not this one"),
        ];
        assert_eq!(
            classic_of(&fields),
            Classic {
                listening: None,
                reading: Some("Piranesi".into()),
                working_on: None,
            }
        );
        assert_eq!(classic_of(&[]), Classic::default());
    }

    #[test]
    fn an_older_save_changes_its_three_in_place_and_keeps_the_rest() {
        let held = vec![
            field("Playing", "Outer Wilds"),
            field("Reading", "Piranesi"),
            field("GitHub", "github.com/you"),
        ];
        // The same values back: nothing moves.
        assert_eq!(
            apply_classic(held.clone(), &classic(None, Some("Piranesi"), None)).unwrap(),
            held
        );
        // A new value replaces the old one where it stands.
        assert_eq!(
            apply_classic(held.clone(), &classic(None, Some(" Dune "), None)).unwrap(),
            vec![
                field("Playing", "Outer Wilds"),
                field("Reading", "Dune"),
                field("GitHub", "github.com/you"),
            ]
        );
        // Empty or null clears it, and only it.
        for cleared in [None, Some(""), Some("  ")] {
            assert_eq!(
                apply_classic(held.clone(), &classic(None, cleared, None)).unwrap(),
                vec![
                    field("Playing", "Outer Wilds"),
                    field("GitHub", "github.com/you")
                ]
            );
        }
    }

    #[test]
    fn an_older_save_adds_at_the_end_in_card_order() {
        assert_eq!(
            apply_classic(
                vec![field("Playing", "Outer Wilds")],
                &classic(Some("Khruangbin"), None, Some("a porch light"))
            )
            .unwrap(),
            vec![
                field("Playing", "Outer Wilds"),
                field("Listening to", "Khruangbin"),
                field("Working on", "a porch light"),
            ]
        );
    }

    #[test]
    fn an_older_save_never_makes_a_fourth_field_but_may_swap_one() {
        let full = vec![
            field("Playing", "Outer Wilds"),
            field("Reading", "Piranesi"),
            field("GitHub", "github.com/you"),
        ];
        assert!(apply_classic(
            full.clone(),
            &classic(Some("Khruangbin"), Some("Piranesi"), None)
        )
        .is_err());
        // Reading goes, so Listening to fits, at the end.
        assert_eq!(
            apply_classic(full, &classic(Some("Khruangbin"), None, None)).unwrap(),
            vec![
                field("Playing", "Outer Wilds"),
                field("GitHub", "github.com/you"),
                field("Listening to", "Khruangbin"),
            ]
        );
    }
}
