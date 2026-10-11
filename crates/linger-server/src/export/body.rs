//! A message body as HTML, for the archive's pages (#585).
//!
//! This is the app's own markdown subset (`client/src/lib/markdown.ts`) carried
//! over to the server, so a page in the archive reads the way the room read:
//! bold, italic, strikethrough, inline code, fenced code, quotes, lists and
//! links, and anything ambiguous left as the characters somebody typed.
//!
//! **The security design is the same as the app's: a tree, then text.** The
//! body is parsed into a closed set of node kinds and every piece of text that
//! reaches the page goes through [`escape`]. There is no path that copies a
//! body's characters into markup, so `<img onerror=…>` in a message is those
//! characters on the page. The one place a body reaches an attribute is a
//! link's `href`, and that has been through [`safe_href`], which keeps only
//! `http:`, `https:` and `mailto:`. The page also carries no scripts at all,
//! and says so in its content security policy (`page.rs`).
//!
//! A mention (`@sam`) and a shortcode (`:tada:`) stay as the characters typed:
//! the archive has nobody to resolve them against, and the words are still
//! right.

use reqwest::Url;

/// How deep nesting is allowed to go, as in the app. `>>>>…` a thousand deep,
/// or `****…`, is hostile input, and without a cap it is a stack overflow
/// anybody could put in a room and then in everybody's archive.
const MAX_BLOCK_DEPTH: usize = 4;
const MAX_INLINE_DEPTH: usize = 6;

/// Characters a backslash can make literal.
const ESCAPABLE: &str = "\\`*_~[]()>#+-.!@";

#[derive(Debug, PartialEq)]
enum Inline {
    Text(String),
    Code(String),
    Strong(Vec<Inline>),
    Em(Vec<Inline>),
    Strike(Vec<Inline>),
    /// `href` has been through [`safe_href`].
    Link {
        href: String,
        children: Vec<Inline>,
    },
}

#[derive(Debug, PartialEq)]
enum Block {
    Paragraph(Vec<Inline>),
    Quote(Vec<Block>),
    Code(String),
    List {
        ordered: bool,
        start: u32,
        items: Vec<Vec<Inline>>,
    },
}

/// Text made safe for HTML, inside an element or inside a double-quoted
/// attribute. Every attribute this module and `page.rs` write is
/// double-quoted, so this is the whole of the escaping either needs.
#[must_use]
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// The single gate between a message body and a link target.
///
/// The WHATWG URL parser is the one browsers use, so a trick that only works
/// because a hand-written check disagreed with the browser (`java\nscript:`,
/// leading spaces, mixed case) is normalised first and then refused on its
/// scheme. A relative address doesn't parse, which is right: there is nothing
/// in an archive for one to point at.
#[must_use]
pub fn safe_href(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https" | "mailto").then(|| url.to_string())
}

/// One message body, as the HTML that goes inside its words' element.
#[must_use]
pub fn to_html(source: &str) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let mut out = String::new();
    render_blocks(&parse_blocks(&lines, 0), &mut out);
    out
}

/// A body as one line of plain text with the markdown taken off, for the
/// quote above a reply. Run through the same parser as the page, so the two
/// can never disagree about what a body says.
#[must_use]
pub fn plain_text(source: &str) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let mut out = String::new();
    flatten_blocks(&parse_blocks(&lines, 0), &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn flatten_blocks(blocks: &[Block], out: &mut String) {
    for block in blocks {
        match block {
            Block::Paragraph(children) => flatten_inline(children, out),
            Block::Quote(children) => flatten_blocks(children, out),
            Block::Code(text) => out.push_str(text),
            Block::List { items, .. } => {
                for item in items {
                    flatten_inline(item, out);
                    out.push(' ');
                }
            }
        }
        out.push(' ');
    }
}

fn flatten_inline(nodes: &[Inline], out: &mut String) {
    for node in nodes {
        match node {
            Inline::Text(text) | Inline::Code(text) => out.push_str(text),
            Inline::Strong(children)
            | Inline::Em(children)
            | Inline::Strike(children)
            | Inline::Link { children, .. } => flatten_inline(children, out),
        }
    }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/// The line after up to three leading spaces, or `None` if it has more.
fn indented(line: &str) -> Option<&str> {
    let spaces = line.len() - line.trim_start_matches(' ').len();
    (spaces <= 3).then(|| &line[spaces..])
}

/// A run of three or more of one fence character at the start of `rest`.
fn fence_run(rest: &str) -> Option<(char, usize)> {
    let first = rest.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let run = rest.chars().take_while(|c| *c == first).count();
    (run >= 3).then_some((first, run))
}

/// An opening fence: the run, then at most one word (the language).
fn fence_open(line: &str) -> Option<(char, usize)> {
    let rest = indented(line)?;
    let (ch, run) = fence_run(rest)?;
    let info = rest[run..].trim();
    (!info.chars().any(char::is_whitespace)).then_some((ch, run))
}

/// A closing fence: the run and nothing else.
fn fence_close(line: &str) -> Option<(char, usize)> {
    let rest = indented(line)?;
    let (ch, run) = fence_run(rest)?;
    rest[run..].trim().is_empty().then_some((ch, run))
}

/// A quoted line's text, without its `>` and one space after it.
fn quote_line(line: &str) -> Option<&str> {
    let rest = indented(line)?.strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// A bullet item's text: `-`, `*` or `+`, then at least one space.
fn bullet(line: &str) -> Option<&str> {
    let rest = indented(line)?;
    let rest = rest
        .strip_prefix('-')
        .or_else(|| rest.strip_prefix('*'))
        .or_else(|| rest.strip_prefix('+'))?;
    let text = rest.trim_start_matches(' ');
    (text.len() < rest.len()).then_some(text)
}

/// A numbered item: its number and its text. `1.` or `1)`, one to nine digits.
fn numbered(line: &str) -> Option<(u32, &str)> {
    let rest = indented(line)?;
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let after = &rest[digits..];
    let after = after
        .strip_prefix('.')
        .or_else(|| after.strip_prefix(')'))?;
    let text = after.trim_start_matches(' ');
    if text.len() == after.len() {
        return None;
    }
    Some((rest[..digits].parse().ok()?, text))
}

fn starts_block(line: &str) -> bool {
    fence_open(line).is_some()
        || quote_line(line).is_some()
        || bullet(line).is_some()
        || numbered(line).is_some()
}

fn parse_blocks(lines: &[&str], depth: usize) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let line = lines[at];
        if line.trim().is_empty() {
            at += 1;
            continue;
        }

        if let Some((ch, run)) = fence_open(line) {
            let mut body = Vec::new();
            at += 1;
            // An unclosed fence runs to the end of the message, as in the app.
            while at < lines.len() {
                if let Some((close, length)) = fence_close(lines[at]) {
                    if close == ch && length >= run {
                        at += 1;
                        break;
                    }
                }
                body.push(lines[at]);
                at += 1;
            }
            blocks.push(Block::Code(body.join("\n")));
            continue;
        }

        if quote_line(line).is_some() {
            let mut inner = Vec::new();
            while let Some(text) = lines.get(at).and_then(|l| quote_line(l)) {
                inner.push(text);
                at += 1;
            }
            if depth >= MAX_BLOCK_DEPTH {
                blocks.push(Block::Paragraph(parse_inline(&inner.join("\n"), 0, false)));
            } else {
                blocks.push(Block::Quote(parse_blocks(&inner, depth + 1)));
            }
            continue;
        }

        if bullet(line).is_some() {
            let mut items = Vec::new();
            while let Some(text) = lines.get(at).and_then(|l| bullet(l)) {
                items.push(parse_inline(text, 0, false));
                at += 1;
            }
            blocks.push(Block::List {
                ordered: false,
                start: 1,
                items,
            });
            continue;
        }

        if let Some((start, _)) = numbered(line) {
            let mut items = Vec::new();
            while let Some((_, text)) = lines.get(at).and_then(|l| numbered(l)) {
                items.push(parse_inline(text, 0, false));
                at += 1;
            }
            blocks.push(Block::List {
                ordered: true,
                start,
                items,
            });
            continue;
        }

        let mut paragraph = Vec::new();
        while let Some(candidate) = lines.get(at) {
            if candidate.trim().is_empty() || starts_block(candidate) {
                break;
            }
            paragraph.push(*candidate);
            at += 1;
        }
        // Single newlines stay newlines: the page draws words with
        // `white-space: pre-wrap`, as the app does, so typed indentation
        // survives too.
        blocks.push(Block::Paragraph(parse_inline(
            &paragraph.join("\n"),
            0,
            false,
        )));
    }
    blocks
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Emphasis {
    Strike,
    Strong,
    Em,
}

/// Openers, longest first: `**` before `*`, or every bold run would come out
/// as an italic holding a stray asterisk.
const EMPHASIS: [(&str, Emphasis); 5] = [
    ("~~", Emphasis::Strike),
    ("**", Emphasis::Strong),
    ("__", Emphasis::Strong),
    ("*", Emphasis::Em),
    ("_", Emphasis::Em),
];

fn is_word(ch: Option<char>) -> bool {
    ch.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

fn starts_with_at(source: &[char], at: usize, pattern: &[char]) -> bool {
    source.len() >= at + pattern.len() && source[at..at + pattern.len()] == *pattern
}

fn run_length(source: &[char], at: usize, ch: char) -> usize {
    source[at..].iter().take_while(|c| **c == ch).count()
}

/// The next run of exactly `length` `ch`s at or after `from`.
fn find_run(source: &[char], from: usize, ch: char, length: usize) -> Option<usize> {
    let mut at = from;
    while at < source.len() {
        if source[at] != ch {
            at += 1;
            continue;
        }
        let run = run_length(source, at, ch);
        if run == length {
            return Some(at);
        }
        at += run;
    }
    None
}

fn parse_inline(source: &str, depth: usize, in_link: bool) -> Vec<Inline> {
    let chars: Vec<char> = source.chars().collect();
    parse_chars(&chars, depth, in_link)
}

/// `in_link` is true inside a link's words, where no link may start (#508).
fn parse_chars(source: &[char], depth: usize, in_link: bool) -> Vec<Inline> {
    let mut nodes = Vec::new();
    let mut plain = String::new();
    let mut at = 0;

    while at < source.len() {
        let ch = source[at];
        let before = at.checked_sub(1).map(|i| source[i]);

        if ch == '\\' {
            if let Some(&escaped) = source.get(at + 1) {
                if ESCAPABLE.contains(escaped) {
                    plain.push(escaped);
                    at += 2;
                    continue;
                }
            }
        }

        let found = if ch == '`' {
            match_code(source, at)
        } else {
            None
        }
        .or_else(|| {
            (ch == '[' && !in_link && depth < MAX_INLINE_DEPTH)
                .then(|| match_link(source, at, depth))
                .flatten()
        })
        .or_else(|| {
            (depth < MAX_INLINE_DEPTH)
                .then(|| match_emphasis(source, at, depth, in_link))
                .flatten()
        })
        .or_else(|| {
            ((ch == 'h' || ch == 'H') && !in_link && !is_word(before))
                .then(|| match_autolink(source, at))
                .flatten()
        });

        if let Some((node, next)) = found {
            if !plain.is_empty() {
                nodes.push(Inline::Text(std::mem::take(&mut plain)));
            }
            nodes.push(node);
            at = next;
            continue;
        }

        plain.push(ch);
        at += 1;
    }

    if !plain.is_empty() {
        nodes.push(Inline::Text(plain));
    }
    nodes
}

fn match_code(source: &[char], at: usize) -> Option<(Inline, usize)> {
    let run = run_length(source, at, '`');
    let close = find_run(source, at + run, '`', run)?;
    let mut text: String = source[at + run..close].iter().collect();
    // One space either side is the delimiter's, which is how a span that
    // starts or ends with a backtick is written.
    if text.chars().count() > 2 && text.starts_with(' ') && text.ends_with(' ') {
        text = text[1..text.len() - 1].to_string();
    }
    Some((Inline::Code(text), close + run))
}

/// From an opening bracket to its partner, honouring nesting and escapes.
fn match_bracket(source: &[char], at: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0_usize;
    let mut i = at;
    while i < source.len() {
        let ch = source[i];
        if ch == '\\' {
            i += 2;
            continue;
        }
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// A link's address without a CommonMark title after it (`https://x "t"`).
/// The title is dropped, as in the app: what the link says on hover is always
/// where it goes.
fn without_title(target: &str) -> &str {
    let Some(space) = target.find(char::is_whitespace) else {
        return target;
    };
    let (address, rest) = target.split_at(space);
    let rest = rest.trim_start();
    let quoted = rest.len() >= 2
        && ((rest.starts_with('"') && rest.ends_with('"'))
            || (rest.starts_with('\'') && rest.ends_with('\''))
            || (rest.starts_with('(') && rest.ends_with(')')));
    if quoted {
        address
    } else {
        target
    }
}

fn match_link(source: &[char], at: usize, depth: usize) -> Option<(Inline, usize)> {
    let label_end = match_bracket(source, at, '[', ']')?;
    if source.get(label_end + 1) != Some(&'(') {
        return None;
    }
    let target_end = match_bracket(source, label_end + 1, '(', ')')?;
    let target: String = source[label_end + 2..target_end].iter().collect();
    // A refused scheme isn't stripped: the whole thing stays as the
    // characters typed, so the reader sees exactly what they were sent.
    let href = safe_href(without_title(target.trim()))?;
    let children = parse_chars(&source[at + 1..label_end], depth + 1, true);
    Some((Inline::Link { href, children }, target_end + 1))
}

/// Whether `source` holds `pattern` at `at`, ignoring ASCII case.
fn starts_with_ignoring_case(source: &[char], at: usize, pattern: &str) -> bool {
    let mut i = at;
    for expected in pattern.chars() {
        match source.get(i) {
            Some(c) if c.eq_ignore_ascii_case(&expected) => i += 1,
            _ => return false,
        }
    }
    true
}

fn match_autolink(source: &[char], at: usize) -> Option<(Inline, usize)> {
    let scheme = if starts_with_ignoring_case(source, at, "https://") {
        8
    } else if starts_with_ignoring_case(source, at, "http://") {
        7
    } else {
        return None;
    };
    let length = source[at..]
        .iter()
        .position(|c| c.is_whitespace() || *c == '<' || *c == '>')
        .unwrap_or(source.len() - at);
    if length <= scheme {
        return None;
    }
    let found: String = source[at..at + length].iter().collect();
    let raw = trim_address(&found);
    let href = safe_href(raw)?;
    let length = raw.chars().count();
    Some((
        Inline::Link {
            href,
            children: vec![Inline::Text(raw.to_string())],
        },
        at + length,
    ))
}

/// An address without the sentence around it: a trailing full stop is the
/// sentence's, and a closing paren is the address's only if it opened one.
fn trim_address(found: &str) -> &str {
    let mut raw = found.trim_end_matches(['.', ',', ';', ':', '!', '?', '\'', '"']);
    while raw.ends_with(')') && raw.matches(')').count() > raw.matches('(').count() {
        raw = &raw[..raw.len() - 1];
    }
    raw
}

fn match_emphasis(
    source: &[char],
    at: usize,
    depth: usize,
    in_link: bool,
) -> Option<(Inline, usize)> {
    for (open, kind) in EMPHASIS {
        let open: Vec<char> = open.chars().collect();
        if !starts_with_at(source, at, &open) {
            continue;
        }
        // Underscores only open at a word boundary: `snake_case_name` stays
        // the identifier somebody meant.
        let underscore = open[0] == '_';
        if underscore && is_word(at.checked_sub(1).map(|i| source[i])) {
            continue;
        }
        let from = at + open.len();
        // No span opens on whitespace: `2 * 3 * 4` is arithmetic.
        match source.get(from) {
            Some(c) if !c.is_whitespace() => {}
            _ => continue,
        }

        let mut close = None;
        let mut search = from + 1;
        while search + open.len() <= source.len() {
            if starts_with_at(source, search, &open) {
                let before = source[search - 1];
                let after = source.get(search + open.len()).copied();
                if !before.is_whitespace() && (!underscore || !is_word(after)) {
                    close = Some(search);
                    break;
                }
            }
            search += 1;
        }
        let Some(close) = close else { continue };

        let children = parse_chars(&source[from..close], depth + 1, in_link);
        let node = match kind {
            Emphasis::Strike => Inline::Strike(children),
            Emphasis::Strong => Inline::Strong(children),
            Emphasis::Em => Inline::Em(children),
        };
        return Some((node, close + open.len()));
    }
    None
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn render_blocks(blocks: &[Block], out: &mut String) {
    for block in blocks {
        match block {
            Block::Paragraph(children) => {
                out.push_str("<p>");
                render_inline(children, out);
                out.push_str("</p>");
            }
            Block::Quote(children) => {
                out.push_str("<blockquote>");
                render_blocks(children, out);
                out.push_str("</blockquote>");
            }
            Block::Code(text) => {
                out.push_str("<pre><code>");
                out.push_str(&escape(text));
                out.push_str("</code></pre>");
            }
            Block::List {
                ordered,
                start,
                items,
            } => {
                if *ordered {
                    if *start == 1 {
                        out.push_str("<ol>");
                    } else {
                        out.push_str(&format!("<ol start=\"{start}\">"));
                    }
                } else {
                    out.push_str("<ul>");
                }
                for item in items {
                    out.push_str("<li>");
                    render_inline(item, out);
                    out.push_str("</li>");
                }
                out.push_str(if *ordered { "</ol>" } else { "</ul>" });
            }
        }
    }
}

fn render_inline(nodes: &[Inline], out: &mut String) {
    for node in nodes {
        match node {
            Inline::Text(text) => out.push_str(&escape(text)),
            Inline::Code(text) => {
                out.push_str("<code>");
                out.push_str(&escape(text));
                out.push_str("</code>");
            }
            Inline::Strong(children) => wrap("strong", children, out),
            Inline::Em(children) => wrap("em", children, out),
            Inline::Strike(children) => wrap("del", children, out),
            Inline::Link { href, children } => {
                // The address shows when pointed at, and it is always the
                // real one: `href` is what `safe_href` made of the target.
                let href = escape(href);
                out.push_str(&format!(
                    "<a href=\"{href}\" title=\"{href}\" rel=\"noreferrer\">"
                ));
                render_inline(children, out);
                out.push_str("</a>");
            }
        }
    }
}

fn wrap(tag: &str, children: &[Inline], out: &mut String) {
    out.push_str(&format!("<{tag}>"));
    render_inline(children, out);
    out.push_str(&format!("</{tag}>"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_in_a_message_is_characters_on_the_page() {
        let html = to_html("<script>alert(1)</script> <img src=x onerror=alert(1)> & \"'");
        assert_eq!(
            html,
            "<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; \
             &amp; &quot;&#39;</p>"
        );
    }

    #[test]
    fn a_link_only_goes_somewhere_safe() {
        assert_eq!(
            to_html("[menu](https://example.com/a?b=1&c=2)"),
            "<p><a href=\"https://example.com/a?b=1&amp;c=2\" \
             title=\"https://example.com/a?b=1&amp;c=2\" rel=\"noreferrer\">menu</a></p>"
        );
        for hostile in [
            "[x](javascript:alert(1))",
            "[x](JaVaScRiPt:alert(1))",
            "[x]( javascript:alert(1))",
            "[x](java\tscript:alert(1))",
            "[x](data:text/html,<script>alert(1)</script>)",
            "[x](file:///etc/passwd)",
            "[x](../rooms/general.html)",
        ] {
            let html = to_html(hostile);
            assert!(!html.contains("<a "), "{hostile:?} became a link: {html}");
            assert!(!html.contains("<script"), "{hostile:?}: {html}");
        }
    }

    #[test]
    fn an_attribute_cannot_be_broken_out_of() {
        let html = to_html("[x](https://example.com/\"onmouseover=alert(1)//)");
        assert!(!html.contains("\"onmouseover"), "{html}");
        let html = to_html("https://example.com/\"><script>alert(1)</script>");
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("\"><"), "{html}");
    }

    #[test]
    fn the_subset_reads_the_way_the_app_draws_it() {
        assert_eq!(
            to_html("**bold** *it* ~~gone~~ `co<de>`"),
            "<p><strong>bold</strong> <em>it</em> <del>gone</del> <code>co&lt;de&gt;</code></p>"
        );
        assert_eq!(to_html("snake_case_name"), "<p>snake_case_name</p>");
        assert_eq!(to_html("2 * 3 * 4"), "<p>2 * 3 * 4</p>");
        assert_eq!(to_html("\\*not em\\*"), "<p>*not em*</p>");
        assert_eq!(
            to_html("> quoted\n> more\n\nafter"),
            "<blockquote><p>quoted\nmore</p></blockquote><p>after</p>"
        );
        assert_eq!(
            to_html("- one\n- two\n\n7. seven\n8. eight"),
            "<ul><li>one</li><li>two</li></ul><ol start=\"7\"><li>seven</li><li>eight</li></ol>"
        );
        assert_eq!(
            to_html("```rust\nfn <main>() {}\n```\nafter"),
            "<pre><code>fn &lt;main&gt;() {}</code></pre><p>after</p>"
        );
        assert_eq!(
            to_html("line one\n  line two"),
            "<p>line one\n  line two</p>"
        );
    }

    #[test]
    fn a_bare_address_links_without_the_sentence_around_it() {
        assert_eq!(
            to_html("see https://linger.example/a."),
            "<p>see <a href=\"https://linger.example/a\" title=\"https://linger.example/a\" \
             rel=\"noreferrer\">https://linger.example/a</a>.</p>"
        );
        // Not inside a word, and not a link inside a link's words (#508).
        assert_eq!(to_html("xhttps://a.example"), "<p>xhttps://a.example</p>");
        let nested = to_html("[https://a.example](https://b.example)");
        assert_eq!(nested.matches("<a ").count(), 1, "{nested}");
    }

    #[test]
    fn a_quote_says_the_words_without_the_markdown() {
        assert_eq!(
            plain_text("we try the **new raid**\n\n> after `dinner`\n- [map](https://x.example)"),
            "we try the new raid after dinner map"
        );
        assert_eq!(plain_text("2 * 3"), "2 * 3");
    }

    #[test]
    fn hostile_nesting_is_capped_rather_than_a_stack_overflow() {
        let deep = ">".repeat(5_000) + " hi";
        assert!(to_html(&deep).contains("hi"));
        let stars = "*".repeat(5_000);
        assert!(!to_html(&stars).is_empty());
        let brackets = "[".repeat(5_000);
        assert!(!to_html(&brackets).is_empty());
    }
}
