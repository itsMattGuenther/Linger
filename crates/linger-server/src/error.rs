//! The one error type route handlers return. Serializes to the PROTOCOL §1
//! envelope; `message` must stay human-readable and safe to display — internals
//! go to tracing, never onto the wire.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use linger_core::wire::{ErrorBody, ErrorCode, ErrorEnvelope};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: ErrorCode,
    pub message: String,
    pub retry_after_ms: Option<u64>,
}

impl ApiError {
    fn new(status: StatusCode, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retry_after_ms: None,
        }
    }

    pub fn unauthenticated() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthenticated,
            "Sign in to do that.",
        )
    }

    /// Same code, different sentence. The default message reads as an
    /// instruction, which is wrong under a login form where the person *is*
    /// trying to sign in. Deliberately says nothing about which half was wrong.
    pub fn unauthenticated_with(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthenticated,
            message,
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, ErrorCode::Forbidden, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::ValidationFailed,
            message,
        )
    }

    /// The file is bigger than a single file may be (SPEC §4.10).
    pub fn file_too_large(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            ErrorCode::FileTooLarge,
            message,
        )
    }

    /// Not a kind of file this server stores, or not the kind it claimed to be.
    pub fn unsupported_media(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ErrorCode::UnsupportedMedia,
            message,
        )
    }

    /// The server's storage pool is full (SPEC §4.10).
    pub fn quota_exceeded(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INSUFFICIENT_STORAGE,
            ErrorCode::QuotaExceeded,
            message,
        )
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, ErrorCode::Conflict, message)
    }

    /// Somebody here already goes by a name that looks like the one asked for
    /// (#574, `names`). It says nothing about who: the person will see the
    /// list once they're in, and a sign-up form is no place to learn it.
    pub fn display_name_taken() -> Self {
        Self::new(
            StatusCode::CONFLICT,
            ErrorCode::DisplayNameTaken,
            "Someone here already goes by a name that looks like that. Try something a little different.",
        )
    }

    pub fn rate_limited(retry_after_ms: u64) -> Self {
        let mut e = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::RateLimited,
            "Slow down a little.",
        );
        e.retry_after_ms = Some(retry_after_ms);
        e
    }

    /// For unexpected failures: log the real cause, say nothing specific.
    pub fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            ErrorCode::Internal,
            "Something went wrong on the server.",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorEnvelope {
            error: ErrorBody {
                code: self.code,
                message: self.message,
                retry_after_ms: self.retry_after_ms,
            },
        };
        (self.status, Json(body)).into_response()
    }
}

/// Anything that bubbles up as `anyhow`/sqlx error becomes an opaque 500 —
/// details are traced server-side only.
impl From<anyhow::Error> for ApiError {
    fn from(err: anyhow::Error) -> Self {
        tracing::error!(error = %err, "internal error");
        Self::internal()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        tracing::error!(error = %err, "database error");
        Self::internal()
    }
}
