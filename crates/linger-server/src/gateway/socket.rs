//! The WebSocket side of the gateway: handshake (hello → identify|resume →
//! ready|resumed), the reader loop, and heartbeat liveness.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use linger_core::gateway::{ClientFrame, ReadyData, ServerEvent, ServerFrame};
use linger_core::limits::{
    HEARTBEAT_INTERVAL_MS, MAX_VOICE_PAYLOAD_BYTES, RATE_TYPING_PER_ROOM, RATE_VOICE_SIGNAL,
};
use linger_core::UserId;
use tokio::sync::{mpsc, oneshot};

use super::{spawn_session, Ctl, SessionHandle};
use crate::db::now_ms;
use crate::repo;
use crate::state::AppState;

/// How long the client has to send identify/resume after hello.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Reader liveness: 2.5× the heartbeat interval with no traffic ⇒ dead peer.
const LIVENESS_TIMEOUT: Duration = Duration::from_millis(HEARTBEAT_INTERVAL_MS * 5 / 2);

pub async fn ws_route(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
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

    state.gateway.connection_opened(user_id);
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
    loop {
        let received = tokio::select! {
            biased;
            _ = &mut close_rx => break,
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
        state.gateway.voice_part(&session_id);
    }
    if let Some(entry) = find_session_for_cleanup(&state, user_id) {
        let _ = entry.send(Ctl::Detach).await;
    }
    state.gateway.connection_closed(user_id);
    let _ = sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(user_id.to_vec())
        .execute(&state.db.write)
        .await;
    drop(sink);
    let _ = writer.await;
}

/// The session this socket was attached to. Sessions are per-socket in
/// practice; matching by user is enough at this scale because a stale Detach
/// to an already-detached session is a no-op.
fn find_session_for_cleanup(state: &AppState, user_id: UserId) -> Option<mpsc::Sender<Ctl>> {
    state
        .gateway
        .sessions
        .iter()
        .find(|e| e.value().user_id == user_id)
        .map(|e| e.value().ctl.clone())
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
            let Ok(user_id) = state.jwt.verify(&token) else {
                send_control(
                    sink,
                    ServerEvent::InvalidSession {
                        reason: "unauthenticated".into(),
                    },
                )
                .await;
                return None;
            };
            let Ok(user) = repo::users::expect(&state.db.read, &state.config, user_id).await else {
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

            // Snapshot after the session subscribed to the bus: anything that
            // lands in between is both in the snapshot and replayed as
            // idempotent state, never lost.
            let users = repo::users::all(&state.db.read, &state.config).await.ok()?;
            let rooms = repo::rooms::all(&state.db.read).await.ok()?;
            // This person's DMs, which is a different list for everybody on the
            // server (SPEC §4.13). Kept apart from `rooms` on the wire so a
            // client drawing the server's rooms cannot draw somebody's private
            // conversation by forgetting a filter.
            let dms = repo::rooms::dms_for(&state.db.read, user_id).await.ok()?;
            let ready = ReadyData {
                session_id: session_id.clone(),
                user,
                users,
                rooms,
                dms,
                presence: state.gateway.presence_snapshot(user_id),
                voice: Some(state.gateway.voice_snapshot(user_id)),
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
            let Ok(user_id) = state.jwt.verify(&token) else {
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
            let entry = state
                .gateway
                .apply_presence(user_id, presence_state, away_message);
            state.gateway.publish(ServerEvent::PresenceUpdate(entry));
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
            let entrance_sound: Option<String> =
                sqlx::query_scalar("SELECT sound_key FROM entrance_sounds WHERE user_id = ?")
                    .bind(user_id.to_vec())
                    .fetch_optional(&state.db.read)
                    .await
                    .ok()
                    .flatten();
            state
                .gateway
                .apply_room_focus(user_id, room_id, entrance_sound);
        }
        ClientFrame::TypingStart { room_id } => {
            // Same check, same reason: without it somebody outside a DM can
            // make the people inside it see a typing line.
            if repo::rooms::visible_to(&state.db.read, room_id, user_id)
                .await
                .is_err()
            {
                return;
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
            state.gateway.voice_join(
                session_id,
                user_id,
                room_id,
                controls,
                forwarding == Some(true),
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
        ClientFrame::VoiceLeave => state.gateway.voice_part(session_id),
        ClientFrame::VoiceSignal { to, kind, payload } => {
            if payload.len() > MAX_VOICE_PAYLOAD_BYTES {
                return;
            }
            if state
                .limiter
                .check(&format!("voice:{session_id}"), RATE_VOICE_SIGNAL)
                .is_err()
            {
                return;
            }
            // Both ends have to be in voice, in the same room. Without this the
            // frame is a way to hand an arbitrary string to any session on the
            // server, which is a side channel nothing else here has and nobody
            // asked for (PROTOCOL §8).
            let Some((mine, _)) = state.gateway.voice_seat_of(session_id) else {
                return;
            };
            let Some((theirs, _)) = state.gateway.voice_seat_of(&to) else {
                // Their client closed mid-exchange, which is the ordinary end
                // of a call. Dropped, not refused.
                return;
            };
            if mine != theirs {
                return;
            }
            state.gateway.publish_to_session(
                &to,
                ServerEvent::VoiceSignal {
                    from: session_id.to_string(),
                    kind,
                    payload,
                },
            );
        }

        // Handshake ops after the handshake: ignore.
        ClientFrame::Identify { .. } | ClientFrame::Resume { .. } => {}
    }
}
