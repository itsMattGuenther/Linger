//! `reset-password`: the way back into a server whose host is locked out (T-414).
//!
//! There is no reset email and no reset link, on purpose. A Linger server holds
//! no addresses to send one to, and the first-run setup token only exists while
//! the server has no users at all — so once the host has forgotten their
//! password there is nothing left that can prove who they are except the machine
//! itself. Being able to run a command against the database *is* the proof of
//! ownership, which is the position ARCHITECTURE §9 already takes on first-run
//! setup: no token, no login, no credentials in environment variables.
//!
//! The password never arrives as a command-line argument. Arguments land in
//! shell history and are readable in `ps` by anyone else on the box, so the
//! caller either lets [`generate_password`] make one or pipes one in.

use linger_core::limits::MIN_PASSWORD_CHARS;
use linger_core::UserId;
use rand::RngCore;
use sqlx::SqlitePool;

use crate::auth;

/// What the reset did, so the command line can say it in plain words.
#[derive(Debug)]
pub struct Reset {
    /// The username as stored, which is lowercase even if the caller shouted it.
    pub username: String,
    pub display_name: String,
    /// This account is currently removed from the server, so the new password
    /// will not sign them in until the host lets them back in.
    pub removed: bool,
}

/// Set a new password for `username` and sign that account out everywhere.
///
/// Revoking the refresh families is not politeness, it is the point: the usual
/// reason to reset a password is that somebody else may have had it, and a
/// refresh token that survives the reset keeps handing that person fresh access
/// tokens for the rest of its thirty days.
pub async fn reset_password(
    db: &SqlitePool,
    username: &str,
    new_password: &str,
) -> anyhow::Result<Reset> {
    if new_password.chars().count() < MIN_PASSWORD_CHARS {
        anyhow::bail!("A password needs at least {MIN_PASSWORD_CHARS} characters.");
    }

    // Usernames are stored lowercase and login lowercases what it is given, so
    // this does too — being shouted at by the shell should not be a failure.
    let username = username.trim().to_lowercase();

    // Deliberately not filtered on `deactivated_at`: a removed member is still
    // an account, and refusing here would report them as nonexistent, which is
    // a different and wrong thing to tell somebody.
    let row: Option<(Vec<u8>, String, Option<i64>)> =
        sqlx::query_as("SELECT id, display_name, deactivated_at FROM users WHERE username = ?")
            .bind(&username)
            .fetch_optional(db)
            .await?;
    let Some((id, display_name, deactivated_at)) = row else {
        anyhow::bail!("There is no account called \"{username}\" on this server.");
    };
    let user_id = UserId::from_slice(&id)?;

    // One hash from a command run by hand, with the server stopped: there is
    // nothing to share turns with, so no `PasswordWork` (#495). Still off the
    // reactor.
    let password = new_password.to_string();
    let password_hash =
        tokio::task::spawn_blocking(move || auth::hash_password_sync(&password)).await??;
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(password_hash)
        .bind(&id)
        .execute(db)
        .await?;
    auth::revoke_all_for_user(db, user_id).await?;

    Ok(Reset {
        username,
        display_name,
        removed: deactivated_at.is_some(),
    })
}

/// A password nobody has to invent while they are stressed and locked out.
///
/// Four groups of five characters, hyphenated, from a 32-character alphabet with
/// the look-alikes taken out (no `l`, no `o`, no `0`, no `1`). That is 100 bits,
/// and the grouping is there so it can be read off a terminal and typed into a
/// phone without a second attempt. The alphabet is exactly 32 characters so five
/// random bits map onto it with no bias to reason about.
#[must_use]
pub fn generate_password() -> String {
    const ALPHABET: &[u8; 32] = b"23456789abcdefghijkmnpqrstuvwxyz";
    const GROUPS: usize = 4;
    const PER_GROUP: usize = 5;

    let mut bytes = [0u8; GROUPS * PER_GROUP];
    rand::rngs::OsRng.fill_bytes(&mut bytes);

    let mut out = String::with_capacity(bytes.len() + GROUPS - 1);
    for (i, byte) in bytes.iter().enumerate() {
        if i > 0 && i % PER_GROUP == 0 {
            out.push('-');
        }
        out.push(char::from(ALPHABET[usize::from(byte & 0b0001_1111)]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_passwords_are_grouped_readable_and_not_the_same_twice() {
        let password = generate_password();
        assert_eq!(password.len(), 23, "four groups of five, three hyphens");
        assert!(password
            .chars()
            .all(|c| c == '-' || (c.is_ascii_alphanumeric() && !"01lo".contains(c))));
        assert!(password.chars().count() >= MIN_PASSWORD_CHARS);
        assert_ne!(password, generate_password());
    }
}
