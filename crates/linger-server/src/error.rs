//! The one error type route handlers return. Serializes to the PROTOCOL §1
//! envelope; `message` must stay human-readable and safe to display — internals
//! go to tracing, never onto the wire.

use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, StatusCode};
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
        Self::rate_limited_with(retry_after_ms, "Slow down a little.")
    }

    /// A limit that says what it is and when to come back (#538), for one a
    /// person can meet without doing anything wrong, such as a crowd joining
    /// from one network. Same code, so an app from before it reads it the
    /// same way and shows the sentence.
    pub fn rate_limited_with(retry_after_ms: u64, message: impl Into<String>) -> Self {
        let mut e = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            ErrorCode::RateLimited,
            message,
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
        let retry_after_ms = self.retry_after_ms;
        let body = ErrorEnvelope {
            error: ErrorBody {
                code: self.code,
                message: self.message,
                retry_after_ms,
            },
        };
        let mut response = (self.status, Json(body)).into_response();
        // The same wait in HTTP's own header, in whole seconds rounded up
        // (PROTOCOL §1), for anything that isn't the app: a script, a proxy.
        // The app reads `retry_after_ms`.
        if let Some(ms) = retry_after_ms {
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from(ms.div_ceil(1_000)));
        }
        response
    }
}

/// How long `ms` is, the way a person says it after "Try again in": "12
/// seconds", "about a minute", "about 10 minutes". Rounded up, so nobody is
/// told to come back before they can.
#[must_use]
pub fn wait_in_words(ms: u64) -> String {
    let seconds = ms.div_ceil(1_000).max(1);
    if seconds == 1 {
        return "a second".into();
    }
    if seconds < 60 {
        return format!("{seconds} seconds");
    }
    match ms.div_ceil(60_000) {
        1 => "about a minute".into(),
        minutes @ 2..=59 => format!("about {minutes} minutes"),
        minutes => match minutes.div_ceil(60) {
            1 => "about an hour".into(),
            hours => format!("about {hours} hours"),
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wait_is_said_the_way_a_person_would_rounded_up() {
        for (ms, said) in [
            (0, "a second"),
            (1, "a second"),
            (1_000, "a second"),
            (1_001, "2 seconds"),
            (11_250, "12 seconds"),
            (59_000, "59 seconds"),
            (59_001, "about a minute"),
            (60_000, "about a minute"),
            (60_001, "about 2 minutes"),
            (599_990, "about 10 minutes"),
            (3_540_000, "about 59 minutes"),
            (3_540_001, "about an hour"),
            (3_600_000, "about an hour"),
            (3_600_001, "about 2 hours"),
        ] {
            assert_eq!(wait_in_words(ms), said, "{ms} ms");
        }
    }

    #[test]
    fn a_refusal_with_a_wait_carries_it_in_the_header_too() {
        let response = ApiError::rate_limited(59_001).into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[RETRY_AFTER], "60");
        let response = ApiError::internal().into_response();
        assert!(!response.headers().contains_key(RETRY_AFTER));
    }
}
