//! The screen socket at `/api/v1/screen` (PROTOCOL §8 "Screen sharing", #360):
//! a hello saying who it is and what for, then a share's frames and sound
//! (#736) coming in or a watcher's going out. The board in `screens.rs`
//! decides who gets what; this is the socket around it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use linger_core::limits::{
    MAX_SCREEN_FRAME_BYTES, MAX_SCREEN_MESSAGE_BYTES, MAX_SCREEN_TEXT_BYTES, RATE_SCREEN_ASK,
    RATE_SCREEN_HELLO, SCREEN_ALIVE_MISSED, SCREEN_HELLO_MS, SCREEN_SOUND_QUEUE,
    SCREEN_WATCH_QUEUE,
};
use linger_core::screen::{
    ScreenCodec, ScreenHello, ScreenShareSays, ScreenSoundHead, ScreenWatchAsks, ScreenWatchSays,
};
use linger_core::{RoomId, UserId};
use tokio::sync::mpsc;
use tokio::time::{Instant, Interval, MissedTickBehavior};

use super::screens::{Closing, ToShare, ToWatch, WatchLine};
use crate::auth;
use crate::state::AppState;

type Sink = SplitSink<WebSocket, Message>;
type Stream = SplitStream<WebSocket>;

/// A frame is the biggest thing either way; a text message is held to far
/// less, after it arrives (`MAX_SCREEN_TEXT_BYTES`). The socket takes up to
/// twice the biggest frame, so one over it is dropped (`share`) rather than
/// ending the share, which the app took as a dropped line and came back to,
/// again and again.
pub async fn screen_route(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_frame_size(MAX_SCREEN_MESSAGE_BYTES)
        .max_message_size(MAX_SCREEN_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle(socket, state))
}

/// Send, unless the line has been stuck for `gone`: a socket whose other end
/// died without closing otherwise held its loop, and with it its share or
/// watching, for as long as the system's own timeout, many minutes.
async fn send(sink: &mut Sink, message: Message, gone: Duration) -> bool {
    matches!(
        tokio::time::timeout(gone, sink.send(message)).await,
        Ok(Ok(()))
    )
}

/// Every `Config::screen_alive` (`SCREEN_ALIVE_MS`), from one period on; and how
/// long with nothing heard, a pong included, before a socket is taken as gone.
fn alive_every(state: &AppState) -> (Interval, Duration) {
    let every = state.config.screen_alive;
    let mut alive = tokio::time::interval_at(Instant::now() + every, every);
    alive.set_missed_tick_behavior(MissedTickBehavior::Delay);
    (alive, every * SCREEN_ALIVE_MISSED)
}

/// Still here: `alive`, for the app, and a ping, which the app's web engine
/// answers by itself, for this end. False once the line is gone.
async fn say_alive(sink: &mut Sink, alive: &impl serde::Serialize, gone: Duration) -> bool {
    let Ok(json) = serde_json::to_string(alive) else {
        return false;
    };
    send(sink, Message::Text(json.into()), gone).await
        && send(sink, Message::Ping(Bytes::new()), gone).await
}

async fn close(sink: &mut Sink, why: Closing) {
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code: why.code(),
            reason: "".into(),
        })))
        .await;
}

/// A hello that checked out: its session, whose it is, and the room of that
/// session's seat.
struct Signed {
    session_id: String,
    user_id: UserId,
    room: RoomId,
}

impl Signed {
    /// Whether the seat is still there, once the share or watching is on the
    /// board: leaving voice between the hello's check and the board taking
    /// it left the board holding one with no seat, until its socket closed.
    fn still_seated(&self, state: &AppState) -> bool {
        state
            .gateway
            .screen_seat(&self.session_id, self.user_id)
            .is_some()
    }
}

async fn handle(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    if !state.gateway.passes_screens() {
        return close(&mut sink, Closing::Off).await;
    }
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
        ScreenHello::Share {
            fps, encode, sound, ..
        } => {
            if !matches!(fps, 30 | 60) || encode.is_empty() {
                return close(&mut sink, Closing::BadHello).await;
            }
            let shape = Shape {
                fps,
                encode,
                sound: sound == Some(true),
            };
            share(&state, signed, shape, sink, stream).await;
        }
        ScreenHello::Watch {
            target,
            decode,
            sound,
            ..
        } => {
            if decode.is_empty() {
                return close(&mut sink, Closing::BadHello).await;
            }
            let wants = Wants {
                decode,
                sound: sound == Some(true),
            };
            watch(&state, signed, &target, wants, sink, stream).await;
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
        return Err(Closing::Busy);
    }
    let room = state
        .gateway
        .screen_seat(session_id, user_id)
        .ok_or(Closing::NotInVoice)?;
    Ok(Signed {
        session_id: session_id.to_owned(),
        user_id,
        room,
    })
}

/// What a share's hello asked for: its speed, its formats, and whether it
/// carries the computer's sound (#736).
struct Shape {
    fps: u8,
    encode: Vec<ScreenCodec>,
    sound: bool,
}

/// What a watch's hello asked for: the formats it plays, and whether it
/// wants the share's sound (#736).
struct Wants {
    decode: Vec<ScreenCodec>,
    sound: bool,
}

/// A share: frames and sound in, what the board asks of the sharer out,
/// until either side ends it.
async fn share(state: &AppState, signed: Signed, shape: Shape, mut sink: Sink, mut stream: Stream) {
    let screens = &state.gateway.screens;
    let (says_tx, mut says) = mpsc::unbounded_channel();
    let Shape { fps, encode, sound } = shape;
    let socket = match screens.share(&signed.session_id, signed.room, fps, encode, sound, says_tx) {
        Ok(socket) => socket,
        Err(why) => return close(&mut sink, why).await,
    };
    if !signed.still_seated(state) {
        let _ = screens.unshare(&signed.session_id, socket);
        return close(&mut sink, Closing::NotInVoice).await;
    }
    state.gateway.announce_screens(signed.room);
    // The room's line saying they're sharing, once the share has lasted (#746).
    crate::share_line::after_share(
        state.clone(),
        signed.session_id.clone(),
        signed.user_id,
        signed.room,
        socket,
    );
    let (mut alive, gone) = alive_every(state);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            biased;
            said = says.recv() => match said {
                Some(ToShare::Say(say)) => {
                    let Ok(json) = serde_json::to_string(&say) else { continue };
                    if !send(&mut sink, Message::Text(json.into()), gone).await {
                        break;
                    }
                }
                Some(ToShare::Close(why)) => {
                    close(&mut sink, why).await;
                    break;
                }
                None => break,
            },
            _ = alive.tick() => {
                // Nothing back for that long, not even a pong: it's gone.
                if heard.elapsed() >= gone || !say_alive(&mut sink, &ScreenShareSays::Alive, gone).await {
                    break;
                }
            },
            received = stream.next() => {
                if matches!(received, Some(Ok(_))) {
                    heard = Instant::now();
                }
                match received {
                    // Over the biggest frame: dropped, as PROTOCOL §8 says.
                    Some(Ok(Message::Binary(frame))) if frame.len() > MAX_SCREEN_FRAME_BYTES => {}
                    // Sound (#736), by its first byte: the board drops it
                    // unless the hello said the share carries some.
                    Some(Ok(Message::Binary(packet))) if ScreenSoundHead::read(&packet).is_some() => {
                        screens.sound(&signed.session_id, socket, &packet);
                    }
                    Some(Ok(Message::Binary(frame))) => {
                        screens.frame(&signed.session_id, socket, &frame);
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    // A share socket has nothing to say in text; a pong is heard above.
                    Some(Ok(_)) => {}
                }
            },
        }
    }
    if let Some(room) = screens.unshare(&signed.session_id, socket) {
        state.gateway.announce_screens(room);
    }
}

/// A watcher: frames, sound and what the board tells it out, its asks in.
/// It sends nothing in binary: anything it does is dropped.
async fn watch(
    state: &AppState,
    signed: Signed,
    target: &str,
    wants: Wants,
    mut sink: Sink,
    mut stream: Stream,
) {
    let screens = &state.gateway.screens;
    let (frames_tx, mut frames) = mpsc::channel(SCREEN_WATCH_QUEUE);
    let (sound_tx, mut sound) = mpsc::channel(SCREEN_SOUND_QUEUE);
    let (says_tx, mut says) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let line = WatchLine {
        frames: frames_tx,
        sound: sound_tx,
        says: says_tx,
        queued: Arc::clone(&queued),
    };
    let Wants {
        decode,
        sound: listens,
    } = wants;
    let socket = match screens.watch(
        &signed.session_id,
        signed.room,
        target,
        decode,
        listens,
        line,
    ) {
        Ok(showing) => showing.socket,
        Err(why) => return close(&mut sink, why).await,
    };
    if !signed.still_seated(state) {
        let _ = screens.unwatch(&signed.session_id, socket);
        return close(&mut sink, Closing::NotInVoice).await;
    }
    state.gateway.announce_screens(signed.room);
    let asks = format!("screen-ask:{}:{socket}", signed.session_id);
    let (mut alive, gone) = alive_every(state);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            biased;
            said = says.recv() => match said {
                Some(ToWatch::Say(say)) => {
                    let Ok(json) = serde_json::to_string(&say) else { continue };
                    if !send(&mut sink, Message::Text(json.into()), gone).await {
                        break;
                    }
                }
                Some(ToWatch::Close(why)) => {
                    close(&mut sink, why).await;
                    break;
                }
                None => break,
            },
            _ = alive.tick() => {
                // Nothing back for that long, not even a pong: it's gone.
                if heard.elapsed() >= gone || !say_alive(&mut sink, &ScreenWatchSays::Alive, gone).await {
                    break;
                }
            },
            // Ahead of frames: a packet of sound is small and late is no use.
            packet = sound.recv() => match packet {
                Some(packet) => {
                    if !send(&mut sink, Message::Binary(packet), gone).await {
                        break;
                    }
                }
                None => break,
            },
            frame = frames.recv() => match frame {
                Some(frame) => {
                    let size = frame.len();
                    let sent = send(&mut sink, Message::Binary(frame), gone).await;
                    queued.fetch_sub(size, Ordering::Relaxed);
                    if !sent {
                        break;
                    }
                }
                None => break,
            },
            received = stream.next() => {
            if matches!(received, Some(Ok(_))) {
                heard = Instant::now();
            }
            match received {
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
                        Ok(ScreenWatchAsks::Sound { on }) => screens.hear(&signed.session_id, socket, on),
                        // Unknown asks are ignored (PROTOCOL §9).
                        Err(_) => {}
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
            },
        }
    }
    if let Some(room) = screens.unwatch(&signed.session_id, socket) {
        state.gateway.announce_screens(room);
    }
}
