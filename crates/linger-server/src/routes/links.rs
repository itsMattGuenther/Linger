//! `POST /links/preview` — the one-line card a link renders as (SPEC §5.6).
//!
//! The client asks about the URLs it is drawing; the server answers from its
//! cache and fetches whatever is missing or stale. **The client never fetches**:
//! if it did, every site anybody linked would collect the IP of every person who
//! scrolled past the message, and a favicon `<img>` pointed at a remote host
//! would do it without anyone clicking a thing. So the host's own IP does the
//! looking, once per URL for everybody, and the icon comes back inline as a
//! `data:` URI (`links::fetch`, where the SSRF guard lives).
//!
//! A URL this server will not fetch — a private address, a port, anything that
//! is not http(s) — still gets a card, made of its domain. Refusing to answer
//! would tell the client to try again forever, and a link to `192.168.1.1` in a
//! message is far more likely to be somebody's router than an attack.

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use linger_core::limits::{MAX_LINK_PREVIEW_BATCH, RATE_LINK_PREVIEW};
use linger_core::wire::{LinkPreview, LinkPreviewRequest};

use crate::auth::AuthedUser;
use crate::db::now_ms;
use crate::error::ApiError;
use crate::links;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/links/preview", post(preview))
}

/// Cards for links a client is about to draw.
///
/// **There is no room here, and no membership check** (SPEC §4.13, T-1303).
/// This answers about URLs the caller already holds, with what a public web
/// page says about itself — never with anything from this server, so a DM's
/// contents cannot come back through it. The link *cards in the media grid* are
/// the surface that could leak, and those are filtered where they are listed.
///
/// One thing this does share across the server: the preview cache is keyed by
/// URL, so a URL somebody posted in a DM answers faster the second time anybody
/// asks about it. Reading that would mean already knowing the exact URL, and
/// the cache is deliberate — the server fetches once for everybody so that
/// looking at a message never tells a website who read it (ARCHITECTURE §7).
/// Splitting it per room would trade a privacy property people have for one
/// nobody can use.
async fn preview(
    State(state): State<AppState>,
    auth: AuthedUser,
    Json(request): Json<LinkPreviewRequest>,
) -> Result<Json<Vec<LinkPreview>>, ApiError> {
    if request.urls.len() > MAX_LINK_PREVIEW_BATCH {
        return Err(ApiError::validation(format!(
            "Ask about at most {MAX_LINK_PREVIEW_BATCH} links at a time."
        )));
    }
    if let Err(retry) = state
        .limiter
        .check(&format!("link:{}", auth.id), RATE_LINK_PREVIEW)
    {
        return Err(ApiError::rate_limited(retry));
    }

    let now = now_ms();
    let cached = crate::repo::links::cached(&state.db.read, &request.urls).await?;

    // Which of them need the network: never looked at, or looked at long enough
    // ago to be worth asking again.
    let mut wanted = Vec::new();
    for url in &request.urls {
        let known = cached.get(url);
        let stale = known.is_none_or(|row| row.wants_another_look(url, now));
        if stale && links::previewable(url).is_some() && !wanted.contains(url) {
            wanted.push(url.clone());
        }
    }

    // All at once: the cap on the batch is the cap on the concurrency, each
    // fetch has its own deadline, and the slowest site decides how long this
    // takes rather than the sum of them.
    let fetched = futures_util::future::join_all(wanted.iter().map(|url| async move {
        let found = match links::previewable(url) {
            Some(parsed) => links::fetch(&parsed).await,
            None => links::Fetched::default(),
        };
        (url.clone(), found)
    }))
    .await;

    for (url, found) in &fetched {
        crate::repo::links::store(&state.db.write, url, found, now).await?;
    }

    let cards = request
        .urls
        .iter()
        .map(|url| {
            if let Some((_, found)) = fetched.iter().find(|(candidate, _)| candidate == url) {
                return LinkPreview {
                    url: url.clone(),
                    domain: links::domain_of(url),
                    title: found.title.clone(),
                    icon: found.icon.clone(),
                };
            }
            cached.get(url).map_or_else(
                // Nothing cached and nothing fetched: a URL this server will not
                // go and look at. Its domain is still an honest card.
                || LinkPreview {
                    url: url.clone(),
                    domain: links::domain_of(url),
                    title: None,
                    icon: None,
                },
                |row| row.card(url),
            )
        })
        .collect();
    Ok(Json(cards))
}
