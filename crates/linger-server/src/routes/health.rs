//! Health endpoint, for reverse proxies, uptime checks, the app's "is there a
//! Linger server at this address" probe, and the version a host's app compares
//! with the newest release (PROTOCOL §9, #314). Keep it dependency-free and
//! instant.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use linger_core::wire::Health;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

async fn health(State(state): State<AppState>) -> Json<Health> {
    // Prove the database file is actually reachable, not just that we're up.
    let ok = sqlx::query("SELECT 1")
        .fetch_one(&state.db.read)
        .await
        .is_ok();
    Json(Health {
        ok,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
