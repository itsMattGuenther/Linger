//! Polls over HTTP (PROTOCOL §4, SPEC §4.18, #474): asking one, voting, and
//! closing one. Closing on time is `crate::polls`.

use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::routing::{post, put};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::{
    MAX_POLL_CHOICES, MAX_POLL_CHOICE_CHARS, MAX_POLL_QUESTION_CHARS, MIN_POLL_CHOICES, POLL_DAYS,
    RATE_POLL_VOTE,
};
use linger_core::wire::{CreatePollRequest, Message, RoomKind, VoteRequest};
use linger_core::{MessageId, RoomId};

use crate::auth::{AuthedUser, HostOrCohost};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/rooms/{id}/polls", post(create))
        .route("/messages/{id}/vote", put(vote))
        .route("/messages/{id}/close", post(close))
}

/// A poll's words, trimmed, after the rules every one of them follows: a
/// question, two to ten different choices, none empty, none too long.
fn checked(req: &CreatePollRequest) -> Result<(String, Vec<String>), ApiError> {
    let question = req.question.trim();
    if question.is_empty() {
        return Err(ApiError::validation("A poll needs a question."));
    }
    if question.chars().count() > MAX_POLL_QUESTION_CHARS {
        return Err(ApiError::validation(format!(
            "A poll's question is at most {MAX_POLL_QUESTION_CHARS} characters."
        )));
    }
    let choices: Vec<String> = req
        .choices
        .iter()
        .map(|choice| choice.trim().to_string())
        .collect();
    if choices.len() < MIN_POLL_CHOICES || choices.len() > MAX_POLL_CHOICES {
        return Err(ApiError::validation(format!(
            "A poll has {MIN_POLL_CHOICES} to {MAX_POLL_CHOICES} choices."
        )));
    }
    if choices.iter().any(String::is_empty) {
        return Err(ApiError::validation("A choice can't be empty."));
    }
    if choices
        .iter()
        .any(|choice| choice.chars().count() > MAX_POLL_CHOICE_CHARS)
    {
        return Err(ApiError::validation(format!(
            "A choice is at most {MAX_POLL_CHOICE_CHARS} characters."
        )));
    }
    let mut seen = HashSet::new();
    if !choices
        .iter()
        .all(|choice| seen.insert(choice.to_lowercase()))
    {
        return Err(ApiError::validation("Each choice can only be there once."));
    }
    if !POLL_DAYS.contains(&req.closes_in_days) {
        return Err(ApiError::validation(
            "A poll closes after 1, 3, 7, 14 or 28 days.",
        ));
    }
    Ok((question.to_string(), choices))
}

/// The poll as words, for an app that doesn't know the field: the question
/// and its choices, as a list.
fn as_words(question: &str, choices: &[String]) -> String {
    let mut words = format!("**Poll:** {question}\n");
    for choice in choices {
        words.push_str(&format!("\n- {choice}"));
    }
    words
}

/// Ask a room a question (#474). The host or a co-host only, as every `/`
/// command is; rooms only, as a message of the day is.
async fn create(
    State(state): State<AppState>,
    host: HostOrCohost,
    Path(room_id): Path<RoomId>,
    Json(req): Json<CreatePollRequest>,
) -> Result<Json<Message>, ApiError> {
    let room = repo::rooms::expect(&state.db.read, room_id).await?;
    if room.kind != RoomKind::Room {
        return Err(ApiError::not_found("No such room on this server."));
    }
    if room.archived_at.is_some() {
        return Err(ApiError::validation("That room is archived."));
    }
    let (question, choices) = checked(&req)?;

    let id = MessageId::new();
    let at = now_ms();
    let mut tx = state.db.write.begin().await?;
    sqlx::query(
        "INSERT INTO messages (id, room_id, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id.to_vec())
    .bind(room_id.to_vec())
    .bind(host.id.to_vec())
    .bind(as_words(&question, &choices))
    .bind(at)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO polls (message_id, question, multi, closes_at) VALUES (?, ?, ?, ?)")
        .bind(id.to_vec())
        .bind(&question)
        .bind(req.multi)
        .bind(at + i64::from(req.closes_in_days) * DAY_MS)
        .execute(&mut *tx)
        .await?;
    for (position, text) in choices.iter().enumerate() {
        sqlx::query("INSERT INTO poll_choices (message_id, position, text) VALUES (?, ?, ?)")
            .bind(id.to_vec())
            .bind(i64::try_from(position).unwrap_or(i64::MAX))
            .bind(text)
            .execute(&mut *tx)
            .await?;
    }
    // Asking is catching up, as saying anything is (#454), and saved with the
    // poll, as a post's marker is with the post (#524).
    crate::routes::messages::advance_read_marker(&mut *tx, host.id, room_id, id).await?;
    tx.commit().await?;

    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    state
        .gateway
        .publish(ServerEvent::MessageCreate(message.clone()));
    Ok(Json(message))
}

/// A poll somebody can see, open, and not taken back.
async fn open_poll(state: &AppState, id: MessageId, user: AuthedUser) -> Result<Message, ApiError> {
    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    repo::rooms::visible_to(&state.db.read, message.room_id, user.id).await?;
    if message.deleted_at.is_some() {
        return Err(ApiError::not_found("That message is gone."));
    }
    let Some(poll) = &message.poll else {
        return Err(ApiError::validation("That message isn't a poll."));
    };
    if poll.closed_at.is_some() || poll.closes_at <= now_ms() {
        return Err(ApiError::validation("That poll has closed."));
    }
    Ok(message)
}

/// Vote, or change a vote, or take it back (an empty list). Anybody who can
/// see the room, whoever asked included; as often as they like until the
/// poll closes.
async fn vote(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<MessageId>,
    Json(req): Json<VoteRequest>,
) -> Result<Json<Message>, ApiError> {
    if let Err(retry) = state
        .limiter
        .check(&format!("vote:{}", auth.id), RATE_POLL_VOTE)
    {
        return Err(ApiError::rate_limited(retry));
    }
    let message = open_poll(&state, id, auth).await?;
    let Some(poll) = &message.poll else {
        return Err(ApiError::validation("That message isn't a poll."));
    };
    let picked: HashSet<u32> = req.choices.iter().copied().collect();
    if picked.len() != req.choices.len() {
        return Err(ApiError::validation("Each choice can only be picked once."));
    }
    if picked.len() > 1 && !poll.multi {
        return Err(ApiError::validation("This poll takes one choice."));
    }
    if picked
        .iter()
        .any(|&at| usize::try_from(at).map_or(true, |at| at >= poll.choices.len()))
    {
        return Err(ApiError::validation("That poll has no such choice."));
    }

    let at = now_ms();
    let mut tx = state.db.write.begin().await?;
    sqlx::query("DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?")
        .bind(id.to_vec())
        .bind(auth.id.to_vec())
        .execute(&mut *tx)
        .await?;
    let mut ordered: Vec<u32> = picked.into_iter().collect();
    ordered.sort_unstable();
    for position in ordered {
        sqlx::query(
            "INSERT INTO poll_votes (message_id, position, user_id, voted_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id.to_vec())
        .bind(i64::from(position))
        .bind(auth.id.to_vec())
        .bind(at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // The poll as it stands now, to everybody in the room: a vote changes
    // what the poll shows, and never makes the room look new.
    let message = repo::messages::expect(&state.db.read, &state.config, id).await?;
    state
        .gateway
        .publish(ServerEvent::MessageUpdate(message.clone()));
    Ok(Json(message))
}

/// Close a poll before its time. Only whoever asked (Matt, 2026-10-10): not
/// the host and not a co-host, who can still delete it like any message.
async fn close(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<MessageId>,
) -> Result<Json<Message>, ApiError> {
    let message = open_poll(&state, id, auth).await?;
    if message.author_id != auth.id {
        return Err(ApiError::forbidden("Only whoever asked can close a poll."));
    }
    crate::polls::close(&state, id, Some(auth.id)).await?;
    Ok(Json(
        repo::messages::expect(&state.db.read, &state.config, id).await?,
    ))
}
