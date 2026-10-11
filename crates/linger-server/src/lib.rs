//! linger-server: the server process. One Rust binary, one data directory.
//!
//! Library layout exists so integration tests can build the exact production
//! router against a temp SQLite file (AGENTS.md testing rules). `main.rs` is a
//! thin shell around [`config`] + [`db`] + [`app`].

pub mod auth;
pub mod config;
pub mod db;
pub mod display;
pub mod error;
pub mod expiry;
pub mod export;
pub mod gateway;
pub mod join_line;
pub mod links;
pub mod media;
pub mod polls;
pub mod ratelimit;
pub mod repo;
pub mod reset;
pub mod routes;
pub mod setup;
pub mod state;
pub mod status_fields;
pub mod storage;
pub mod turn;
pub mod unsent;
pub mod validate;

pub use state::AppState;

/// Build the full application router. Everything REST lives under `/api/v1`;
/// the gateway is at `/api/v1/gateway` (PROTOCOL preamble).
pub fn app(state: AppState) -> axum::Router {
    routes::router(state)
}
