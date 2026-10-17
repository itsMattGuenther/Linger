//! The WebSocket side of the gateway: handshake (hello → identify|resume →
//! ready|resumed), the reader loop, and heartbeat liveness.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use dashmap::mapref::entry::Entry;
use futures_util::{SinkExt, StreamExt};
use linger_core::gateway::{ClientFrame, ReadyData, ServerEvent, ServerFrame};
use linger_core::limits::{
    HEARTBEAT_INTERVAL_MS, MAX_VOICE_PAYLOAD_BYTES, RATE_PRESENCE, RATE_ROOM_FOCUS,
    RATE_TYPING_PER_ROOM, RATE_VOICE_SEAT, RATE_VOICE_SIGNAL,
};
use linger_core::UserId;
use tokio::sync::{mpsc, oneshot};

use super::{spawn_session, Ctl, HeldVoice, Merged, SessionHandle, VoiceJoined, WantedSeat};
use crate::db::now_ms;
use crate::state::AppState;
use crate::{auth, repo, validate};

/// How long the client has to send identify/resume after hello.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Reader liveness: 2.5× the heartbeat interval with no traffic ⇒ dead peer.
const LIVENESS_TIMEOUT: Duration = Duration::from_millis(HEARTBEAT_INTERVAL_MS * 5 / 2);

/// How much of the network the socket reads at a time. The library's default,
/// 128 KiB, is set aside for every connection, signed in or not, and every
/// frame an app sends but `voice.answer` is a few hundred bytes.
const READ_BUFFER_BYTES: usize = 4 * 1024;

/// The socket's limits are set here, before anybody has identified (#517), so
/// a connection that hasn't signed in can't make the server hold more than the
/// biggest frame an app really sends. A frame that says it is bigger than
/// `MAX_CLIENT_FRAME_BYTES` ends the connection as soon as its header is read,
/// and so does a message pieced together from smaller frames once it passes
/// the same size. The write side keeps the library's settings: it sets nothing
/// aside until there is something to send, and the writer task flushes each
/// frame as it goes.
pub async fn ws_route(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.read_buffer_size(READ_BUFFER_BYTES)
        .max_frame_size(linger_core::limits::MAX_CLIENT_FRAME_BYTES)
        .max_message_size(linger_core::limits::MAX_CLIENT_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn send_control(sink: &mpsc::Sender<String>, event: ServerEvent) {
    if let Ok(json) = serde_json::to_string(&ServerFrame::control(event)) {
        let _ = sink.send(json).await;
    }
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Writer task: everything outbound funnels through one queue so the
    // handler, the session task, and heartbeat acks can't interleave frames.
    let (sink, mut sink_rx) = mpsc::channel::<String>(256);
    let writer = tokio::spawn(async move {
        while let Some(json) = sink_rx.recv().await {
            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    send_control(
        &sink,
        ServerEvent::Hello {
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        },
    )
    .await;

    // The session task's way of hanging up on this socket: it fires when the
    // person on the other end is removed from the server (T-413). Handed over
    // in the `Attach` below, so whichever session this socket ends up on is the
    // one holding it.
    let (close_tx, mut close_rx) = oneshot::channel::<()>();

    // First frame decides the path: identify (new session) or resume.
    let (user_id, session_id) = match handshake(&state, &sink, &mut ws_rx, close_tx).await {
        Some(both) => both,
        None => {
            drop(sink);
            let _ = writer.await;
            return;
        }
    };

    state.gateway.connection_opened(user_id, &session_id);
    let _ = sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(user_id.to_vec())
        .execute(&state.db.write)
        .await;

    // Reader loop until close, error, liveness timeout, or the session hanging
    // up on us. `biased` so a close that lands at the same moment as a frame
    // wins: the last thing a removed member should get is one more message.
    // Whether this socket ended by saying goodbye or by going quiet. It is the
    // difference between leaving a call and dropping out of one — see the
    // `voice_part` below.
    let mut said_goodbye = false;
    // Whether the session hung up on this socket on purpose (`Ctl::Close`):
    // its person was removed, or every sign-in they had ended. Nothing can
    // resume it, so its presence ends at once, as after a goodbye (#654). A
    // socket replaced by a resume is let go instead, and isn't this.
    let mut hung_up = false;
    loop {
        let received = tokio::select! {
            biased;
            closed = &mut close_rx => {
                hung_up = closed.is_ok();
                break;
            }
            received = tokio::time::timeout(LIVENESS_TIMEOUT, ws_rx.next()) => received,
        };
        let frame = match received {
            Err(_) | Ok(None) | Ok(Some(Err(_))) => break,
            Ok(Some(Ok(Message::Close(_)))) => {
                said_goodbye = true;
                break;
            }
            Ok(Some(Ok(Message::Text(text)))) => text,
            Ok(Some(Ok(_))) => continue, // binary/ping/pong: nothing for us
        };
        // Unknown ops and malformed frames are ignored, per PROTOCOL §9.
        let Ok(frame) = serde_json::from_str::<ClientFrame>(frame.as_str()) else {
            continue;
        };
        handle_client_frame(&state, user_id, &session_id, frame, &sink).await;
    }

    // Socket gone. The session task survives for the resume window.
    //
    // **Voice does not**, if the client said goodbye (SPEC §4.14). A closed
    // socket and a dropped one mean different things and voice is the one place
    // it matters: being cut off might be two seconds of bad wifi, and holding
    // the seat is what stops a blip tearing down every peer connection. Closing
    // the app is not, and a seat that outlives its client leaves everybody else
    // talking to somebody who is not there — the two ends disagreeing, which is
    // exactly the half-connected state T-1401 is about.
    //
    // The session itself still survives either way, so a client that says
    // goodbye and then resumes is resumed; it simply has to join voice again,
    // which is what it asked for by leaving.
    if said_goodbye {
        // A join still waiting for its turn goes with it (#527).
        state.gateway.voice_held.remove(&session_id);
        state.gateway.voice_part(&session_id);
    }
    // This socket's own session, by id (#451). Any session of the same person
    // is not the same thing once they have two: a phone and a computer, or the
    // old session still waiting out its resume window behind a fresh one.
    // Detaching the wrong one hung up on a healthy socket and left this one's
    // session attached to nothing, so its voice seat outlived it.
    let ctl = state
        .gateway
        .sessions
        .get(&session_id)
        .map(|entry| entry.value().ctl.clone());
    if let Some(ctl) = ctl {
        let _ = ctl.send(Ctl::Detach { from: sink.clone() }).await;
    }
    // What this session said goes with it (#653): somebody still on another
    // device is told what that one says. At once after a goodbye. After a
    // drop, presence is like voice: the app gets a moment to resume, and
    // nobody is told anything meanwhile (#654).
    if said_goodbye || hung_up {
        let merged = state.gateway.connection_closed(user_id, &session_id);
        tell_merged(&state, user_id, merged).await;
    } else if let Some(number) = state.gateway.connection_dropped(user_id, &session_id) {
        wait_for_resume(&state, user_id, &session_id, number);
    }
    let _ = sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(user_id.to_vec())
        .execute(&state.db.write)
        .await;
    drop(sink);
    let _ = writer.await;
}

/// Run the handshake; `Some((user_id, session_id))` once a session is attached.
///
/// The session id comes back out because voice needs it (SPEC §4.14): a peer
/// connection is between two clients, so the frames that route between them are
/// addressed by session and not by person.
async fn handshake(
    state: &AppState,
    sink: &mpsc::Sender<String>,
    ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
    closer: oneshot::Sender<()>,
) -> Option<(UserId, String)> {
    let first = tokio::time::timeout(HANDSHAKE_TIMEOUT, ws_rx.next())
        .await
        .ok()??;
    let Ok(Message::Text(text)) = first else {
        return None;
    };
    let Ok(frame) = serde_json::from_str::<ClientFrame>(text.as_str()) else {
        return None;
    };

    match frame {
        ClientFrame::Identify { token, client: _ } => {
            let Ok(bearer) = state.jwt.verify(&token) else {
                send_control(
                    sink,
                    ServerEvent::InvalidSession {
                        reason: "unauthenticated".into(),
                    },
                )
                .await;
                return None;
            };
            let user_id = bearer.user_id;
            let Ok(user) = repo::users::expect(&state.db.read, user_id).await else {
                send_control(
                    sink,
                    ServerEvent::InvalidSession {
                        reason: "unknown user".into(),
                    },
                )
                .await;
                return None;
            };

            let session_id = uuid::Uuid::now_v7().as_simple().to_string();
            let ctl = spawn_session(Arc::clone(&state.gateway), session_id.clone(), user_id);
            state.gateway.sessions.insert(
                session_id.clone(),
                SessionHandle {
                    user_id,
                    ctl: ctl.clone(),
                },
            );

            // Is the token from before a password change (#496)? Asked after
            // the session is in the map, not before: ending sign-ins commits
            // first and then closes every session it finds, so either this
            // read sees the change, or the change finds this session.
            match auth::still_signed_in(&state.db.read, bearer).await {
                Ok(true) => {}
                still => {
                    // Dropping its last handle ends the session task.
                    state.gateway.sessions.remove(&session_id);
                    if still.is_ok() {
                        send_control(
                            sink,
                            ServerEvent::InvalidSession {
                                reason: "unauthenticated".into(),
                            },
                        )
                        .await;
                    }
                    return None;
                }
            }

            // Snapshot after the session subscribed to the bus: anything that
            // lands in between is both in the snapshot and replayed as
            // idempotent state, never lost.
            let users = repo::users::all(&state.db.read).await.ok()?;
            let rooms = repo::rooms::all(&state.db.read).await.ok()?;
            // This person's DMs, which is a different list for everybody on the
            // server (SPEC §4.13). Kept apart from `rooms` on the wire so a
            // client drawing the server's rooms cannot draw somebody's private
            // conversation by forgetting a filter.
            let dms = repo::rooms::dms_for(&state.db.read, user_id).await.ok()?;
            // The server's own emoji (#359): the whole set, kept current
            // afterwards by `emoji.update`.
            let emoji = repo::emoji::all(&state.db.read, &state.config).await.ok()?;
            // Deleted accounts (#650), so what they left says so.
            let deleted_users = repo::users::deleted_ids(&state.db.read).await.ok()?;
            let ready = ReadyData {
                session_id: session_id.clone(),
                user,
                users,
                rooms,
                dms,
                presence: state.gateway.presence_snapshot(user_id),
                voice: Some(state.gateway.voice_snapshot(user_id)),
                emoji: Some(emoji),
                reactions: Some(true),
                deleted_users: Some(deleted_users),
            };
            let frame = ServerFrame::sequenced(ServerEvent::Ready(ready), 0);
            sink.send(serde_json::to_string(&frame).ok()?).await.ok()?;

            ctl.send(Ctl::Attach {
                sink: sink.clone(),
                closer,
                resume_from: 0,
                is_resume: false,
            })
            .await
            .ok()?;
            Some((user_id, session_id))
        }
        ClientFrame::Resume {
            session_id,
            token,
            s,
        } => {
            // A token from before a password change resumes nothing (#496),
            // not even a session somebody opened since with a good one.
            let signed_in = match state.jwt.verify(&token) {
                Ok(bearer) => auth::still_signed_in(&state.db.read, bearer)
                    .await
                    .ok()?
                    .then_some(bearer.user_id),
                Err(_) => None,
            };
            let Some(user_id) = signed_in else {
                send_control(
                    sink,
                    ServerEvent::InvalidSession {
                        reason: "unauthenticated".into(),
                    },
                )
                .await;
                return None;
            };
            let ctl = state
                .gateway
                .sessions
                .get(&session_id)
                .filter(|e| e.value().user_id == user_id)
                .map(|e| e.value().ctl.clone());
            let Some(ctl) = ctl else {
                send_control(
                    sink,
                    ServerEvent::InvalidSession {
                        reason: "expired".into(),
                    },
                )
                .await;
                return None;
            };
            ctl.send(Ctl::Attach {
                sink: sink.clone(),
                closer,
                resume_from: s,
                is_resume: true,
            })
            .await
            .ok()?;
            Some((user_id, session_id))
        }
        _ => None,
    }
}

async fn handle_client_frame(
    state: &AppState,
    user_id: UserId,
    session_id: &str,
    frame: ClientFrame,
    sink: &mpsc::Sender<String>,
) {
    match frame {
        ClientFrame::Heartbeat { s: _ } => {
            send_control(sink, ServerEvent::HeartbeatAck).await;
        }
        ClientFrame::PresenceUpdate {
            state: presence_state,
            away_message,
        } => {
            // Held to the rule `PATCH /me` holds an away message to (#497):
            // this copy goes to everybody connected, and into every `ready`
            // until it changes. Ignored rather than refused, like any client
            // frame that doesn't fit, and ignored whole: the state it came
            // with doesn't change either, so nobody is told half of it.
            // Counted without the characters that turn text around (#488),
            // which come out first, as `PATCH /me` takes them out before it
            // counts.
            let away_message = away_message
                .as_deref()
                .map(validate::without_direction_overrides);
            if away_message
                .as_deref()
                .is_some_and(|message| validate::away_message(message).is_err())
            {
                return;
            }
            let merged =
                state
                    .gateway
                    .update_presence(user_id, session_id, presence_state, away_message);
            tell_merged(state, user_id, merged).await;
        }
        ClientFrame::RoomFocus { room_id } => {
            // Standing in a DM you are not in would put you in its occupancy
            // and its `room.enter`, in front of the people who *are* in it
            // (SPEC §4.13). The outward direction is already covered — the
            // fan-out would not send those frames to anybody else — but this is
            // the inward one, and a stranger appearing inside a private
            // conversation is worse than a frame nobody sees.
            //
            // Ignored rather than refused: this is a client frame, and the
            // gateway has no way to answer one. A client that sends it is
            // broken or lying, and neither deserves a reply.
            if let Some(room_id) = room_id {
                if repo::rooms::visible_to(&state.db.read, room_id, user_id)
                    .await
                    .is_err()
                {
                    return;
                }
            }
            // Where they are changes now; telling everybody waits for their
            // turn when they move faster than `RATE_ROOM_FOCUS` (#527).
            let merged = state.gateway.move_to(user_id, session_id, room_id);
            tell_merged(state, user_id, merged).await;
        }
        ClientFrame::TypingStart { room_id } => {
            // Same check, same reason: without it somebody outside a DM can
            // make the people inside it see a typing line. And the rule a
            // message keeps (#497): an archived room takes no new ones, so
            // nobody is shown typing one there.
            match repo::rooms::visible_to(&state.db.read, room_id, user_id).await {
                Ok(room) if !room.archived => {}
                _ => return,
            }
            let key = format!("typing:{user_id}:{room_id}");
            if state.limiter.check(&key, RATE_TYPING_PER_ROOM).is_ok() {
                state
                    .gateway
                    .publish(ServerEvent::Typing { room_id, user_id });
            }
        }
        // --- voice (SPEC §4.14, PROTOCOL §8, T-1401) -----------------------
        //
        // Every one of these is ignored rather than refused when it is wrong.
        // These are client frames and the gateway has no way to answer one; a
        // client sending them is either broken or lying, and neither deserves
        // a reply. The same rule `room.focus` and `typing.start` follow.
        ClientFrame::VoiceJoin {
            room_id,
            controls,
            forwarding,
        } => {
            // Voice in a room you cannot see would put you in its `voice.state`
            // in front of its members — the outward direction is covered by the
            // fan-out, this is the inward one (SPEC §4.13).
            if repo::rooms::visible_to(&state.db.read, room_id, user_id)
                .await
                .is_err()
            {
                return;
            }
            // Any `forwarding` at all is an app that takes voice through the
            // server (0.4.1 on); its value is left over from Settings' old
            // switch and no longer matters (#306).
            change_voice(
                state,
                session_id,
                user_id,
                Some(WantedSeat {
                    room_id,
                    controls,
                    can_forward: forwarding.is_some(),
                }),
            );
        }
        ClientFrame::VoiceAnswer { sdp } => {
            if sdp.len() > MAX_VOICE_PAYLOAD_BYTES {
                return;
            }
            if state
                .limiter
                .check(&format!("voice:{session_id}"), RATE_VOICE_SIGNAL)
                .is_err()
            {
                return;
            }
            state.gateway.voice_answer(session_id, &sdp);
        }
        ClientFrame::VoiceRestart => {
            if state
                .limiter
                .check(&format!("voice:{session_id}"), RATE_VOICE_SIGNAL)
                .is_err()
            {
                return;
            }
            state.gateway.voice_restart(session_id);
        }
        ClientFrame::VoiceLeave => change_voice(state, session_id, user_id, None),

        // Handshake ops after the handshake: ignore.
        ClientFrame::Identify { .. } | ClientFrame::Resume { .. } => {}
    }
}

/// Tell everybody what a change to one of a person's sessions did to them
/// (#653), the way that kind of change is told. A `presence.update` can move
/// somebody, and a `room.focus` can leave them where they were: away on the
/// computer takes them out of the room the phone has open, and the phone
/// opening a room while they're away moves nobody. What it did decides it,
/// not which frame did it, so a room always hears its `room.leave` and
/// `room.enter` in order (`tell_focus`).
async fn tell_merged(state: &AppState, user_id: UserId, merged: Merged) {
    match merged {
        Merged::Same => {}
        Merged::Changed => tell_presence(state, user_id),
        Merged::Moved => tell_focus(state, user_id).await,
    }
}

/// A session's last socket dropped without a goodbye (#654): give its app
/// `Config::presence_grace` to resume before anybody is told, then tell what
/// the end of the grace period changed (`Gateway::grace_over`).
///
/// One short wait per drop, and only the newest drop's counts: once the
/// session drops again, an earlier wait's end does nothing. A drop needs a
/// socket that was let in first, so there are never more of these waiting
/// than connections made in one grace period.
fn wait_for_resume(state: &AppState, user_id: UserId, session_id: &str, number: u64) {
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(state.config.presence_grace).await;
        let merged = state.gateway.grace_over(user_id, &session_id, number);
        tell_merged(&state, user_id, merged).await;
    });
}

/// Somebody cleared the away saved on their status (#653): end it on every
/// one of their sessions, and tell everybody what that changed, the way a
/// session's own change is told (`tell_merged`).
pub async fn tell_back_everywhere(state: &AppState, user_id: UserId) {
    let merged = state.gateway.back_everywhere(user_id);
    tell_merged(state, user_id, merged).await;
}

/// Tell everybody a person's presence changed, at most `RATE_PRESENCE` times
/// (#497). Each `presence.update` goes to everybody connected, so without
/// this one app in a loop is every app on the server redrawing in one.
///
/// Past the limit a change is held back, not dropped. Presence is state, and
/// dropping the last change of a burst would leave everybody looking at the
/// one before it until the next. When the person's turn comes, whatever is
/// newest is told, once, however many changes arrived meanwhile. It is in
/// memory from the start, so somebody connecting in between gets it in their
/// `ready`.
fn tell_presence(state: &AppState, user_id: UserId) {
    // A turn is already coming, and it will tell this change too.
    if state.gateway.presence_held.contains(&user_id) {
        return;
    }
    let key = format!("presence:{user_id}");
    let Err(mut wait_ms) = state.limiter.check(&key, RATE_PRESENCE) else {
        state.gateway.tell_presence(user_id);
        return;
    };
    // Two of their apps can both get here; the one that holds it waits.
    if !state.gateway.presence_held.insert(user_id) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            match state.limiter.check(&key, RATE_PRESENCE) {
                Ok(()) => break,
                Err(more) => wait_ms = more,
            }
        }
        // Let go first, then read: a change that lands after this is told by
        // its own turn, and one that landed before is in what's read.
        state.gateway.presence_held.remove(&user_id);
        state.gateway.tell_presence(user_id);
    });
}

/// Tell everybody somebody moved, at most `RATE_ROOM_FOCUS` times (#527).
/// Each move can send a `room.leave`, a `room.enter`, two `room.occupancy`
/// and a `presence.update` to everybody connected, and reads the database.
///
/// The move itself has already happened (`Gateway::move_to`): this is only
/// the telling, held back past the limit the way presence is (`tell_presence`,
/// #497). When the person's turn comes, everybody is told where they are by
/// then, once, however many moves came in between. A room they passed
/// through on the way hears nothing, and plays nobody's entrance sound.
async fn tell_focus(state: &AppState, user_id: UserId) {
    // A turn is already coming, and it will tell this move too.
    if state.gateway.focus_held.contains(&user_id) {
        return;
    }
    let key = format!("focus:{user_id}");
    let Err(mut wait_ms) = state.limiter.check(&key, RATE_ROOM_FOCUS) else {
        tell_focus_now(state, user_id).await;
        return;
    };
    // Two of their apps can both get here; the one that holds it waits.
    if !state.gateway.focus_held.insert(user_id) {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            match state.limiter.check(&key, RATE_ROOM_FOCUS) {
                Ok(()) => break,
                Err(more) => wait_ms = more,
            }
        }
        // Let go first, then tell: a move that lands after this is told by
        // its own turn, and one that landed before is where they are now.
        state.gateway.focus_held.remove(&user_id);
        tell_focus_now(&state, user_id).await;
    });
}

/// Tell a move now, with the sound the room plays for whoever comes in.
async fn tell_focus_now(state: &AppState, user_id: UserId) {
    let entrance_sound: Option<String> =
        sqlx::query_scalar("SELECT sound_key FROM entrance_sounds WHERE user_id = ?")
            .bind(user_id.to_vec())
            .fetch_optional(&state.db.read)
            .await
            .ok()
            .flatten();
    state.gateway.tell_focus(user_id, entrance_sound);
}

/// Take, change or leave a session's voice seat, at most `RATE_VOICE_SEAT`
/// times (#527). Each seat taken or left makes the forwarding server offer
/// everybody in that voice room a fresh connection, and changing mute or
/// deafen tells the whole room.
///
/// Past the limit the newest request is held, not dropped, and taken once
/// when the session's turn comes: a burst of joins and leaves ends where the
/// last one said, with one round of offers. A seat is not taken early, since
/// taking it is the cost; see `HeldVoice`.
fn change_voice(state: &AppState, session_id: &str, user_id: UserId, wanted: Option<WantedSeat>) {
    let key = format!("voice-seat:{session_id}");
    let wait_ms = match state.gateway.voice_held.entry(session_id.to_string()) {
        // A turn is already coming, and it takes this one instead.
        Entry::Occupied(mut held) => {
            held.get_mut().newest(wanted);
            return;
        }
        Entry::Vacant(vacant) => match state.limiter.check(&key, RATE_VOICE_SEAT) {
            Err(wait_ms) => {
                let seated = state.gateway.seat_room(session_id);
                vacant.insert(HeldVoice::new(seated, wanted));
                wait_ms
            }
            Ok(()) => {
                drop(vacant);
                take_seat(state, session_id, user_id, wanted, false);
                return;
            }
        },
    };
    let state = state.clone();
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        let mut wait_ms = wait_ms;
        loop {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            match state.limiter.check(&key, RATE_VOICE_SEAT) {
                Ok(()) => break,
                Err(more) => wait_ms = more,
            }
        }
        // Held while the seat is taken, so the session can't end in between
        // and leave a seat behind it: its end waits for this, then leaves.
        let Some(_alive) = state.gateway.sessions.get(&session_id) else {
            state.gateway.voice_held.remove(&session_id);
            return;
        };
        // Taken out first: a request that lands after this goes through the
        // limit again, and one that landed before is in what's taken.
        let Some((_, held)) = state.gateway.voice_held.remove(&session_id) else {
            // The app said goodbye, and its join went with it.
            return;
        };
        take_seat(&state, &session_id, user_id, held.wanted, held.churned);
    });
}

/// Do what a session asked of voice. `churned` says its app closed its
/// connection and opened another while the request waited, so it gets a
/// fresh offer even when its seat ends up where it was.
fn take_seat(
    state: &AppState,
    session_id: &str,
    user_id: UserId,
    wanted: Option<WantedSeat>,
    churned: bool,
) {
    let Some(seat) = wanted else {
        state.gateway.voice_part(session_id);
        return;
    };
    match state.gateway.voice_join(
        session_id,
        user_id,
        seat.room_id,
        seat.controls,
        seat.can_forward,
    ) {
        // A new seat: the room gets its quiet line if they stay (#473).
        VoiceJoined::Seated(number) => crate::join_line::after_join(
            state.clone(),
            session_id.to_string(),
            user_id,
            seat.room_id,
            number,
        ),
        VoiceJoined::Again if churned => state.gateway.voice_restart(session_id),
        VoiceJoined::Again | VoiceJoined::Refused => {}
    }
}
