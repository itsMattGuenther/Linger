//! The media collection and its stars (SPEC §4.4, PROTOCOL §6).
//!
//! `GET /media` is the grid: everything shared on this server, filterable by
//! person, by type and by date range, newest first with starred items ahead of
//! everything else. The assembly and the paging rules live in
//! [`crate::repo::media`]; this file is the door and the argument checking.
//!
//! Stars are on uploads only, because a star is what stops a file being swept
//! (SPEC §4.4, T-505, #583). A link or a pinned message has no object to
//! keep alive — a pin is already the thing that keeps a message.

use axum::extract::{Path, Query as AxumQuery, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use linger_core::limits::MAX_MEDIA_PAGE;
use linger_core::wire::{MediaItem, MediaKind};
use linger_core::{AttachmentId, UserId};
use serde::Deserialize;

use crate::auth::AuthedUser;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo::media::{Cursor, Query};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/media", get(page))
        .route("/media/{id}/star", put(star).delete(unstar))
}

#[derive(Deserialize)]
struct MediaQuery {
    kind: Option<MediaKind>,
    author: Option<UserId>,
    before: Option<String>,
    /// Unix ms, inclusive on both ends — the date range in SPEC §4.4.
    since: Option<i64>,
    until: Option<i64>,
    /// `true`: only what would go next, "Leaving soon" (#583).
    leaving: Option<bool>,
    limit: Option<u32>,
}

async fn page(
    State(state): State<AppState>,
    auth: AuthedUser,
    AxumQuery(query): AxumQuery<MediaQuery>,
) -> Result<Json<Vec<MediaItem>>, ApiError> {
    // A range that ends before it starts is a mistake worth naming: silently
    // answering with an empty grid reads as "nothing was ever shared".
    if let (Some(since), Some(until)) = (query.since, query.until) {
        if until < since {
            return Err(ApiError::validation(
                "That date range ends before it starts.",
            ));
        }
    }
    // What would go next (#583). Nothing is leaving soon on a server with
    // expiry off, or with room to spare under `when-full`.
    let leaving_before = if query.leaving == Some(true) {
        match crate::expiry::leaving_cutoff(&state, now_ms()).await? {
            Some(at) => Some(at),
            None => return Ok(Json(Vec::new())),
        }
    } else {
        None
    };
    let request = Query {
        viewer: auth.id,
        kind: query.kind,
        author: query.author,
        before: query.before.as_deref().map(Cursor::parse).transpose()?,
        since: query.since,
        until: query.until,
        leaving_before,
        limit: query.limit.unwrap_or(50).clamp(1, MAX_MEDIA_PAGE),
    };
    crate::repo::media::page(&state.db.read, &state.config, &request)
        .await
        .map(Json)
}

/// `PUT /media/:id/star` — anyone can star anything (SPEC §4.4). There is no
/// per-person star: the collection belongs to the room, not to a reader.
async fn star(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<AttachmentId>,
) -> Result<StatusCode, ApiError> {
    set(&state, id, auth.id, Some(now_ms())).await
}

async fn unstar(
    State(state): State<AppState>,
    auth: AuthedUser,
    Path(id): Path<AttachmentId>,
) -> Result<StatusCode, ApiError> {
    set(&state, id, auth.id, None).await
}

async fn set(
    state: &AppState,
    id: AttachmentId,
    viewer: UserId,
    starred_at: Option<i64>,
) -> Result<StatusCode, ApiError> {
    if crate::repo::media::set_star(&state.db.write, id, viewer, starred_at).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("That isn't in the media collection."))
    }
}
