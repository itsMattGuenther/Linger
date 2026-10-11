//! Link cards: finding URLs in a message, and asking the web about them
//! (SPEC §5.6, T-504).
//!
//! A card is one line — favicon, title, domain — and the fetch that fills it in
//! happens **here, on the server**, once per URL for everybody. That is a
//! privacy decision before it is a caching one: if each client fetched its own
//! preview, every site anyone linked would learn the IP of every person who
//! scrolled past the message. The host's IP does it instead, and the favicon
//! comes back to the client as a small `data:` URI so drawing the card makes no
//! request at all.
//!
//! Fetching a URL somebody typed is a server-side request forgery machine if it
//! is written carelessly, and this server sits on a home LAN next to a router
//! admin page and whatever else is on 192.168.x. So [`fetch`] is written the
//! paranoid way:
//!
//! - `http` and `https` only, on the default ports only.
//! - The hostname is resolved **here**, and every address it resolves to must be
//!   public. One private answer refuses the whole name — a name with an A record
//!   for both a real host and `127.0.0.1` is an attack, not a configuration.
//! - The connection is then pinned to the address that was checked
//!   (`ClientBuilder::resolve`), so the name cannot resolve to something else
//!   between the check and the connect (DNS rebinding).
//! - Redirects are followed by hand, at most [`MAX_LINK_REDIRECTS`] of them, and
//!   every hop goes through all of the above again. A public URL that 302s to
//!   `http://169.254.169.254/` is the oldest trick there is.
//! - Time and bytes are both capped, and the body is read in chunks so a server
//!   that streams forever is cut off rather than followed.
//!
//! Nothing here trusts the response either: the HTML is scanned for a title and
//! an icon href with a small hand-rolled tag reader, never executed, and the
//! icon is accepted only if its *bytes* are a raster image. SVG is refused
//! wherever it appears, for the same reason it is off the upload allowlist —
//! it is a script that renders.

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use linger_core::limits::{
    LINK_FETCH_TIMEOUT_MS, MAX_LINKS_PER_MESSAGE, MAX_LINK_ICON_BYTES, MAX_LINK_OEMBED_BYTES,
    MAX_LINK_PAGE_BYTES, MAX_LINK_REDIRECTS, MAX_LINK_TITLE_CHARS,
};
use reqwest::Url;

/// What a fetch found. Both fields are optional: a page with no title and no
/// icon still makes an honest card out of its domain alone.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub title: Option<String>,
    /// A `data:` URI, never a remote address.
    pub icon: Option<String>,
}

// ---------------------------------------------------------------------------
// Finding links in a message body
// ---------------------------------------------------------------------------

/// Every `http(s)` URL in a message body, in order, deduplicated, capped at
/// [`MAX_LINKS_PER_MESSAGE`].
///
/// The trimming rules match `client/src/stream/markdown.ts` deliberately: the
/// stream and the media grid must agree about what counts as a link, or a
/// message would show a card for something the archive never recorded. Trailing
/// sentence punctuation belongs to the sentence, and a closing paren is only the
/// URL's if the URL opened one — which is also what strips the `)` off a
/// markdown `[label](https://…)` target.
#[must_use]
pub fn extract(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    // Lowercased once: `find_scheme` is called per candidate, and doing it in
    // there would be quadratic on a body full of links.
    let lower = body.to_ascii_lowercase();
    let mut at = 0;

    while at < body.len() {
        let Some(start) = find_scheme(body, &lower, at) else {
            break;
        };
        let rest = &body[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"')
            .unwrap_or(rest.len());
        let raw = trim_trailing(&rest[..end]);
        at = start + end.max(1);

        // `https://` on its own is not an address, and `new URL` in the client
        // rejects it too. Parsing is the check.
        if let Some(url) = parse_public_shape(raw) {
            let normalised = url.to_string();
            if seen.insert(normalised.clone()) {
                found.push(normalised);
                if found.len() == MAX_LINKS_PER_MESSAGE {
                    break;
                }
            }
        }
    }
    found
}

/// The next `http://` or `https://` at a character boundary, case-insensitively.
/// `lower` is `body` lowercased — same byte length, so the indices match.
fn find_scheme(body: &str, lower: &str, from: usize) -> Option<usize> {
    let mut at = from;
    while at < lower.len() {
        let slice = &lower[at..];
        let hit = slice.find("http")?;
        let start = at + hit;
        if !body.is_char_boundary(start) {
            at = start + 1;
            continue;
        }
        let tail = &lower[start..];
        if tail.starts_with("http://") || tail.starts_with("https://") {
            return Some(start);
        }
        at = start + 4;
    }
    None
}

fn trim_trailing(raw: &str) -> &str {
    let mut end = raw.len();
    loop {
        let candidate = &raw[..end];
        let last = candidate.chars().last();
        match last {
            Some(c) if ".,;:!?'\"".contains(c) => end -= c.len_utf8(),
            Some(')') if candidate.matches(')').count() > candidate.matches('(').count() => {
                end -= 1;
            }
            _ => return candidate,
        }
    }
}

/// Parse a URL and check its *shape* — scheme, port, and that it has a host.
/// No DNS happens here, so this is safe to run over every message body.
fn parse_public_shape(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    // A non-default port is how you reach the thing listening on 8080 of a box
    // this server can see. There is no reason for a shared link card to need
    // one, and refusing them removes a whole class of internal target.
    if url.port().is_some() {
        return None;
    }
    let host = url.host_str()?;
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    // A bare IP is never a link worth a card, and it is every SSRF target.
    if host.parse::<IpAddr>().is_ok() {
        return None;
    }
    Some(url)
}

/// Whether a URL is one this server will look up at all, and its normalised
/// form if so. The shape check only — no DNS, so this is cheap enough to run
/// over anything a client asks about.
#[must_use]
pub fn previewable(raw: &str) -> Option<Url> {
    parse_public_shape(raw)
}

/// The domain a card shows: the host, minus a leading `www.`.
#[must_use]
pub fn domain_of(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .map_or_else(String::new, |host| {
            host.strip_prefix("www.").unwrap_or(&host).to_string()
        })
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

/// Whether an address is somewhere on the public internet.
///
/// Everything else is refused: loopback, private ranges, link-local (which is
/// where cloud metadata services live), carrier-grade NAT, multicast,
/// broadcast, reserved blocks and the unspecified address.
///
/// IPv6 gets the same treatment however the address is written. Several IPv6
/// forms carry an IPv4 address, and a network that routes the prefix delivers
/// the connection to that IPv4 address: `::ffff:127.0.0.1` is loopback wearing
/// a different hat, and on an IPv6-only VPS behind NAT64, `64:ff9b::a9fe:a9fe`
/// is the cloud metadata service. Those forms are judged by the IPv4 address
/// inside (`embedded_ipv4`); the ones that can't be read reliably are refused.
#[must_use]
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
            {
                return false;
            }
            let [a, b, c, _] = v4.octets();
            // 0/8 ("this network", the unspecified address included),
            // 100.64/10 (carrier-grade NAT), 192.0.0/24 (IETF protocol
            // assignments), 198.18/15 (benchmarking), and 240/4 (reserved).
            if a == 0 {
                return false;
            }
            if a == 100 && (64..128).contains(&b) {
                return false;
            }
            if a == 192 && b == 0 && c == 0 {
                return false;
            }
            if a == 198 && (b == 18 || b == 19) {
                return false;
            }
            if a >= 240 {
                return false;
            }
            true
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() {
                return false;
            }
            if let Some(v4) = embedded_ipv4(v6) {
                return is_public(IpAddr::V4(v4));
            }
            let [first, second, ..] = v6.segments();
            // Only 2000::/3 is handed out as global unicast. Everything
            // outside it is local or reserved: fc00::/7 unique-local,
            // fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast,
            // the rest of ::/8, and 64:ff9b:1::/48, local-use NAT64, whose
            // IPv4 address sits wherever the network chose to put it.
            if first & 0xe000 != 0x2000 {
                return false;
            }
            // 2001::/32 is Teredo, which tunnels to an IPv4 address it
            // carries scrambled; 2001:db8::/32 is documentation.
            if first == 0x2001 && (second == 0 || second == 0x0db8) {
                return false;
            }
            true
        }
    }
}

/// The IPv4 address an IPv6 address stands for, in the forms where its place
/// is fixed: v4-mapped `::ffff:a.b.c.d`, the old v4-compatible `::a.b.c.d`,
/// the well-known NAT64 prefix `64:ff9b::/96` (last 32 bits), and 6to4
/// `2002::/16` (the 32 bits after the prefix).
fn embedded_ipv4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let join = |hi: u16, lo: u16| Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo));
    match v6.segments() {
        [0, 0, 0, 0, 0, 0xffff | 0, hi, lo] | [0x64, 0xff9b, 0, 0, 0, 0, hi, lo] => {
            Some(join(hi, lo))
        }
        [0x2002, hi, lo, ..] => Some(join(hi, lo)),
        _ => None,
    }
}

/// Resolve a URL's host and refuse the name unless **every** address it answers
/// with is public. The address that comes back is the one the connection is then
/// pinned to, which is what closes the rebinding window.
async fn resolve_public(url: &Url) -> Option<SocketAddr> {
    let host = url.host_str()?.to_string();
    let port = if url.scheme() == "https" { 443 } else { 80 };
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port)).await.ok()?.collect();
    if addrs.is_empty() {
        return None;
    }
    if !addrs.iter().all(|addr| is_public(addr.ip())) {
        return None;
    }
    addrs.into_iter().next()
}

/// A client pinned to one already-checked address, with redirects off so the
/// caller can re-check every hop itself.
fn pinned_client(host: &str, addr: SocketAddr) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(LINK_FETCH_TIMEOUT_MS))
        .connect_timeout(Duration::from_millis(LINK_FETCH_TIMEOUT_MS))
        // No cookie store, no proxy: this request carries nothing and reaches
        // nowhere but the address that was checked.
        .no_proxy()
        .user_agent("Linger link preview")
        .resolve(host, addr)
        .build()
        .ok()
}

/// One GET, guarded, capped, and read in chunks. Returns the final URL, the
/// content type, and at most `max_bytes` of body.
async fn guarded_get(url: &Url, accept: &str, max_bytes: u64) -> Option<(Url, String, Vec<u8>)> {
    let mut current = url.clone();

    for _ in 0..=MAX_LINK_REDIRECTS {
        let addr = resolve_public(&current).await?;
        let host = current.host_str()?.to_string();
        let client = pinned_client(&host, addr)?;
        let response = client
            .get(current.clone())
            .header(reqwest::header::ACCEPT, accept)
            .send()
            .await
            .ok()?;

        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)?
                .to_str()
                .ok()?
                .to_string();
            // Relative redirects are ordinary, so join rather than parse; the
            // result goes through the same shape check as the original URL.
            let next = current.join(&location).ok()?;
            current = parse_public_shape(next.as_str())?;
            continue;
        }
        if !response.status().is_success() {
            return None;
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        // Chunked rather than `bytes()`, because `bytes()` will happily follow a
        // server that streams a gigabyte at us.
        let mut body = Vec::new();
        let mut response = response;
        while let Ok(Some(chunk)) = response.chunk().await {
            body.extend_from_slice(&chunk);
            if body.len() as u64 >= max_bytes {
                body.truncate(max_bytes as usize);
                break;
            }
        }
        return Some((current, content_type, body));
    }
    None
}

/// Ask a URL what it is called and what its icon is.
///
/// Every failure — refused address, timeout, non-HTML, no title — is the same
/// answer: whatever was found, which may be nothing. The card falls back to the
/// domain, and the caller records the attempt so it is not repeated per reader.
pub async fn fetch(url: &Url) -> Fetched {
    let deadline = Duration::from_millis(LINK_FETCH_TIMEOUT_MS * 2);
    tokio::time::timeout(deadline, fetch_inner(url))
        .await
        .unwrap_or_default()
}

async fn fetch_inner(url: &Url) -> Fetched {
    if let Some(video) = youtube_video(url) {
        return fetch_youtube(&video).await;
    }
    let Some((final_url, content_type, body)) =
        guarded_get(url, "text/html,application/xhtml+xml", MAX_LINK_PAGE_BYTES).await
    else {
        return Fetched::default();
    };
    if !content_type.contains("html") && !content_type.is_empty() {
        return Fetched::default();
    }

    let html = String::from_utf8_lossy(&body);
    let head = read_head(&html);
    let title = head.title.map(|text| shorten(&text, MAX_LINK_TITLE_CHARS));

    // An explicit `<link rel="icon">` first, then the well-known location every
    // browser tries anyway.
    let icon_url = head
        .icon_href
        .and_then(|href| final_url.join(&href).ok())
        .and_then(|joined| parse_public_shape(joined.as_str()))
        .or_else(|| final_url.join("/favicon.ico").ok());

    let icon = match icon_url {
        Some(candidate) => fetch_icon(&candidate).await,
        None => None,
    };
    Fetched { title, icon }
}

// ---------------------------------------------------------------------------
// YouTube (#300)
// ---------------------------------------------------------------------------
//
// A YouTube video's page is about 1.3 MB, and its title starts about 700 KB in,
// far past `MAX_LINK_PAGE_BYTES`, so reading the page finds no title and the
// card was only "youtube.com". YouTube answers the question directly at its
// oEmbed address: a few hundred bytes of JSON with the title, and no key or
// account. The request goes through `guarded_get` like every other fetch, so
// the address checks, the pinning and the caps all still apply, and it is the
// server asking, never the reader. Nothing but `title` is read from it: no
// thumbnail, no player, no embed.

/// A YouTube video's own id, when the link is to one video:
/// `youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`,
/// `/live/…` and `/embed/…`, on `www.`, `m.` and `music.` too. A channel, a
/// playlist or the home page isn't a video, and reads as any other page.
pub fn youtube_video(url: &Url) -> Option<String> {
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let id = match host {
        "youtu.be" => url.path_segments()?.next().map(str::to_string),
        "youtube.com" | "m.youtube.com" | "music.youtube.com" => {
            let mut segments = url.path_segments()?;
            match segments.next()? {
                "watch" => url
                    .query_pairs()
                    .find(|(key, _)| key == "v")
                    .map(|(_, value)| value.into_owned()),
                "shorts" | "live" | "embed" => segments.next().map(str::to_string),
                _ => None,
            }
        }
        _ => None,
    }?;
    // Every video id is eleven of these; anything else isn't one, and isn't
    // passed on to YouTube.
    let valid = id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some(id)
}

/// Where to ask YouTube about one video. The video goes in as its plain
/// watch address, whichever form was linked.
fn youtube_oembed_url(video: &str) -> Option<Url> {
    let mut url = Url::parse("https://www.youtube.com/oembed").ok()?;
    url.query_pairs_mut()
        .append_pair("url", &format!("https://www.youtube.com/watch?v={video}"))
        .append_pair("format", "json");
    Some(url)
}

/// The video's title out of an oEmbed answer, on one line and bounded like
/// any page's. Anything that isn't JSON with a non-empty `title` string is no
/// title, and the card keeps its domain.
fn oembed_title(body: &[u8]) -> Option<String> {
    let answer: serde_json::Value = serde_json::from_slice(body).ok()?;
    let title = answer.get("title")?.as_str()?;
    let title = shorten(
        &title.split_whitespace().collect::<Vec<_>>().join(" "),
        MAX_LINK_TITLE_CHARS,
    );
    (!title.is_empty()).then_some(title)
}

async fn fetch_youtube(video: &str) -> Fetched {
    let title = match youtube_oembed_url(video) {
        Some(ask) => guarded_get(&ask, "application/json", MAX_LINK_OEMBED_BYTES)
            .await
            .and_then(|(_, content_type, body)| {
                (content_type.contains("json") || content_type.is_empty())
                    .then(|| oembed_title(&body))
                    .flatten()
            }),
        None => None,
    };
    // The site's own icon, from the address every browser tries.
    let icon = match Url::parse("https://www.youtube.com/favicon.ico") {
        Ok(at) => fetch_icon(&at).await,
        Err(_) => None,
    };
    Fetched { title, icon }
}

/// The favicon, as a `data:` URI, or nothing.
///
/// The sniffed bytes decide the type, not the header and not the extension —
/// and only raster formats are accepted. An SVG "favicon" is a script, and this
/// one would be inlined into the app's own origin, which is the worst possible
/// place for it.
async fn fetch_icon(url: &Url) -> Option<String> {
    let (_, _, bytes) = guarded_get(url, "image/*", MAX_LINK_ICON_BYTES).await?;
    if bytes.is_empty() {
        return None;
    }
    let mime = icon_mime(&bytes)?;
    Some(format!("data:{mime};base64,{}", BASE64.encode(&bytes)))
}

/// Magic bytes for the icon formats a card may show. `infer` knows the web
/// formats; `.ico` is not one of them and gets its own four-byte check.
fn icon_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    match infer::get(bytes).map(|kind| kind.mime_type()) {
        Some("image/png") => Some("image/png"),
        Some("image/jpeg") => Some("image/jpeg"),
        Some("image/gif") => Some("image/gif"),
        Some("image/webp") => Some("image/webp"),
        Some("image/bmp") => Some("image/bmp"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Reading the head of an HTML document
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
struct Head {
    title: Option<String>,
    icon_href: Option<String>,
}

/// Pull a title and an icon href out of a document.
///
/// A hand-rolled scanner rather than an HTML parser: this needs three tags out
/// of the head of a document that is never rendered, and a parser is a large
/// dependency plus a large attack surface for the privilege of being wrong
/// about the same malformed markup in a more sophisticated way. It stops at
/// `</head>`, or at the first `<body>`, whichever comes first.
///
/// `og:title` wins over `<title>` when both are there — it is the one the site
/// wrote for exactly this purpose, and it is usually the one without the
/// " | Site Name — Home" tail.
fn read_head(html: &str) -> Head {
    let mut head = Head::default();
    let mut og_title: Option<String> = None;
    let mut icon_score = -1i32;
    let mut rest = html;

    while let Some(open) = rest.find('<') {
        rest = &rest[open + 1..];
        let name_end = rest
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .unwrap_or(rest.len());
        let name = rest[..name_end].to_ascii_lowercase();

        if name == "/head" || name == "body" {
            break;
        }
        let Some(close) = rest.find('>') else { break };
        let inside = &rest[name_end..close];

        match name.as_str() {
            "title" => {
                if head.title.is_none() {
                    let after = &rest[close + 1..];
                    let end = after.find('<').unwrap_or(after.len());
                    let text = decode_entities(after[..end].trim());
                    if !text.is_empty() {
                        head.title = Some(text);
                    }
                }
            }
            "meta" => {
                let attrs = attributes(inside);
                let key = attr(&attrs, "property")
                    .or_else(|| attr(&attrs, "name"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if (key == "og:title" || key == "twitter:title") && og_title.is_none() {
                    if let Some(value) = attr(&attrs, "content") {
                        let text = decode_entities(value.trim());
                        if !text.is_empty() {
                            og_title = Some(text);
                        }
                    }
                }
            }
            "link" => {
                let attrs = attributes(inside);
                let rel = attr(&attrs, "rel").unwrap_or_default().to_ascii_lowercase();
                let score = match rel.as_str() {
                    "icon" | "shortcut icon" => 2,
                    "apple-touch-icon" | "apple-touch-icon-precomposed" => 1,
                    _ => -1,
                };
                if score > icon_score {
                    if let Some(href) = attr(&attrs, "href") {
                        let href = decode_entities(href.trim());
                        // An SVG icon is refused before it is ever fetched.
                        if !href.is_empty() && !href.to_ascii_lowercase().ends_with(".svg") {
                            head.icon_href = Some(href);
                            icon_score = score;
                        }
                    }
                }
            }
            _ => {}
        }
        rest = &rest[close + 1..];
    }

    if let Some(text) = og_title {
        head.title = Some(text);
    }
    head
}

/// `name="value"` pairs out of the inside of a tag. Values may be double,
/// single, or unquoted; names are lowercased.
fn attributes(inside: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let chars: Vec<char> = inside.chars().collect();
    let mut at = 0;

    while at < chars.len() {
        while at < chars.len() && (chars[at].is_whitespace() || chars[at] == '/') {
            at += 1;
        }
        let start = at;
        while at < chars.len() && !chars[at].is_whitespace() && chars[at] != '=' && chars[at] != '/'
        {
            at += 1;
        }
        if at == start {
            at += 1;
            continue;
        }
        let name: String = chars[start..at].iter().collect::<String>().to_lowercase();
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
        if at >= chars.len() || chars[at] != '=' {
            pairs.push((name, String::new()));
            continue;
        }
        at += 1;
        while at < chars.len() && chars[at].is_whitespace() {
            at += 1;
        }
        let value = if at < chars.len() && (chars[at] == '"' || chars[at] == '\'') {
            let quote = chars[at];
            at += 1;
            let from = at;
            while at < chars.len() && chars[at] != quote {
                at += 1;
            }
            let value: String = chars[from..at].iter().collect();
            at += 1;
            value
        } else {
            let from = at;
            while at < chars.len() && !chars[at].is_whitespace() {
                at += 1;
            }
            chars[from..at].iter().collect()
        };
        pairs.push((name, value));
    }
    pairs
}

fn attr<'a>(pairs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// The handful of entities a page title actually contains. Anything else is
/// left as written — a stray `&pound;` in a card is a cosmetic problem, and
/// carrying a full entity table for it is not worth the bytes.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity.to_ascii_lowercase().as_str() {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ => numeric_entity(entity),
        };
        match decoded {
            Some(c) => out.push(c),
            None => out.push_str(&rest[..=end]),
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    // Titles run through a card that is one line high; newlines and runs of
    // whitespace in one are a layout bug waiting to happen.
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn numeric_entity(entity: &str) -> Option<char> {
    let digits = entity.strip_prefix('#')?;
    let code = if let Some(hex) = digits.strip_prefix(['x', 'X']) {
        u32::from_str_radix(hex, 16).ok()?
    } else {
        digits.parse::<u32>().ok()?
    };
    char::from_u32(code)
}

/// Cut to a character count, with an ellipsis. Chars, not bytes: cutting a
/// title mid-codepoint would panic.
#[must_use]
pub fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_come_out_of_a_message_the_way_the_stream_draws_them() {
        assert_eq!(
            extract("look at https://linger.example/thing."),
            vec!["https://linger.example/thing".to_string()]
        );
        assert_eq!(
            extract("(see https://linger.example)"),
            vec!["https://linger.example/".to_string()]
        );
        assert_eq!(
            extract("[label](https://linger.example/a)"),
            vec!["https://linger.example/a".to_string()]
        );
        // Wikipedia's disambiguation parens survive, because the URL opened one.
        assert_eq!(
            extract("https://en.wikipedia.example/wiki/Mercury_(planet)"),
            vec!["https://en.wikipedia.example/wiki/Mercury_(planet)".to_string()]
        );
    }

    #[test]
    fn the_same_link_twice_is_one_card_and_a_dump_is_capped() {
        let body = "https://a.example https://a.example https://b.example";
        assert_eq!(
            extract(body),
            vec![
                "https://a.example/".to_string(),
                "https://b.example/".to_string()
            ]
        );

        let many = (0..10)
            .map(|n| format!("https://s{n}.example"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(extract(&many).len(), MAX_LINKS_PER_MESSAGE);
    }

    #[test]
    fn what_is_never_a_link_card() {
        // No scheme, a scheme this app does not follow, a bare address, a port,
        // and a hostname with no dot in it — every one of them is an internal
        // target or not a link at all.
        for body in [
            "linger.example",
            "ftp://files.example/x",
            "javascript:alert(1)",
            "http://127.0.0.1/admin",
            "http://192.168.1.1/",
            "http://router.example:8080/admin",
            "http://localhost/",
            "https://",
        ] {
            assert!(extract(body).is_empty(), "{body} must not become a card");
        }
    }

    #[test]
    fn private_space_is_never_fetched() {
        for refused in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254", // the cloud metadata service
            "100.64.0.1",      // carrier-grade NAT
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1", // loopback wearing a v6 hat
            "::",
        ] {
            let ip: IpAddr = refused.parse().unwrap();
            assert!(!is_public(ip), "{refused} must be refused");
        }
        for allowed in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            let ip: IpAddr = allowed.parse().unwrap();
            assert!(is_public(ip), "{allowed} should be reachable");
        }
    }

    /// The IPv4 rules hold however the address is written (#490). Each IPv6
    /// form below carries an IPv4 address, and a network that routes the
    /// prefix (an IPv6-only VPS behind NAT64, say) delivers the connection to
    /// that IPv4 address.
    #[test]
    fn an_ipv4_address_inside_an_ipv6_one_is_judged_as_ipv4() {
        fn wrapped(v4: Ipv4Addr) -> Vec<(&'static str, Ipv6Addr)> {
            let [a, b, c, d] = v4.octets();
            let hi = u16::from_be_bytes([a, b]);
            let lo = u16::from_be_bytes([c, d]);
            vec![
                ("v4-mapped", Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, hi, lo)),
                ("v4-compatible", Ipv6Addr::new(0, 0, 0, 0, 0, 0, hi, lo)),
                (
                    "v4-translated",
                    Ipv6Addr::new(0, 0, 0, 0, 0xffff, 0, hi, lo),
                ),
                ("NAT64", Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, hi, lo)),
                (
                    "local NAT64 /96",
                    Ipv6Addr::new(0x64, 0xff9b, 1, 0, 0, 0, hi, lo),
                ),
                // RFC 6052's /48 layout: the address straddles a reserved byte.
                (
                    "local NAT64 /48",
                    Ipv6Addr::new(0x64, 0xff9b, 1, hi, u16::from(c), u16::from(d) << 8, 0, 0),
                ),
                ("6to4", Ipv6Addr::new(0x2002, hi, lo, 0, 0, 0, 0, 1)),
                // Teredo: the relay's IPv4 address in plain sight, the
                // client's flipped bit for bit in the last 32 bits.
                (
                    "Teredo server",
                    Ipv6Addr::new(0x2001, 0, hi, lo, 0, 0, 0, 0),
                ),
                (
                    "Teredo client",
                    Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, !hi, !lo),
                ),
            ]
        }

        for v4 in [
            Ipv4Addr::new(127, 0, 0, 1),
            Ipv4Addr::new(10, 0, 0, 1),
            Ipv4Addr::new(169, 254, 169, 254), // the cloud metadata service
        ] {
            assert!(!is_public(IpAddr::V4(v4)), "{v4} must be refused");
            for (form, v6) in wrapped(v4) {
                assert!(
                    !is_public(IpAddr::V6(v6)),
                    "{v6} ({form} {v4}) must be refused"
                );
            }
        }

        // Site-local, withdrawn in 2004, never meant the public internet.
        for refused in ["fec0::1", "feff::1"] {
            let ip: IpAddr = refused.parse().unwrap();
            assert!(!is_public(ip), "{refused} must be refused");
        }

        // The forms whose meaning is fixed let a public IPv4 address through:
        // the check reads the address inside rather than refusing the form.
        let public = Ipv4Addr::new(1, 1, 1, 1);
        for (form, v6) in wrapped(public) {
            let expected = matches!(form, "v4-mapped" | "v4-compatible" | "NAT64" | "6to4");
            assert_eq!(
                is_public(IpAddr::V6(v6)),
                expected,
                "{v6} ({form} {public})"
            );
        }
    }

    /// The reserved IPv4 blocks are as wide as the registry says: all of
    /// 0.0.0.0/8, and 192.0.0.0/24 rather than the /16 around it, where
    /// ordinary sites live.
    #[test]
    fn the_reserved_ipv4_blocks_have_the_right_edges() {
        for refused in [
            "0.1.2.3",         // 0.0.0.0/8, "this network"
            "192.0.0.8",       // 192.0.0.0/24, IETF protocol assignments
            "192.0.2.1",       // documentation
            "198.19.255.254",  // benchmarking
            "100.127.255.254", // carrier-grade NAT
            "224.0.0.1",       // multicast
            "240.0.0.1",       // reserved
        ] {
            let ip: IpAddr = refused.parse().unwrap();
            assert!(!is_public(ip), "{refused} must be refused");
        }
        for allowed in ["192.0.78.9", "198.20.0.1", "100.128.0.1", "1.0.0.1"] {
            let ip: IpAddr = allowed.parse().unwrap();
            assert!(is_public(ip), "{allowed} should be reachable");
        }
    }

    #[test]
    fn a_title_and_an_icon_come_out_of_a_head() {
        let html = r#"<!doctype html><html><head>
            <link rel="stylesheet" href="/a.css">
            <link rel="icon" href="/favicon.png">
            <title>Ordinary &amp; fine &#8212; A Site</title>
            </head><body><title>not this one</title></body></html>"#;
        let head = read_head(html);
        assert_eq!(head.title.as_deref(), Some("Ordinary & fine — A Site"));
        assert_eq!(head.icon_href.as_deref(), Some("/favicon.png"));
    }

    #[test]
    fn og_title_wins_and_svg_icons_are_refused() {
        let html = r#"<head>
            <title>Site — Home</title>
            <meta property="og:title" content="The actual thing">
            <link rel='icon' href='/icon.svg'>
            <link rel=apple-touch-icon href=/touch.png>
            </head>"#;
        let head = read_head(html);
        assert_eq!(head.title.as_deref(), Some("The actual thing"));
        assert_eq!(head.icon_href.as_deref(), Some("/touch.png"));
    }

    #[test]
    fn a_title_is_one_line_and_bounded() {
        let html = "<head><title>  a\n  b\t c  </title></head>";
        assert_eq!(read_head(html).title.as_deref(), Some("a b c"));

        let long = "x".repeat(400);
        let cut = shorten(&long, MAX_LINK_TITLE_CHARS);
        assert_eq!(cut.chars().count(), MAX_LINK_TITLE_CHARS);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn only_raster_icons_are_accepted() {
        assert_eq!(
            icon_mime(&[0x00, 0x00, 0x01, 0x00, 0x01]),
            Some("image/x-icon")
        );
        assert_eq!(
            icon_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]),
            Some("image/png")
        );
        assert_eq!(
            icon_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            None
        );
        assert_eq!(icon_mime(b"not an image at all"), None);
    }

    #[test]
    fn domains_lose_their_www() {
        assert_eq!(domain_of("https://www.example.com/a/b"), "example.com");
        assert_eq!(domain_of("https://news.example.com/"), "news.example.com");
        assert_eq!(domain_of("nonsense"), "");
    }

    fn video_of(raw: &str) -> Option<String> {
        youtube_video(&Url::parse(raw).expect("a url"))
    }

    #[test]
    fn a_youtube_video_is_known_in_every_form_it_is_linked_in() {
        let id = Some("dQw4w9WgXcQ".to_string());
        for raw in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?si=abc&t=10",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "http://WWW.YouTube.com/watch?v=dQw4w9WgXcQ",
        ] {
            assert_eq!(video_of(raw), id, "{raw}");
        }
    }

    #[test]
    fn anything_else_on_youtube_is_an_ordinary_page() {
        for raw in [
            "https://www.youtube.com/",
            "https://www.youtube.com/@RickAstleyYT",
            "https://www.youtube.com/playlist?list=PL1",
            "https://www.youtube.com/watch",
            "https://www.youtube.com/watch?v=",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQtoolong",
            "https://www.youtube.com/watch?v=dQw4w9Wg%2FcQ",
            "https://youtu.be/",
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.example.net/watch?v=dQw4w9WgXcQ",
            "https://example.com/watch?v=dQw4w9WgXcQ",
        ] {
            assert_eq!(video_of(raw), None, "{raw}");
        }
    }

    #[test]
    fn youtube_is_asked_about_the_plain_watch_address() {
        let ask = youtube_oembed_url("dQw4w9WgXcQ").expect("an address");
        assert_eq!(ask.host_str(), Some("www.youtube.com"));
        assert_eq!(ask.path(), "/oembed");
        let pairs: Vec<(String, String)> = ask
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                (
                    "url".to_string(),
                    "https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string()
                ),
                ("format".to_string(), "json".to_string()),
            ]
        );
    }

    #[test]
    fn an_oembed_answer_gives_its_title_and_nothing_else() {
        let answer = br#"{"title":"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)","author_name":"Rick Astley","thumbnail_url":"https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg","html":"<iframe></iframe>"}"#;
        assert_eq!(
            oembed_title(answer).as_deref(),
            Some("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)")
        );
        // One line, like any page's title.
        assert_eq!(
            oembed_title(br#"{"title":"  a\n  b\t c  "}"#).as_deref(),
            Some("a b c")
        );
        // Bounded, like any page's title.
        let long = format!(r#"{{"title":"{}"}}"#, "x".repeat(400));
        assert_eq!(
            oembed_title(long.as_bytes()).map(|title| title.chars().count()),
            Some(MAX_LINK_TITLE_CHARS)
        );
        // No title, an empty one, a title that isn't words, or not JSON at all.
        for bad in [
            &br#"{"author_name":"Rick Astley"}"#[..],
            br#"{"title":"   "}"#,
            br#"{"title":42}"#,
            br#"[]"#,
            b"<html>Not Found</html>",
            b"",
        ] {
            assert_eq!(oembed_title(bad), None, "{}", String::from_utf8_lossy(bad));
        }
    }

    /// The whole path, against the real YouTube: a title through oEmbed, and
    /// the site's icon. It reaches the internet, so it never runs on its own;
    /// run it by hand with `cargo test -p linger-server -- --ignored youtube`.
    #[tokio::test]
    #[ignore = "reaches the real YouTube; run by hand"]
    async fn a_real_youtube_link_gets_its_title_and_icon() {
        let url = Url::parse("https://youtu.be/dQw4w9WgXcQ").expect("a url");
        let found = fetch(&url).await;
        assert_eq!(
            found.title.as_deref(),
            Some("Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)")
        );
        assert!(found
            .icon
            .as_deref()
            .is_some_and(|icon| icon.starts_with("data:image/")));
    }
}
