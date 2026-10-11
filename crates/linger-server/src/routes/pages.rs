//! The pages a shared link opens in a browser (PROTOCOL §2.2, #578).
//!
//! An invite link (`/invite/CODE`) and the first-run setup link
//! (`/setup?token=…`) are made to be pasted into the app. People tap links,
//! though, so a friend's first minute used to be a blank 404. These answer
//! with one small page: what the link is for, where to get the app, and the
//! link again with a Copy button.
//!
//! The page is deliberately inert. Its one style sheet and one script are
//! fixed strings whose hashes are the whole of its Content-Security-Policy, so
//! nothing else can run or load, and it reaches nothing outside this server.
//! It sends no referrer, so the link in the address bar never travels to the
//! download site. What it says about an invite is what the unauthenticated
//! preview (`GET /auth/invite/:code`) already tells anybody holding the code,
//! and nothing more.

use std::fmt::Write as _;
use std::sync::OnceLock;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::db::now_ms;
use crate::error::ApiError;
use crate::state::AppState;

const STYLE: &str = include_str!("pages/page.css");
const SCRIPT: &str = include_str!("pages/copy.js");
/// A copy of `assets/logo/linger-logo.svg`: the image is built from `crates/`
/// alone, so the page can't reach the original. A test keeps the two the same.
const LOGO: &str = include_str!("pages/linger-logo.svg");

/// Where the app comes from: the same page the README and the user guide send
/// people to. A fork that ships its own builds changes it here.
const RELEASES_URL: &str = "https://github.com/itsMattGuenther/Linger/releases/latest";
const GUIDE_URL: &str =
    "https://github.com/itsMattGuenther/Linger/blob/main/docs/user-guide.md#installing-linger";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/invite", get(invite_by_query))
        .route("/invite/{code}", get(invite_by_path))
        .route("/setup", get(setup_by_query))
        .route("/setup/{token}", get(setup_by_path))
}

#[derive(serde::Deserialize)]
struct InviteQuery {
    code: Option<String>,
}

#[derive(serde::Deserialize)]
struct SetupQuery {
    token: Option<String>,
}

async fn invite_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Result<Response, ApiError> {
    invite_page(&state, &headers, &code).await
}

async fn invite_by_query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InviteQuery>,
) -> Result<Response, ApiError> {
    invite_page(&state, &headers, query.code.as_deref().unwrap_or_default()).await
}

async fn setup_by_path(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Response {
    setup_page(&state, &headers, &token)
}

async fn setup_by_query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SetupQuery>,
) -> Response {
    setup_page(&state, &headers, query.token.as_deref().unwrap_or_default())
}

/// What an invite can still do, as the page says it.
enum InviteState {
    Open {
        server_name: String,
        expires_at: Option<i64>,
    },
    Expired,
    /// Unknown, revoked or used up: the same "isn't valid" the sign-up form
    /// gives, so the page tells a stranger guessing codes nothing new.
    Invalid,
}

async fn invite_state(state: &AppState, code: &str, now: i64) -> Result<InviteState, ApiError> {
    // (expires_at, max_uses, uses, revoked_at)
    type Row = (Option<i64>, Option<u32>, u32, Option<i64>);
    if !is_invite_code(code) {
        return Ok(InviteState::Invalid);
    }
    let row: Option<Row> =
        sqlx::query_as("SELECT expires_at, max_uses, uses, revoked_at FROM invites WHERE code = ?")
            .bind(code)
            .fetch_optional(&state.db.read)
            .await?;
    let expires_at = match row {
        None | Some((_, _, _, Some(_))) => return Ok(InviteState::Invalid),
        Some((Some(at), _, _, None)) if at <= now => return Ok(InviteState::Expired),
        Some((_, Some(max), uses, None)) if uses >= max => return Ok(InviteState::Invalid),
        Some((expires_at, _, _, None)) => expires_at,
    };
    let server_name: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_config WHERE key = 'name'")
            .fetch_optional(&state.db.read)
            .await?;
    Ok(InviteState::Open {
        server_name: server_name.unwrap_or_else(|| "a Linger server".into()),
        expires_at,
    })
}

/// Invite codes are lowercase base32 (`routes::invites`). Anything else can't
/// be one, and is never echoed back into the page.
fn is_invite_code(code: &str) -> bool {
    (1..=64).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// Setup tokens are hex (`setup::SetupState`).
fn is_setup_token(token: &str) -> bool {
    (1..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn invite_page(
    state: &AppState,
    headers: &HeaderMap,
    code: &str,
) -> Result<Response, ApiError> {
    let code = code.trim().to_lowercase();
    let now = now_ms();
    let page = match invite_state(state, &code, now).await? {
        InviteState::Open {
            server_name,
            expires_at,
        } => {
            let origin = link_origin(state, headers);
            let link = format!("{origin}/invite/{code}");
            let open = app_link("invite", &origin, "code", &code);
            let mut lede = String::from(
                "Linger is a small, private place for a group of friends. \
                 This link is your way in.",
            );
            if let Some(at) = expires_at {
                lede.push(' ');
                lede.push_str(&runs_out_in(at - now));
            }
            Page {
                status: StatusCode::OK,
                title: format!("You're invited to {server_name}"),
                heading: format!(
                    "You\u{2019}re invited to <bdi>{}</bdi>",
                    escape(&server_name)
                ),
                body: format!(
                    "<p class=\"lede\">{}</p>{}",
                    escape(&lede),
                    steps(
                        &link,
                        &open,
                        "Pick a username, the name people will see, and a password. \
                         They\u{2019}re new, just for this server.",
                    )
                ) + &already_have_an_account(state, headers),
            }
        }
        InviteState::Expired => dead_end(
            "This invite has run out",
            "Invites only work for a while. Ask whoever sent it for a new one.",
        ),
        InviteState::Invalid => dead_end(
            "This invite doesn\u{2019}t work",
            "It may have been used already, or taken back. Ask whoever sent it \
             for a new one.",
        ),
    };
    Ok(page.into_response())
}

fn setup_page(state: &AppState, headers: &HeaderMap, token: &str) -> Response {
    let token = token.trim();
    let page = if state.setup.peek().is_none() {
        dead_end(
            "This server is already set up",
            "A setup link works once, to make the host\u{2019}s account. If that\u{2019}s \
             you, open Linger and sign in with your username and password.",
        )
    } else if !is_setup_token(token) || !state.setup.matches(token) {
        dead_end(
            "This setup link doesn\u{2019}t work",
            "The server makes a new setup link every time it starts. Look for the \
             newest one in the server\u{2019}s log.",
        )
    } else {
        let origin = link_origin(state, headers);
        let link = format!("{origin}/setup?token={token}");
        let open = app_link("setup", &origin, "token", token);
        Page {
            status: StatusCode::OK,
            title: "Set up your Linger server".into(),
            heading: "Set up your Linger server".into(),
            body: format!(
                "<p class=\"warning\"><strong>Don\u{2019}t share this link.</strong> \
                 It makes the host\u{2019}s account, and whoever uses it first runs the \
                 server. Send friends an invite from the app instead.</p>{}",
                steps(
                    &link,
                    &open,
                    "Name the server, then pick your username, the name people will \
                     see, and a password. You\u{2019}re the host.",
                )
            ),
        }
    };
    page.into_response()
}

/// Where the link on the page starts: the server's own name when it has one,
/// otherwise the address this browser used, which is the only one known to
/// reach it. A `Host` that isn't a plain host and port is not trusted into
/// the page.
fn link_origin(state: &AppState, headers: &HeaderMap) -> String {
    if state.config.domain.is_some() {
        return state.config.public_origin();
    }
    match headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        Some(host) if is_plain_host(host) => format!("http://{host}"),
        _ => state.config.setup_origin().url,
    }
}

fn is_plain_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 255
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.:[]_".contains(&b))
}

/// The line under an existing account: an invite makes a new one, so somebody
/// who already has one only needs the server's address.
fn already_have_an_account(state: &AppState, headers: &HeaderMap) -> String {
    let origin = link_origin(state, headers);
    let address = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(&origin);
    format!(
        "<p class=\"muted\">Already have an account here? You don\u{2019}t need this \
         invite: paste <code>{}</code> into Linger and sign in.</p>",
        escape(address)
    )
}

/// "It runs out in about 6 days." The page can't know the reader's time zone,
/// so it says how long, never when.
fn runs_out_in(ms: i64) -> String {
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;
    if ms < HOUR {
        "It runs out in less than an hour.".into()
    } else if ms < 2 * DAY {
        let hours = (ms + HOUR / 2) / HOUR;
        format!(
            "It runs out in about {hours} hour{}.",
            if hours == 1 { "" } else { "s" }
        )
    } else {
        let days = (ms + DAY / 2) / DAY;
        format!("It runs out in about {days} days.")
    }
}

/// "Open in Linger" (#607): the same link as a `linger://` one, which an
/// installed Linger registers itself for. It carries the server and the code
/// or token and nothing else; the app reads it as if it had been pasted, and
/// asks nothing until the person presses Continue (`client/src-tauri/src/
/// deep_link.rs`). An `https://` server is named by its host alone; one
/// reached over plain `http://` (on the host's own computer) keeps its scheme.
fn app_link(kind: &str, origin: &str, key: &str, secret: &str) -> String {
    let server = origin.strip_prefix("https://").unwrap_or(origin);
    format!(
        "linger://{kind}?server={}&{key}={}",
        query_value(server),
        query_value(secret)
    )
}

/// Percent-encodes everything but the characters a query value never needs
/// encoded (RFC 3986's unreserved set).
fn query_value(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// The three steps: get the app, paste the link (or open it in Linger), finish
/// in the app.
fn steps(link: &str, open: &str, last: &str) -> String {
    let link = escape(link);
    let open = escape(open);
    let last = escape(last);
    format!(
        "<ol class=\"steps\">\
           <li><h2>Get Linger</h2>\
             <ul class=\"downloads\">\
               <li><a href=\"{RELEASES_URL}\"><strong>Windows</strong>\
                 <span>The file ending in <code>x64-setup.exe</code></span></a></li>\
               <li><a href=\"{RELEASES_URL}\"><strong>Linux</strong>\
                 <span><code>.deb</code>, <code>.rpm</code> or <code>.AppImage</code></span></a></li>\
               <li><a href=\"{RELEASES_URL}\"><strong>Android</strong>\
                 <span>The file ending in <code>.apk</code>, on the phone</span></a></li>\
             </ul>\
             <p class=\"muted\">On Arch or Omarchy, or stuck on a step? \
               <a href=\"{GUIDE_URL}\">The guide</a> goes through each one.</p></li>\
           <li><h2>Open it and paste this link</h2>\
             <p>Into the box that says <strong>Server or link</strong>.</p>\
             <div class=\"copy\">\
               <code id=\"link\" class=\"link\">{link}</code>\
               <button id=\"copy\" type=\"button\" hidden>Copy</button>\
             </div>\
             <p class=\"open\"><span>Already have Linger?</span> \
               <a class=\"open-app\" href=\"{open}\">Open in Linger</a></p>\
             <p class=\"muted\">Nothing happened? Paste the link instead.</p></li>\
           <li><h2>Make your account</h2><p>{last}</p></li>\
         </ol>"
    )
}

fn dead_end(heading: &str, said: &str) -> Page {
    Page {
        status: StatusCode::NOT_FOUND,
        title: heading.into(),
        heading: escape(heading),
        body: format!("<p class=\"lede\">{}</p>", escape(said)),
    }
}

struct Page {
    status: StatusCode,
    /// Plain text; escaped here.
    title: String,
    /// Already HTML.
    heading: String,
    /// Already HTML.
    body: String,
}

impl IntoResponse for Page {
    fn into_response(self) -> Response {
        let html = format!(
            "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
             <meta name=\"robots\" content=\"noindex, nofollow\">\
             <meta name=\"referrer\" content=\"no-referrer\">\
             <meta name=\"color-scheme\" content=\"dark\">\
             <title>{title} \u{b7} Linger</title><style>{STYLE}</style></head>\
             <body><main><div class=\"logo\">{LOGO}</div><h1>{heading}</h1>{body}</main>\
             <footer>Linger has no public sign-up: a link like this is the only way in.</footer>\
             <script>{SCRIPT}</script></body></html>",
            title = escape(&self.title),
            heading = self.heading,
            body = self.body,
        );
        let mut response = (self.status, html).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        );
        if let Ok(policy) = HeaderValue::from_str(content_security_policy()) {
            headers.insert(header::CONTENT_SECURITY_POLICY, policy);
        }
        // The link carries the code: never keep it, and never pass it on.
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
        headers.insert(
            "x-robots-tag",
            HeaderValue::from_static("noindex, nofollow"),
        );
        response
    }
}

/// Everything the page may do: draw its own style, run its own Copy script,
/// and nothing else. No images, fonts, frames, forms or connections.
fn content_security_policy() -> &'static str {
    static POLICY: OnceLock<String> = OnceLock::new();
    POLICY.get_or_init(|| {
        format!(
            "default-src 'none'; style-src '{}'; script-src '{}'; base-uri 'none'; \
             form-action 'none'; frame-ancestors 'none'",
            sha256_source(STYLE),
            sha256_source(SCRIPT)
        )
    })
}

fn sha256_source(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    format!(
        "sha256-{}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

/// Text into HTML, safe in an element and in a quoted attribute.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_logo_is_the_one_in_assets() {
        let original = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/logo/linger-logo.svg"
        ))
        .expect("assets/logo/linger-logo.svg");
        assert_eq!(
            LOGO, original,
            "copy assets/logo/linger-logo.svg over crates/linger-server/src/routes/pages/"
        );
    }

    #[test]
    fn text_is_escaped_for_elements_and_attributes() {
        assert_eq!(
            escape("<b>\"Tom & Jerry's\"</b>"),
            "&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;"
        );
    }

    #[test]
    fn only_an_invite_shaped_code_is_looked_up() {
        assert!(is_invite_code("abcdefgh2345"));
        assert!(!is_invite_code(""));
        assert!(!is_invite_code("ABC"));
        assert!(!is_invite_code("abc\"><script>"));
        assert!(!is_invite_code("abc 1"));
    }

    #[test]
    fn how_long_an_invite_has_left_is_said_in_words() {
        const HOUR: i64 = 3_600_000;
        assert_eq!(
            runs_out_in(10 * 60_000),
            "It runs out in less than an hour."
        );
        assert_eq!(runs_out_in(HOUR), "It runs out in about 1 hour.");
        assert_eq!(runs_out_in(23 * HOUR + 1), "It runs out in about 23 hours.");
        assert_eq!(
            runs_out_in(7 * 24 * HOUR - 1),
            "It runs out in about 7 days."
        );
    }

    #[test]
    fn open_in_linger_carries_the_server_and_the_code_and_nothing_else() {
        assert_eq!(
            app_link("invite", "https://linger.example", "code", "abcd2345"),
            "linger://invite?server=linger.example&code=abcd2345"
        );
        assert_eq!(
            app_link("invite", "https://linger.example:8443", "code", "abcd"),
            "linger://invite?server=linger.example%3A8443&code=abcd"
        );
        // Plain http only reaches a server on the host's own computer, and
        // the app keeps it only there (`client/src/lib/link.ts`).
        assert_eq!(
            app_link("setup", "http://127.0.0.1:8420", "token", "0a1b"),
            "linger://setup?server=http%3A%2F%2F127.0.0.1%3A8420&token=0a1b"
        );
        assert_eq!(query_value("[::1]:8420"), "%5B%3A%3A1%5D%3A8420");
        assert_eq!(query_value("a&b=c#d"), "a%26b%3Dc%23d");
    }

    #[test]
    fn a_strange_host_header_never_reaches_the_page() {
        assert!(is_plain_host("linger.example:8420"));
        assert!(is_plain_host("[::1]:8420"));
        assert!(!is_plain_host("evil\"><script>"));
        assert!(!is_plain_host("a b"));
    }
}
