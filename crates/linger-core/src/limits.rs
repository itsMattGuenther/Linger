//! Numeric limits shared by client and server, so validation logic never drifts.
//! Sources: SPEC §4 and ARCHITECTURE §7 (rate limits).

/// 500 MB per file (SPEC §4.10).
pub const MAX_FILE_BYTES: u64 = 500 * 1024 * 1024;
/// 50 GB default per-server pool; host-configurable (SPEC §4.10).
pub const DEFAULT_POOL_BYTES: u64 = 50 * 1024 * 1024 * 1024;
/// Files over this use multipart upload, which is what makes uploads resumable.
pub const MULTIPART_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;
/// Non-starred, non-pinned files expire after this many days by default.
pub const DEFAULT_FILE_EXPIRY_DAYS: u32 = 365;
/// How many finished uploads one message may carry.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 10;
/// Filenames are stored and echoed in a download header, so they are bounded.
pub const MAX_FILENAME_CHARS: usize = 200;

/// Custom entrance sounds: max 2 seconds, max 200 KB, reject (never truncate).
pub const MAX_ENTRANCE_SOUND_BYTES: u64 = 200 * 1024;
pub const MAX_ENTRANCE_SOUND_MS: u32 = 2_000;
/// A given user's entrance sound plays at most once per 5 min per listener.
pub const ENTRANCE_SOUND_COOLDOWN_MS: u64 = 5 * 60 * 1000;

/// User-status fields (SPEC §4.6).
pub const MAX_STATUS_LINE_CHARS: usize = 240;
/// A field's value.
pub const MAX_STATUS_FIELD_CHARS: usize = 80;
/// A field's label, chosen from the app's suggestions or typed (#270).
pub const MAX_STATUS_LABEL_CHARS: usize = 24;
/// A status is a small card, not a bio: three fields at most (#270).
pub const MAX_STATUS_FIELDS: usize = 3;

/// Message body cap, chars after trim (PROTOCOL §4).
pub const MAX_MESSAGE_CHARS: usize = 8_000;

/// A room's message of the day, chars after trim (PROTOCOL §3, #464). It sits
/// whole under the room's header, so it is a few sentences, not a page.
pub const MAX_MOTD_CHARS: usize = 300;

/// How long somebody stays in a room's voice before the room gets a line
/// saying they joined (SPEC §4.14, #473). A misclick on Join, or a join that
/// ends at once, leaves nothing behind.
pub const VOICE_JOIN_LINE_AFTER_MS: u64 = 10_000;

/// At most one join line per person per room this often (#473), however many
/// times they join in between: somebody joining and leaving over and over
/// can't fill a room with lines.
pub const VOICE_JOIN_LINE_EVERY_MS: i64 = 10 * 60 * 1000;

/// A poll's question, chars after trim (PROTOCOL §4, #474): as long as a
/// message of the day, since it is read whole at the top of the card.
pub const MAX_POLL_QUESTION_CHARS: usize = 300;
/// One of a poll's choices, chars after trim: a row's worth.
pub const MAX_POLL_CHOICE_CHARS: usize = 80;
/// A poll has at least two choices, or there is nothing to choose.
pub const MIN_POLL_CHOICES: usize = 2;
/// And at most ten, so the card stays a card.
pub const MAX_POLL_CHOICES: usize = 10;
/// How long a poll may run before it closes on its own, in days: a day, three,
/// a week (the app's default), two weeks or four (Matt, 2026-10-10). Every
/// poll closes.
pub const POLL_DAYS: [u32; 5] = [1, 3, 7, 14, 28];

/// Link cards and the media grid (SPEC §4.4/§5.6, PROTOCOL §6).
///
/// A message with a dozen URLs in it is a link dump, and the stream renders one
/// restrained line per link — so only the first few become cards, and the rest
/// stay plain links in the text.
pub const MAX_LINKS_PER_MESSAGE: usize = 4;
/// How many URLs one `POST /links/preview` may ask about.
pub const MAX_LINK_PREVIEW_BATCH: usize = 16;
/// A card is one line. A title longer than this is cut, not wrapped.
pub const MAX_LINK_TITLE_CHARS: usize = 140;
/// The message text a media item carries, shortened.
pub const MAX_MEDIA_EXCERPT_CHARS: usize = 140;
/// How long a fetched preview stands before the server looks again.
pub const LINK_PREVIEW_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// A refusal is remembered for less time, so a site that was briefly down gets
/// another chance without every reader re-triggering the fetch meanwhile.
pub const LINK_PREVIEW_RETRY_MS: i64 = 60 * 60 * 1000;
/// Caps on what a preview fetch will pull down (the SSRF guard's other half).
pub const MAX_LINK_PAGE_BYTES: u64 = 256 * 1024;
pub const MAX_LINK_ICON_BYTES: u64 = 32 * 1024;
/// A YouTube oEmbed answer (#300) is a few hundred bytes of JSON; anything
/// much bigger isn't one.
pub const MAX_LINK_OEMBED_BYTES: u64 = 16 * 1024;
pub const LINK_FETCH_TIMEOUT_MS: u64 = 5_000;
/// Redirects are followed by hand so every hop is checked again.
pub const MAX_LINK_REDIRECTS: usize = 3;
/// Ceiling on `GET /media?limit=` (PROTOCOL §6).
pub const MAX_MEDIA_PAGE: u32 = 100;

/// How many people can be in one DM, counting the person who made it
/// (SPEC §4.13, PROTOCOL §3.1).
///
/// A DM has no host and its members are fixed when it is made, so it stays a
/// conversation on the side: a group that wants to be bigger is a room, where
/// the host decides who is in it. The floor of two is what stops a DM with only
/// yourself in it, which is a text file wearing a conversation's clothes.
pub const MIN_DM_MEMBERS: usize = 2;
pub const MAX_DM_MEMBERS: usize = 8;
/// A report's note to the host, in characters (PROTOCOL §5).
pub const MAX_REPORT_NOTE_CHARS: usize = 1_000;

/// Search (SPEC §4.12, PROTOCOL §6).
///
/// A query longer than this is a paste, not a search, and every extra token is
/// another term the index has to intersect.
pub const MAX_SEARCH_QUERY_CHARS: usize = 200;
/// Terms beyond this are ignored rather than refused: a long query still
/// answers, it is simply the first few words that decide the answer.
pub const MAX_SEARCH_TERMS: usize = 12;
/// How much of a message a hit shows, in words. A result list is scanned, not
/// read — a snippet long enough to need reading is the room's job.
pub const SEARCH_SNIPPET_TOKENS: u32 = 16;
/// Ceiling on `GET /search?limit=` (PROTOCOL §6).
pub const MAX_SEARCH_PAGE: u32 = 50;

/// Access tokens are short-lived JWTs; refresh tokens rotate (ARCHITECTURE §7).
pub const ACCESS_TOKEN_TTL_SECS: u64 = 15 * 60;
pub const REFRESH_TOKEN_TTL_DAYS: i64 = 30;

/// Identity fields (PROTOCOL §2).
pub const USERNAME_PATTERN: &str = "^[a-z0-9_]{2,24}$";
pub const ROOM_SLUG_PATTERN: &str = "^[a-z0-9-]{1,32}$";
pub const MAX_DISPLAY_NAME_CHARS: usize = 32;
/// Accent marks (the combining diacritics every script shares, U+0300–U+036F
/// and its kin) one letter of a display name may carry (#296). Two covers
/// every language that writes them decomposed, Vietnamese included; a third
/// is where "zalgo" text starts, the kind that paints over the lines around it.
pub const MAX_ACCENT_MARKS_PER_LETTER: usize = 2;
/// Combining marks of any kind (Unicode categories Mn and Me) one letter of a
/// display name may carry (#296). Higher than the accent cap because some
/// scripts write a letter with three or four marks on it (Tibetan's stacked
/// consonants, Hebrew with its points); four is the ceiling Unicode's own
/// security guidance suggests (UTS #39 §5.4).
pub const MAX_MARKS_PER_LETTER: usize = 4;
/// Minimum only. No composition rules, no expiry (PROTOCOL §2). The client
/// keeps the password in the OS keyring, so a long floor is friction on every
/// fresh install rather than security anybody gets.
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const INVITE_CODE_CHARS: usize = 12;

/// A client's answer to the forwarding server's offer (SPEC §4.14, PROTOCOL
/// §8). The answer carries a few hundred bytes for every other person in the
/// room, so a room of 60 answers in tens of kilobytes; 16 KB, enough for 25,
/// would have dropped the answers of the last people into a raid (#197).
pub const MAX_VOICE_PAYLOAD_BYTES: usize = 128 * 1024;

/// How many people can be in one voice room (#197): a 40-person raid and the
/// people around it. Each person sends once, only while talking (silence isn't
/// sent), and hears everybody else through the server.
pub const MAX_VOICE_PEERS: usize = 60;

/// Gateway (PROTOCOL §8).
pub const HEARTBEAT_INTERVAL_MS: u64 = 30_000;
pub const RESUME_BUFFER_FRAMES: usize = 500;
pub const RESUME_WINDOW_MS: u64 = 120_000;

/// Rate limits (ARCHITECTURE §7). Format: (events, per_seconds).
/// A server's own emoji (SPEC §4.8, #359): pictures the host or a co-host adds
/// for everybody on it, written `:name:` in a message.
pub const MAX_CUSTOM_EMOJI: usize = 200;
/// A custom emoji's name, between the colons: `[a-z0-9_]`, this long.
pub const EMOJI_NAME_MIN_CHARS: usize = 2;
pub const EMOJI_NAME_MAX_CHARS: usize = 32;
/// A custom emoji's picture: PNG, GIF (animated or not), WebP or JPEG, at
/// most this big and this wide or tall. The app shrinks a still picture to
/// emoji size before it uploads, so a host never has to.
pub const MAX_EMOJI_BYTES: u64 = 256 * 1024;
pub const MAX_EMOJI_EDGE: u32 = 512;
pub const EMOJI_MIMES: [&str; 4] = ["image/png", "image/gif", "image/webp", "image/jpeg"];

/// Whether `name` is a custom emoji's name: lowercase letters, digits and
/// underscores, [`EMOJI_NAME_MIN_CHARS`] to [`EMOJI_NAME_MAX_CHARS`] long.
/// The server holds every name to it; the app shapes a picture's file name
/// into one so the host rarely has to type.
#[must_use]
pub fn emoji_name_ok(name: &str) -> bool {
    (EMOJI_NAME_MIN_CHARS..=EMOJI_NAME_MAX_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The most different reactions one message holds (SPEC §4.8, #485). Past
/// it, anybody can still add theirs to one that's there.
pub const MAX_REACTIONS_PER_MESSAGE: usize = 6;
/// A reaction is the emoji itself, or this and the id of one of the server's
/// own emoji (`emoji:<32 hex>`): by id, so renaming it keeps its reactions
/// and removing it takes them.
pub const CUSTOM_REACTION_PREFIX: &str = "emoji:";

pub const RATE_LOGIN_PER_IP: (u32, u64) = (5, 60);
/// Sign-ups from one address (#495): sixty at once, then one a minute. A
/// raid's worth of friends on one connection can join in one go, and so can
/// `examples/voice_load.rs`, which signs up 49 from one machine. A script
/// that keeps going is held to one a minute. The invite is checked before
/// the password is hashed, so an attempt without a good invite costs one
/// read; this bounds what somebody holding a good one can make the server do.
pub const RATE_REGISTER_PER_IP: (u32, u64) = (60, 3_600);
pub const RATE_MESSAGE_SEND: (u32, u64) = (10, 10);
pub const RATE_UPLOAD_SLOTS: (u32, u64) = (20, 3_600);
pub const RATE_INVITE_CREATE: (u32, u64) = (10, 86_400);
pub const RATE_KNOCK_PER_TARGET: (u32, u64) = (3, 3_600);
/// Reports one person may send in an hour (PROTOCOL §5, "Report and block"):
/// plenty for a real problem, and not a way to bury the host.
pub const RATE_REPORT_PER_HOUR: (u32, u64) = (10, 3_600);
pub const RATE_EXPORT: (u32, u64) = (1, 3_600);
/// Full-text search is cheap per query and not free, and it is the one endpoint
/// a client can fire on every keystroke. Thirty a minute leaves room for
/// search-as-you-type without leaving the index open to a loop.
pub const RATE_SEARCH: (u32, u64) = (30, 60);
/// Link previews are cached server-side, so this only bounds the misses.
pub const RATE_LINK_PREVIEW: (u32, u64) = (60, 60);
pub const RATE_TYPING_PER_ROOM: (u32, u64) = (1, 4);
/// Voice answers and restarts, per session (PROTOCOL §8). Loose, because a
/// busy room re-offers everybody each time somebody comes or goes, and each
/// offer wants an answer; a limit tight enough to be interesting would break
/// an ordinary evening.
pub const RATE_VOICE_SIGNAL: (u32, u64) = (300, 10);
/// Votes per person (#474): plenty for changing your mind, too few to make a
/// room's every app redraw a poll many times a second.
pub const RATE_POLL_VOTE: (u32, u64) = (20, 10);
/// Read-marker updates are debounced client-side to once per 5s per room.
pub const READ_MARKER_DEBOUNCE_MS: u64 = 5_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_emoji_name_is_lowercase_letters_digits_and_underscores() {
        for good in [
            "ok",
            "party_parrot",
            "cat2",
            "a_b_c",
            &"x".repeat(EMOJI_NAME_MAX_CHARS),
        ] {
            assert!(emoji_name_ok(good), "{good}");
        }
        for bad in [
            "",
            "x",
            "Party",
            "party-parrot",
            "party parrot",
            ":ok:",
            "émoji",
            &"x".repeat(EMOJI_NAME_MAX_CHARS + 1),
        ] {
            assert!(!emoji_name_ok(bad), "{bad}");
        }
    }
}
