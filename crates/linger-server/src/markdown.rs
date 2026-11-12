//! A message body read the way the app reads it: which handles it mentions,
//! and its words with the formatting taken off.
//!
//! The server needs both for phone notifications (#830, PROTOCOL §5): who a
//! message names, and the start of what it says. The app decides the same
//! two things with `client/src/lib/markdown.ts` (`mentionHandles` and
//! `plainText`), and the two must never disagree. A handle in a code span
//! draws as code, not as a mention, so it must not wake anybody's phone; a
//! phone notification must say what a desktop banner says.
//!
//! So this is a port of that parser, rule for rule, rather than a regex over
//! the body: blocks (code fences, quotes, lists, paragraphs), then inline
//! (escapes, code spans, links, emphasis, bare addresses, `:shortcodes:` and
//! `@mentions`), with the same depth caps. Both are tested against the same
//! examples (`tests/fixtures/markdown.json`, read by `markdown.test.ts` too),
//! so a change to one that the other doesn't follow fails a test.
//!
//! It works on `char`s where the app works on UTF-16 units. The two differ
//! only for characters outside the Basic Multilingual Plane (most emoji, and
//! letters such as `𝐀` and digits such as `𝟙`), which JavaScript holds as
//! two halves. Every boundary rule looks at one unit beside the syntax, and
//! for such a character that is a half, which is never a letter or a number:
//! so in the app `@jo𝟙` mentions `jo` and `𝐀@jo` mentions `jo` too.
//! [`word_char`] says the same of the whole character (#890). None of them
//! is a space or a character the syntax uses either.

use std::collections::HashMap;

use unicode_properties::{GeneralCategory, UnicodeGeneralCategory};

/// How deep nesting may go: quotes in quotes, and spans in spans. Typed input
/// is hostile, and `>>>>…` or `****…` a thousand deep would otherwise be a
/// stack overflow anybody could send.
const MAX_BLOCK_DEPTH: usize = 4;
const MAX_INLINE_DEPTH: usize = 6;

/// What a backslash makes literal.
const ESCAPABLE: &str = "\\`*_~[]()>#+-.!@";

/// Every handle a body mentions, in order, each once: exactly what the app
/// draws as a mention (`mentionHandles`).
#[must_use]
pub fn mentions(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    collect_blocks(&parse(body), &mut found);
    let mut seen = std::collections::HashSet::new();
    found.retain(|handle| seen.insert(handle.clone()));
    found
}

/// A body as one line of plain words, its formatting taken off (`plainText`).
#[must_use]
pub fn plain_text(body: &str) -> String {
    let flat = flatten_blocks(&parse(body));
    let mut out = String::with_capacity(flat.len());
    let mut space = false;
    for c in flat.chars() {
        if js_space(c) {
            space = true;
            continue;
        }
        if space && !out.is_empty() {
            out.push(' ');
        }
        space = false;
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum Inline {
    Text(String),
    Code(String),
    /// Strong, emphasis and strikethrough: all that matters here is what's
    /// inside.
    Span(Vec<Inline>),
    /// A link's words. Where it goes is not a word, and not a mention.
    Link(Vec<Inline>),
    Mention(String),
    Shortcode(String),
}

#[derive(Debug)]
enum Block {
    Paragraph(Vec<Inline>),
    Quote(Vec<Block>),
    Code(String),
    List(Vec<Vec<Inline>>),
}

fn parse(body: &str) -> Vec<Block> {
    let lines: Vec<Vec<char>> = body
        .split('\n')
        .map(|line| line.chars().collect())
        .collect();
    parse_blocks(&lines, 0)
}

// ---------------------------------------------------------------------------
// Character classes, as JavaScript has them
// ---------------------------------------------------------------------------

/// JavaScript's `\s`, which `trim()` also uses. Not quite Rust's
/// `is_whitespace`: it has U+FEFF and lacks U+0085.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// What JavaScript's `.` refuses: the line terminators.
fn js_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `[\p{L}\p{N}_]`: a letter, a number or an underscore, as the app asks it
/// of one UTF-16 unit. A character outside the Basic Multilingual Plane is
/// two units there, and half of one is neither, so it is no word character
/// here either, whatever it is whole.
fn word_char(c: Option<&char>) -> bool {
    let Some(&c) = c else { return false };
    if u32::from(c) > 0xFFFF {
        return false;
    }
    c == '_'
        || matches!(
            c.general_category(),
            GeneralCategory::UppercaseLetter
                | GeneralCategory::LowercaseLetter
                | GeneralCategory::TitlecaseLetter
                | GeneralCategory::ModifierLetter
                | GeneralCategory::OtherLetter
                | GeneralCategory::DecimalNumber
                | GeneralCategory::LetterNumber
                | GeneralCategory::OtherNumber
        )
}

fn before(source: &[char], at: usize) -> Option<&char> {
    at.checked_sub(1).and_then(|i| source.get(i))
}

fn trim(text: &[char]) -> &[char] {
    let start = text
        .iter()
        .position(|&c| !js_space(c))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|&c| !js_space(c))
        .map_or(start, |i| i + 1);
    &text[start..end]
}

fn blank(line: &[char]) -> bool {
    trim(line).is_empty()
}

fn string(text: &[char]) -> String {
    text.iter().collect()
}

/// Up to three spaces at the start of a line, as `^ {0,3}` takes them.
fn indent(line: &[char]) -> usize {
    line.iter().take(3).take_while(|&&c| c == ' ').count()
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/// `^ {0,3}(`{3,}|~{3,})\s*\S*\s*$`: an opening fence and its run.
fn fence(line: &[char]) -> Option<(char, usize)> {
    let at = indent(line);
    let (mark, run) = fence_run(line, at)?;
    let rest = trim(&line[at + run..]);
    if rest.iter().any(|&c| js_space(c)) {
        return None;
    }
    Some((mark, run))
}

/// `^ {0,3}(`{3,}|~{3,})\s*$`: a closing fence and its run.
fn fence_close(line: &[char]) -> Option<(char, usize)> {
    let at = indent(line);
    let (mark, run) = fence_run(line, at)?;
    if !blank(&line[at + run..]) {
        return None;
    }
    Some((mark, run))
}

fn fence_run(line: &[char], at: usize) -> Option<(char, usize)> {
    let mark = *line.get(at)?;
    if mark != '`' && mark != '~' {
        return None;
    }
    let run = line[at..].iter().take_while(|&&c| c == mark).count();
    (run >= 3).then_some((mark, run))
}

/// `^ {0,3}> ?`: how much of the line is the quote's marker.
fn quote(line: &[char]) -> Option<usize> {
    let at = indent(line);
    if line.get(at) != Some(&'>') {
        return None;
    }
    Some(if line.get(at + 1) == Some(&' ') {
        at + 2
    } else {
        at + 1
    })
}

/// `(.*)$` after a list marker: the rest, unless it holds a line terminator.
fn rest_of_line(line: &[char], from: usize) -> Option<&[char]> {
    let rest = &line[from..];
    (!rest.iter().any(|&c| js_line_end(c))).then_some(rest)
}

/// Spaces after a list marker, one at least (` +`).
fn after_spaces(line: &[char], from: usize) -> Option<usize> {
    let spaces = line[from..].iter().take_while(|&&c| c == ' ').count();
    (spaces > 0).then_some(from + spaces)
}

/// `^ {0,3}[-*+] +(.*)$`: a bullet's item.
fn bullet(line: &[char]) -> Option<&[char]> {
    let at = indent(line);
    if !matches!(line.get(at), Some('-' | '*' | '+')) {
        return None;
    }
    rest_of_line(line, after_spaces(line, at + 1)?)
}

/// `^ {0,3}(\d{1,9})[.)] +(.*)$`: a numbered item, and its number.
fn numbered(line: &[char]) -> Option<(u64, &[char])> {
    let at = indent(line);
    let digits = line[at..].iter().take_while(|c| c.is_ascii_digit()).count();
    if !(1..=9).contains(&digits) || !matches!(line.get(at + digits), Some('.' | ')')) {
        return None;
    }
    let number = string(&line[at..at + digits]).parse().ok()?;
    Some((
        number,
        rest_of_line(line, after_spaces(line, at + digits + 1)?)?,
    ))
}

fn starts_block(line: &[char]) -> bool {
    fence(line).is_some()
        || quote(line).is_some()
        || bullet(line).is_some()
        || numbered(line).is_some()
}

fn join(lines: &[&[char]]) -> Vec<char> {
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.extend_from_slice(line);
    }
    out
}

fn parse_blocks(lines: &[Vec<char>], depth: usize) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut at = 0;

    while at < lines.len() {
        let line = &lines[at];
        if blank(line) {
            at += 1;
            continue;
        }

        if let Some((mark, run)) = fence(line) {
            let mut body: Vec<&[char]> = Vec::new();
            at += 1;
            // An unclosed fence runs to the end of the message.
            while at < lines.len() {
                if let Some((close, length)) = fence_close(&lines[at]) {
                    if close == mark && length >= run {
                        at += 1;
                        break;
                    }
                }
                body.push(&lines[at]);
                at += 1;
            }
            blocks.push(Block::Code(string(&join(&body))));
            continue;
        }

        if quote(line).is_some() {
            let mut inner: Vec<Vec<char>> = Vec::new();
            while let Some(marker) = lines.get(at).and_then(|line| quote(line)) {
                inner.push(lines[at][marker..].to_vec());
                at += 1;
            }
            if depth >= MAX_BLOCK_DEPTH {
                let joined: Vec<&[char]> = inner.iter().map(Vec::as_slice).collect();
                blocks.push(Block::Paragraph(parse_inline(&join(&joined), 0, false)));
            } else {
                blocks.push(Block::Quote(parse_blocks(&inner, depth + 1)));
            }
            continue;
        }

        if bullet(line).is_some() {
            let mut items = Vec::new();
            while let Some(item) = lines.get(at).and_then(|line| bullet(line)) {
                items.push(parse_inline(item, 0, false));
                at += 1;
            }
            blocks.push(Block::List(items));
            continue;
        }

        if numbered(line).is_some() {
            let mut items = Vec::new();
            while let Some((_, item)) = lines.get(at).and_then(|line| numbered(line)) {
                items.push(parse_inline(item, 0, false));
                at += 1;
            }
            blocks.push(Block::List(items));
            continue;
        }

        let mut paragraph: Vec<&[char]> = Vec::new();
        while let Some(candidate) = lines.get(at) {
            if blank(candidate) || starts_block(candidate) {
                break;
            }
            paragraph.push(candidate);
            at += 1;
        }
        blocks.push(Block::Paragraph(parse_inline(&join(&paragraph), 0, false)));
    }

    blocks
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/// Openers, longest first, so `**` is tried before `*`.
const EMPHASIS: [&str; 5] = ["~~", "**", "__", "*", "_"];

struct Found {
    node: Inline,
    next: usize,
}

fn run_length(source: &[char], at: usize, ch: char) -> usize {
    source[at.min(source.len())..]
        .iter()
        .take_while(|&&c| c == ch)
        .count()
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

fn starts_with(source: &[char], at: usize, open: &str) -> bool {
    (at..)
        .zip(open.chars())
        .all(|(i, c)| source.get(i) == Some(&c))
}

/// Where each opener's partner is, worked out once per source (#512): the
/// app's `Partners`, for the same reason.
struct Partners<'a> {
    source: &'a [char],
    brackets: HashMap<char, Vec<Option<usize>>>,
    closes: HashMap<&'static str, Vec<usize>>,
}

impl<'a> Partners<'a> {
    fn new(source: &'a [char]) -> Self {
        Self {
            source,
            brackets: HashMap::new(),
            closes: HashMap::new(),
        }
    }

    /// The bracket closing the one at `at`, honouring nesting and escapes.
    fn bracket(&mut self, at: usize, open: char, close: char) -> Option<usize> {
        let source = self.source;
        let partner = self.brackets.entry(open).or_insert_with(|| {
            let mut partner = vec![None; source.len()];
            for start in (0..source.len()).rev() {
                if source[start] != open {
                    continue;
                }
                let mut i = start + 1;
                while i < source.len() {
                    let c = source[i];
                    if c == '\\' {
                        i += 2;
                    } else if c == open {
                        let Some(nested) = partner[i] else { break };
                        i = nested + 1;
                    } else if c == close {
                        partner[start] = Some(i);
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            partner
        });
        partner.get(at).copied().flatten()
    }

    /// The first place at or after `from` where `open` can close a span: not
    /// after whitespace, and for underscores not before a letter.
    fn emphasis_close(&mut self, open: &'static str, from: usize) -> Option<usize> {
        let source = self.source;
        let found = self.closes.entry(open).or_insert_with(|| {
            let width = open.chars().count();
            let underscore = open.starts_with('_');
            (1..source.len())
                .filter(|&at| starts_with(source, at, open))
                .filter(|&at| {
                    !js_space(source[at - 1]) && (!underscore || !word_char(source.get(at + width)))
                })
                .collect()
        });
        let index = found.partition_point(|&at| at < from);
        found.get(index).copied()
    }
}

fn parse_inline(source: &[char], depth: usize, in_link: bool) -> Vec<Inline> {
    let mut nodes = Vec::new();
    let mut partners = Partners::new(source);
    let mut plain = String::new();
    let flush = |plain: &mut String, nodes: &mut Vec<Inline>| {
        if !plain.is_empty() {
            nodes.push(Inline::Text(std::mem::take(plain)));
        }
    };

    let mut at = 0;
    // Where the last `:name:` ended: another may follow it at once.
    let mut shortcode_end = None;
    while at < source.len() {
        let ch = source[at];

        if ch == '\\' {
            if let Some(&escaped) = source.get(at + 1) {
                if ESCAPABLE.contains(escaped) {
                    plain.push(escaped);
                    at += 2;
                    continue;
                }
            }
        }

        let found = match ch {
            '`' => match_code(source, at),
            _ => None,
        }
        .or_else(|| {
            (ch == '[' && !in_link && depth < MAX_INLINE_DEPTH)
                .then(|| match_link(source, at, depth, &mut partners))
                .flatten()
        })
        .or_else(|| {
            (depth < MAX_INLINE_DEPTH)
                .then(|| match_emphasis(source, at, depth, in_link, &mut partners))
                .flatten()
        })
        .or_else(|| {
            ((ch == 'h' || ch == 'H') && !in_link && !word_char(before(source, at)))
                .then(|| match_autolink(source, at))
                .flatten()
        });
        let found = match found {
            Some(found) => Some(found),
            None if ch == ':' => {
                let found = match_shortcode(source, at, shortcode_end == Some(at));
                if let Some(found) = &found {
                    shortcode_end = Some(found.next);
                }
                found
            }
            None if ch == '@' => match_mention(source, at),
            None => None,
        };

        if let Some(found) = found {
            flush(&mut plain, &mut nodes);
            nodes.push(found.node);
            at = found.next;
            continue;
        }

        plain.push(ch);
        at += 1;
    }

    flush(&mut plain, &mut nodes);
    nodes
}

fn match_code(source: &[char], at: usize) -> Option<Found> {
    let run = run_length(source, at, '`');
    let close = find_run(source, at + run, '`', run)?;
    let mut text = &source[at + run..close];
    // One space either side is the delimiter's, not the code's.
    if text.len() > 2 && text.first() == Some(&' ') && text.last() == Some(&' ') {
        text = &text[1..text.len() - 1];
    }
    Some(Found {
        node: Inline::Code(string(text)),
        next: close + run,
    })
}

/// A link's address, without a CommonMark title after it: the app's
/// `LINK_TITLE`, `^(\S+)\s+("…"|'…'|(…))$`.
fn without_title(target: &[char]) -> &[char] {
    let address = target.iter().take_while(|&&c| !js_space(c)).count();
    if address == 0 || address == target.len() {
        return target;
    }
    let spaces = target[address..]
        .iter()
        .take_while(|&&c| js_space(c))
        .count();
    if title(&target[address + spaces..]) {
        &target[..address]
    } else {
        target
    }
}

/// `"(?:[^"\\]|\\.)*"`, `'…'` or `\((?:[^()\\]|\\.)*\)`, to the end.
fn title(text: &[char]) -> bool {
    let (open, close) = match text.first() {
        Some('"') => ('"', '"'),
        Some('\'') => ('\'', '\''),
        Some('(') => ('(', ')'),
        _ => return false,
    };
    let mut i = 1;
    while i < text.len() {
        let c = text[i];
        if c == '\\' {
            if i + 1 >= text.len() {
                return false;
            }
            i += 2;
        } else if c == close {
            return i == text.len() - 1;
        } else if open == '(' && c == '(' {
            return false;
        } else {
            i += 1;
        }
    }
    false
}

/// The app's `safeHref`: an address that parses, with a scheme a link may
/// use. Only whether it does matters here; what it says isn't a word.
fn safe_href(raw: &[char]) -> bool {
    reqwest::Url::parse(&string(trim(raw)))
        .is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "mailto"))
}

fn match_link(source: &[char], at: usize, depth: usize, partners: &mut Partners) -> Option<Found> {
    let label_end = partners.bracket(at, '[', ']')?;
    if source.get(label_end + 1) != Some(&'(') {
        return None;
    }
    let target_end = partners.bracket(label_end + 1, '(', ')')?;
    let target = trim(&source[label_end + 2..target_end]);
    if !safe_href(without_title(target)) {
        return None;
    }
    Some(Found {
        node: Inline::Link(parse_inline(&source[at + 1..label_end], depth + 1, true)),
        next: target_end + 1,
    })
}

/// `^https?:\/\/[^\s<>]+` (any case), trimmed of the sentence around it.
fn match_autolink(source: &[char], at: usize) -> Option<Found> {
    let rest = &source[at..];
    let scheme = ["https://", "http://"].into_iter().find(|scheme| {
        rest.len() >= scheme.len()
            && rest
                .iter()
                .zip(scheme.chars())
                .all(|(a, b)| a.to_ascii_lowercase() == b)
    })?;
    let width = scheme.len();
    let tail = rest[width..]
        .iter()
        .take_while(|&&c| !js_space(c) && c != '<' && c != '>')
        .count();
    if tail == 0 {
        return None;
    }
    let raw = trim_address(&rest[..width + tail]);
    if !safe_href(raw) {
        return None;
    }
    Some(Found {
        node: Inline::Link(vec![Inline::Text(string(raw))]),
        next: at + raw.len(),
    })
}

/// The app's `trimAddress`: sentence punctuation is the sentence's, and a
/// closing paren is the address's only if it opened one.
fn trim_address(found: &[char]) -> &[char] {
    let mut raw = found;
    while let Some(last) = raw.last() {
        if !".,;:!?'\"".contains(*last) {
            break;
        }
        raw = &raw[..raw.len() - 1];
    }
    let count = |raw: &[char], ch: char| raw.iter().filter(|&&c| c == ch).count();
    while raw.last() == Some(&')') && count(raw, ')') > count(raw, '(') {
        raw = &raw[..raw.len() - 1];
    }
    raw
}

/// `@someone`: it starts a word and the handle ends one, so
/// `you@example.com` is an address and `@matthews` isn't `matt`.
fn match_mention(source: &[char], at: usize) -> Option<Found> {
    if word_char(before(source, at)) {
        return None;
    }
    let run = source[at + 1..]
        .iter()
        .take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || **c == '_')
        .count();
    if run < 2 {
        return None;
    }
    let length = run.min(24);
    let next = at + 1 + length;
    if word_char(source.get(next)) {
        return None;
    }
    Some(Found {
        node: Inline::Mention(string(&source[at + 1..next])),
        next,
    })
}

/// `:name:`, starting a word or straight after another.
fn match_shortcode(source: &[char], at: usize, after_another: bool) -> Option<Found> {
    let previous = before(source, at);
    if word_char(previous) || (previous == Some(&':') && !after_another) {
        return None;
    }
    let name = source[at + 1..]
        .iter()
        .take_while(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '+' | '-')
        })
        .count();
    if !(1..=64).contains(&name) || source.get(at + 1 + name) != Some(&':') {
        return None;
    }
    Some(Found {
        node: Inline::Shortcode(string(&source[at + 1..at + 1 + name])),
        next: at + name + 2,
    })
}

fn match_emphasis(
    source: &[char],
    at: usize,
    depth: usize,
    in_link: bool,
    partners: &mut Partners,
) -> Option<Found> {
    for open in EMPHASIS {
        if !starts_with(source, at, open) {
            continue;
        }
        // Underscores open a span only at a word boundary.
        if open.starts_with('_') && word_char(before(source, at)) {
            continue;
        }
        let from = at + open.chars().count();
        // No span opens on whitespace: `2 * 3 * 4` is arithmetic.
        match source.get(from) {
            Some(&c) if !js_space(c) => {}
            _ => continue,
        }
        let Some(close) = partners.emphasis_close(open, from + 1) else {
            continue;
        };
        return Some(Found {
            node: Inline::Span(parse_inline(&source[from..close], depth + 1, in_link)),
            next: close + open.chars().count(),
        });
    }
    None
}

// ---------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------

fn flatten_blocks(blocks: &[Block]) -> String {
    blocks
        .iter()
        .map(|block| match block {
            Block::Paragraph(children) => flatten_inline(children),
            Block::Quote(children) => flatten_blocks(children),
            Block::Code(text) => text.clone(),
            Block::List(items) => items
                .iter()
                .map(|item| flatten_inline(item))
                .collect::<Vec<_>>()
                .join(" "),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn flatten_inline(nodes: &[Inline]) -> String {
    nodes
        .iter()
        .map(|node| match node {
            Inline::Text(text) | Inline::Code(text) => text.clone(),
            Inline::Mention(handle) => format!("@{handle}"),
            Inline::Shortcode(name) => format!(":{name}:"),
            Inline::Span(children) | Inline::Link(children) => flatten_inline(children),
        })
        .collect()
}

fn collect_blocks(blocks: &[Block], into: &mut Vec<String>) {
    for block in blocks {
        match block {
            Block::Paragraph(children) => collect_inline(children, into),
            Block::Quote(children) => collect_blocks(children, into),
            Block::Code(_) => {}
            Block::List(items) => {
                for item in items {
                    collect_inline(item, into);
                }
            }
        }
    }
}

fn collect_inline(nodes: &[Inline], into: &mut Vec<String>) {
    for node in nodes {
        match node {
            Inline::Mention(handle) => into.push(handle.clone()),
            Inline::Span(children) | Inline::Link(children) => collect_inline(children, into),
            Inline::Text(_) | Inline::Code(_) | Inline::Shortcode(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One example the app and the server must read the same way.
    #[derive(serde::Deserialize)]
    struct Case {
        body: String,
        mentions: Vec<String>,
        plain: String,
    }

    /// The examples `client/src/lib/markdown.test.ts` reads too. A rule
    /// changed on one side and not the other fails here or there.
    #[test]
    fn reads_every_shared_example_as_the_app_does() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/markdown.json")).unwrap();
        assert!(cases.len() > 20, "the examples are all there");
        for case in cases {
            assert_eq!(
                mentions(&case.body),
                case.mentions,
                "mentions in {:?}",
                case.body
            );
            assert_eq!(
                plain_text(&case.body),
                case.plain,
                "words of {:?}",
                case.body
            );
        }
    }

    #[test]
    fn hostile_nesting_is_capped_rather_than_followed() {
        let quotes = format!("{} @deep", ">".repeat(5_000));
        assert_eq!(mentions(&quotes), vec!["deep"]);
        let stars = format!("{}@deep{}", "*".repeat(5_000), "*".repeat(5_000));
        let _ = mentions(&stars);
        let brackets = "[".repeat(20_000);
        assert!(mentions(&brackets).is_empty());
    }
}
