//! The pages a shared link opens in a browser (PROTOCOL §2.2, #578): an
//! invite or setup link tapped by somebody who doesn't have the app yet gets
//! a page saying what to do, not a 404.

mod common;

use base64::Engine;
use linger_core::wire::Invite;
use sha2::{Digest, Sha256};

async fn get(server: &common::TestServer, path: &str) -> reqwest::Response {
    reqwest::Client::new()
        .get(format!("{}{path}", server.base))
        .send()
        .await
        .unwrap()
}

async fn make_invite(server: &common::TestServer, token: &str, body: serde_json::Value) -> Invite {
    reqwest::Client::new()
        .post(server.url("/invites"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn rename_server(server: &common::TestServer, token: &str, name: &str) {
    let resp = reqwest::Client::new()
        .patch(server.url("/server"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "{}", resp.text().await.unwrap());
}

/// The text between `<tag>` and `</tag>`, the first time it appears.
fn inside<'a>(html: &'a str, tag: &str) -> &'a str {
    let open = format!("<{tag}>");
    let start = html.find(&open).expect("opening tag") + open.len();
    let end = start
        + html[start..]
            .find(&format!("</{tag}>"))
            .expect("closing tag");
    &html[start..end]
}

/// How the page writes a server into a `linger://` link: everything but
/// letters, digits and `-._~` percent-encoded.
fn encoded(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn hash(text: &str) -> String {
    format!(
        "'sha256-{}'",
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(text.as_bytes()))
    )
}

#[tokio::test]
async fn an_invite_link_opens_a_page_with_the_steps_and_the_link() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    rename_server(&server, &host.access_token, "The Good Company").await;
    let invite = make_invite(
        &server,
        &host.access_token,
        serde_json::json!({ "expires_in_hours": 72 }),
    )
    .await;

    let resp = get(&server, &format!("/invite/{}", invite.code)).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()["content-type"],
        "text/html; charset=utf-8",
        "a browser draws it as a page"
    );
    assert_eq!(resp.headers()["cache-control"], "no-store");
    assert_eq!(resp.headers()["referrer-policy"], "no-referrer");
    let html = resp.text().await.unwrap();

    assert!(
        html.contains("re invited to <bdi>The Good Company</bdi>"),
        "{html}"
    );
    assert!(html.contains("It runs out in about 3 days."), "{html}");
    assert!(html.contains("releases/latest"), "where to get the app");
    let link = format!(">{}/invite/{}</code>", server.base, invite.code);
    assert!(
        html.contains(&link),
        "the link to paste, from {link}: {html}"
    );
    assert!(html.contains("id=\"copy\""), "a Copy button");
    assert!(
        html.contains("Already have an account here?"),
        "an invite makes a new account; the page says so"
    );
    // "Open in Linger" (#607): the same invite as a `linger://` link, the
    // server spelled out because this one is reached over plain http.
    let open = format!(
        "href=\"linger://invite?server={}&amp;code={}\"",
        encoded(&server.base),
        invite.code
    );
    assert!(html.contains(&open), "{open}: {html}");
    assert!(
        html.contains("Nothing happened? Paste the link instead."),
        "a button that opens nothing says what to do: {html}"
    );

    // The same page for the query form the app also accepts.
    let resp = get(&server, &format!("/invite?code={}", invite.code)).await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn the_page_runs_nothing_but_its_own_style_and_script() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;

    let resp = get(&server, &format!("/invite/{}", invite.code)).await;
    let policy = resp.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    let html = resp.text().await.unwrap();

    assert!(policy.starts_with("default-src 'none';"), "{policy}");
    assert!(policy.contains("frame-ancestors 'none'"), "{policy}");
    assert!(!policy.contains("unsafe-inline"), "{policy}");
    // The hashes are of exactly what the page carries, or a browser would
    // refuse its own style and script.
    assert!(policy.contains(&hash(inside(&html, "style"))), "{policy}");
    assert!(policy.contains(&hash(inside(&html, "script"))), "{policy}");
    assert_eq!(html.matches("<script").count(), 1, "one script: Copy");
    assert!(!html.contains("http://fonts"), "no outside fonts");
    assert!(!html.contains("<img"), "nothing loaded");
}

#[tokio::test]
async fn a_used_expired_or_made_up_invite_says_so_and_names_no_server() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    rename_server(&server, &host.access_token, "The Good Company").await;

    let used = make_invite(&server, &host.access_token, serde_json::json!({})).await;
    let joined = reqwest::Client::new()
        .post(server.url("/auth/register"))
        .json(&serde_json::json!({
            "invite_code": used.code, "username": "callie",
            "display_name": "Callie", "password": "a long enough password",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(joined.status(), 200);
    let resp = get(&server, &format!("/invite/{}", used.code)).await;
    assert_eq!(resp.status(), 404);
    let html = resp.text().await.unwrap();
    assert!(html.contains("This invite doesn\u{2019}t work"), "{html}");
    assert!(!html.contains("The Good Company"), "{html}");
    assert!(!html.contains("id=\"link\""), "no link to paste: {html}");
    assert!(!html.contains("linger://"), "nothing to open: {html}");

    let expired = make_invite(
        &server,
        &host.access_token,
        serde_json::json!({ "expires_in_hours": 1 }),
    )
    .await;
    sqlx::query("UPDATE invites SET expires_at = 1 WHERE code = ?")
        .bind(&expired.code)
        .execute(&server.state.db.write)
        .await
        .unwrap();
    let html = get(&server, &format!("/invite/{}", expired.code))
        .await
        .text()
        .await
        .unwrap();
    assert!(html.contains("This invite has run out"), "{html}");
    assert!(!html.contains("The Good Company"), "{html}");

    let resp = get(&server, "/invite/nosuchcode").await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn nothing_from_the_address_bar_is_written_into_the_page() {
    let server = common::spawn_server().await;
    common::bootstrap_host(&server).await;
    let resp = get(&server, "/invite/%3Cscript%3Ealert(1)%3C%2Fscript%3E").await;
    assert_eq!(resp.status(), 404);
    let html = resp.text().await.unwrap();
    assert!(!html.contains("alert(1)"), "{html}");

    let html = get(&server, "/invite?code=%22%3E%3Cb%3Ehi")
        .await
        .text()
        .await
        .unwrap();
    assert!(!html.contains("<b>hi"), "{html}");
}

#[tokio::test]
async fn a_server_name_is_escaped() {
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    rename_server(&server, &host.access_token, "<b>Tom & Jerry</b>").await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;
    let html = get(&server, &format!("/invite/{}", invite.code))
        .await
        .text()
        .await
        .unwrap();
    assert!(
        html.contains("&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;"),
        "{html}"
    );
    assert!(!html.contains("<b>Tom"), "{html}");
}

#[tokio::test]
async fn a_named_server_links_to_its_own_name() {
    let server = common::spawn_named_server("linger.example", "cdn.linger.example").await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;
    let resp = reqwest::Client::new()
        .get(format!("{}/invite/{}", server.base, invite.code))
        .header("host", "linger.example")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let html = resp.text().await.unwrap();
    assert!(
        html.contains(&format!(
            ">https://linger.example/invite/{}</code>",
            invite.code
        )),
        "{html}"
    );
    assert!(html.contains("<code>linger.example</code>"), "{html}");
    assert!(
        html.contains(&format!(
            "href=\"linger://invite?server=linger.example&amp;code={}\"",
            invite.code
        )),
        "an https server is named by its host alone: {html}"
    );

    // The media host serves files and nothing else (ARCHITECTURE §7).
    let resp = reqwest::Client::new()
        .get(format!("{}/invite/{}", server.base, invite.code))
        .header("host", "cdn.linger.example")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    assert!(!resp.text().await.unwrap().contains("invited"));
}

#[tokio::test]
async fn the_setup_link_opens_a_page_that_says_not_to_share_it() {
    let server = common::spawn_server().await;
    let token = server.state.setup.peek().expect("a fresh server has one");

    let resp = get(&server, &format!("/setup?token={token}")).await;
    assert_eq!(resp.status(), 200);
    let html = resp.text().await.unwrap();
    assert!(html.contains("Don\u{2019}t share this link."), "{html}");
    assert!(
        html.contains(&format!(">{}/setup?token={token}</code>", server.base)),
        "{html}"
    );
    assert!(
        html.contains(&format!(
            "href=\"linger://setup?server={}&amp;token={token}\"",
            encoded(&server.base)
        )),
        "{html}"
    );

    // The path form the app also accepts.
    assert_eq!(get(&server, &format!("/setup/{token}")).await.status(), 200);

    let resp = get(&server, "/setup?token=0000").await;
    assert_eq!(resp.status(), 404);
    let html = resp.text().await.unwrap();
    assert!(
        html.contains("This setup link doesn\u{2019}t work"),
        "{html}"
    );
    assert!(!html.contains(&token), "never shows the real token");

    common::bootstrap_host(&server).await;
    let resp = get(&server, &format!("/setup?token={token}")).await;
    assert_eq!(resp.status(), 404);
    let html = resp.text().await.unwrap();
    assert!(html.contains("This server is already set up"), "{html}");
}

#[tokio::test]
async fn the_api_still_answers_in_json() {
    // The pages sit beside `/api/v1`, not over it.
    let server = common::spawn_server().await;
    let host = common::bootstrap_host(&server).await;
    let invite = make_invite(&server, &host.access_token, serde_json::json!({})).await;
    let resp = reqwest::Client::new()
        .get(server.url(&format!("/auth/invite/{}", invite.code)))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let preview: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(preview["valid"], true);
}
