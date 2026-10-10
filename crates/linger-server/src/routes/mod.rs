//! Route assembly. Everything REST lives under `/api/v1`; the gateway upgrades
//! at `/api/v1/gateway` (PROTOCOL preamble).
//!
//! Two paths sit deliberately *outside* `/api/v1`: `/upload/...` takes the bytes
//! of an upload and `/objects/...` serves them back. Bytes never travel through
//! the JSON API (ARCHITECTURE §8) — see [`objects`].
//!
//! `/objects/...` is also outside the app's *origin*, not just its path space:
//! it answers on `cdn.<domain>` and nowhere else, and every other route answers
//! everywhere else. See [`media_origin_gate`].
//!
//! Unknown paths get the PROTOCOL §1 envelope, not axum's plain-text 404, so
//! the client can always switch on `error.code`.

mod auth;
mod blocks;
mod dms;
mod emoji;
mod export;
mod health;
mod invites;
mod knock;
mod links;
mod media;
mod messages;
mod objects;
mod polls;
mod reports;
mod rooms;
mod search;
mod server;
mod setup;
mod uploads;
mod users;
mod voice;

use axum::extract::{Request, State};
use axum::http::{header, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::error::ApiError;
use crate::state::AppState;

/// Origins the desktop client runs from. A webview page is a cross-origin
/// caller like any other, so without these the client can't read a single
/// response — which is how this list came to exist (T-301).
///
/// Tauri serves the app from `tauri://localhost`, except on Windows and Android
/// where webview2/webkit need the `tauri.localhost` workaround host. The last
/// entry is Vite's dev server, so `pnpm dev` can talk to a real server.
///
/// It is a fixed list rather than "reflect whatever asked", on purpose: with a
/// wildcard, any web page you happened to visit could read this server's
/// unauthenticated endpoints and learn that it exists. Nothing here needs to be
/// reachable from the open web.
const CLIENT_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
];

fn cors() -> CorsLayer {
    let origins: Vec<HeaderValue> = CLIENT_ORIGINS
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        // The client reads the etag off each uploaded part and hands it back at
        // complete; a cross-origin caller cannot see a header unless it is
        // named here.
        .expose_headers([header::ETAG])
        // Auth is a bearer token the client holds deliberately. There are no
        // cookies, so there is no ambient authority for a browser to attach.
        .allow_credentials(false)
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .merge(health::router())
        .merge(setup::router())
        .merge(auth::router())
        .merge(users::router())
        .merge(invites::router())
        .merge(server::router())
        .merge(rooms::router())
        .merge(dms::router())
        .merge(messages::router())
        .merge(polls::router())
        .merge(uploads::router())
        .merge(media::router())
        .merge(search::router())
        .merge(export::router())
        .merge(knock::router())
        .merge(blocks::router())
        .merge(reports::router())
        .merge(voice::router())
        .merge(links::router())
        .merge(emoji::router())
        .route("/gateway", any(crate::gateway::ws_route))
        .fallback(api_not_found);

    Router::new()
        .nest("/api/v1", api)
        .merge(objects::router())
        .layer(cors())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            media_origin_gate,
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Keep the two origins apart (ARCHITECTURE §7).
///
/// Uploaded files are somebody else's bytes, so they are served from a host of
/// their own — `cdn.<domain>` by default. That is only worth anything if the
/// two hosts serve different things, and a reverse proxy that sends both names
/// to this process would otherwise serve everything on both:
///
/// - on the media host, `/objects/...` and nothing else. A file that talked a
///   browser into running it would find no API to call at its own origin.
/// - everywhere else, everything *but* `/objects/...`. A hostile upload cannot
///   be fetched from the app's own name, so it can never be same-origin with
///   the app.
///
/// A server with no `LINGER_DOMAIN` has only one origin and this does nothing —
/// there is no second host to keep it away from.
async fn media_origin_gate(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let Some(media_host) = state.config.media_host() else {
        return next.run(request).await;
    };

    let host = request
        .uri()
        .host()
        .map(str::to_string)
        .or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(hostname_of)
        })
        .unwrap_or_default();

    let asked_the_media_host = host.eq_ignore_ascii_case(media_host);
    let asked_for_an_object = request.uri().path().starts_with("/objects/");
    if asked_the_media_host != asked_for_an_object {
        return ApiError::not_found("No such thing on this server.").into_response();
    }
    next.run(request).await
}

/// The hostname out of a `Host` header, without its port. IPv6 arrives in
/// brackets (`[::1]:8420`), which is the only reason this is not a `split`.
fn hostname_of(header: &str) -> String {
    let header = header.trim();
    if let Some(rest) = header.strip_prefix('[') {
        return rest.split(']').next().unwrap_or_default().to_string();
    }
    header
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

async fn api_not_found() -> ApiError {
    ApiError::not_found("No such thing on this server.")
}

#[cfg(test)]
mod tests {
    use super::hostname_of;

    #[test]
    fn a_host_header_is_compared_without_its_port() {
        assert_eq!(hostname_of("cdn.linger.example"), "cdn.linger.example");
        assert_eq!(hostname_of("cdn.linger.example:8443"), "cdn.linger.example");
        assert_eq!(hostname_of("CDN.Linger.Example"), "cdn.linger.example");
        assert_eq!(hostname_of("[::1]:8420"), "::1");
    }
}
