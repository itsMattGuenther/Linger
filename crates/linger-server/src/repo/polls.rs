//! Assembling a message's poll (`wire::Message::poll`) and a closed line's
//! result (`wire::Message::poll_closed`), a batch of messages at a time, as
//! reactions are.

use std::collections::HashMap;

use linger_core::wire::{Message, Poll, PollChoice};
use linger_core::{MessageId, UserId};
use sqlx::{Row, Sqlite, SqlitePool};

use crate::error::ApiError;

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

fn id_of(bytes: &[u8]) -> Result<MessageId, ApiError> {
    Ok(MessageId::from_slice(bytes).map_err(anyhow::Error::from)?)
}

/// Fill in the polls among `messages`, and the question and result of every
/// closed line among them.
///
/// # Errors
///
/// The database's.
pub async fn hydrate(db: &SqlitePool, messages: &mut [Message]) -> Result<(), ApiError> {
    let asked: Vec<MessageId> = messages.iter().map(|message| message.id).collect();
    let closed_lines: Vec<MessageId> = messages
        .iter()
        .filter_map(|message| message.poll_closed.as_ref().map(|line| line.poll_id))
        .collect();
    if asked.is_empty() {
        return Ok(());
    }
    let mut polls = load(db, &asked).await?;
    for message in messages.iter_mut() {
        if let Some(poll) = polls.remove(&message.id) {
            message.poll = Some(poll);
        }
    }
    if closed_lines.is_empty() {
        return Ok(());
    }
    let ended = load(db, &closed_lines).await?;
    for message in messages.iter_mut() {
        let Some(line) = message.poll_closed.as_mut() else {
            continue;
        };
        if let Some(poll) = ended.get(&line.poll_id) {
            line.question.clone_from(&poll.question);
            line.winners = winners_of(poll);
        }
    }
    Ok(())
}

/// The polls carried by any of `ids`, whole.
async fn load(db: &SqlitePool, ids: &[MessageId]) -> Result<HashMap<MessageId, Poll>, ApiError> {
    let marks = placeholders(ids.len());
    let sql = format!(
        "SELECT message_id, question, multi, closes_at, closed_at, closed_by
           FROM polls WHERE message_id IN ({marks})"
    );
    let mut query =
        sqlx::query_as::<_, (Vec<u8>, String, bool, i64, Option<i64>, Option<Vec<u8>>)>(&sql);
    for id in ids {
        query = query.bind(id.to_vec());
    }
    let mut polls = HashMap::new();
    for (id, question, multi, closes_at, closed_at, closed_by) in query.fetch_all(db).await? {
        let closed_by = closed_by
            .map(|by| UserId::from_slice(&by))
            .transpose()
            .map_err(anyhow::Error::from)?;
        polls.insert(
            id_of(&id)?,
            Poll {
                question,
                choices: Vec::new(),
                multi,
                closes_at,
                closed_at,
                closed_by,
            },
        );
    }
    if polls.is_empty() {
        return Ok(polls);
    }

    let sql = format!(
        "SELECT message_id, position, text FROM poll_choices
          WHERE message_id IN ({marks}) ORDER BY message_id, position"
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id.to_vec());
    }
    for row in query.fetch_all(db).await? {
        if let Some(poll) = polls.get_mut(&id_of(&row.get::<Vec<u8>, _>("message_id"))?) {
            poll.choices.push(PollChoice {
                text: row.get("text"),
                voter_ids: Vec::new(),
            });
        }
    }

    let sql = format!(
        "SELECT message_id, position, user_id FROM poll_votes
          WHERE message_id IN ({marks}) ORDER BY voted_at, user_id"
    );
    let mut query = sqlx::query(&sql);
    for id in ids {
        query = query.bind(id.to_vec());
    }
    for row in query.fetch_all(db).await? {
        let poll = polls.get_mut(&id_of(&row.get::<Vec<u8>, _>("message_id"))?);
        let position = usize::try_from(row.get::<i64, _>("position")).unwrap_or(usize::MAX);
        if let Some(choice) = poll.and_then(|poll| poll.choices.get_mut(position)) {
            choice.voter_ids.push(
                UserId::from_slice(&row.get::<Vec<u8>, _>("user_id"))
                    .map_err(anyhow::Error::from)?,
            );
        }
    }
    Ok(polls)
}

/// The choice, or the choices tied, with the most votes; none when nobody
/// voted.
#[must_use]
pub fn winners_of(poll: &Poll) -> Vec<String> {
    let most = poll
        .choices
        .iter()
        .map(|choice| choice.voter_ids.len())
        .max()
        .unwrap_or(0);
    if most == 0 {
        return Vec::new();
    }
    poll.choices
        .iter()
        .filter(|choice| choice.voter_ids.len() == most)
        .map(|choice| choice.text.clone())
        .collect()
}

/// The same, counted inside a transaction, for the line written as a poll
/// closes.
///
/// # Errors
///
/// The database's.
pub async fn winners<'c>(
    tx: &mut sqlx::Transaction<'c, Sqlite>,
    poll_id: MessageId,
) -> Result<Vec<String>, ApiError> {
    let counted: Vec<(String, i64)> = sqlx::query_as(
        "SELECT c.text, COUNT(v.user_id) FROM poll_choices c
           LEFT JOIN poll_votes v ON v.message_id = c.message_id AND v.position = c.position
          WHERE c.message_id = ?
          GROUP BY c.position ORDER BY c.position",
    )
    .bind(poll_id.to_vec())
    .fetch_all(&mut **tx)
    .await?;
    let most = counted.iter().map(|(_, n)| *n).max().unwrap_or(0);
    if most == 0 {
        return Ok(Vec::new());
    }
    Ok(counted
        .into_iter()
        .filter(|(_, n)| *n == most)
        .map(|(text, _)| text)
        .collect())
}
