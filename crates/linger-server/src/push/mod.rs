//! Phone notifications (SPEC §4.15, PROTOCOL §5, #830): who a message or a
//! knock should wake, and handing each of their phones an encrypted
//! notification through the relay.
//!
//! A closed phone app can only be woken by Apple's or Google's push service,
//! and only with keys from Linger's own Apple and Google accounts, which
//! can't be handed to every host. So one relay holds them (`relay/`, #887),
//! and this server never talks to Apple or Google itself. It sends the relay
//! two things: the phone's push address, sealed by the relay so the host
//! never sees the real one, and the notification, encrypted to a key only
//! the phone holds (`crypto`). The relay, Apple and Google learn that a
//! phone got something, and when, and nothing else.
//!
//! **Who** is the desktop's own list of reasons (`client/src/lib/notify-rules.ts`)
//! plus the phone's switches: somebody names you; somebody writes in a DM
//! you're in; somebody you follow posts; a room you chose wakes up, or says
//! anything. Never your own message, never a room you can't see, never
//! across a block either way, and never while you're using Linger somewhere
//! else: the desktop says it there, and the phone would only buzz twice.
//! Quiet lines, polls, reactions and a new message of the day call nobody,
//! here as on desktop: none of them comes through `message_posted`.
//!
//! **When** is after the message is saved and told to everybody connected.
//! The sending happens in a task of its own, so posting never waits on the
//! relay, and a relay that's down or slow costs a notification, never a
//! message.

pub mod crypto;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use linger_core::limits::{
    PUSH_EVERY_QUIET_MS, PUSH_EXCERPT_CHARS, PUSH_KEEP_SECS, PUSH_KNOCK_KEEP_SECS,
    PUSH_WAKE_AFTER_MS,
};
use linger_core::wire::{Attachment, Message, PushKind, PushPayload, PushRoomChoice, RelaySend};
use linger_core::{RoomId, UserId};
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, Semaphore};

use crate::db::now_ms;
use crate::error::ApiError;
use crate::repo::push::Candidate;
use crate::state::AppState;
use crate::{markdown, repo};

/// How long one hand-off to the relay may take. A notification that hasn't
/// gone by then is stale, and a hung relay mustn't hold sends forever.
const RELAY_TIMEOUT: Duration = Duration::from_secs(10);

/// How many hand-offs to the relay run at once, server-wide. A burst of
/// messages in a big room queues here rather than opening a connection per
/// phone at once.
const RELAY_AT_ONCE: usize = 8;

/// What sends notifications, when the host hasn't turned them off. Lives in
/// `AppState` as `Option<Arc<Pusher>>`: `None` is `LINGER_PUSH=off`, and then
/// nothing in this module runs at all.
pub struct Pusher {
    client: reqwest::Client,
    send_url: reqwest::Url,
    turns: Semaphore,
    in_flight: InFlight,
    /// Notifications waiting for one of the `turns`.
    queued: AtomicUsize,
}

impl Pusher {
    /// A sender for the relay at `relay` (`Config::push_relay`).
    pub fn new(relay: &reqwest::Url) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(RELAY_TIMEOUT)
            // The relay answers where it is; a redirect would send the
            // sealed address somewhere the host never named.
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        // `/send` after the relay's own path, through the URL's own parts
        // (#890): the setting has no query or fragment for it to land in.
        let mut send_url = relay.clone();
        send_url
            .path_segments_mut()
            .map_err(|()| anyhow::anyhow!("the relay's address can't take a path"))?
            .pop_if_empty()
            .push("send");
        Ok(Self {
            client,
            send_url,
            turns: Semaphore::new(RELAY_AT_ONCE),
            in_flight: InFlight::default(),
            queued: AtomicUsize::new(0),
        })
    }

    /// How many notifications are waiting for a turn to reach the relay.
    /// Tests ask it, to change something while one waits.
    pub fn queued(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }

    /// Wait for a turn at the relay, counted in [`Pusher::queued`] while
    /// waiting, however the wait ends.
    async fn turn(&self) -> Option<tokio::sync::SemaphorePermit<'_>> {
        struct Waiting<'a>(&'a AtomicUsize);
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        self.queued.fetch_add(1, Ordering::AcqRel);
        let _waiting = Waiting(&self.queued);
        self.turns.acquire().await.ok()
    }

    /// Wait until every notification already started has been sent, or
    /// given up on. Tests ask it, so that "nothing was sent" is a fact
    /// rather than a guess about how long to wait.
    pub async fn settled(&self) {
        loop {
            let done = self.in_flight.done.notified();
            tokio::pin!(done);
            done.as_mut().enable();
            if self.in_flight.count.load(Ordering::Acquire) == 0 {
                return;
            }
            done.await;
        }
    }
}

/// Notifications started and not yet finished.
#[derive(Default)]
struct InFlight {
    count: AtomicUsize,
    done: Notify,
}

/// One notification's place in [`InFlight`], given back when it's dropped.
struct Turn(Arc<Pusher>);

impl Turn {
    fn take(pusher: &Arc<Pusher>) -> Self {
        pusher.in_flight.count.fetch_add(1, Ordering::AcqRel);
        Self(pusher.clone())
    }
}

impl Drop for Turn {
    fn drop(&mut self) {
        if self.0.in_flight.count.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.in_flight.done.notify_waiters();
        }
    }
}

/// A message was posted (`routes::messages`): tell the phones it should
/// wake. Returns at once; the work runs in a task of its own.
pub fn message_posted(state: &AppState, message: &Message) {
    let Some(pusher) = state.push.clone() else {
        return;
    };
    let turn = Turn::take(&pusher);
    let state = state.clone();
    let message = message.clone();
    tokio::spawn(async move {
        let _turn = turn;
        // Everything for one message, waits included, within
        // `push_within` (#890): a slow relay costs notifications, never a
        // pile of them arriving late.
        let within = state.config.push_within;
        match tokio::time::timeout(within, for_message(&state, &pusher, &message)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(error = %error.message, "couldn't work out phone notifications for a message");
            }
            Err(_) => tracing::debug!(
                "a message's phone notifications took too long, and the rest were dropped"
            ),
        }
    });
}

/// Somebody knocked (`routes::knock`): tell the phones of the person knocked
/// on, if they hear knocks. Returns at once.
pub fn knocked(state: &AppState, from: UserId, to: UserId) {
    let Some(pusher) = state.push.clone() else {
        return;
    };
    let turn = Turn::take(&pusher);
    let state = state.clone();
    tokio::spawn(async move {
        let _turn = turn;
        let within = state.config.push_within;
        match tokio::time::timeout(within, for_knock(&state, &pusher, from, to)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::warn!(error = %error.message, "couldn't work out phone notifications for a knock");
            }
            Err(_) => {
                tracing::debug!("a knock's phone notifications took too long, and were dropped")
            }
        }
    });
}

/// The one switch that lets this message through to this phone, or `None`.
///
/// The order only picks the label: a mention is a mention even in a DM, so a
/// phone with DMs off and mentions on still hears its name.
pub(crate) fn reason(
    phone: &Candidate,
    mentioned: &[String],
    dm: bool,
    wakes: bool,
) -> Option<PushKind> {
    if phone.mentions && mentioned.contains(&phone.username) {
        return Some(PushKind::Mention);
    }
    if dm && phone.dms {
        return Some(PushKind::Dm);
    }
    if phone.follows && phone.follows_author {
        return Some(PushKind::Follow);
    }
    match (dm, phone.room) {
        (false, Some(PushRoomChoice::Every)) => Some(PushKind::Room),
        (false, Some(PushRoomChoice::Wakes)) if wakes => Some(PushKind::Room),
        _ => None,
    }
}

async fn for_message(state: &AppState, pusher: &Pusher, message: &Message) -> Result<(), ApiError> {
    // Belt and braces: nothing but an ordinary new message comes through
    // here, and these call nobody (`client/src/lib/quietLines.ts`).
    if message.deleted_at.is_some()
        || message.poll.is_some()
        || message.motd == Some(true)
        || message.voice_join == Some(true)
        || message.poll_closed.is_some()
        || message.left == Some(true)
        || message.screen_share == Some(true)
    {
        return Ok(());
    }
    let now = now_ms();
    let Some((slug, dm)) = room(state, message.room_id).await? else {
        return Ok(());
    };
    let phones =
        repo::push::for_message(&state.db.read, message.author_id, message.room_id, dm, now)
            .await?;
    if phones.is_empty() {
        return Ok(());
    }

    let mentioned = markdown::mentions(&message.body);
    let wakes = !dm
        && repo::push::previous_at(&state.db.read, message.room_id, message.id)
            .await?
            .is_none_or(|before| message.created_at - before >= PUSH_WAKE_AFTER_MS);
    let name = display_name(state, message.author_id).await?;
    let title = if dm {
        name
    } else {
        format!("{name} in #{slug}")
    };
    let body = excerpt(&words(message));

    for phone in phones {
        if state.gateway.attending(phone.user_id) {
            continue;
        }
        let Some(kind) = reason(&phone, &mentioned, dm, wakes) else {
            continue;
        };
        // "Every message" is once a burst: take the room's turn, or stay
        // quiet. A wake-up on such a phone takes the turn too.
        if kind == PushKind::Room
            && phone.room == Some(PushRoomChoice::Every)
            && !repo::push::claim_every(
                &state.db.write,
                phone.id,
                phone.user_id,
                message.room_id,
                message.id,
                now,
                PUSH_EVERY_QUIET_MS,
            )
            .await?
        {
            continue;
        }
        let payload = PushPayload {
            v: 1,
            kind,
            title: title.clone(),
            body: body.clone(),
            user_id: message.author_id,
            room_id: Some(message.room_id),
            message_id: Some(message.id),
        };
        let collapse = (kind == PushKind::Room).then(|| collapse_key(&phone, message.room_id));
        send(state, pusher, &phone, &payload, PUSH_KEEP_SECS, collapse).await;
    }
    Ok(())
}

async fn for_knock(
    state: &AppState,
    pusher: &Pusher,
    from: UserId,
    to: UserId,
) -> Result<(), ApiError> {
    if state.gateway.attending(to) {
        return Ok(());
    }
    let phones = repo::push::for_knock(&state.db.read, from, to, now_ms()).await?;
    if phones.is_empty() {
        return Ok(());
    }
    let name = display_name(state, from).await?;
    let payload = PushPayload {
        v: 1,
        kind: PushKind::Knock,
        // The card a desktop shows (SPEC §4.9): "Sam knocked. Just saying hi."
        title: format!("{name} knocked"),
        body: "Just saying hi.".to_string(),
        user_id: from,
        room_id: None,
        message_id: None,
    };
    for phone in phones {
        // A person's next knock replaces their last, on every phone: an
        // iPhone only replaces what Apple is told to, and Android's app
        // already did it itself (`LingerMessagingService`).
        let collapse = Some(knock_collapse_key(&phone, from));
        send(
            state,
            pusher,
            &phone,
            &payload,
            PUSH_KNOCK_KEEP_SECS,
            collapse,
        )
        .await;
    }
    Ok(())
}

/// A room's slug, and whether it's a DM.
async fn room(state: &AppState, room_id: RoomId) -> Result<Option<(String, bool)>, ApiError> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT slug, kind FROM rooms WHERE id = ?")
        .bind(room_id.to_vec())
        .fetch_optional(&state.db.read)
        .await?;
    Ok(row.map(|(slug, kind)| (slug, kind == "dm")))
}

async fn display_name(state: &AppState, user_id: UserId) -> Result<String, ApiError> {
    let name: Option<String> = sqlx::query_scalar("SELECT display_name FROM users WHERE id = ?")
        .bind(user_id.to_vec())
        .fetch_optional(&state.db.read)
        .await?;
    Ok(name.unwrap_or_else(|| "Somebody".to_string()))
}

/// What a message says, as words: its body with the formatting off, or,
/// for files sent with no words, what was sent.
fn words(message: &Message) -> String {
    let text = markdown::plain_text(&message.body);
    if !text.is_empty() || message.attachments.is_empty() {
        return text;
    }
    files(&message.attachments).to_string()
}

/// Files sent with no words, said without counting them.
fn files(attachments: &[Attachment]) -> &'static str {
    let all = |prefix: &str| attachments.iter().all(|file| file.mime.starts_with(prefix));
    match (attachments.len(), all("image/"), all("video/")) {
        (1, true, _) => "Sent a photo",
        (1, _, true) => "Sent a video",
        (1, _, _) => "Sent a file",
        (_, true, _) => "Sent photos",
        (_, _, true) => "Sent videos",
        _ => "Sent files",
    }
}

/// The start of the words, the way a desktop banner trims them
/// (`notificationText`): [`PUSH_EXCERPT_CHARS`], then an ellipsis.
fn excerpt(text: &str) -> String {
    if text.chars().count() <= PUSH_EXCERPT_CHARS {
        return text.to_string();
    }
    let cut: String = text.chars().take(PUSH_EXCERPT_CHARS).collect();
    format!("{}…", cut.trim_end())
}

/// The same for every notification from one room to one phone, and
/// different for every other phone and room: it says nothing about which
/// room it is to anybody without the phone's secret.
fn collapse_key(phone: &Candidate, room_id: RoomId) -> String {
    let mut hash = Sha256::new();
    hash.update(phone.auth_secret);
    hash.update(room_id.to_vec());
    hex::encode(&hash.finalize()[..16])
}

/// The same for every knock from one person to one phone, so the next
/// replaces the last, as a room's do with `collapse_key`. `knock` in front
/// keeps it apart from every room's, whatever the ids, and like those it
/// says nothing about who knocked to anybody without the phone's secret.
fn knock_collapse_key(phone: &Candidate, from: UserId) -> String {
    let mut hash = Sha256::new();
    hash.update(phone.auth_secret);
    hash.update(b"knock");
    hash.update(from.to_vec());
    hex::encode(&hash.finalize()[..16])
}

/// Encrypt one notification to one phone and hand it to the relay. Nothing
/// here is retried: a notification late enough to need a retry is one
/// nobody wants. A phone the relay says is gone is forgotten.
async fn send(
    state: &AppState,
    pusher: &Pusher,
    phone: &Candidate,
    payload: &PushPayload,
    ttl: u32,
    collapse: Option<String>,
) {
    let Some(_turn) = pusher.turn().await else {
        return;
    };
    // Everything that let it through, asked again now that it's its turn
    // (#890): its owner may have signed out, turned the switch off, blocked
    // somebody or opened Linger elsewhere while it waited.
    if state.gateway.attending(phone.user_id) {
        return;
    }
    let still = repo::push::Still {
        id: phone.id,
        sealed_token: &phone.sealed_token,
        public_key: &phone.public_key,
        switch: switch(payload.kind),
        room_id: payload.room_id,
        from: payload.user_id,
    };
    match repo::push::still_wanted(&state.db.read, &still, now_ms()).await {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            tracing::warn!(error = %error.message, "couldn't check a notification was still wanted");
            return;
        }
    }

    let Ok(words) = serde_json::to_vec(payload) else {
        return;
    };
    let sealed = match crypto::encrypt(&phone.public_key, &phone.auth_secret, &words) {
        Ok(sealed) => sealed,
        Err(error) => {
            tracing::warn!(%error, "couldn't encrypt a notification to a phone");
            return;
        }
    };
    let body = RelaySend {
        token: phone.sealed_token.clone(),
        payload: URL_SAFE_NO_PAD.encode(sealed),
        ttl,
        collapse,
    };
    match pusher
        .client
        .post(pusher.send_url.clone())
        .json(&body)
        .send()
        .await
    {
        Ok(answer) if answer.status().is_success() => {}
        Ok(answer) if matches!(answer.status(), StatusCode::NOT_FOUND | StatusCode::GONE) => {
            if let Err(error) =
                repo::push::forget(&state.db.write, phone.id, &phone.sealed_token).await
            {
                tracing::warn!(error = %error.message, "couldn't forget a phone the relay says is gone");
            }
        }
        // What went wrong, never what was sent or to whom.
        Ok(answer) => {
            tracing::debug!(status = %answer.status(), "the relay didn't take a notification")
        }
        Err(error) => tracing::debug!(error = %error.without_url(), "couldn't reach the relay"),
    }
}

/// The switch on a phone that lets a kind through, as `push_devices` names
/// it; a room's is its row in `push_rooms`.
fn switch(kind: PushKind) -> &'static str {
    match kind {
        PushKind::Mention => "mentions",
        PushKind::Dm => "dms",
        PushKind::Knock => "knocks",
        PushKind::Follow => "follows",
        PushKind::Room => "room",
    }
}

#[cfg(test)]
mod tests {
    use linger_core::PushDeviceId;

    use super::*;

    fn phone() -> Candidate {
        Candidate {
            id: PushDeviceId::new(),
            user_id: UserId::new(),
            username: "jo".to_string(),
            sealed_token: String::new(),
            public_key: Vec::new(),
            auth_secret: [0; 16],
            mentions: true,
            dms: true,
            follows: true,
            follows_author: false,
            room: None,
        }
    }

    #[test]
    fn each_switch_lets_through_its_own_kind_and_nothing_else() {
        let named = vec!["jo".to_string()];
        let nobody: Vec<String> = Vec::new();
        let all = phone();
        assert_eq!(reason(&all, &named, false, false), Some(PushKind::Mention));
        assert_eq!(reason(&all, &nobody, true, false), Some(PushKind::Dm));
        assert_eq!(
            reason(&all, &nobody, false, true),
            None,
            "rooms are off unless chosen"
        );

        // Only mentions: a DM that doesn't name you is quiet, one that does isn't.
        let only = Candidate {
            dms: false,
            follows: false,
            follows_author: true,
            ..phone()
        };
        assert_eq!(reason(&only, &nobody, true, false), None);
        assert_eq!(reason(&only, &named, true, false), Some(PushKind::Mention));
        assert_eq!(reason(&only, &nobody, false, false), None);

        let following = Candidate {
            follows_author: true,
            ..phone()
        };
        assert_eq!(
            reason(&following, &nobody, false, false),
            Some(PushKind::Follow)
        );
        let not_following = Candidate {
            follows: false,
            follows_author: true,
            ..phone()
        };
        assert_eq!(reason(&not_following, &nobody, false, false), None);

        // Somebody else's name is nobody's business on this phone.
        assert_eq!(reason(&all, &["joe".to_string()], false, false), None);
    }

    #[test]
    fn a_room_wakes_a_phone_only_as_chosen() {
        let nobody: Vec<String> = Vec::new();
        let wakes = Candidate {
            room: Some(PushRoomChoice::Wakes),
            ..phone()
        };
        assert_eq!(reason(&wakes, &nobody, false, true), Some(PushKind::Room));
        assert_eq!(reason(&wakes, &nobody, false, false), None);
        let every = Candidate {
            room: Some(PushRoomChoice::Every),
            ..phone()
        };
        assert_eq!(reason(&every, &nobody, false, false), Some(PushKind::Room));
        // A DM is `dms`, whatever a room setting says.
        let quiet_dms = Candidate {
            dms: false,
            ..every
        };
        assert_eq!(reason(&quiet_dms, &nobody, true, true), None);
    }

    #[test]
    fn the_words_trail_off_where_a_banner_s_do() {
        assert_eq!(excerpt("short"), "short");
        // Cut at 140 characters, and the space the cut leaves goes too.
        let long = format!("{} tail", "a".repeat(PUSH_EXCERPT_CHARS - 1));
        assert_eq!(
            excerpt(&long),
            format!("{}…", "a".repeat(PUSH_EXCERPT_CHARS - 1))
        );
        let exact = "a".repeat(PUSH_EXCERPT_CHARS);
        assert_eq!(excerpt(&exact), exact);
    }

    #[test]
    fn files_are_said_without_a_number() {
        let file = |mime: &str| Attachment {
            id: linger_core::AttachmentId::new(),
            filename: "f".into(),
            mime: mime.into(),
            size_bytes: 1,
            url: String::new(),
            width: None,
            height: None,
            duration_ms: None,
            blurhash: None,
            poster_url: None,
            display_url: None,
            starred_at: None,
            uploader_id: UserId::new(),
            created_at: 0,
        };
        assert_eq!(files(&[file("image/png")]), "Sent a photo");
        assert_eq!(
            files(&[file("image/png"), file("image/jpeg")]),
            "Sent photos"
        );
        assert_eq!(files(&[file("video/mp4")]), "Sent a video");
        assert_eq!(files(&[file("application/pdf")]), "Sent a file");
        assert_eq!(files(&[file("image/png"), file("video/mp4")]), "Sent files");
    }

    /// After the relay's own path, never inside a query or after a slash it
    /// already has (#890).
    #[test]
    fn send_goes_after_the_relay_s_own_path() {
        for (relay, send) in [
            ("https://push.linger.im", "https://push.linger.im/send"),
            (
                "https://relay.example/push",
                "https://relay.example/push/send",
            ),
            (
                "https://relay.example/push/",
                "https://relay.example/push/send",
            ),
        ] {
            let pusher = Pusher::new(&relay.parse().unwrap()).unwrap();
            assert_eq!(pusher.send_url.as_str(), send);
        }
    }

    #[test]
    fn a_collapse_key_differs_by_phone_and_by_room() {
        let one = phone();
        let other = Candidate {
            auth_secret: [1; 16],
            ..phone()
        };
        let room = RoomId::new();
        assert_eq!(collapse_key(&one, room), collapse_key(&one, room));
        assert_ne!(collapse_key(&one, room), collapse_key(&other, room));
        assert_ne!(collapse_key(&one, room), collapse_key(&one, RoomId::new()));
        assert!(!collapse_key(&one, room).contains(&hex::encode(room.to_vec())));
    }

    #[test]
    fn a_knock_s_collapse_key_differs_by_phone_and_by_person_and_from_any_room_s() {
        let one = phone();
        let other = Candidate {
            auth_secret: [1; 16],
            ..phone()
        };
        let sam = UserId::new();
        assert_eq!(knock_collapse_key(&one, sam), knock_collapse_key(&one, sam));
        assert_ne!(
            knock_collapse_key(&one, sam),
            knock_collapse_key(&other, sam)
        );
        assert_ne!(
            knock_collapse_key(&one, sam),
            knock_collapse_key(&one, UserId::new())
        );
        assert!(!knock_collapse_key(&one, sam).contains(&hex::encode(sam.to_vec())));
        // The same sixteen bytes as a room's id still make another key.
        let room = RoomId::from_slice(sam.as_bytes()).unwrap();
        assert_ne!(knock_collapse_key(&one, sam), collapse_key(&one, room));
    }
}
