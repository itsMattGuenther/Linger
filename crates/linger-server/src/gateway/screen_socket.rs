//! The screen socket at `/api/v1/screen` (PROTOCOL §8 "Screen sharing", #360):
//! a hello saying who it is and what for, then a share's frames coming in or
//! a watcher's going out. The board in `screens.rs` decides who gets what;
//! this is the socket around it.

use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use linger_core::limits::{
    MAX_SCREEN_FRAME_BYTES, MAX_SCREEN_TEXT_BYTES, RATE_SCREEN_ASK, RATE_SCREEN_HELLO,
    SCREEN_HELLO_MS, SCREEN_WATCH_QUEUE,
};
use linger_core::screen::{ScreenCodec, ScreenHello, ScreenWatchAsks};
use linger_core::RoomId;
use tokio::sync::mpsc;

use super::screens::{Closing, ToShare, ToWatch, WatchLine};
use crate::auth;
use crate::state::AppState;

type Sink = SplitSink<WebSocket, Message>;
type Stream = SplitStream<WebSocket>;

/// A frame is the biggest thing either way; a text message is held to far
/// less, after it arrives (`MAX_SCREEN_TEXT_BYTES`).
pub async fn screen_route(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_frame_size(MAX_SCREEN_FRAME_BYTES)
        .max_message_size(MAX_SCREEN_FRAME_BYTES)
        .on_upgrade(move |socket| handle(socket, state))
}

async fn close(sink: &mut Sink, why: Closing) {
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code: why.code(),
            reason: "".into(),
        })))
        .await;
}

/// A hello that checked out: its session and the room of that session's seat.
struct Signed {
    session_id: String,
    room: RoomId,
}

async fn handle(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let first = tokio::time::timeout(Duration::from_millis(SCREEN_HELLO_MS), stream.next()).await;
    let hello = match first {
        Ok(Some(Ok(Message::Text(text)))) if text.len() <= MAX_SCREEN_TEXT_BYTES => {
            serde_json::from_str::<ScreenHello>(text.as_str()).ok()
        }
        _ => None,
    };
    let Some(hello) = hello else {
        return close(&mut sink, Closing::BadHello).await;
    };
    let (token, session_id) = match &hello {
        ScreenHello::Share {
            token, session_id, ..
        }
        | ScreenHello::Watch {
            token, session_id, ..
        } => (token.as_str(), session_id.as_str()),
    };
    let signed = match sign(&state, token, session_id).await {
        Ok(signed) => signed,
        Err(why) => return close(&mut sink, why).await,
    };
    match hello {
        ScreenHello::Share { fps, encode, .. } => {
            if !matches!(fps, 30 | 60) || encode.is_empty() {
                return close(&mut sink, Closing::BadHello).await;
            }
            share(&state, signed, fps, encode, sink, stream).await;
        }
        ScreenHello::Watch { target, decode, .. } => {
            if decode.is_empty() {
                return close(&mut sink, Closing::BadHello).await;
            }
            watch(&state, signed, &target, decode, sink, stream).await;
        }
    }
}

/// Check a hello's token and session: a good sign-in, under the hello
/// limit, whose session holds a voice seat.
async fn sign(state: &AppState, token: &str, session_id: &str) -> Result<Signed, Closing> {
    let bearer = state.jwt.verify(token).map_err(|_| Closing::NotSignedIn)?;
    let user_id = bearer.user_id;
    if !matches!(
        auth::still_signed_in(&state.db.read, bearer).await,
        Ok(true)
    ) {
        return Err(Closing::NotSignedIn);
    }
    let key = format!("screen-hello:{user_id}");
    if state.limiter.check(&key, RATE_SCREEN_HELLO).is_err() {
        return Err(Closing::BadHello);
    }
    let room = state
        .gateway
        .screen_seat(session_id, user_id)
        .ok_or(Closing::NotInVoice)?;
    Ok(Signed {
        session_id: session_id.to_owned(),
        room,
    })
}

/// A share: frames in, what the board asks of the sharer out, until either
/// side ends it.
async fn share(
    state: &AppState,
    signed: Signed,
    fps: u8,
    encode: Vec<ScreenCodec>,
    mut sink: Sink,
    mut stream: Stream,
) {
    let screens = &state.gateway.screens;
    let (says_tx, mut says) = mpsc::unbounded_channel();
    let socket = match screens.share(&signed.session_id, signed.room, fps, encode, says_tx) {
        Ok(socket) => socket,
        Err(why) => return close(&mut sink, why).await,
    };
    state.gateway.announce_screens(signed.room);
    loop {
        tokio::select! {
            biased;
            said = says.recv() => match said {
                Some(ToShare::Say(say)) => {
                    let Ok(json) = serde_json::to_string(&say) else { continue };
                    if sink.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Some(ToShare::Close(why)) => {
                    close(&mut sink, why).await;
                    break;
                }
                None => break,
            },
            received = stream.next() => match received {
                Some(Ok(Message::Binary(frame))) => {
                    screens.frame(&signed.session_id, socket, &frame);
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                // A share socket has nothing to say in text.
                Some(Ok(_)) => {}
            },
        }
    }
    if let Some(room) = screens.unshare(&signed.session_id, socket) {
        state.gateway.announce_screens(room);
    }
}

/// A watcher: frames and what the board tells it out, its asks in.
async fn watch(
    state: &AppState,
    signed: Signed,
    target: &str,
    decode: Vec<ScreenCodec>,
    mut sink: Sink,
    mut stream: Stream,
) {
    let screens = &state.gateway.screens;
    let (frames_tx, mut frames) = mpsc::channel(SCREEN_WATCH_QUEUE);
    let (says_tx, mut says) = mpsc::unbounded_channel();
    let line = WatchLine {
        frames: frames_tx,
        says: says_tx,
    };
    let socket = match screens.watch(&signed.session_id, signed.room, target, decode, line) {
        Ok(showing) => showing.socket,
        Err(why) => return close(&mut sink, why).await,
    };
    state.gateway.announce_screens(signed.room);
    let asks = format!("screen-ask:{}:{socket}", signed.session_id);
    loop {
        tokio::select! {
            biased;
            said = says.recv() => match said {
                Some(ToWatch::Say(say)) => {
                    let Ok(json) = serde_json::to_string(&say) else { continue };
                    if sink.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Some(ToWatch::Close(why)) => {
                    close(&mut sink, why).await;
                    break;
                }
                None => break,
            },
            frame = frames.recv() => match frame {
                Some(frame) => {
                    if sink.send(Message::Binary(frame)).await.is_err() {
                        break;
                    }
                }
                None => break,
            },
            received = stream.next() => match received {
                Some(Ok(Message::Text(text))) => {
                    if text.len() > MAX_SCREEN_TEXT_BYTES {
                        close(&mut sink, Closing::BadHello).await;
                        break;
                    }
                    if state.limiter.check(&asks, RATE_SCREEN_ASK).is_err() {
                        continue;
                    }
                    match serde_json::from_str::<ScreenWatchAsks>(text.as_str()) {
                        Ok(ScreenWatchAsks::Watch { target, decode }) => {
                            if let Ok(room) = screens.switch(&signed.session_id, socket, &target, decode) {
                                state.gateway.announce_screens(room);
                            } else {
                                state.gateway.announce_screens(signed.room);
                            }
                        }
                        Ok(ScreenWatchAsks::Keyframe) => screens.keyframe(&signed.session_id, socket),
                        // Unknown asks are ignored (PROTOCOL §9).
                        Err(_) => {}
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    if let Some(room) = screens.unwatch(&signed.session_id, socket) {
        state.gateway.announce_screens(room);
    }
}
