//! Search (SPEC §4.12, PROTOCOL §6, T-1202).
//!
//! One endpoint over the index built in T-1201. This file is the door: it
//! checks the arguments, spends a rate-limit token, and hands the rest to
//! [`crate::repo::search`].
//!
//! The rate limit is the part worth explaining. Every other read endpoint here
//! is a range scan over rows a client already knows exist; a search is work the
//! server does on demand, and it is the one thing a client can fire on every
//! keystroke. Thirty a minute per person is generous for search-as-you-type and
//! still bounded, and it is keyed per person rather than per IP so one busy
//! member cannot use up a household's share.

use axum::extract::{Query as AxumQuery, State};
use axum::routing::get;
use axum::{Json, Router};
use linger_core::limits::{MAX_SEARCH_PAGE, MAX_SEARCH_QUERY_CHARS, RATE_SEARCH};
use linger_core::wire::SearchHit;
use linger_core::{RoomId, UserId};
use serde::Deserialize;

use crate::auth::AuthedUser;
use crate::error::ApiError;
use crate::repo;
use crate::repo::search::{Query, Terms};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    room_id: Option<RoomId>,
    author_id: Option<UserId>,
    before: Option<String>,
    limit: Option<u32>,
}

async fn search(
    State(state): State<AppState>,
    auth: AuthedUser,
    AxumQuery(query): AxumQuery<SearchQuery>,
) -> Result<Json<Vec<SearchHit>>, ApiError> {
    let raw = query.q.unwrap_or_default();
    if raw.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(ApiError::validation("That's a lot to search for at once."));
    }
    // An empty box asked for nothing, and answering it with every message on
    // the server is the one thing this endpoint must not do.
    let terms = Terms::parse(&raw).ok_or_else(|| ApiError::validation("Search for something."))?;

    if let Err(retry_after_ms) = state
        .limiter
        .check(&format!("search:{}", auth.id), RATE_SEARCH)
    {
        return Err(ApiError::rate_limited(retry_after_ms));
    }

    // A filter naming something that is not here is a mistake worth saying out
    // loud: no results and "that room does not exist" look identical otherwise,
    // and only one of them means "try a different word".
    if let Some(room_id) = query.room_id {
        // A DM you are not in answers like a room that is not here. Without
        // this, asking to search inside one would be a way to find out it
        // exists — the results would be empty either way, and `NOT_FOUND`
        // versus an empty page is the difference between "no such room" and
        // "nothing matched in that room".
        repo::rooms::visible_to(&state.db.read, room_id, auth.id).await?;
    }
    if let Some(author_id) = query.author_id {
        repo::users::expect(&state.db.read, author_id).await?;
    }

    let request = Query {
        terms,
        viewer: auth.id,
        room_id: query.room_id,
        author_id: query.author_id,
        before: query
            .before
            .as_deref()
            .map(repo::search::parse_cursor)
            .transpose()?,
        limit: query.limit.unwrap_or(25).clamp(1, MAX_SEARCH_PAGE),
    };
    repo::search::page(&state.db.read, &request).await.map(Json)
}
