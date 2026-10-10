//! Full-text search over messages (SPEC §4.12, PROTOCOL §6, T-1201/T-1202).
//!
//! The index is `message_fts`, an FTS5 table built and kept in step by triggers
//! in migration `0004_search.sql`. Nothing in this module writes to it — if a
//! word is in a message it is in the index, because SQLite put it there when the
//! row changed, and there is no code path that can forget to.
//!
//! Two things here are worth reading before changing anything.
//!
//! **The query is rebuilt, never forwarded.** FTS5 has a query language of its
//! own — `AND`, `OR`, `NOT`, `NEAR`, column filters, prefixes, parentheses — and
//! handing somebody's raw typing to it means either a syntax error thrown at
//! whoever typed an apostrophe, or a search that quietly did something other
//! than what it looked like. So [`Terms::parse`] pulls the words out and builds
//! a query from them: every term becomes a quoted phrase, and quoting is what
//! makes every operator inert. There is no input that can reach `MATCH` as
//! syntax.
//!
//! **Paging is keyset on the message id.** Message ids are UUIDv7, so their
//! bytes sort in the order the messages were said; `before` is one, and the
//! next page is everything ordered before it. Nothing repeats and nothing is
//! skipped when somebody posts while a reader is paging, which an `OFFSET`
//! cannot promise.

use linger_core::limits::{MAX_SEARCH_TERMS, SEARCH_SNIPPET_TOKENS};
use linger_core::wire::{SearchHit, SearchSnippetPart};
use linger_core::{MessageId, RoomId, UserId};
use sqlx::{Row, SqlitePool};

use crate::error::ApiError;

/// Filenames are joined by this inside the index's second column, and split
/// back out on it here. `validate::filename` strips control characters, so it
/// cannot occur inside one (migration `0004_search.sql`).
const FILENAME_SEPARATOR: char = '\u{1f}';

/// What `snippet()` and `highlight()` wrap a matched word in. Control
/// characters rather than punctuation, so ordinary writing cannot look like a
/// marker: a message *can* still contain one, and the only consequence is that
/// its own snippet emphasises the wrong word.
const MARK_START: &str = "\u{2}";
const MARK_END: &str = "\u{3}";

/// What `GET /search` was asked for, already checked.
#[derive(Debug, Clone)]
pub struct Query {
    pub terms: Terms,
    /// Who is searching. **Required**, so nobody can build a search that is
    /// nobody's (SPEC §4.13) — the index covers every message on the server,
    /// including DMs, and it is this that decides which of them come back.
    pub viewer: UserId,
    pub room_id: Option<RoomId>,
    pub author_id: Option<UserId>,
    pub before: Option<MessageId>,
    pub limit: u32,
}

/// The words somebody typed, ready to become an FTS5 `MATCH` expression.
#[derive(Debug, Clone)]
pub struct Terms {
    phrases: Vec<String>,
}

impl Terms {
    /// Pull searchable words out of raw typing.
    ///
    /// A run inside double quotes stays together as one phrase, so `"drive
    /// cage"` finds the two words next to each other; everything else splits on
    /// whitespace. Each piece is then stripped of its own double quotes and
    /// wrapped in a pair of ours, which is what neutralises FTS5 syntax: inside
    /// a quoted phrase, `OR`, `*` and `(` are just characters for the tokenizer
    /// to break on.
    ///
    /// Returns `None` when there is nothing left to search for — an empty box,
    /// or a query made only of punctuation. That is a validation error at the
    /// endpoint rather than an empty result, because "no messages contain `***`"
    /// and "you did not ask for anything" are different answers.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        let mut phrases = Vec::new();
        let mut current = String::new();
        let mut in_quotes = false;

        let flush = |current: &mut String, phrases: &mut Vec<String>| {
            let phrase = current.trim().to_string();
            current.clear();
            if is_searchable(&phrase) {
                phrases.push(phrase);
            }
        };

        for c in raw.chars() {
            match c {
                '"' => {
                    flush(&mut current, &mut phrases);
                    in_quotes = !in_quotes;
                }
                c if c.is_whitespace() && !in_quotes => flush(&mut current, &mut phrases),
                c => current.push(c),
            }
        }
        flush(&mut current, &mut phrases);

        phrases.truncate(MAX_SEARCH_TERMS);
        (!phrases.is_empty()).then_some(Self { phrases })
    }

    /// The `MATCH` expression: quoted phrases side by side, which is FTS5's
    /// implicit AND. Every term has to be in the message, in some column.
    fn to_match(&self) -> String {
        self.phrases
            .iter()
            .map(|phrase| format!("\"{phrase}\""))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Whether a run of characters has anything the tokenizer would index. A term
/// of pure punctuation matches nothing and would make `""` — an FTS5 syntax
/// error — so it is dropped here instead.
fn is_searchable(phrase: &str) -> bool {
    phrase.chars().any(char::is_alphanumeric)
}

/// One page of hits, newest first.
pub async fn page(db: &SqlitePool, query: &Query) -> Result<Vec<SearchHit>, ApiError> {
    // `message_fts` is not aliased: FTS5 wants the table's own name on the left
    // of MATCH and as the first argument to snippet()/highlight().
    let mut sql = String::from(
        "SELECT m.id, m.room_id, m.author_id, m.created_at,
                snippet(message_fts, 0, ?, ?, '…', ?) AS body_snippet,
                highlight(message_fts, 1, ?, ?) AS marked_filenames
         FROM message_fts
         JOIN messages m ON m.rowid = message_fts.rowid
         WHERE message_fts MATCH ?
           AND m.deleted_at IS NULL
           AND m.voice_join = 0",
    );
    // The index holds every message on the server, DMs included — it is built
    // by triggers on `messages` and has no idea what a room is. So this is the
    // only thing standing between a search box and somebody else's private
    // conversation, and it goes in before any of the optional filters so that
    // an unfiltered search is still a filtered one.
    sql.push_str(&format!(" AND {}", crate::repo::rooms::visible_rooms("m")));
    if query.room_id.is_some() {
        sql.push_str(" AND m.room_id = ?");
    }
    if query.author_id.is_some() {
        sql.push_str(" AND m.author_id = ?");
    }
    if query.before.is_some() {
        sql.push_str(" AND m.id < ?");
    }
    // Newest first, and the id *is* the order: a UUIDv7 blob sorts
    // chronologically, so this is the same walk the message stream does.
    sql.push_str(" ORDER BY m.id DESC LIMIT ?");

    let mut request = sqlx::query(&sql)
        .bind(MARK_START)
        .bind(MARK_END)
        .bind(i64::from(SEARCH_SNIPPET_TOKENS))
        .bind(MARK_START)
        .bind(MARK_END)
        .bind(query.terms.to_match())
        .bind(query.viewer.to_vec());
    if let Some(room_id) = query.room_id {
        request = request.bind(room_id.to_vec());
    }
    if let Some(author_id) = query.author_id {
        request = request.bind(author_id.to_vec());
    }
    if let Some(before) = query.before {
        request = request.bind(before.to_vec());
    }
    request = request.bind(i64::from(query.limit));

    let rows = request.fetch_all(db).await?;
    rows.iter()
        .map(|row| {
            let id =
                MessageId::from_slice(&row.get::<Vec<u8>, _>("id")).map_err(anyhow::Error::from)?;
            Ok(SearchHit {
                message_id: id,
                room_id: RoomId::from_slice(&row.get::<Vec<u8>, _>("room_id"))
                    .map_err(anyhow::Error::from)?,
                author_id: UserId::from_slice(&row.get::<Vec<u8>, _>("author_id"))
                    .map_err(anyhow::Error::from)?,
                created_at: row.get("created_at"),
                cursor: cursor_of(id),
                snippet: split_marks(&row.get::<String, _>("body_snippet")),
                matched_filenames: matched_filenames(&row.get::<String, _>("marked_filenames")),
            })
        })
        .collect()
}

/// A cursor is the message id, hex, and nothing else — the sort is on that id
/// alone, so there is nothing to break a tie with.
fn cursor_of(id: MessageId) -> String {
    hex::encode(id.to_vec())
}

/// Read a cursor back. Cursors are handed out by this module and handed back
/// verbatim, so a malformed one is a client bug rather than something to guess
/// at.
pub fn parse_cursor(raw: &str) -> Result<MessageId, ApiError> {
    let bytes =
        hex::decode(raw).map_err(|_| ApiError::validation("That's not a search cursor."))?;
    MessageId::from_slice(&bytes).map_err(|_| ApiError::validation("That's not a search cursor."))
}

/// Cut marked-up text into runs, alternating unmatched and matched.
///
/// The alternative — handing the client a string with markers in it — makes
/// every client parse them, and makes the obvious rendering (drop it into HTML)
/// an injection. A list of runs has neither problem.
fn split_marks(marked: &str) -> Vec<SearchSnippetPart> {
    let mut parts: Vec<SearchSnippetPart> = Vec::new();
    let mut push = |text: &str, matched: bool| {
        if text.is_empty() {
            return;
        }
        // Two adjacent runs of the same kind happen when a marker was stray;
        // joining them keeps the list something a renderer can trust.
        match parts.last_mut() {
            Some(last) if last.matched == matched => last.text.push_str(text),
            _ => parts.push(SearchSnippetPart {
                text: text.to_string(),
                matched,
            }),
        }
    };

    for (index, chunk) in marked.split(MARK_START).enumerate() {
        if index == 0 {
            push(chunk, false);
            continue;
        }
        match chunk.split_once(MARK_END) {
            Some((inside, after)) => {
                push(inside, true);
                push(after, false);
            }
            // An opening marker with no close: treat what follows as plain
            // text rather than swallowing the rest of the snippet.
            None => push(chunk, false),
        }
    }
    parts
}

/// The filenames on a message that the search actually matched, out of
/// `highlight()`'s copy of the whole column.
fn matched_filenames(marked: &str) -> Vec<String> {
    marked
        .split(FILENAME_SEPARATOR)
        .filter(|name| name.contains(MARK_START))
        .map(|name| name.replace(MARK_START, "").replace(MARK_END, ""))
        .filter(|name| !name.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fts5_operator_arrives_as_a_word_to_look_for() {
        // None of these may reach MATCH as syntax: each ends up inside quotes,
        // where FTS5 has no operators, only words for the tokenizer to find.
        let terms = Terms::parse("NEAR(a b) OR *foo* AND x").expect("terms");
        assert_eq!(
            terms.to_match(),
            "\"NEAR(a\" \"b)\" \"OR\" \"*foo*\" \"AND\" \"x\""
        );
        // And a lone quote cannot leave one of ours unbalanced.
        assert_eq!(
            Terms::parse("say \"what").unwrap().to_match(),
            "\"say\" \"what\""
        );
    }

    #[test]
    fn quotes_hold_a_phrase_together() {
        let terms = Terms::parse("\"drive cage\" bolts").expect("terms");
        assert_eq!(terms.to_match(), "\"drive cage\" \"bolts\"");
    }

    #[test]
    fn nothing_to_search_for_is_nothing_rather_than_everything() {
        assert!(Terms::parse("").is_none());
        assert!(Terms::parse("   ").is_none());
        assert!(Terms::parse("*** --- ???").is_none());
        assert!(Terms::parse("\"\"").is_none());
    }

    #[test]
    fn a_long_query_is_cut_rather_than_refused() {
        let raw = (0..40)
            .map(|n| format!("w{n}"))
            .collect::<Vec<_>>()
            .join(" ");
        let terms = Terms::parse(&raw).expect("terms");
        assert_eq!(terms.phrases.len(), MAX_SEARCH_TERMS);
    }

    #[test]
    fn a_snippet_comes_back_as_runs_of_matched_and_unmatched() {
        let parts = split_marks("did the \u{2}drive\u{3} get here");
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].text, "did the ");
        assert!(!parts[0].matched);
        assert_eq!(parts[1].text, "drive");
        assert!(parts[1].matched);
        assert_eq!(parts[2].text, " get here");
        assert!(!parts[2].matched);
    }

    #[test]
    fn an_empty_snippet_has_no_runs() {
        assert!(split_marks("").is_empty());
    }

    #[test]
    fn a_stray_marker_does_not_swallow_the_rest_of_the_snippet() {
        let parts = split_marks("before \u{2}after");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].text, "before after");
        assert!(!parts[0].matched);
    }

    #[test]
    fn only_the_filenames_that_matched_come_back_and_they_keep_their_spaces() {
        let marked = "holiday photo.jpg\u{1f}\u{2}turbo\u{3}-invoice.pdf";
        assert_eq!(matched_filenames(marked), vec!["turbo-invoice.pdf"]);
        assert!(matched_filenames("nothing here").is_empty());
    }

    #[test]
    fn a_cursor_round_trips() {
        let id = MessageId::new();
        assert_eq!(parse_cursor(&cursor_of(id)).unwrap(), id);
        assert!(parse_cursor("nonsense").is_err());
        assert!(parse_cursor("ab").is_err());
    }
}
