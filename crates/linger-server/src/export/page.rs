//! The archive's pages for any browser (#585): `Open me.html`, a page per
//! room and DM, and a page of every file.
//!
//! The markdown is for anybody who wants plain text. These are for a friend
//! who double-clicks: a conversation laid out the way Linger lays one out
//! (`docs/design/system.md`, "The conversation"), with pictures in place and
//! videos and sound that play.
//!
//! **No scripts, no fonts, nothing from anywhere else.** A page is one file of
//! HTML with its style inside it, and it opens offline, from a USB stick, in
//! ten years. Its content security policy refuses every script, so even a
//! mistake in the escaping couldn't run anything. Everything a person wrote,
//! names and filenames included, reaches the page through [`escape`].
//!
//! The app is dark only, and so are these: the 16 name colors are only
//! promised to read against the app's dark surfaces (`linger_core::palette`).

use std::collections::HashMap;
use std::fmt::Write as _;

use linger_core::wire::{Attachment, Fill, Message, Poll, Room, RoomKind, User};
use linger_core::{MessageId, UserId};

use super::body::{escape, to_html};
use super::{civil_date, clock, human_size, object_key_of, Said};

/// The name of the page a person opens first. A space and a capital, because
/// it is the one file in the archive that is for a person rather than a
/// program, and it says what to do with it.
pub const INDEX: &str = "Open me.html";

/// The page of every file.
pub const MEDIA: &str = "media.html";

/// A conversation's run of messages breaks after this long with nothing said,
/// as in the app (SPEC §4.7).
const GROUP_GAP_MS: i64 = 10 * 60 * 1000;

/// Pictures and videos are drawn at most this big, as in the app
/// (`--media-max-w`, `--media-max-h`), and a very tall picture no narrower
/// than `MIN_WIDTH`, filled from its top (#512).
const MAX_WIDTH: f64 = 320.0;
const MAX_HEIGHT: f64 = 400.0;
const MIN_WIDTH: f64 = 120.0;

/// Refuses every script, plugin, frame and form. Pictures, video and sound
/// load from the archive's own folders, which is all a page ever names.
const POLICY: &str = "script-src 'none'; object-src 'none'; frame-src 'none'; \
                      worker-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";

const STYLE: &str = r#"
*{box-sizing:border-box}
html,body{margin:0;background:var(--surface-window);color:var(--text-primary)}
body{font:14.5px/20px var(--font-ui);-webkit-text-size-adjust:100%}
a{color:var(--text-accent);text-decoration:underline;text-decoration-color:var(--accent-edge);text-underline-offset:2px}
a:hover{text-decoration-color:var(--accent)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.page{display:grid;grid-template-columns:220px minmax(0,1fr);grid-template-areas:"nav main";min-height:100vh}
main{grid-area:main;min-width:0;max-width:1040px;padding:16px 16px 48px}
nav{grid-area:nav;position:sticky;top:0;height:100vh;overflow-y:auto;padding:16px 8px;background:var(--surface-sunken);border-right:1px solid var(--hairline)}
nav .server{display:block;padding:0 8px 4px;color:var(--text-primary);font-size:15.5px;font-weight:600;text-decoration:none;overflow-wrap:anywhere}
nav h2,.label{margin:16px 8px 4px;font:11px/16px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)}
.label{margin:24px 0 4px}
nav ul{list-style:none;margin:0;padding:0}
nav li a{display:block;padding:6px 8px;border-radius:6px;color:var(--text-secondary);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav li a:hover{background:var(--surface-hover);color:var(--text-primary)}
nav li a[aria-current]{background:var(--surface-hover);color:var(--text-primary)}
nav .gone{color:var(--text-muted)}
.jump{display:none}
@media (max-width:720px){
.page{grid-template-columns:minmax(0,1fr);grid-template-areas:"main" "nav"}
nav{position:static;height:auto;border-right:0;border-top:1px solid var(--hairline);padding:16px 8px 32px}
.jump{display:inline-block;margin-bottom:12px;font-size:12.5px}
.home nav,.home .jump{display:none}
}
h1{margin:0;font-size:20px;line-height:28px;font-weight:600;overflow-wrap:anywhere}
.sub{margin:4px 0 0;color:var(--text-secondary);overflow-wrap:anywhere}
.note{margin:4px 0 0;color:var(--text-muted);font-size:12.5px}
.day{margin:24px 0 4px;padding-bottom:4px;border-bottom:1px solid var(--hairline);font:11px/16px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)}
.msg{padding:2px 4px 2px 8px;border-radius:6px}
.msg.first{margin-top:8px}
.msg:target{background:var(--surface-hover)}
.head,.line{display:flex;align-items:baseline;gap:8px}
.head .did{flex:1 1 auto;min-width:0;color:var(--text-secondary)}
.head .grow{flex:1 1 auto}
.name{min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;unicode-bidi:isolate}
.name.gone{color:var(--text-muted)}
.name.grad{color:var(--c1)}
@supports ((-webkit-background-clip:text) or (background-clip:text)){.name.grad{background:linear-gradient(90deg,var(--c1),var(--c2));-webkit-background-clip:text;background-clip:text;color:transparent}}
time,.meta{flex:none;font:12.5px/20px var(--font-mono);color:var(--text-muted);white-space:nowrap}
.line .words{flex:1 1 auto}
.line time{visibility:hidden}
.msg:hover .line time,.msg:target .line time{visibility:visible}
@media (hover:none){.line time{visibility:visible}}
.words{min-width:0;margin-left:16px;overflow-wrap:anywhere;unicode-bidi:isolate}
.words>*{margin:0}
.words>*+*{margin-top:4px}
.words p,.words li{white-space:pre-wrap}
.words blockquote{padding-left:10px;border-left:2px solid var(--hairline-strong);color:var(--text-secondary)}
.words pre{padding:8px 10px;overflow-x:auto;border:1px solid var(--hairline);border-radius:6px;background:var(--surface-sunken);font:12.5px/16px var(--font-mono)}
.words code{padding:0 4px;border-radius:4px;background:var(--surface-sunken);font-family:var(--font-mono);font-size:12.5px}
.words pre code{padding:0;background:none}
.words ul,.words ol{padding-left:20px}
.nowords{margin-left:16px;color:var(--text-muted)}
.quote{display:flex;gap:6px;max-width:100%;margin:0 0 2px;padding-left:8px;border-left:2px solid var(--hairline-strong);color:var(--text-muted);font-size:12.5px;text-decoration:none;white-space:nowrap;overflow:hidden}
.quote:hover{color:var(--text-secondary)}
.quote .name{flex:none;max-width:50%}
.quote .excerpt{min-width:0;overflow:hidden;text-overflow:ellipsis;unicode-bidi:isolate}
.attach{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin:4px 0 0 16px}
.attach img,.attach video{display:block;max-width:100%;height:auto;border-radius:8px;background:var(--surface-sunken)}
.attach img.tall{object-fit:cover;object-position:top}
.file{display:flex;align-items:center;gap:8px;width:320px;max-width:100%;padding:8px 12px;border-radius:8px;background:var(--surface-raised)}
.file.sound{flex-direction:column;align-items:stretch}
.file .fname{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file audio{width:100%}
.reactions{display:flex;flex-wrap:wrap;gap:4px;list-style:none;margin:4px 0 0 16px;padding:0}
.reactions li{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border-radius:999px;background:var(--surface-control);font-size:12.5px}
.poll{width:420px;max-width:calc(100% - 16px);margin:4px 0 0 16px;padding:12px;border-radius:10px;background:var(--surface-raised)}
.poll .q{margin:0 0 8px;font-weight:600;overflow-wrap:anywhere}
.poll ul{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}
.poll li{overflow-wrap:anywhere}
.poll .who{color:var(--text-muted)}
.poll .note{margin-top:8px}
.quiet{display:flex;align-items:baseline;gap:8px;margin-top:4px;padding:0 4px 0 24px;color:var(--text-muted)}
.quiet .what{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.empty{margin-top:24px;color:var(--text-muted)}
.rooms{display:flex;flex-direction:column;gap:4px;list-style:none;margin:0;padding:0}
.rooms a{font-weight:500}
.rooms .sub{margin:0;font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(152px,1fr));gap:8px;list-style:none;margin:12px 0 0;padding:0}
.tile{min-width:0;padding:8px;border-radius:8px;background:var(--surface-raised)}
.tile .pic{display:block;aspect-ratio:1;margin-bottom:6px;border-radius:6px;overflow:hidden;background:var(--surface-sunken)}
.tile .pic img{display:block;width:100%;height:100%;object-fit:cover}
.tile .fname{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .pic.kind{display:flex;align-items:center;justify-content:center;font:11px/16px var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)}
.tile .who{display:block;margin-top:2px;color:var(--text-secondary);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .meta{display:block;font-size:11px;line-height:16px;white-space:normal}
"#;

/// The style every page carries: the app's surface and text colors, the
/// sixteen name colors, then the layout.
///
/// Hex rather than `oklch()` for the names: a custom property can't carry a
/// fallback, and an archive has to open in whatever browser somebody has in
/// ten years' time and in the one they had ten years ago.
fn style() -> String {
    let mut out = String::from(
        ":root{color-scheme:dark;\
         --surface-window:#131a28;--surface-sunken:#0f1522;--surface-raised:#1b2436;\
         --surface-hover:#1f2a40;--surface-control:#2a3550;\
         --text-primary:#f1ebe0;--text-secondary:#c0c6d2;--text-muted:#8d96a9;\
         --text-accent:#f3b55c;--accent:#f3b55c;--accent-edge:rgba(243,181,92,.45);\
         --hairline:#222d44;--hairline-strong:#2e3b54;\
         --font-ui:system-ui,-apple-system,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\
         --font-mono:ui-monospace,\"SF Mono\",Menlo,Consolas,\"Liberation Mono\",monospace;",
    );
    for color in &linger_core::palette::PALETTE {
        let _ = write!(out, "--n-{}:{};", color.key, color.hex());
    }
    out.push('}');
    out.push_str(STYLE);
    out
}

/// One place in the side list.
pub struct NavItem {
    /// Where it is, from the archive's top folder: `rooms/general.html`.
    pub href: String,
    pub title: String,
    /// An archived room is still listed, quietly.
    pub archived: bool,
}

/// The side list every page carries: the server, its rooms, your DMs, and
/// the media.
pub struct Nav {
    pub server: String,
    pub rooms: Vec<NavItem>,
    pub dms: Vec<NavItem>,
}

/// A link from a page at `depth` folders down to `href` from the top.
fn from_page(depth: usize, href: &str) -> String {
    format!("{}{}", "../".repeat(depth), path_href(href))
}

/// A path inside the archive as an `href`. Archive filenames are already
/// `[A-Za-z0-9 ._()-]` (`archive_filename`), and room slugs and usernames
/// narrower still; this encodes whatever isn't plain, so a space or a paren
/// can't end a URL early, and the result needs no further escaping.
#[must_use]
pub fn path_href(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// A page's top: the document, its style, and the opening of the layout.
/// `home` is the first page, which is itself the list of everything, so on
/// a phone it doesn't repeat that list under itself.
#[must_use]
pub fn open(title: &str, home: bool) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"{POLICY}\">\n\
         <meta name=\"referrer\" content=\"no-referrer\">\n\
         <title>{}</title>\n<style>{}</style>\n</head>\n<body{}>\n<div class=\"page\">\n<main>\n\
         <a class=\"jump\" href=\"#rooms\">All rooms</a>\n",
        escape(title),
        style(),
        if home { " class=\"home\"" } else { "" },
    )
}

/// A page's foot: the side list, after the conversation so a phone and a
/// screen reader both reach the words first, and the end of the document.
/// `depth` is how many folders down the page sits; `current` is its own
/// `href` from the top, so the list can mark it.
#[must_use]
pub fn close(nav: &Nav, depth: usize, current: &str) -> String {
    let mut out =
        String::from("</main>\n<nav id=\"rooms\" aria-label=\"Everything in this archive\">\n");
    let _ = writeln!(
        out,
        "<a class=\"server\" href=\"{}\"{}>{}</a>",
        from_page(depth, INDEX),
        if current == INDEX {
            " aria-current=\"page\""
        } else {
            ""
        },
        escape(&nav.server)
    );
    let mut list = |heading: &str, items: &[NavItem]| {
        if items.is_empty() {
            return;
        }
        let _ = writeln!(out, "<h2>{heading}</h2>\n<ul>");
        for item in items {
            let _ = writeln!(
                out,
                "<li><a href=\"{}\"{}{}>{}</a></li>",
                from_page(depth, &item.href),
                if item.href == current {
                    " aria-current=\"page\""
                } else {
                    ""
                },
                if item.archived {
                    " class=\"gone\" title=\"Archived\""
                } else {
                    ""
                },
                escape(&item.title)
            );
        }
        out.push_str("</ul>\n");
    };
    list("Rooms", &nav.rooms);
    list("Direct messages", &nav.dms);
    list(
        "Files",
        &[NavItem {
            href: MEDIA.to_string(),
            title: "Media".to_string(),
            archived: false,
        }],
    );
    out.push_str("</nav>\n</div>\n</body>\n</html>\n");
    out
}

// ---------------------------------------------------------------------------
// Names, times, dates
// ---------------------------------------------------------------------------

/// A person's name the way they styled it: their palette color or gradient,
/// weight and slant. Not their face: the page uses the system's fonts only.
/// A key that isn't in the palette draws as slate rather than reaching the
/// page as anything else (AGENTS rule 8: the server already refuses one).
fn name_html(user: Option<&User>) -> String {
    let Some(user) = user else {
        return "<span class=\"name gone\">somebody who is gone</span>".to_string();
    };
    let key = |color: &linger_core::wire::ColorKey| {
        linger_core::palette::get(&color.0).map_or("slate", |p| p.key)
    };
    let (class, mut style) = match &user.style.fill {
        Fill::Solid { color } => ("name", format!("color:var(--n-{})", key(color))),
        Fill::Gradient { from, to } => (
            "name grad",
            format!("--c1:var(--n-{});--c2:var(--n-{})", key(from), key(to)),
        ),
    };
    if matches!(user.style.weight, 400 | 500 | 700) {
        let _ = write!(style, ";font-weight:{}", user.style.weight);
    }
    if user.style.italic {
        style.push_str(";font-style:italic");
    }
    format!(
        "<span class=\"{class}\" style=\"{style}\" title=\"@{}\">{}</span>",
        escape(&user.username),
        escape(&user.display_name)
    )
}

/// `2026-10-09T20:50:00Z`, for a `<time>`'s machine-readable side.
#[must_use]
pub fn iso(unix_ms: i64) -> String {
    let (y, m, d) = civil_date(unix_ms);
    let secs = unix_ms.div_euclid(1000).rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

fn time_html(unix_ms: i64) -> String {
    format!(
        "<time datetime=\"{}\" title=\"{} UTC\">{}</time>",
        iso(unix_ms),
        long_date(unix_ms),
        clock(unix_ms)
    )
}

/// "Friday, 9 October 2026": a day said the way a person says it.
#[must_use]
pub fn long_date(unix_ms: i64) -> String {
    const DAYS: [&str; 7] = [
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
    ];
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    let (y, m, d) = civil_date(unix_ms);
    // 1970-01-01 was a Thursday.
    let weekday = DAYS[usize::try_from(unix_ms.div_euclid(86_400_000).rem_euclid(7)).unwrap_or(0)];
    let month = MONTHS[(m as usize).saturating_sub(1).min(11)];
    format!("{weekday}, {d} {month} {y}")
}

// ---------------------------------------------------------------------------
// A conversation
// ---------------------------------------------------------------------------

/// What a conversation page needs to know beyond the messages themselves.
pub struct Context<'a> {
    pub users: &'a HashMap<UserId, User>,
    /// Storage key → the file's name in `media/`.
    pub names: &'a HashMap<String, String>,
    /// A server emoji's reaction key → `:name:`.
    pub emoji: &'a HashMap<String, String>,
}

/// The top of a conversation's page, under the layout's opening.
#[must_use]
pub fn conversation_header(room: &Room, title: &str) -> String {
    let mut out = format!("<header>\n<h1>{}</h1>\n", escape(title));
    if room.kind != RoomKind::Dm && room.name != room.slug {
        let _ = writeln!(out, "<p class=\"sub\">{}</p>", escape(&room.name));
    }
    if let Some(topic) = room
        .topic
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        let _ = writeln!(out, "<p class=\"sub\">{}</p>", escape(topic));
    }
    if room.archived_at.is_some() {
        out.push_str("<p class=\"note\">This room was archived.</p>\n");
    }
    out.push_str("<p class=\"note\">Times are UTC.</p>\n</header>\n");
    out
}

/// What was said so far on a page, for deciding where a run of messages from
/// one person starts.
#[derive(Default)]
pub struct Run {
    day: Option<(i64, u32, u32)>,
    /// The author and time of the message above, if it was an ordinary one.
    last: Option<(UserId, i64)>,
}

impl Run {
    /// One message's HTML, with the day's heading first when it opens a day.
    pub fn message(
        &mut self,
        message: &Message,
        ctx: &Context<'_>,
        said: &HashMap<MessageId, Said>,
    ) -> String {
        let mut out = String::new();
        let today = civil_date(message.created_at);
        if self.day != Some(today) {
            let (y, m, d) = today;
            let _ = writeln!(
                out,
                "<h2 class=\"day\"><time datetime=\"{y:04}-{m:02}-{d:02}\">{}</time></h2>",
                long_date(message.created_at)
            );
            self.day = Some(today);
            self.last = None;
        }

        let author = ctx.users.get(&message.author_id);
        let anchor = format!("m-{}", message.id);

        // The lines the server writes itself: who and when, quietly.
        let quiet = if message.voice_join == Some(true) {
            Some("joined voice".to_string())
        } else if message.left == Some(true) {
            Some("left".to_string())
        } else {
            message
                .poll_closed
                .as_ref()
                .map(|_| escape(message.body.trim()))
        };
        if let Some(what) = quiet {
            let name = if message.poll_closed.is_some() {
                String::new()
            } else {
                format!("{} ", name_html(author))
            };
            let _ = writeln!(
                out,
                "<div class=\"quiet\" id=\"{anchor}\"><span class=\"what\">{name}{what}</span>{}</div>",
                time_html(message.created_at)
            );
            self.last = None;
            return out;
        }

        let special = message.poll.is_some() || message.motd == Some(true);
        let first = special
            || message.reply_to.is_some()
            || !matches!(self.last, Some((who, at))
                if who == message.author_id && message.created_at - at < GROUP_GAP_MS);
        self.last = (!special).then_some((message.author_id, message.created_at));

        let _ = write!(
            out,
            "<article class=\"msg{}\" id=\"{anchor}\">",
            if first { " first" } else { "" }
        );

        if let Some(replied_to) = message.reply_to {
            match said.get(&replied_to) {
                Some(quoted) => {
                    let _ = write!(
                        out,
                        "<a class=\"quote\" href=\"#m-{replied_to}\">↩ {}<span class=\"excerpt\">{}</span></a>",
                        name_html(ctx.users.get(&quoted.author)),
                        escape(&quoted.short)
                    );
                }
                None => out.push_str(
                    "<p class=\"quote\">↩ <span class=\"excerpt\">a message that is no longer here</span></p>",
                ),
            }
        }

        let mut meta = String::new();
        if message.edited_at.is_some() {
            meta.push_str("<span class=\"meta\">edited</span>");
        }
        if message.pinned_at.is_some() {
            meta.push_str("<span class=\"meta\">pinned</span>");
        }

        if first {
            let did = if message.poll.is_some() {
                "<span class=\"did\">asked a poll</span>"
            } else if message.motd == Some(true) {
                "<span class=\"did\">set the message of the day</span>"
            } else {
                "<span class=\"grow\"></span>"
            };
            let _ = write!(
                out,
                "<div class=\"head\">{}{did}{meta}{}</div>",
                name_html(author),
                time_html(message.created_at)
            );
        }

        if let Some(poll) = &message.poll {
            out.push_str(&poll_html(poll, ctx.users));
        } else {
            let body = message.body.trim();
            let words = if body.is_empty() {
                if message.attachments.is_empty() {
                    "<p class=\"nowords\">(no words)</p>".to_string()
                } else {
                    String::new()
                }
            } else {
                format!("<div class=\"words\">{}</div>", to_html(body))
            };
            if first {
                out.push_str(&words);
            } else if !words.is_empty() || !meta.is_empty() {
                let _ = write!(
                    out,
                    "<div class=\"line\">{}{meta}{}</div>",
                    if words.is_empty() {
                        "<div class=\"words\"></div>".to_string()
                    } else {
                        words
                    },
                    time_html(message.created_at)
                );
            }
            // A picture with no words, under the one before it, is just the
            // picture: an empty line above it would be a gap in the run.
        }

        if !message.attachments.is_empty() {
            out.push_str("<div class=\"attach\">");
            for attachment in &message.attachments {
                let file = ctx.names.get(&object_key_of(attachment));
                out.push_str(&attachment_html(attachment, file.map(String::as_str), 1));
            }
            out.push_str("</div>");
        }

        if !message.reactions.is_empty() {
            out.push_str("<ul class=\"reactions\">");
            for group in &message.reactions {
                let shown = ctx.emoji.get(&group.key).unwrap_or(&group.key);
                let who: Vec<&str> = group
                    .user_ids
                    .iter()
                    .map(|id| {
                        ctx.users
                            .get(id)
                            .map_or("somebody who is gone", |u| u.display_name.as_str())
                    })
                    .collect();
                let _ = write!(
                    out,
                    "<li title=\"{}\"><span>{}</span><span>{}</span></li>",
                    escape(&who.join(", ")),
                    escape(shown),
                    group.count
                );
            }
            out.push_str("</ul>");
        }

        out.push_str("</article>\n");
        out
    }
}

/// A poll as a card: the question, each choice and who picked it, and how it
/// ended if it has (#474).
fn poll_html(poll: &Poll, users: &HashMap<UserId, User>) -> String {
    let name = |id: &UserId| {
        users
            .get(id)
            .map_or("somebody who is gone", |u| u.display_name.as_str())
    };
    let mut out = format!(
        "<div class=\"poll\"><p class=\"q\">{}</p><ul>",
        escape(&poll.question)
    );
    for choice in &poll.choices {
        let picked: Vec<&str> = choice.voter_ids.iter().map(name).collect();
        if picked.is_empty() {
            let _ = write!(out, "<li>{}</li>", escape(&choice.text));
        } else {
            let _ = write!(
                out,
                "<li>{} <span class=\"who\">— {}</span></li>",
                escape(&choice.text),
                escape(&picked.join(", "))
            );
        }
    }
    out.push_str("</ul>");
    if let Some(at) = poll.closed_at {
        let when = long_date(at);
        match poll.closed_by {
            Some(by) => {
                let _ = write!(
                    out,
                    "<p class=\"note\">Closed by {} on {when}.</p>",
                    escape(name(&by))
                );
            }
            None => {
                let _ = write!(out, "<p class=\"note\">Closed on its own on {when}.</p>");
            }
        }
    }
    out.push_str("</div>");
    out
}

/// How big a picture or video is drawn, from its stored size: at most
/// 320 by 400, and a very tall one 120 wide and cut from its top (#512).
/// `None` when the size isn't known; the style's maximums hold it then.
fn media_box(width: Option<u32>, height: Option<u32>) -> Option<(u32, u32, bool)> {
    let (w, h) = (f64::from(width?), f64::from(height?));
    if w < 1.0 || h < 1.0 {
        return None;
    }
    let scale = (MAX_WIDTH / w).min(MAX_HEIGHT / h).min(1.0);
    let (mut bw, mut bh) = (w * scale, h * scale);
    let tall = bh >= MAX_HEIGHT - 0.5 && bw < MIN_WIDTH;
    if tall {
        bw = MIN_WIDTH.min(w);
        bh = MAX_HEIGHT;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some((bw.round().max(1.0) as u32, bh.round().max(1.0) as u32, tall))
}

/// One attachment, from a page `depth` folders down. `file` is its name in
/// `media/`, or `None` when the archive doesn't carry it.
#[must_use]
pub fn attachment_html(attachment: &Attachment, file: Option<&str>, depth: usize) -> String {
    let label = escape(&attachment.filename);
    let Some(file) = file else {
        return format!(
            "<div class=\"file\"><span class=\"fname\">{label}</span>\
             <span class=\"meta\">not in this archive</span></div>"
        );
    };
    let href = from_page(depth, &format!("media/{file}"));
    let sized = media_box(attachment.width, attachment.height);
    let dims = sized.map_or(String::new(), |(w, h, _)| {
        format!(" width=\"{w}\" height=\"{h}\"")
    });
    let mime = attachment.mime.as_str();
    if mime.starts_with("image/") {
        let tall = sized.is_some_and(|(_, _, tall)| tall);
        format!(
            "<a href=\"{href}\" title=\"{label}\"><img src=\"{href}\" alt=\"{label}\"{dims}{} loading=\"lazy\"></a>",
            if tall {
                " class=\"tall\" style=\"height:400px\""
            } else {
                ""
            }
        )
    } else if mime.starts_with("video/") {
        format!(
            "<video controls preload=\"metadata\" src=\"{href}\" title=\"{label}\"{dims}></video>"
        )
    } else if mime.starts_with("audio/") {
        format!(
            "<div class=\"file sound\"><span class=\"fname\">{label}</span>\
             <audio controls preload=\"none\" src=\"{href}\"></audio></div>"
        )
    } else {
        format!(
            "<div class=\"file\"><span class=\"fname\">{label}</span>\
             <span class=\"meta\">{}</span><a href=\"{href}\" download>Download</a></div>",
            human_size(i64::try_from(attachment.size_bytes).unwrap_or(i64::MAX))
        )
    }
}

/// A conversation with nothing in it.
#[must_use]
pub fn empty_conversation() -> &'static str {
    "<p class=\"empty\">Nothing was ever said here.</p>\n"
}

/// The first page: what this is, and where everything went.
#[must_use]
pub fn index(nav: &Nav, exported_at: i64, topics: &HashMap<String, String>) -> String {
    let mut out = open(&nav.server, true);
    let _ = writeln!(
        out,
        "<header>\n<h1>{}</h1>\n<p class=\"sub\">Everything on this server that you could see, \
         exported on {}.</p>\n<p class=\"note\">Times are UTC. You don't need Linger, an \
         account, or the server to read any of this.</p>\n</header>",
        escape(&nav.server),
        long_date(exported_at)
    );
    let mut section = |heading: &str, items: &[NavItem]| {
        if items.is_empty() {
            return;
        }
        let _ = writeln!(
            out,
            "<h2 class=\"label\">{heading}</h2>\n<ul class=\"rooms\">"
        );
        for item in items {
            let _ = write!(
                out,
                "<li><a href=\"{}\">{}</a>",
                path_href(&item.href),
                escape(&item.title)
            );
            if item.archived {
                out.push_str(" <span class=\"meta\">archived</span>");
            }
            if let Some(topic) = topics.get(&item.href) {
                let _ = write!(out, "<p class=\"sub\">{}</p>", escape(topic));
            }
            out.push_str("</li>\n");
        }
        out.push_str("</ul>\n");
    };
    section("Rooms", &nav.rooms);
    section("Direct messages", &nav.dms);
    let _ = writeln!(
        out,
        "<h2 class=\"label\">Files</h2>\n<ul class=\"rooms\"><li><a href=\"{}\">Media</a>\
         <p class=\"sub\">Every file shared here, newest last.</p></li></ul>\n\
         <h2 class=\"label\">Also in this folder</h2>\n<p class=\"sub\">The same conversations \
         as plain text (the .md files beside each page) and as data for programs (the .json \
         files), and every file in the media folder.</p>",
        path_href(MEDIA)
    );
    out.push_str(&close(nav, 0, INDEX));
    out
}

/// One file on the media page.
pub struct Tile<'a> {
    pub file: Option<&'a str>,
    pub filename: &'a str,
    pub mime: &'a str,
    pub who: &'a str,
    pub when: i64,
    pub place: String,
    pub size_bytes: i64,
    pub starred: bool,
}

/// The page of every file, oldest first, as the media index is.
#[must_use]
pub fn media(nav: &Nav, tiles: &[Tile<'_>]) -> String {
    let mut out = open(&format!("Media · {}", nav.server), false);
    out.push_str("<header>\n<h1>Media</h1>\n<p class=\"note\">Every file shared here. Times are UTC.</p>\n</header>\n");
    if tiles.is_empty() {
        out.push_str("<p class=\"empty\">Nothing has been shared yet.</p>\n");
    } else {
        out.push_str("<ul class=\"grid\">\n");
        for tile in tiles {
            let label = escape(tile.filename);
            let href = tile.file.map(|f| path_href(&format!("media/{f}")));
            // A picture shows itself; anything else holds its square with
            // the kind of file it is, so every tile's name lines up.
            let picture = match (&href, tile.mime.starts_with("image/")) {
                (Some(href), true) => format!(
                    "<a class=\"pic\" href=\"{href}\"><img src=\"{href}\" alt=\"{label}\" loading=\"lazy\"></a>"
                ),
                _ => format!(
                    "<span class=\"pic kind\" aria-hidden=\"true\">{}</span>",
                    escape(&kind_of(tile.filename))
                ),
            };
            let name = match &href {
                Some(href) => format!("<a class=\"fname\" href=\"{href}\">{label}</a>"),
                None => format!("<span class=\"fname\">{label}</span>"),
            };
            let (y, m, d) = civil_date(tile.when);
            let _ = writeln!(
                out,
                "<li class=\"tile\">{picture}{name}<span class=\"who\">{}{}</span>\
                 <span class=\"meta\">{y:04}-{m:02}-{d:02} {} · {} · {}</span></li>",
                if tile.starred { "★ " } else { "" },
                escape(tile.who),
                clock(tile.when),
                escape(&tile.place),
                human_size(tile.size_bytes)
            );
        }
        out.push_str("</ul>\n");
    }
    out.push_str(&close(nav, 0, MEDIA));
    out
}

/// A file's kind, from the end of its name: `txt`, `wav`, or `file`.
fn kind_of(filename: &str) -> String {
    filename
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| {
            (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("file")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_cannot_end_its_url_early_or_leave_its_attribute() {
        assert_eq!(
            path_href("media/IMG 0001 (2).jpg"),
            "media/IMG%200001%20%282%29.jpg"
        );
        assert_eq!(path_href("Open me.html"), "Open%20me.html");
        assert_eq!(path_href("a\"b<c>'"), "a%22b%3Cc%3E%27");
    }

    #[test]
    fn a_tall_picture_is_not_a_sliver() {
        // A phone's scrolling screenshot (#512).
        assert_eq!(media_box(Some(1080), Some(8000)), Some((120, 400, true)));
        // An ordinary photo fits the box.
        assert_eq!(media_box(Some(4000), Some(3000)), Some((320, 240, false)));
        // A small one isn't blown up.
        assert_eq!(media_box(Some(50), Some(40)), Some((50, 40, false)));
        // A one-pixel-wide picture is drawn no wider than it is.
        assert_eq!(media_box(Some(1), Some(10_000)), Some((1, 400, true)));
        assert_eq!(media_box(None, Some(10)), None);
        assert_eq!(media_box(Some(0), Some(10)), None);
    }

    #[test]
    fn days_are_named_the_way_people_say_them() {
        assert_eq!(long_date(0), "Thursday, 1 January 1970");
        assert_eq!(long_date(1_709_164_800_000), "Thursday, 29 February 2024");
        assert_eq!(iso(1_709_164_800_000 + 3_723_000), "2024-02-29T01:02:03Z");
    }

    #[test]
    fn every_page_refuses_scripts() {
        let nav = Nav {
            server: "<b>x</b>".to_string(),
            rooms: Vec::new(),
            dms: Vec::new(),
        };
        let page = index(&nav, 0, &HashMap::new());
        assert!(page.contains("script-src 'none'"));
        assert!(
            !page.contains("<b>x</b>"),
            "the server's name reached the page as markup"
        );
        assert!(page.contains("&lt;b&gt;x&lt;/b&gt;"));
    }
}
