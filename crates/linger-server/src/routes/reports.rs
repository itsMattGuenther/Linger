//! Report (SPEC §4.15, PROTOCOL §5 "Report and block", T-1605): a message or a
//! person, sent to the host and the co-hosts they named (#424), and to nobody
//! else — a self-hosted server has nobody else to send it to. They already
//! have what to do about one: delete the message, remove the person
//! (`routes/users.rs`), or let it go.
//!
//! There is no count anywhere (AGENTS rule 3). Their sessions hear
//! `reports.changed` and ask for the list again; the list is the reports, and
//! the app shows one quiet row while there are any.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, post};
use axum::{Json, Router};
use linger_core::gateway::ServerEvent;
use linger_core::limits::{MAX_REPORT_NOTE_CHARS, RATE_REPORT_PER_HOUR};
use linger_core::wire::{Report, ReportRequest, ReportedMessage};
use linger_core::{MessageId, ReportId, RoomId, UserId};
use sqlx::Row;

use crate::auth::{AuthedUser, HostOrCohost};
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/reports", post(send_report).get(open_reports))
        .route("/reports/{id}", delete(close_report))
}

/// `POST /reports` — a message, or a person, for the host to look at.
async fn send_report(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(req): Json<ReportRequest>,
) -> Result<(StatusCode, Json<Report>), ApiError> {
    let note = req
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty())
        .map(str::to_owned);
    if note
        .as_ref()
        .is_some_and(|note| note.chars().count() > MAX_REPORT_NOTE_CHARS)
    {
        return Err(ApiError::validation(format!(
            "A note to the host is at most {MAX_REPORT_NOTE_CHARS} characters."
        )));
    }

    let (user_id, message) = match (req.message_id, req.user_id) {
        (Some(message_id), None) => {
            let message = repo::messages::by_id(&state.db.read, &state.config, message_id)
                .await?
                .ok_or_else(|| ApiError::not_found("No such message."))?;
            // A message in a DM you're not in is as unknown as one never
            // sent: reporting it must not be a way to learn it exists.
            repo::rooms::visible_to(&state.db.read, message.room_id, auth.id)
                .await
                .map_err(|_| ApiError::not_found("No such message."))?;
            if message.author_id == auth.id {
                return Err(ApiError::validation("You can't report your own message."));
            }
            if message.deleted_at.is_some() {
                return Err(ApiError::validation("That message was deleted."));
            }
            let reported = ReportedMessage {
                id: message.id,
                room_id: message.room_id,
                excerpt: message.body,
                created_at: message.created_at,
            };
            (message.author_id, Some(reported))
        }
        (None, Some(user_id)) => {
            if user_id == auth.id {
                return Err(ApiError::validation("You can't report yourself."));
            }
            repo::users::expect(&state.db.read, user_id).await?;
            (user_id, None)
        }
        _ => {
            return Err(ApiError::validation(
                "A report names a message or a person, one of the two.",
            ))
        }
    };

    // Ten an hour for each person reporting: plenty for a real problem, and
    // not a way to bury the host.
    let key = format!("report:{}", auth.id);
    if let Err(retry_after_ms) = state.limiter.check(&key, RATE_REPORT_PER_HOUR) {
        return Err(ApiError::rate_limited(retry_after_ms));
    }

    let report = Report {
        id: ReportId::new(),
        reporter_id: auth.id,
        user_id,
        message,
        note,
        created_at: now_ms(),
    };
    sqlx::query(
        "INSERT INTO reports (id, reporter_id, user_id, message_id, room_id, excerpt, message_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(report.id.to_vec())
    .bind(report.reporter_id.to_vec())
    .bind(report.user_id.to_vec())
    .bind(report.message.as_ref().map(|m| m.id.to_vec()))
    .bind(report.message.as_ref().map(|m| m.room_id.to_vec()))
    .bind(report.message.as_ref().map(|m| m.excerpt.clone()))
    .bind(report.message.as_ref().map(|m| m.created_at))
    .bind(report.note.clone())
    .bind(report.created_at)
    .execute(&state.db.write)
    .await?;

    tell_the_host(&state).await?;
    Ok((StatusCode::CREATED, Json(report)))
}

/// `GET /reports` — the open reports, newest first, for the host and the
/// co-hosts.
async fn open_reports(
    State(state): State<AppState>,
    _host: HostOrCohost,
) -> Result<Json<Vec<Report>>, ApiError> {
    let rows = sqlx::query(
        "SELECT id, reporter_id, user_id, message_id, room_id, excerpt, message_at, note, created_at
         FROM reports WHERE closed_at IS NULL ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(&state.db.read)
    .await?;
    let reports = rows
        .iter()
        .map(|row| -> Result<Report, ApiError> {
            let message_id: Option<Vec<u8>> = row.get("message_id");
            let room_id: Option<Vec<u8>> = row.get("room_id");
            let message = match (message_id, room_id) {
                (Some(message_id), Some(room_id)) => Some(ReportedMessage {
                    id: MessageId::from_slice(&message_id).map_err(anyhow::Error::from)?,
                    room_id: RoomId::from_slice(&room_id).map_err(anyhow::Error::from)?,
                    excerpt: row.get::<Option<String>, _>("excerpt").unwrap_or_default(),
                    created_at: row.get::<Option<i64>, _>("message_at").unwrap_or_default(),
                }),
                _ => None,
            };
            Ok(Report {
                id: ReportId::from_slice(&row.get::<Vec<u8>, _>("id"))
                    .map_err(anyhow::Error::from)?,
                reporter_id: UserId::from_slice(&row.get::<Vec<u8>, _>("reporter_id"))
                    .map_err(anyhow::Error::from)?,
                user_id: UserId::from_slice(&row.get::<Vec<u8>, _>("user_id"))
                    .map_err(anyhow::Error::from)?,
                message,
                note: row.get("note"),
                created_at: row.get("created_at"),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    Ok(Json(reports))
}

/// `DELETE /reports/:id` — the host or a co-host dealt with it. Closing one already closed
/// changes nothing; one that never existed is not found.
async fn close_report(
    State(state): State<AppState>,
    _host: HostOrCohost,
    Path(id): Path<ReportId>,
) -> Result<StatusCode, ApiError> {
    let exists: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT closed_at FROM reports WHERE id = ?")
            .bind(id.to_vec())
            .fetch_optional(&state.db.read)
            .await?;
    let Some((closed_at,)) = exists else {
        return Err(ApiError::not_found("No such report."));
    };
    if closed_at.is_none() {
        sqlx::query("UPDATE reports SET closed_at = ? WHERE id = ? AND closed_at IS NULL")
            .bind(now_ms())
            .bind(id.to_vec())
            .execute(&state.db.write)
            .await?;
        tell_the_host(&state).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `reports.changed` to every session the host and each co-host has open,
/// and nobody else's (#424). Asked of the database each time rather than
/// remembered, so somebody made a co-host hears the next change, and
/// somebody who stops being one doesn't.
async fn tell_the_host(state: &AppState) -> Result<(), ApiError> {
    let hosts: Vec<(Vec<u8>,)> = sqlx::query_as(
        "SELECT id FROM users WHERE (is_host = 1 OR is_cohost = 1) AND deactivated_at IS NULL",
    )
    .fetch_all(&state.db.read)
    .await?;
    for (host,) in hosts {
        let host = UserId::from_slice(&host).map_err(anyhow::Error::from)?;
        state
            .gateway
            .publish_to(host, ServerEvent::ReportsChanged {});
    }
    Ok(())
}
