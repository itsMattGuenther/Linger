//! Each conversation as data, for programs (#585): `rooms/<slug>.json`.
//!
//! The markdown is for reading and the pages are for looking; this is for a
//! script somebody writes in five years to search their old group's jokes, or
//! to bring them somewhere else. So it says what each thing is in plain names,
//! keeps the body as the markdown that was typed, and points at files by
//! their place in the archive rather than at a server that may be gone.
//!
//! It is the archive's own shape, not the wire's: it doesn't cross between
//! the app and the server, so it isn't in `linger-core`, and a change to the
//! wire doesn't change it. `format` names its version.
//!
//! One message per line inside the `messages` array, so a room with years in
//! it can be read a line at a time, and is written that way too.

use std::collections::HashMap;

use linger_core::wire::{Attachment, Message, Room, RoomKind, User};
use linger_core::UserId;
use serde::Serialize;

use super::object_key_of;
use super::page::iso;

/// What the file says it is, so a program can tell this shape from a later
/// one.
pub const FORMAT: &str = "linger-export-conversation/1";

#[derive(Serialize)]
struct Header<'a> {
    format: &'static str,
    conversation: Conversation<'a>,
}

#[derive(Serialize)]
struct Conversation<'a> {
    id: String,
    /// `room` or `dm`.
    kind: &'static str,
    title: &'a str,
    slug: Option<&'a str>,
    name: Option<&'a str>,
    topic: Option<&'a str>,
    archived: bool,
}

/// The file's opening, up to the `[` its messages follow.
#[must_use]
pub fn open(room: &Room, title: &str) -> String {
    let dm = room.kind == RoomKind::Dm;
    let header = Header {
        format: FORMAT,
        conversation: Conversation {
            id: room.id.to_string(),
            kind: if dm { "dm" } else { "room" },
            title,
            // A DM's slug and name are generated and mean nothing.
            slug: (!dm).then_some(room.slug.as_str()),
            name: (!dm).then_some(room.name.as_str()),
            topic: room
                .topic
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty()),
            archived: room.archived_at.is_some(),
        },
    };
    let mut out = serde_json::to_string(&header).unwrap_or_else(|_| "{".to_string());
    // `{"format":…,"conversation":{…}}` with its closing brace swapped for
    // the start of the messages, so they can be written as they come.
    out.pop();
    out.push_str(",\"messages\":[\n");
    out
}

/// The file's end, after the last message.
#[must_use]
pub fn close() -> &'static str {
    "\n]}\n"
}

#[derive(Serialize)]
struct Record<'a> {
    id: String,
    /// UTC, ISO 8601.
    at: String,
    /// The same moment in unix milliseconds.
    at_ms: i64,
    /// `message`, `poll`, `motd` (set the message of the day), `voice_join`,
    /// `left` (a group DM), or `poll_closed`: the last three are lines the
    /// server wrote, not words anybody typed.
    kind: &'static str,
    /// `null` for somebody who is no longer on the server.
    author: Option<Person<'a>>,
    /// The markdown as it was typed.
    body: &'a str,
    reply_to: Option<String>,
    edited_at: Option<String>,
    pinned: bool,
    files: Vec<File<'a>>,
    reactions: Vec<Reaction>,
    poll: Option<PollRecord<'a>>,
}

#[derive(Serialize)]
struct Person<'a> {
    username: &'a str,
    display_name: &'a str,
}

#[derive(Serialize)]
struct File<'a> {
    /// What it was called when it was shared.
    name: &'a str,
    /// Where it is in this archive, or `null` when the archive doesn't
    /// carry it.
    path: Option<String>,
    mime: &'a str,
    size_bytes: u64,
    width: Option<u32>,
    height: Option<u32>,
    duration_ms: Option<u64>,
}

#[derive(Serialize)]
struct Reaction {
    /// The emoji, or a server emoji's `:name:`.
    emoji: String,
    /// Usernames, in the order they reacted.
    by: Vec<String>,
}

#[derive(Serialize)]
struct PollRecord<'a> {
    question: &'a str,
    multi: bool,
    closes_at: Option<String>,
    closed_at: Option<String>,
    closed_by: Option<String>,
    choices: Vec<Choice<'a>>,
}

#[derive(Serialize)]
struct Choice<'a> {
    text: &'a str,
    voters: Vec<String>,
}

/// One message as a line of JSON.
#[must_use]
pub fn message(
    message: &Message,
    users: &HashMap<UserId, User>,
    names: &HashMap<String, String>,
    emoji: &HashMap<String, String>,
) -> String {
    let username = |id: &UserId| {
        users
            .get(id)
            .map_or_else(|| "(gone)".to_string(), |u| u.username.clone())
    };
    let kind = if message.voice_join == Some(true) {
        "voice_join"
    } else if message.left == Some(true) {
        "left"
    } else if message.poll_closed.is_some() {
        "poll_closed"
    } else if message.poll.is_some() {
        "poll"
    } else if message.motd == Some(true) {
        "motd"
    } else {
        "message"
    };
    let record = Record {
        id: message.id.to_string(),
        at: iso(message.created_at),
        at_ms: message.created_at,
        kind,
        author: users.get(&message.author_id).map(|u| Person {
            username: &u.username,
            display_name: &u.display_name,
        }),
        body: &message.body,
        reply_to: message.reply_to.map(|id| id.to_string()),
        edited_at: message.edited_at.map(iso),
        pinned: message.pinned_at.is_some(),
        files: message.attachments.iter().map(|a| file(a, names)).collect(),
        reactions: message
            .reactions
            .iter()
            .map(|group| Reaction {
                emoji: emoji.get(&group.key).unwrap_or(&group.key).clone(),
                by: group.user_ids.iter().map(username).collect(),
            })
            .collect(),
        poll: message.poll.as_ref().map(|poll| PollRecord {
            question: &poll.question,
            multi: poll.multi,
            closes_at: (poll.closes_at > 0).then(|| iso(poll.closes_at)),
            closed_at: poll.closed_at.map(iso),
            closed_by: poll.closed_by.as_ref().map(username),
            choices: poll
                .choices
                .iter()
                .map(|choice| Choice {
                    text: &choice.text,
                    voters: choice.voter_ids.iter().map(username).collect(),
                })
                .collect(),
        }),
    };
    serde_json::to_string(&record).unwrap_or_default()
}

fn file<'a>(attachment: &'a Attachment, names: &HashMap<String, String>) -> File<'a> {
    File {
        name: &attachment.filename,
        path: names
            .get(&object_key_of(attachment))
            .map(|name| format!("media/{name}")),
        mime: &attachment.mime,
        size_bytes: attachment.size_bytes,
        width: attachment.width,
        height: attachment.height,
        duration_ms: attachment.duration_ms,
    }
}
