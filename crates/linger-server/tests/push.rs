//! Phone notifications (SPEC §4.15, PROTOCOL §5, #830, #886) over real HTTP,
//! against a fake relay that keeps what it's handed.
//!
//! The audience is the thing to get right, the way it is for a knock: a
//! notification on the wrong phone is somebody's words on a stranger's lock
//! screen, and one too many is the buzzing this app exists to avoid. So most
//! tests here are "this phone got exactly this, and no other phone got
//! anything". Each notification is decrypted the way a phone does, so what
//! is checked is what the phone would show.
//!
//! Sending happens in the background (`push::message_posted`). Every check
//! waits for `Pusher::settled` first, so "nothing was sent" means nothing,
//! not "nothing yet".

mod common;

use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::post as on_post;
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use linger_core::wire::{
    AuthResponse, Message, PushDevice, PushKind, PushPayload, RelaySend, Room, ServerInfo,
};
use linger_core::{RoomId, UserId};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde_json::{json, Value};
use sha2::Sha256;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ---------------------------------------------------------------------------
// A relay that keeps what it's handed
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Relay {
    sent: Arc<Mutex<Vec<RelaySend>>>,
    /// Sealed addresses the relay says are gone (410).
    gone: Arc<Mutex<Vec<String>>>,
    /// Answer everything with a 500, as a relay with a problem of its own.
    broken: Arc<std::sync::atomic::AtomicBool>,
    /// Never answer, as a relay that has hung.
    hung: Arc<std::sync::atomic::AtomicBool>,
}

impl Relay {
    async fn start() -> (Self, reqwest::Url) {
        let relay = Self::default();
        let app = Router::new()
            .route("/send", on_post(take))
            .with_state(relay.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (relay, format!("http://{address}").parse().unwrap())
    }

    /// Everything handed over since the last look.
    fn take_sent(&self) -> Vec<RelaySend> {
        std::mem::take(&mut *self.sent.lock().unwrap())
    }
}

async fn take(State(relay): State<Relay>, Json(send): Json<RelaySend>) -> StatusCode {
    if relay.hung.load(std::sync::atomic::Ordering::SeqCst) {
        std::future::pending::<()>().await;
    }
    let gone = relay.gone.lock().unwrap().contains(&send.token);
    relay.sent.lock().unwrap().push(send);
    if relay.broken.load(std::sync::atomic::Ordering::SeqCst) {
        StatusCode::INTERNAL_SERVER_ERROR
    } else if gone {
        StatusCode::GONE
    } else {
        StatusCode::CREATED
    }
}

// ---------------------------------------------------------------------------
// A phone
// ---------------------------------------------------------------------------

struct Phone {
    auth: AuthResponse,
    key: SecretKey,
    secret: [u8; 16],
    sealed: String,
    id: String,
}

impl Phone {
    /// Open a notification the way the phone does (RFC 8291), or `None` when
    /// it isn't for this phone.
    fn open(&self, send: &RelaySend) -> Option<PushPayload> {
        if send.token != self.sealed {
            return None;
        }
        let message = URL_SAFE_NO_PAD.decode(&send.payload).ok()?;
        let salt = &message[..16];
        let id_len = message[20] as usize;
        let server_key = &message[21..21 + id_len];
        let ua_public = self.key.public_key().to_encoded_point(false);
        let shared = p256::ecdh::diffie_hellman(
            self.key.to_nonzero_scalar(),
            PublicKey::from_sec1_bytes(server_key).ok()?.as_affine(),
        );
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(ua_public.as_bytes());
        info.extend_from_slice(server_key);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&self.secret), shared.raw_secret_bytes())
            .expand(&info, &mut ikm)
            .ok()?;
        let content = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        content
            .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .ok()?;
        content
            .expand(b"Content-Encoding: nonce\0", &mut nonce)
            .ok()?;
        let mut record = Aes128Gcm::new_from_slice(&cek)
            .ok()?
            .decrypt(Nonce::from_slice(&nonce), &message[21 + id_len..])
            .ok()?;
        while record.last() == Some(&0) {
            record.pop();
        }
        assert_eq!(record.pop(), Some(0x02), "padding delimiter");
        serde_json::from_slice(&record).ok()
    }
}

fn defaults() -> Value {
    json!({ "mentions": true, "dms": true, "knocks": true, "follows": true, "rooms": [] })
}

fn register_body(
    auth: &AuthResponse,
    key: &SecretKey,
    secret: &[u8; 16],
    sealed: &str,
    settings: Value,
) -> Value {
    json!({
        "refresh_token": auth.refresh_token,
        "sealed_token": sealed,
        "public_key": URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes()),
        "auth_secret": URL_SAFE_NO_PAD.encode(secret),
        "settings": settings,
    })
}

async fn phone(server: &common::TestServer, auth: AuthResponse, settings: Value) -> Phone {
    let key = SecretKey::random(&mut rand::rngs::OsRng);
    let secret: [u8; 16] = rand::random();
    let sealed = format!("sealed-{}", auth.user.username);
    let resp = http()
        .post(server.url("/push/devices"))
        .bearer_auth(&auth.access_token)
        .json(&register_body(&auth, &key, &secret, &sealed, settings))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        200,
        "register: {}",
        resp.text().await.unwrap()
    );
    let device: PushDevice = resp.json().await.unwrap();
    Phone {
        auth,
        key,
        secret,
        sealed,
        id: device.id.to_string(),
    }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

fn http() -> reqwest::Client {
    reqwest::Client::new()
}

async fn server() -> (common::TestServer, Relay, AuthResponse, Room) {
    let (relay, url) = Relay::start().await;
    let (server, host, room) =
        common::server_with_room_tuned("garage", |config| config.push_relay = Some(url)).await;
    (server, relay, host, room)
}

/// Wait until every notification started so far has gone to the relay.
async fn settled(server: &common::TestServer) {
    server
        .state
        .push
        .as_ref()
        .expect("push is on")
        .settled()
        .await;
}

async fn post(server: &common::TestServer, token: &str, room: RoomId, body: &str) -> Message {
    let resp = http()
        .post(server.url(&format!("/rooms/{room}/messages")))
        .bearer_auth(token)
        .json(&json!({ "body": body }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "post: {}", resp.text().await.unwrap());
    let message = resp.json().await.unwrap();
    settled(server).await;
    message
}

async fn dm(server: &common::TestServer, token: &str, with: &[UserId]) -> Room {
    let resp = http()
        .post(server.url("/dms"))
        .bearer_auth(token)
        .json(&json!({ "user_ids": with }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "dm: {}", resp.text().await.unwrap());
    resp.json().await.unwrap()
}

/// What each phone got, opened: `(whose, payload)`.
fn opened(relay: &Relay, phones: &[&Phone]) -> Vec<(String, PushPayload)> {
    relay
        .take_sent()
        .iter()
        .map(|send| {
            phones
                .iter()
                .find_map(|phone| {
                    phone
                        .open(send)
                        .map(|payload| (phone.auth.user.username.clone(), payload))
                })
                .expect("every notification opens on the phone it was sealed for")
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_mention_reaches_the_phone_named_and_no_other() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    let sam = phone(
        &server,
        common::join_member(&server, &host.access_token, "sam").await,
        defaults(),
    )
    .await;

    let message = post(
        &server,
        &host.access_token,
        room.id,
        "**hey** @jo, you around `tonight`?",
    )
    .await;

    let got = opened(&relay, &[&jo, &sam]);
    assert_eq!(got.len(), 1, "one notification, to jo");
    let (whose, payload) = &got[0];
    assert_eq!(whose, "jo");
    assert_eq!(payload.v, 1);
    assert_eq!(payload.kind, PushKind::Mention);
    assert_eq!(payload.title, "Matt in #garage");
    assert_eq!(
        payload.body, "hey @jo, you around tonight?",
        "the words, formatting off"
    );
    assert_eq!(payload.user_id, host.user.id);
    assert_eq!(payload.room_id, Some(room.id));
    assert_eq!(payload.message_id, Some(message.id));
}

#[tokio::test]
async fn nobody_hears_their_own_words_or_a_handle_in_code() {
    let (server, relay, host, room) = server().await;
    let jo_auth = common::join_member(&server, &host.access_token, "jo").await;
    let jo = phone(&server, jo_auth.clone(), defaults()).await;

    post(
        &server,
        &jo.auth.access_token,
        room.id,
        "talking to myself, @jo",
    )
    .await;
    post(&server, &host.access_token, room.id, "the handle is `@jo`").await;
    post(&server, &host.access_token, room.id, "```\n@jo\n```").await;
    post(&server, &host.access_token, room.id, "mail jo@example.com").await;
    assert!(relay.take_sent().is_empty());
}

#[tokio::test]
async fn a_dm_reaches_its_people_and_nobody_outside_it() {
    let (server, relay, host, _room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    let sam = phone(
        &server,
        common::join_member(&server, &host.access_token, "sam").await,
        defaults(),
    )
    .await;
    let ours = dm(&server, &host.access_token, &[jo.auth.user.id]).await;

    // Naming sam in a DM sam isn't in reaches sam nowhere.
    post(
        &server,
        &host.access_token,
        ours.id,
        "dinner? don't tell @sam",
    )
    .await;

    let got = opened(&relay, &[&jo, &sam]);
    assert_eq!(got.len(), 1);
    let (whose, payload) = &got[0];
    assert_eq!(whose, "jo");
    assert_eq!(payload.kind, PushKind::Dm);
    assert_eq!(payload.title, "Matt", "a DM's title is who wrote");
    assert_eq!(payload.room_id, Some(ours.id));
}

#[tokio::test]
async fn only_mentions_lets_nothing_else_through() {
    let (server, relay, host, room) = server().await;
    let only =
        json!({ "mentions": true, "dms": false, "knocks": false, "follows": false, "rooms": [] });
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        only,
    )
    .await;
    let ours = dm(&server, &host.access_token, &[jo.auth.user.id]).await;
    follow(&server, &jo.auth, host.user.id, None).await;

    post(&server, &host.access_token, ours.id, "a DM").await;
    post(&server, &host.access_token, room.id, "somebody jo follows").await;
    knock(&server, &host.access_token, jo.auth.user.id).await;
    assert!(relay.take_sent().is_empty());

    post(&server, &host.access_token, ours.id, "now with @jo").await;
    let got = opened(&relay, &[&jo]);
    assert_eq!(got.len(), 1);
    assert_eq!(
        got[0].1.kind,
        PushKind::Mention,
        "a mention in a DM is still a mention"
    );
}

async fn follow(
    server: &common::TestServer,
    auth: &AuthResponse,
    target: UserId,
    room: Option<RoomId>,
) {
    let resp = http()
        .put(server.url("/me/notify-rules"))
        .bearer_auth(&auth.access_token)
        .json(&json!({ "target_user_id": target, "room_id": room }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "follow: {}",
        resp.text().await.unwrap()
    );
}

async fn knock(server: &common::TestServer, token: &str, target: UserId) {
    let resp = http()
        .post(server.url("/knock"))
        .bearer_auth(token)
        .json(&json!({ "target_user_id": target }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204, "knock: {}", resp.text().await.unwrap());
    settled(server).await;
}

#[tokio::test]
async fn somebody_you_follow_wakes_your_phone_where_you_asked() {
    let (server, relay, host, room) = server().await;
    let other: Room = http()
        .post(server.url("/rooms"))
        .bearer_auth(&host.access_token)
        .json(&json!({ "slug": "kitchen", "name": "#kitchen" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    follow(&server, &jo.auth, host.user.id, Some(room.id)).await;

    post(&server, &host.access_token, other.id, "elsewhere").await;
    assert!(relay.take_sent().is_empty(), "the rule names #garage only");

    post(&server, &host.access_token, room.id, "here").await;
    let got = opened(&relay, &[&jo]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1.kind, PushKind::Follow);
    assert_eq!(got[0].1.body, "here");
}

#[tokio::test]
async fn a_block_either_way_stops_it() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    let sam = phone(
        &server,
        common::join_member(&server, &host.access_token, "sam").await,
        defaults(),
    )
    .await;
    let block = |auth: &AuthResponse, who: UserId| {
        let token = auth.access_token.clone();
        let url = server.url(&format!("/me/blocks/{who}"));
        async move {
            let resp = http().put(url).bearer_auth(token).send().await.unwrap();
            assert!(resp.status().is_success());
        }
    };
    // jo blocked the host; the host blocked sam.
    block(&jo.auth, host.user.id).await;
    block(&host, sam.auth.user.id).await;

    post(&server, &host.access_token, room.id, "@jo @sam").await;
    knock(&server, &host.access_token, jo.auth.user.id).await;
    assert!(relay.take_sent().is_empty());
}

// ---------------------------------------------------------------------------
// Rooms: off, when it wakes up, every message
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_room_is_off_until_chosen_then_wakes_after_an_hour_of_quiet() {
    let (server, relay, host, room) = server().await;
    let wakes = json!({ "mentions": true, "dms": true, "knocks": true, "follows": true,
                        "rooms": [{ "room_id": room.id, "choice": "wakes" }] });
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        wakes,
    )
    .await;
    let sam = phone(
        &server,
        common::join_member(&server, &host.access_token, "sam").await,
        defaults(),
    )
    .await;

    // The room's first message is it waking up.
    post(&server, &host.access_token, room.id, "anyone?").await;
    let sent = relay.take_sent();
    assert_eq!(sent.len(), 1, "jo chose the room; sam didn't");
    assert!(sam.open(&sent[0]).is_none());
    let payload = jo.open(&sent[0]).expect("for jo");
    assert_eq!(payload.kind, PushKind::Room);
    assert_eq!(payload.title, "Matt in #garage");
    assert!(
        sent[0].collapse.is_some(),
        "a room's notification replaces the one before"
    );
    assert_eq!(sent[0].ttl, linger_core::limits::PUSH_KEEP_SECS);

    // The room is awake now.
    post(&server, &host.access_token, room.id, "hello?").await;
    assert!(relay.take_sent().is_empty());

    // An hour of quiet later, it wakes again.
    sqlx::query("UPDATE messages SET created_at = created_at - 3600001 WHERE room_id = ?")
        .bind(room.id.to_vec())
        .execute(&server.state.db.write)
        .await
        .unwrap();
    post(&server, &host.access_token, room.id, "morning").await;
    assert_eq!(opened(&relay, &[&jo]).len(), 1);
}

#[tokio::test]
async fn every_message_buzzes_once_a_burst_until_read_or_fifteen_minutes() {
    let (server, relay, host, room) = server().await;
    let every = json!({ "mentions": true, "dms": true, "knocks": true, "follows": true,
                        "rooms": [{ "room_id": room.id, "choice": "every" }] });
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        every,
    )
    .await;

    post(&server, &host.access_token, room.id, "one").await;
    let first = relay.take_sent();
    assert_eq!(first.len(), 1);
    let key = first[0]
        .collapse
        .clone()
        .expect("a room's notifications collapse");
    assert!(
        !key.contains(&room.id.to_string()),
        "the key doesn't say which room"
    );

    post(&server, &host.access_token, room.id, "two").await;
    post(&server, &host.access_token, room.id, "three").await;
    assert!(relay.take_sent().is_empty(), "quiet until it's read");

    // jo reads up to "three": the next one buzzes again, replacing the first.
    post(&server, &jo.auth.access_token, room.id, "reading along").await;
    let fourth = post(&server, &host.access_token, room.id, "four").await;
    let again = relay.take_sent();
    assert_eq!(again.len(), 1, "jo saying something read the room");
    assert_eq!(
        again[0].collapse.as_deref(),
        Some(key.as_str()),
        "same key, so it replaces"
    );
    assert_eq!(jo.open(&again[0]).unwrap().message_id, Some(fourth.id));

    post(&server, &host.access_token, room.id, "five").await;
    assert!(relay.take_sent().is_empty());

    // Fifteen minutes on, unread, it buzzes once more.
    sqlx::query("UPDATE push_rooms SET notified_at = notified_at - 900000")
        .execute(&server.state.db.write)
        .await
        .unwrap();
    post(&server, &host.access_token, room.id, "six").await;
    assert_eq!(relay.take_sent().len(), 1);

    // A mention in the quiet still comes through: it's addressed to jo.
    post(&server, &host.access_token, room.id, "@jo look").await;
    let mention = relay.take_sent();
    assert_eq!(mention.len(), 1);
    assert_eq!(jo.open(&mention[0]).unwrap().kind, PushKind::Mention);
    assert_eq!(
        mention[0].collapse, None,
        "a mention stacks rather than replacing"
    );
}

#[tokio::test]
async fn two_messages_at_once_take_every_message_s_turn_once() {
    let (server, relay, host, room) = server().await;
    let every = json!({ "mentions": true, "dms": true, "knocks": true, "follows": true,
                        "rooms": [{ "room_id": room.id, "choice": "every" }] });
    phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        every,
    )
    .await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;

    for _ in 0..5 {
        let (a, b) = tokio::join!(
            http()
                .post(server.url(&format!("/rooms/{}/messages", room.id)))
                .bearer_auth(&host.access_token)
                .json(&json!({ "body": "at once" }))
                .send(),
            http()
                .post(server.url(&format!("/rooms/{}/messages", room.id)))
                .bearer_auth(&sam.access_token)
                .json(&json!({ "body": "at once too" }))
                .send(),
        );
        assert_eq!(a.unwrap().status(), 200);
        assert_eq!(b.unwrap().status(), 200);
        settled(&server).await;
        assert_eq!(relay.take_sent().len(), 1, "one burst, one buzz");
        // Start the next round's quiet over.
        sqlx::query("UPDATE push_rooms SET notified_at = NULL")
            .execute(&server.state.db.write)
            .await
            .unwrap();
    }
}

// ---------------------------------------------------------------------------
// A relay that goes wrong
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_relay_with_a_problem_costs_the_notification_and_nothing_else() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    relay
        .broken
        .store(true, std::sync::atomic::Ordering::SeqCst);

    post(&server, &host.access_token, room.id, "@jo one").await;
    assert_eq!(relay.take_sent().len(), 1);
    // Not a "gone": the phone is kept, and the next one goes.
    relay
        .broken
        .store(false, std::sync::atomic::Ordering::SeqCst);
    post(&server, &host.access_token, room.id, "@jo two").await;
    let got = opened(&relay, &[&jo]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1.body, "@jo two");
}

#[tokio::test]
async fn a_relay_that_isn_t_there_or_never_answers_never_holds_up_a_message() {
    // Nothing listens on a port that was just let go.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap()
    };
    let (server, host, room) = common::server_with_room_tuned("garage", |config| {
        config.push_relay = Some(format!("http://{closed}").parse().unwrap());
    })
    .await;
    phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    post(&server, &host.access_token, room.id, "@jo nobody's home").await;

    // A relay that never answers: the message is posted and told at once.
    let (relay, _) = server_and_relay_hung().await;
    let (server, host, room) = relay;
    let started = std::time::Instant::now();
    let resp = http()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "@jo hello?" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "posting waited on the relay: {:?}",
        started.elapsed()
    );
}

/// A server whose relay hangs, with jo's phone registered on it.
async fn server_and_relay_hung() -> ((common::TestServer, AuthResponse, Room), Relay) {
    let (server, relay, host, room) = server().await;
    phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    relay.hung.store(true, std::sync::atomic::Ordering::SeqCst);
    ((server, host, room), relay)
}

// ---------------------------------------------------------------------------
// Never
// ---------------------------------------------------------------------------

#[tokio::test]
async fn polls_reactions_and_a_motd_never_notify() {
    let (server, relay, host, room) = server().await;
    let every = json!({ "mentions": true, "dms": true, "knocks": true, "follows": true,
                        "rooms": [{ "room_id": room.id, "choice": "every" }] });
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        every,
    )
    .await;
    follow(&server, &jo.auth, host.user.id, None).await;

    let resp = http()
        .post(server.url(&format!("/rooms/{}/polls", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "question": "pizza, @jo?", "choices": ["yes", "no"], "multi": false, "closes_in_days": 1 }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200, "poll: {}", resp.text().await.unwrap());
    let resp = http()
        .patch(server.url(&format!("/rooms/{}", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "motd": "be nice, @jo" }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "motd: {}",
        resp.text().await.unwrap()
    );
    settled(&server).await;
    assert!(
        relay.take_sent().is_empty(),
        "a poll and a MOTD call nobody"
    );

    let mine = post(&server, &jo.auth.access_token, room.id, "my message").await;
    let resp = http()
        .put(server.url(&format!("/messages/{}/reactions/%F0%9F%91%8D", mine.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "react: {}",
        resp.text().await.unwrap()
    );
    settled(&server).await;
    assert!(relay.take_sent().is_empty(), "a reaction calls nobody");
}

async fn connect(
    server: &common::TestServer,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (mut ws, _) = connect_async(server.gateway_url()).await.unwrap();
    ws.send(WsMessage::Text(
        json!({ "op": "identify", "d": { "token": token, "client": "test/0" } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
            .await
            .expect("a frame within 5s")
            .unwrap()
            .unwrap();
        if let WsMessage::Text(text) = frame {
            let value: Value = serde_json::from_str(text.as_str()).unwrap();
            if value["op"] == "ready" {
                return ws;
            }
        }
    }
}

#[tokio::test]
async fn somebody_using_linger_elsewhere_isn_t_buzzed_until_idle() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;

    let mut desk = connect(&server, &jo.auth.access_token).await;
    post(&server, &host.access_token, room.id, "@jo at your desk?").await;
    knock(&server, &host.access_token, jo.auth.user.id).await;
    assert!(
        relay.take_sent().is_empty(),
        "the desktop says it; the phone stays quiet"
    );

    // Idle at the desk: the phone hears it.
    desk.send(WsMessage::Text(
        json!({ "op": "presence.update", "d": { "state": "idle" } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    for _ in 0..100 {
        if !server.state.gateway.attending(jo.auth.user.id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    post(&server, &host.access_token, room.id, "@jo now?").await;
    assert_eq!(opened(&relay, &[&jo]).len(), 1);
}

#[tokio::test]
async fn a_knock_wakes_a_phone_that_hears_knocks() {
    let (server, relay, host, _room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    let no_knocks =
        json!({ "mentions": true, "dms": true, "knocks": false, "follows": true, "rooms": [] });
    let sam = phone(
        &server,
        common::join_member(&server, &host.access_token, "sam").await,
        no_knocks,
    )
    .await;

    knock(&server, &host.access_token, jo.auth.user.id).await;
    knock(&server, &host.access_token, sam.auth.user.id).await;

    let sent = relay.take_sent();
    assert_eq!(sent.len(), 1, "sam's phone doesn't hear knocks");
    let payload = jo.open(&sent[0]).expect("for jo");
    assert_eq!(payload.kind, PushKind::Knock);
    assert_eq!(payload.title, "Matt knocked");
    assert_eq!(payload.body, "Just saying hi.");
    assert_eq!(payload.room_id, None);
    assert_eq!(
        sent[0].ttl,
        linger_core::limits::PUSH_KNOCK_KEEP_SECS,
        "a knock goes stale fast"
    );
}

// ---------------------------------------------------------------------------
// A phone's life
// ---------------------------------------------------------------------------

#[tokio::test]
async fn signing_out_forgets_the_phone() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;

    let resp = http()
        .post(server.url("/auth/logout"))
        .json(&json!({ "refresh_token": jo.auth.refresh_token }))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_devices")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(left, 0, "its sealed address and keys are gone");

    post(&server, &host.access_token, room.id, "@jo?").await;
    assert!(relay.take_sent().is_empty());
}

#[tokio::test]
async fn a_new_password_forgets_every_phone() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    let resp = http()
        .patch(server.url("/me/password"))
        .bearer_auth(&jo.auth.access_token)
        .json(&json!({ "current_password": "a perfectly fine password", "new_password": "another perfectly fine one" }))
        .send()
        .await
        .unwrap();
    assert!(
        resp.status().is_success(),
        "password: {}",
        resp.text().await.unwrap()
    );
    post(&server, &host.access_token, room.id, "@jo?").await;
    assert!(relay.take_sent().is_empty());
}

#[tokio::test]
async fn a_phone_the_relay_says_is_gone_is_forgotten() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;
    relay.gone.lock().unwrap().push(jo.sealed.clone());

    post(&server, &host.access_token, room.id, "@jo?").await;
    assert_eq!(relay.take_sent().len(), 1);
    let resp = http()
        .get(server.url(&format!("/push/devices/{}", jo.id)))
        .bearer_auth(&jo.auth.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        404,
        "the phone registers again to hear anything"
    );

    post(&server, &host.access_token, room.id, "@jo??").await;
    assert!(relay.take_sent().is_empty());
}

#[tokio::test]
async fn a_phone_changes_what_it_hears_and_asking_again_keeps_its_id() {
    let (server, relay, host, room) = server().await;
    let jo = phone(
        &server,
        common::join_member(&server, &host.access_token, "jo").await,
        defaults(),
    )
    .await;

    let resp = http()
        .patch(server.url(&format!("/push/devices/{}", jo.id)))
        .bearer_auth(&jo.auth.access_token)
        .json(
            &json!({ "settings": { "mentions": false, "dms": true, "knocks": true, "follows": true,
                                     "rooms": [{ "room_id": room.id, "choice": "every" }] } }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let device: PushDevice = resp.json().await.unwrap();
    assert!(!device.settings.mentions);
    assert_eq!(device.settings.rooms.len(), 1);

    post(&server, &host.access_token, room.id, "hi").await;
    let got = opened(&relay, &[&jo]);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].1.kind, PushKind::Room);

    // Asking again from the same sign-in replaces it, same id.
    let key = SecretKey::random(&mut rand::rngs::OsRng);
    let again: PushDevice = http()
        .post(server.url("/push/devices"))
        .bearer_auth(&jo.auth.access_token)
        .json(&register_body(
            &jo.auth,
            &key,
            &[9; 16],
            "sealed-again",
            defaults(),
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again.id.to_string(), jo.id);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_devices")
        .fetch_one(&server.state.db.read)
        .await
        .unwrap();
    assert_eq!(count, 1);

    // "Nothing": gone, and gone again is the same answer.
    for _ in 0..2 {
        let resp = http()
            .delete(server.url(&format!("/push/devices/{}", jo.id)))
            .bearer_auth(&jo.auth.access_token)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
    }
}

#[tokio::test]
async fn what_a_phone_hands_over_is_checked() {
    let (server, _relay, host, room) = server().await;
    let jo = common::join_member(&server, &host.access_token, "jo").await;
    let sam = common::join_member(&server, &host.access_token, "sam").await;
    let key = SecretKey::random(&mut rand::rngs::OsRng);
    let ours = dm(&server, &host.access_token, &[jo.user.id]).await;
    let refused = |body: Value, token: String| {
        let url = server.url("/push/devices");
        async move {
            let resp = http()
                .post(url)
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(resp.status(), 422, "{body}");
        }
    };

    let mut bad_key = register_body(&jo, &key, &[1; 16], "sealed", defaults());
    bad_key["public_key"] = json!(URL_SAFE_NO_PAD.encode([4u8; 65]));
    refused(bad_key, jo.access_token.clone()).await;
    let mut bad_secret = register_body(&jo, &key, &[1; 16], "sealed", defaults());
    bad_secret["auth_secret"] = json!(URL_SAFE_NO_PAD.encode([1u8; 8]));
    refused(bad_secret, jo.access_token.clone()).await;
    refused(
        register_body(&jo, &key, &[1; 16], "has a space", defaults()),
        jo.access_token.clone(),
    )
    .await;
    // Somebody else's sign-in isn't yours to register.
    refused(
        register_body(&sam, &key, &[1; 16], "sealed", defaults()),
        jo.access_token.clone(),
    )
    .await;
    // A DM has no room setting: DMs are `dms`.
    let dm_room = json!({ "mentions": true, "dms": true, "knocks": true, "follows": true,
                          "rooms": [{ "room_id": ours.id, "choice": "every" }] });
    refused(
        register_body(&jo, &key, &[1; 16], "sealed", dm_room),
        jo.access_token.clone(),
    )
    .await;
    let twice = json!({ "mentions": true, "dms": true, "knocks": true, "follows": true,
                        "rooms": [{ "room_id": room.id, "choice": "every" }, { "room_id": room.id, "choice": "wakes" }] });
    refused(
        register_body(&jo, &key, &[1; 16], "sealed", twice),
        jo.access_token.clone(),
    )
    .await;

    // One person's phone is nobody else's to read or change.
    let jo_phone = phone(&server, jo.clone(), defaults()).await;
    let resp = http()
        .get(server.url(&format!("/push/devices/{}", jo_phone.id)))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let resp = http()
        .delete(server.url(&format!("/push/devices/{}", jo_phone.id)))
        .bearer_auth(&sam.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);
    let still: PushDevice = http()
        .get(server.url(&format!("/push/devices/{}", jo_phone.id)))
        .bearer_auth(&jo.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        still.id.to_string(),
        jo_phone.id,
        "sam's delete touched nothing of jo's"
    );
}

// ---------------------------------------------------------------------------
// The host's off switch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_server_says_whether_it_notifies_and_through_which_relay() {
    let (relay, url) = Relay::start().await;
    let (server, host, _room) =
        common::server_with_room_tuned("garage", |config| config.push_relay = Some(url.clone()))
            .await;
    let info: ServerInfo = http()
        .get(server.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info.push, Some(true));
    assert_eq!(
        info.push_relay.as_deref(),
        Some(url.as_str().trim_end_matches('/'))
    );
    drop(relay);
}

#[tokio::test]
async fn switched_off_nothing_reaches_the_relay_and_no_phone_is_kept() {
    let (relay, _url) = Relay::start().await;
    // The default test server is the host's `LINGER_PUSH=off`.
    let (server, host, room) = common::server_with_room("garage").await;
    let jo = common::join_member(&server, &host.access_token, "jo").await;

    let info: ServerInfo = http()
        .get(server.url("/server"))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info.push, Some(false));
    assert_eq!(info.push_relay, None);

    let key = SecretKey::random(&mut rand::rngs::OsRng);
    let resp = http()
        .post(server.url("/push/devices"))
        .bearer_auth(&jo.access_token)
        .json(&register_body(&jo, &key, &[1; 16], "sealed", defaults()))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 409, "the server takes no phone's details");

    // A row that got in some other way is never sent anything either.
    sqlx::query(
        "INSERT INTO push_devices (id, user_id, family_id, sealed_token, public_key, auth_secret,
                                   mentions, dms, knocks, follows, created_at, updated_at)
         SELECT randomblob(16), user_id, family_id, 'sealed', ?, zeroblob(16), 1, 1, 1, 1, 0, 0
         FROM refresh_tokens WHERE user_id = ? LIMIT 1",
    )
    .bind(key.public_key().to_encoded_point(false).as_bytes().to_vec())
    .bind(jo.user.id.to_vec())
    .execute(&server.state.db.write)
    .await
    .unwrap();
    let resp = http()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&json!({ "body": "@jo" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert!(server.state.push.is_none());
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(relay.take_sent().is_empty());
}
