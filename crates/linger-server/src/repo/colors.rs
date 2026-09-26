//! A newcomer's name color (SPEC §4.5). Everyone used to start in the default
//! gray, so in a big server most people, who never change it, looked alike.
//! Now whoever joins (or sets a server up) is given the palette color that the
//! fewest active people on the server wear. They can change it any time in
//! Profile; this only chooses where they start.

use std::collections::HashMap;

use linger_core::{UserId, PALETTE};
use sqlx::{Row, Sqlite, Transaction};

use crate::error::ApiError;

/// The palette's hued colors in the order ties are broken: around the wheel
/// in steps of seven, so each next newcomer lands far from the last. Slate,
/// the one muted entry, is never handed out: it reads as "no color chosen".
fn spread() -> impl Iterator<Item = &'static str> {
    let hued: Vec<&'static str> = PALETTE
        .iter()
        .filter(|color| !color.muted)
        .map(|color| color.key)
        .collect();
    (0..hued.len()).filter_map(move |step| hued.get((step * 7) % hued.len()).copied())
}

/// The color to give a newcomer, from the colors already worn: the least worn
/// hued color, ties going to the first in `spread`. Only the first color of a
/// gradient counts, since that is the color of the person's dot.
pub fn next_color<'a>(worn: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for color in worn {
        *counts.entry(color).or_default() += 1;
    }
    let mut best: Option<(&'static str, usize)> = None;
    for color in spread() {
        let count = counts.get(color).copied().unwrap_or(0);
        if best.is_none_or(|(_, fewest)| count < fewest) {
            best = Some((color, count));
        }
    }
    best.map_or("ember", |(color, _)| color)
}

/// Give a just-created account its starting color, inside the transaction
/// that created it, so two people joining at once still count each other
/// (SQLite runs one writer at a time).
pub async fn assign_starting_color(
    tx: &mut Transaction<'_, Sqlite>,
    user: UserId,
) -> Result<(), ApiError> {
    let rows = sqlx::query(
        "SELECT s.fill_from FROM users u
         LEFT JOIN user_style s ON s.user_id = u.id
         WHERE u.deactivated_at IS NULL AND u.id != ?",
    )
    .bind(user.to_vec())
    .fetch_all(&mut **tx)
    .await?;
    let worn: Vec<String> = rows
        .iter()
        .filter_map(|row| row.get::<Option<String>, _>("fill_from"))
        .collect();
    let color = next_color(worn.iter().map(String::as_str));
    sqlx::query("INSERT INTO user_style (user_id, fill_kind, fill_from) VALUES (?, 'solid', ?)")
        .bind(user.to_vec())
        .bind(color)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{next_color, spread};
    use std::collections::HashSet;

    /// How many hued colors there are: every palette entry but the muted one.
    const HUES: usize = 15;

    #[test]
    fn hands_out_every_hued_color_before_any_twice() {
        let mut worn: Vec<&str> = Vec::new();
        for _ in 0..HUES {
            let next = next_color(worn.iter().copied());
            worn.push(next);
        }
        let distinct: HashSet<&str> = worn.iter().copied().collect();
        assert_eq!(distinct.len(), HUES);
        assert!(!distinct.contains("slate"));
        // The sixteenth starts the round again, from the top.
        assert_eq!(next_color(worn.iter().copied()), worn[0]);
    }

    #[test]
    fn neighbors_in_line_are_far_apart_on_the_wheel() {
        let order: Vec<&str> = spread().collect();
        assert_eq!(order.len(), HUES);
        assert_eq!(&order[..4], &["ember", "teal", "rose", "mint"]);
    }

    #[test]
    fn counts_colors_people_chose_and_ignores_gray() {
        // Everyone else chose ember and teal, and some are still gray.
        let worn = ["ember", "teal", "slate", "slate", "ember"];
        assert_eq!(next_color(worn), "rose");
        // With every color worn once but one, that one is next.
        let all_but_violet: Vec<&str> = spread().filter(|color| *color != "violet").collect();
        assert_eq!(next_color(all_but_violet), "violet");
    }
}
