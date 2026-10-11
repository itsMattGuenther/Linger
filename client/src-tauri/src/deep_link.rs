//! "Open in Linger" (#607): the invite page's button is a `linger://` link,
//! and the computer hands it to Linger.
//!
//! Three shapes, carrying only a server and the code or token (PROTOCOL §2.2):
//!
//! ```text
//! linger://invite?server=linger.example&code=CODE
//! linger://setup?server=linger.example&token=TOKEN
//! linger://sign-in?server=linger.example&code=CODE    (#581)
//! ```
//!
//! The link comes from outside the app: any web page can point a browser at
//! one. So it is read strictly here and turned into the link a person would
//! have pasted (`https://linger.example/invite/CODE`), or dropped. Nothing is
//! contacted because of it. The list window puts it in the "Server or link"
//! box (`core/offeredLink.ts`), the person sees the address, and presses
//! Continue, as if they had pasted it. An invite is still "make a new
//! account", as a pasted one is.
//!
//! Windows and Linux start a second copy of Linger for a link; the
//! single-instance plugin hands it to the running one (`lib.rs`). macOS and
//! Android give it to the running app. Either way it arrives through the
//! deep-link plugin's `on_open_url`, or, when the link started Linger, its
//! `get_current`.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

/// The event that tells the list window a link is waiting
/// (`core/offeredLink.ts`). It carries nothing: the window asks for the link
/// with `link_offered`, so one that arrives before the page is listening
/// still waits for it.
pub const OFFERED: &str = "next:link";

/// The newest link handed to Linger and not yet taken by the list window.
/// Only the newest: two clicks in a row mean the second.
#[derive(Default)]
pub struct Offered(Mutex<Option<String>>);

/// Listen for links from now on, and take the one that started Linger.
/// Called from `setup`, after the plugins have read the command line.
pub fn install(app: &tauri::App) {
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            offer(&handle, url.as_str());
        }
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            offer(app.handle(), url.as_str());
        }
    }
}

fn offer(app: &AppHandle, raw: &str) {
    let Some(link) = pasted_link(raw) else {
        return;
    };
    if let Ok(mut held) = app.state::<Offered>().0.lock() {
        *held = Some(link);
    }
    #[cfg(desktop)]
    crate::tray::show_list(app);
    let _ = app.emit_to("main", OFFERED, ());
}

/// The link waiting for the list window, once: taking it clears it.
#[tauri::command]
pub fn link_offered(offered: tauri::State<'_, Offered>) -> Option<String> {
    offered.0.lock().ok().and_then(|mut held| held.take())
}

/// The longest `linger://` link read at all. An invite link is well under
/// 300 characters; anything this long is not one.
const MOST: usize = 1024;

/// A `linger://` link as the link a person would paste, or `None` for
/// anything that isn't exactly one of the three shapes.
#[must_use]
pub fn pasted_link(raw: &str) -> Option<String> {
    if raw.len() > MOST {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "linger"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let kind = url.host_str()?;
    let (key, valid): (&str, fn(&str) -> bool) = match kind {
        "invite" | "sign-in" => ("code", is_code),
        "setup" => ("token", is_token),
        _ => return None,
    };
    let mut server = None;
    let mut secret = None;
    for (name, value) in url.query_pairs() {
        let slot = if name == "server" {
            &mut server
        } else if name == key {
            &mut secret
        } else {
            return None;
        };
        if slot.replace(value.into_owned()).is_some() {
            return None;
        }
    }
    let origin = origin_of(&server?)?;
    let secret = secret?;
    if !valid(&secret) {
        return None;
    }
    Some(match kind {
        "invite" => format!("{origin}/invite/{secret}"),
        "sign-in" => format!("{origin}/sign-in/{secret}"),
        _ => format!("{origin}/setup?token={secret}"),
    })
}

/// `linger.example`, `linger.example:8443`, or a whole `http(s)://` origin
/// (a server on this computer is reached over plain `http://`), as an origin.
/// Only a host the paste box would accept (`lib/link.ts`), with nothing after it.
fn origin_of(server: &str) -> Option<String> {
    if server.is_empty() || server.len() > 255 {
        return None;
    }
    let whole = if server.starts_with("https://") || server.starts_with("http://") {
        server.to_string()
    } else {
        format!("https://{server}")
    };
    let url = Url::parse(&whole).ok()?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return None;
    }
    let host = url.host_str()?;
    if !is_host(host) {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// Letters, digits, dots, dashes and underscores, or a bracketed IPv6
/// address: the hosts `lib/link.ts` accepts.
fn is_host(host: &str) -> bool {
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty()
            && inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.');
    }
    !host.is_empty()
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// An invite or sign-in link code: letters and digits (the server makes
/// lowercase base32).
fn is_code(code: &str) -> bool {
    (1..=64).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// A setup token: hex (the server's `setup::SetupState`).
fn is_token(token: &str) -> bool {
    (1..=128).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::pasted_link;

    #[test]
    fn an_invite_becomes_the_link_a_person_would_paste() {
        assert_eq!(
            pasted_link("linger://invite?server=linger.example&code=abcd2345").as_deref(),
            Some("https://linger.example/invite/abcd2345")
        );
        assert_eq!(
            pasted_link("linger://invite/?code=abcd2345&server=linger.example:8443").as_deref(),
            Some("https://linger.example:8443/invite/abcd2345")
        );
        assert_eq!(
            pasted_link("linger://invite?server=https%3A%2F%2Flinger.example&code=abcd").as_deref(),
            Some("https://linger.example/invite/abcd")
        );
    }

    #[test]
    fn a_server_on_this_computer_keeps_plain_http() {
        assert_eq!(
            pasted_link("linger://invite?server=http%3A%2F%2Flocalhost%3A8420&code=abcd")
                .as_deref(),
            Some("http://localhost:8420/invite/abcd")
        );
        // Exactly as the invite page writes it (`routes/pages.rs`, `app_link`).
        assert_eq!(
            pasted_link("linger://setup?server=http%3A%2F%2F127.0.0.1%3A8420&token=0a1b")
                .as_deref(),
            Some("http://127.0.0.1:8420/setup?token=0a1b")
        );
        assert_eq!(
            pasted_link("linger://invite?server=%5B%3A%3A1%5D%3A8420&code=abcd").as_deref(),
            Some("https://[::1]:8420/invite/abcd")
        );
    }

    #[test]
    fn a_sign_in_link_becomes_the_link_a_person_would_paste() {
        // Exactly as the sign-in link page writes it (`routes/pages.rs`, `app_link`).
        assert_eq!(
            pasted_link("linger://sign-in?server=linger.example&code=fbv42riq4hxs7oec3d2nkmjx63")
                .as_deref(),
            Some("https://linger.example/sign-in/fbv42riq4hxs7oec3d2nkmjx63")
        );
        assert_eq!(
            pasted_link("linger://sign-in?server=linger.example&token=0123abcdef"),
            None,
            "a sign-in link takes a code, not a token"
        );
    }

    #[test]
    fn a_setup_link_keeps_its_token() {
        assert_eq!(
            pasted_link("linger://setup?server=linger.example&token=0123abcdef").as_deref(),
            Some("https://linger.example/setup?token=0123abcdef")
        );
        assert_eq!(
            pasted_link("linger://setup?server=linger.example&token=not-hex"),
            None
        );
        assert_eq!(
            pasted_link("linger://setup?server=linger.example&code=abcd"),
            None,
            "a setup link takes a token, not a code"
        );
    }

    #[test]
    fn anything_but_the_three_shapes_is_dropped() {
        for raw in [
            "",
            "linger://",
            "linger://invite",
            "linger://invite?server=linger.example",
            "linger://invite?code=abcd",
            "linger://open?server=linger.example&code=abcd",
            "https://linger.example/invite/abcd",
            "linger://invite?server=linger.example&code=abcd&next=https://evil.example",
            "linger://invite?server=linger.example&code=abcd&code=efgh",
            "linger://invite?server=linger.example&server=evil.example&code=abcd",
            "linger://invite?server=linger.example&code=ab/../cd",
            "linger://invite?server=linger.example&code=ab%20cd",
            "linger://invite?server=linger.example&code=",
            "linger://invite/more?server=linger.example&code=abcd",
            "linger://invite?server=linger.example&code=abcd#x",
            "linger://me@invite?server=linger.example&code=abcd",
            "linger://invite:9?server=linger.example&code=abcd",
        ] {
            assert_eq!(pasted_link(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_server_that_is_more_than_an_address_is_dropped() {
        for server in [
            "",
            "linger.example/evil",
            "linger.example%2Fevil",
            "linger.example?x=1",
            "linger.example%3Fx%3D1",
            "linger.example%23x",
            "me%40linger.example",
            "https%3A%2F%2Fme%40linger.example",
            "https%3A%2F%2Flinger.example%2Fpath",
            "file%3A%2F%2F%2Fetc%2Fpasswd",
            "javascript%3Aalert(1)",
            "linger example",
            "linger%20example",
            ".linger.example",
            "linger..example",
            "%E2%80%AEelpmaxe.regnil",
        ] {
            let raw = format!("linger://invite?server={server}&code=abcd");
            assert_eq!(pasted_link(&raw), None, "{raw}");
        }
    }

    #[test]
    fn a_link_too_long_to_be_an_invite_is_dropped() {
        let long = format!(
            "linger://invite?server=linger.example&code=abcd&pad={}",
            "a".repeat(2000)
        );
        assert_eq!(pasted_link(&long), None);
    }
}
