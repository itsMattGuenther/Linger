//! Who is sharing a screen and who is watching whom (SPEC §4.20, PROTOCOL §8
//! "Screen sharing", #360), and passing each frame on.
//!
//! Every share and every watcher has a screen socket of its own
//! (`screen_socket.rs`); this is what they have in common. It is one board
//! behind one lock: a frame is passed on while the lock is held, which is a
//! handful of channel sends, and nothing in here waits for anything.
//!
//! **Nothing in here announces.** What changes who shares or watches answers
//! with the room that changed, and the gateway sends that room its
//! `voice.state` once the lock is let go: `voice_peers` reads this board, and
//! a lock taken twice by one thread never comes back.
//!
//! The board never opens a frame. It reads a frame's format and whether it is
//! a key frame from the header, and hands every watcher the same bytes. A
//! share's sound (#736) goes the same way, to the watchers who asked for it,
//! read only for being sound: never opened, never gated on a key frame, and
//! dropped rather than queued for a watcher whose line is behind.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use linger_core::limits::{
    MAX_SCREENS_PER_ROOM, MAX_SCREEN_SOUND_BYTES, MAX_SCREEN_WATCH_BYTES, SCREEN_BURST_BYTES,
    SCREEN_KEYFRAME_EVERY_MS, SCREEN_MAX_BITS_PER_SECOND,
};
use linger_core::screen::{
    ScreenCodec, ScreenFrameHead, ScreenShare, ScreenShareSays, ScreenSoundHead, ScreenWatchSays,
};
use linger_core::RoomId;
use tokio::sync::mpsc;

/// Why a screen socket was closed: the codes PROTOCOL §8 lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closing {
    /// The token isn't good, or that sign-in ended.
    NotSignedIn = 4001,
    /// That session has no voice seat, or isn't that person's.
    NotInVoice = 4002,
    /// Three people share in that room already.
    RoomFull = 4003,
    /// The target isn't sharing in this room.
    NothingToWatch = 4004,
    /// The hello wasn't one.
    BadHello = 4005,
    /// Another socket took over this session's share or watching.
    Replaced = 4006,
    /// The seat left voice, or the session ended.
    Ended = 4007,
    /// This server doesn't pass screens on: no voice, or `LINGER_SCREENS=off`.
    Off = 4008,
    /// Too many screen sockets started in a minute (`RATE_SCREEN_HELLO`).
    Busy = 4009,
}

impl Closing {
    #[must_use]
    pub fn code(self) -> u16 {
        self as u16
    }
}

/// What the board sends a share socket.
#[derive(Debug)]
pub enum ToShare {
    Say(ScreenShareSays),
    Close(Closing),
}

/// What the board sends a watch socket, other than frames.
#[derive(Debug)]
pub enum ToWatch {
    Say(ScreenWatchSays),
    Close(Closing),
}

/// What a watch socket is given: frames on a bounded channel, so a watcher
/// that falls behind is noticed, sound on a short one of its own (#736), so
/// sound that can't go at once is dropped rather than queued behind frames,
/// and everything else on its own, so nothing the board says is ever dropped.
pub struct WatchLine {
    pub frames: mpsc::Sender<Bytes>,
    /// `SCREEN_SOUND_QUEUE` packets at most.
    pub sound: mpsc::Sender<Bytes>,
    pub says: mpsc::UnboundedSender<ToWatch>,
    /// The bytes waiting on `frames`: the board adds, the socket takes away
    /// as each one goes (`MAX_SCREEN_WATCH_BYTES`).
    pub queued: Arc<AtomicUsize>,
}

struct Share {
    room: RoomId,
    fps: u8,
    encode: Vec<ScreenCodec>,
    /// Its hello said it carries the computer's sound (#736): sound from any
    /// other share is dropped.
    sound: bool,
    /// Whether it was last told to send its sound: somebody watching asked.
    sounding: bool,
    says: mpsc::UnboundedSender<ToShare>,
    /// Which socket this is, so an old one closing after a new one took over
    /// doesn't end the new one's share.
    socket: u64,
    /// The formats the sharer was last asked to make.
    wanted: Vec<ScreenCodec>,
    /// When a key frame was last asked for, by format.
    asked: HashMap<ScreenCodec, Instant>,
    /// What this share may still send at once (`SCREEN_BURST_BYTES` at most).
    budget: f64,
    filled: Instant,
}

impl Share {
    /// Whether `bytes` more fit under the share's ceiling at `now`, taken
    /// from what it may still send if so: a bucket that fills at
    /// `SCREEN_MAX_BITS_PER_SECOND` and holds `SCREEN_BURST_BYTES`. Frames
    /// and sound draw on the same one (#736).
    fn afford(&mut self, bytes: usize, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.filled).as_secs_f64();
        self.filled = now;
        self.budget = (self.budget + elapsed * bytes_per_second()).min(budget_cap());
        #[allow(clippy::cast_precision_loss)]
        let cost = bytes as f64;
        if self.budget < cost {
            return false;
        }
        self.budget -= cost;
        true
    }

    /// Tell the sharer what to make now: its formats, and whether its sound.
    fn want(&self) {
        let _ = self.says.send(ToShare::Say(ScreenShareSays::Want {
            codecs: self.wanted.clone(),
            sound: self.sounding.then_some(true),
        }));
    }
}

struct Watch {
    room: RoomId,
    target: Option<String>,
    decode: Vec<ScreenCodec>,
    /// The format this watcher is sent, picked by `choose`.
    codec: Option<ScreenCodec>,
    line: WatchLine,
    socket: u64,
    /// Nothing goes to it until a key frame in its format: it just started,
    /// fell behind, or asked for one.
    gated: bool,
    /// It asked for the share's sound (#736): its hello, then its sound
    /// button.
    sound: bool,
}

impl Watch {
    /// Whether it could take a key frame now: room in its queue, and not
    /// much more than half its bytes' worth waiting. A watcher that's still
    /// full would only refuse one, and every key frame asked for on its
    /// behalf costs everybody else's picture its detail.
    fn has_room(&self) -> bool {
        self.line.frames.capacity() > 0
            && self.line.queued.load(Ordering::Relaxed) < MAX_SCREEN_WATCH_BYTES / 2
    }

    /// Its own line couldn't keep up and it was skipped forward: the app
    /// says so on its screen, the slowness being its own (#360).
    fn tell_behind(&self) {
        let _ = self.line.says.send(ToWatch::Say(ScreenWatchSays::Behind));
    }
}

#[derive(Default)]
struct Board {
    shares: HashMap<String, Share>,
    watches: HashMap<String, Watch>,
    sockets: u64,
}

/// The screen-sharing half of the gateway.
#[derive(Default)]
pub struct Screens {
    board: Mutex<Board>,
}

/// What a share's formats should be, given its watchers: the first of the
/// sharer's formats every watcher can play, for everybody; failing that,
/// each watcher's first playable one, which the sharer then makes all of.
/// Watchers that can play none get `None`. Answers the formats to make, in
/// the sharer's order, and each watcher's, in the order given.
fn choose(
    encode: &[ScreenCodec],
    watchers: &[&[ScreenCodec]],
) -> (Vec<ScreenCodec>, Vec<Option<ScreenCodec>>) {
    if watchers.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if let Some(common) = encode
        .iter()
        .find(|codec| watchers.iter().all(|decode| decode.contains(codec)))
    {
        return (vec![*common], vec![Some(*common); watchers.len()]);
    }
    let each: Vec<Option<ScreenCodec>> = watchers
        .iter()
        .map(|decode| encode.iter().find(|codec| decode.contains(codec)).copied())
        .collect();
    let wanted = encode
        .iter()
        .filter(|codec| each.contains(&Some(**codec)))
        .copied()
        .collect();
    (wanted, each)
}

fn lock(screens: &Screens) -> std::sync::MutexGuard<'_, Board> {
    // A panic while the lock was held leaves the board as it was at worst;
    // screen sharing carrying on beats every share on the server ending.
    screens
        .board
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Board {
    fn next_socket(&mut self) -> u64 {
        self.sockets += 1;
        self.sockets
    }

    /// Ask `sharer` for a key frame in `codec`, unless one was asked for
    /// within `SCREEN_KEYFRAME_EVERY_MS`.
    fn ask_keyframe(&mut self, sharer: &str, codec: ScreenCodec, now: Instant) {
        let Some(share) = self.shares.get_mut(sharer) else {
            return;
        };
        let every = Duration::from_millis(SCREEN_KEYFRAME_EVERY_MS);
        if share
            .asked
            .get(&codec)
            .is_some_and(|at| now.saturating_duration_since(*at) < every)
        {
            return;
        }
        share.asked.insert(codec, now);
        let _ = share
            .says
            .send(ToShare::Say(ScreenShareSays::Keyframe { codec }));
    }

    /// Work out `sharer`'s formats again from who watches it, tell the sharer
    /// if they changed, tell each watcher whose format changed, and ask for a
    /// key frame for each watcher now waiting on one.
    fn settle(&mut self, sharer: &str, now: Instant) {
        let Some(share) = self.shares.get(sharer) else {
            return;
        };
        let encode = share.encode.clone();
        let mut watching: Vec<&String> = self
            .watches
            .iter()
            .filter(|(_, watch)| watch.target.as_deref() == Some(sharer))
            .map(|(session, _)| session)
            .collect();
        watching.sort();
        let watching: Vec<String> = watching.into_iter().cloned().collect();
        let decodes: Vec<Vec<ScreenCodec>> = watching
            .iter()
            .map(|session| self.watches[session].decode.clone())
            .collect();
        let slices: Vec<&[ScreenCodec]> = decodes.iter().map(Vec::as_slice).collect();
        let (wanted, each) = choose(&encode, &slices);
        let sound = self.sounds(sharer);

        let mut keyframes: Vec<ScreenCodec> = Vec::new();
        for (session, codec) in watching.iter().zip(each) {
            let Some(watch) = self.watches.get_mut(session) else {
                continue;
            };
            if watch.codec != codec {
                watch.codec = codec;
                watch.gated = true;
                let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                    target: Some(sharer.to_owned()),
                    codec,
                    sound,
                }));
            }
            if let (true, Some(codec)) = (watch.gated, watch.codec) {
                if !keyframes.contains(&codec) {
                    keyframes.push(codec);
                }
            }
        }
        let listening = self.listening(sharer);
        if let Some(share) = self.shares.get_mut(sharer) {
            if share.wanted != wanted || share.sounding != listening {
                share.wanted.clone_from(&wanted);
                share.sounding = listening;
                share.want();
            }
        }
        for codec in keyframes {
            self.ask_keyframe(sharer, codec, now);
        }
    }

    /// Whether `sharer`'s sound has anybody to go to: it carries some, and
    /// somebody watching it asked for it (#736).
    fn listening(&self, sharer: &str) -> bool {
        self.shares.get(sharer).is_some_and(|share| share.sound)
            && self
                .watches
                .values()
                .any(|watch| watch.sound && watch.target.as_deref() == Some(sharer))
    }

    /// What `sharer`'s watchers are told it carries: `sound: true` when it
    /// carries the computer's sound, left out otherwise.
    fn sounds(&self, sharer: &str) -> Option<bool> {
        self.shares
            .get(sharer)
            .is_some_and(|share| share.sound)
            .then_some(true)
    }

    /// Stop `session` watching, telling nobody: the caller settles and
    /// closes.
    fn take_watch(&mut self, session: &str) -> Option<Watch> {
        self.watches.remove(session)
    }
}

/// How a watcher's share went: who it watches and in which format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Showing {
    pub socket: u64,
    pub codec: Option<ScreenCodec>,
}

impl Screens {
    /// What `voice.state` says of `session`: the share it makes, and whose it
    /// watches.
    #[must_use]
    pub fn peer(&self, session: &str) -> (Option<ScreenShare>, Option<String>) {
        let board = lock(self);
        (
            board
                .shares
                .get(session)
                .map(|share| ScreenShare { fps: share.fps }),
            board
                .watches
                .get(session)
                .and_then(|watch| watch.target.clone()),
        )
    }

    /// Start `session` sharing in `room`, or share again at a new speed.
    /// Answers the new socket's number, or why not. Its watchers, if it was
    /// sharing already, carry on, waiting for a key frame.
    ///
    /// # Errors
    ///
    /// [`Closing::RoomFull`] when three others share in that room.
    pub fn share(
        &self,
        session: &str,
        room: RoomId,
        fps: u8,
        encode: Vec<ScreenCodec>,
        sound: bool,
        says: mpsc::UnboundedSender<ToShare>,
    ) -> Result<u64, Closing> {
        let mut board = lock(self);
        let others = board
            .shares
            .iter()
            .filter(|(other, share)| share.room == room && other.as_str() != session)
            .count();
        if others >= MAX_SCREENS_PER_ROOM {
            return Err(Closing::RoomFull);
        }
        let socket = board.next_socket();
        let now = Instant::now();
        let share = Share {
            room,
            fps,
            encode,
            sound,
            sounding: false,
            says,
            socket,
            wanted: Vec::new(),
            asked: HashMap::new(),
            budget: budget_cap(),
            filled: now,
        };
        if let Some(old) = board.shares.insert(session.to_owned(), share) {
            let _ = old.says.send(ToShare::Close(Closing::Replaced));
        }
        // Somebody watching from before starts again on a key frame: a new
        // share is a new encoder, which can't carry on from the old one.
        for watch in board.watches.values_mut() {
            if watch.target.as_deref() == Some(session) {
                watch.codec = None;
            }
        }
        board.shares[session].want();
        board.settle(session, now);
        Ok(socket)
    }

    /// `session`'s share socket `socket` closed. Answers the room to tell,
    /// when that ended a share. Its watchers stay connected with nothing to
    /// show.
    pub fn unshare(&self, session: &str, socket: u64) -> Option<RoomId> {
        let mut board = lock(self);
        if board
            .shares
            .get(session)
            .is_none_or(|share| share.socket != socket)
        {
            return None;
        }
        let share = board.shares.remove(session)?;
        for watch in board.watches.values_mut() {
            if watch.target.as_deref() == Some(session) {
                watch.target = None;
                watch.codec = None;
                let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                    target: None,
                    codec: None,
                    sound: None,
                }));
            }
        }
        Some(share.room)
    }

    /// Start `session` watching `target`'s share, or move its watching
    /// there. Answers the socket's number and the format it gets.
    ///
    /// # Errors
    ///
    /// [`Closing::NothingToWatch`] when `target` isn't sharing in `room`, or
    /// is `session` itself.
    pub fn watch(
        &self,
        session: &str,
        room: RoomId,
        target: &str,
        decode: Vec<ScreenCodec>,
        sound: bool,
        line: WatchLine,
    ) -> Result<Showing, Closing> {
        let mut board = lock(self);
        if target == session
            || board
                .shares
                .get(target)
                .is_none_or(|share| share.room != room)
        {
            return Err(Closing::NothingToWatch);
        }
        let socket = board.next_socket();
        let watch = Watch {
            room,
            target: Some(target.to_owned()),
            decode,
            codec: None,
            line,
            socket,
            gated: true,
            sound,
        };
        let before = board
            .watches
            .insert(session.to_owned(), watch)
            .and_then(|old| {
                let _ = old.line.says.send(ToWatch::Close(Closing::Replaced));
                old.target
            });
        let now = Instant::now();
        if let Some(before) = before.filter(|before| before != target) {
            board.settle(&before, now);
        }
        board.settle(target, now);
        let sound = board.sounds(target);
        let watch = &board.watches[session];
        if watch.codec.is_none() {
            // `settle` tells only a watcher whose format changed; one that
            // can play nothing of this share is told so here.
            let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                target: Some(target.to_owned()),
                codec: None,
                sound,
            }));
        }
        Ok(Showing {
            socket,
            codec: watch.codec,
        })
    }

    /// The watch socket `socket` asks to watch `target` instead, on the same
    /// socket. Answers the room to tell when it moved.
    ///
    /// # Errors
    ///
    /// [`Closing::NothingToWatch`] when `target` isn't sharing in its room;
    /// it then watches nothing.
    pub fn switch(
        &self,
        session: &str,
        socket: u64,
        target: &str,
        decode: Option<Vec<ScreenCodec>>,
    ) -> Result<RoomId, Closing> {
        let mut board = lock(self);
        let Some(watch) = board
            .watches
            .get(session)
            .filter(|watch| watch.socket == socket)
        else {
            return Err(Closing::Ended);
        };
        let room = watch.room;
        let before = watch.target.clone();
        let can_watch = target != session
            && board
                .shares
                .get(target)
                .is_some_and(|share| share.room == room);
        let now = Instant::now();
        let watch = board.watches.get_mut(session).ok_or(Closing::Ended)?;
        if let Some(decode) = decode {
            watch.decode = decode;
        }
        watch.target = can_watch.then(|| target.to_owned());
        watch.codec = None;
        watch.gated = true;
        if !can_watch {
            let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                target: None,
                codec: None,
                sound: None,
            }));
        }
        if let Some(before) = before.filter(|before| before != target) {
            board.settle(&before, now);
        }
        if can_watch {
            board.settle(target, now);
            let sound = board.sounds(target);
            let watch = &board.watches[session];
            if watch.codec.is_none() {
                let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                    target: Some(target.to_owned()),
                    codec: None,
                    sound,
                }));
            }
            Ok(room)
        } else {
            Err(Closing::NothingToWatch)
        }
    }

    /// The watch socket `socket` closed. Answers the room to tell, when that
    /// ended its watching.
    pub fn unwatch(&self, session: &str, socket: u64) -> Option<RoomId> {
        let mut board = lock(self);
        if board
            .watches
            .get(session)
            .is_none_or(|watch| watch.socket != socket)
        {
            return None;
        }
        let watch = board.take_watch(session)?;
        if let Some(target) = &watch.target {
            board.settle(target, Instant::now());
        }
        Some(watch.room)
    }

    /// The watcher on socket `socket` lost its place: hold its frames until a
    /// key frame, and ask for one.
    pub fn keyframe(&self, session: &str, socket: u64) {
        let mut board = lock(self);
        let Some(watch) = board
            .watches
            .get_mut(session)
            .filter(|watch| watch.socket == socket)
        else {
            return;
        };
        watch.gated = true;
        if let (Some(target), Some(codec)) = (watch.target.clone(), watch.codec) {
            board.ask_keyframe(&target, codec, Instant::now());
        }
    }

    /// The watcher on socket `socket` turned the share's sound on or off
    /// (#736): its sharer is told whether anybody still wants it.
    pub fn hear(&self, session: &str, socket: u64, on: bool) {
        let mut board = lock(self);
        let Some(watch) = board
            .watches
            .get_mut(session)
            .filter(|watch| watch.socket == socket)
        else {
            return;
        };
        watch.sound = on;
        if let Some(target) = watch.target.clone() {
            let listening = board.listening(&target);
            if let Some(share) = board.shares.get_mut(&target) {
                if share.sounding != listening {
                    share.sounding = listening;
                    share.want();
                }
            }
        }
    }

    /// A sound packet from `session`'s share socket `socket` (#736): pass it
    /// to each of its watchers that asked for sound, unless the share never
    /// said it carries any or is over its ceiling, which sound counts toward.
    /// Never held for a key frame; a watcher whose sound line is full goes
    /// without this one. Answers whether it went anywhere (for tests).
    pub fn sound(&self, session: &str, socket: u64, packet: &Bytes) -> bool {
        self.sound_at(session, socket, packet, Instant::now())
    }

    /// [`Self::sound`] at a given moment, as [`Self::frame_at`].
    fn sound_at(&self, session: &str, socket: u64, packet: &Bytes, now: Instant) -> bool {
        if packet.len() > MAX_SCREEN_SOUND_BYTES || ScreenSoundHead::read(packet).is_none() {
            return false;
        }
        let mut board = lock(self);
        let Some(share) = board
            .shares
            .get_mut(session)
            .filter(|share| share.socket == socket && share.sound)
        else {
            return false;
        };
        if !share.afford(packet.len(), now) {
            return false;
        }
        let mut went = false;
        for watch in board.watches.values() {
            if !watch.sound || watch.target.as_deref() != Some(session) {
                continue;
            }
            // Full, it's behind: this packet is dropped, not queued.
            went |= watch.line.sound.try_send(packet.clone()).is_ok();
        }
        went
    }

    /// A frame from `session`'s share socket `socket`: pass it to each of its
    /// watchers in that format, unless the share is over its ceiling.
    /// Answers whether it went anywhere (for tests).
    pub fn frame(&self, session: &str, socket: u64, frame: &Bytes) -> bool {
        self.frame_at(session, socket, frame, Instant::now())
    }

    /// [`Self::frame`] at a given moment, so a test of the ceiling doesn't
    /// depend on how fast the machine runs it.
    fn frame_at(&self, session: &str, socket: u64, frame: &Bytes, now: Instant) -> bool {
        let Some(head) = ScreenFrameHead::read(frame) else {
            return false;
        };
        let mut board = lock(self);
        let Some(share) = board
            .shares
            .get_mut(session)
            .filter(|share| share.socket == socket)
        else {
            return false;
        };
        if !share.wanted.contains(&head.codec) {
            return false;
        }
        let over = !share.afford(frame.len(), now);

        let mut went = false;
        let mut behind = false;
        for watch in board.watches.values_mut() {
            if watch.target.as_deref() != Some(session) || watch.codec != Some(head.codec) {
                continue;
            }
            if over {
                // Frames after a dropped one can't be played until a key frame.
                watch.gated = true;
                continue;
            }
            if watch.gated {
                if !head.key {
                    // A key frame is asked for on its behalf once it can
                    // take one: asked for while it's still full, the sharer
                    // sent one twice a second for as long as it stayed
                    // behind, and it took none of them.
                    behind |= watch.has_room();
                    continue;
                }
                watch.gated = false;
            }
            if watch.line.queued.load(Ordering::Relaxed) + frame.len() > MAX_SCREEN_WATCH_BYTES {
                // Too much waiting for it already, however few frames: it
                // waits for a key frame, asked for once it has room, and is
                // told its picture was behind.
                watch.gated = true;
                watch.tell_behind();
                continue;
            }
            match watch.line.frames.try_send(frame.clone()) {
                Ok(()) => {
                    watch.line.queued.fetch_add(frame.len(), Ordering::Relaxed);
                    went = true;
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // It fell behind: skip it forward to the next key frame,
                    // asked for once it has room, and tell it so.
                    watch.gated = true;
                    watch.tell_behind();
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {}
            }
        }
        if behind && !over {
            board.ask_keyframe(session, head.codec, now);
        }
        went
    }

    /// `session` left voice, or ended: end its share and its watching, each
    /// socket told why. Answers whether anything ended; the caller is already
    /// telling the room.
    pub fn leave(&self, session: &str) -> bool {
        let mut board = lock(self);
        let mut ended = false;
        if let Some(share) = board.shares.remove(session) {
            ended = true;
            let _ = share.says.send(ToShare::Close(Closing::Ended));
            for watch in board.watches.values_mut() {
                if watch.target.as_deref() == Some(session) {
                    watch.target = None;
                    watch.codec = None;
                    let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                        target: None,
                        codec: None,
                        sound: None,
                    }));
                }
            }
        }
        if let Some(watch) = board.take_watch(session) {
            ended = true;
            let _ = watch.line.says.send(ToWatch::Close(Closing::Ended));
            if let Some(target) = &watch.target {
                board.settle(target, Instant::now());
            }
        }
        ended
    }

    /// The other sessions whose watching `session` leaving ended, so their
    /// rooms are told too. A share ending changes its watchers' `watching`.
    #[must_use]
    pub fn watchers_of(&self, session: &str) -> Vec<String> {
        let board = lock(self);
        board
            .watches
            .iter()
            .filter(|(_, watch)| watch.target.as_deref() == Some(session))
            .map(|(watcher, _)| watcher.clone())
            .collect()
    }
}

#[allow(clippy::cast_precision_loss)]
fn bytes_per_second() -> f64 {
    SCREEN_MAX_BITS_PER_SECOND as f64 / 8.0
}

#[allow(clippy::cast_precision_loss)]
fn budget_cap() -> f64 {
    SCREEN_BURST_BYTES as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use linger_core::limits::{SCREEN_SOUND_QUEUE, SCREEN_WATCH_QUEUE};

    const VP8: ScreenCodec = ScreenCodec::Vp8;
    const AVC: ScreenCodec = ScreenCodec::Avc1;

    fn room() -> RoomId {
        RoomId::new()
    }

    fn frame(codec: ScreenCodec, key: bool, size: usize) -> Bytes {
        let mut bytes = ScreenFrameHead { codec, key }.write(0).to_vec();
        bytes.resize(bytes.len() + size, 7);
        Bytes::from(bytes)
    }

    struct Sharer {
        socket: u64,
        says: mpsc::UnboundedReceiver<ToShare>,
    }

    impl Sharer {
        fn start(screens: &Screens, session: &str, room: RoomId, encode: &[ScreenCodec]) -> Self {
            let (tx, says) = mpsc::unbounded_channel();
            let socket = screens
                .share(session, room, 30, encode.to_vec(), false, tx)
                .expect("a share");
            Self { socket, says }
        }

        fn heard(&mut self) -> Vec<ScreenShareSays> {
            let mut heard = Vec::new();
            while let Ok(ToShare::Say(say)) = self.says.try_recv() {
                heard.push(say);
            }
            heard
        }
    }

    struct Watcher {
        socket: u64,
        frames: mpsc::Receiver<Bytes>,
        sound: mpsc::Receiver<Bytes>,
        says: mpsc::UnboundedReceiver<ToWatch>,
        queued: Arc<AtomicUsize>,
    }

    impl Watcher {
        fn start(
            screens: &Screens,
            session: &str,
            room: RoomId,
            target: &str,
            decode: &[ScreenCodec],
        ) -> Self {
            Self::listening(screens, session, room, target, decode, false)
        }

        /// A watcher that asked for the share's sound, or didn't.
        fn listening(
            screens: &Screens,
            session: &str,
            room: RoomId,
            target: &str,
            decode: &[ScreenCodec],
            sound: bool,
        ) -> Self {
            let (frames_tx, frames) = mpsc::channel(SCREEN_WATCH_QUEUE);
            let (sound_tx, sound_rx) = mpsc::channel(SCREEN_SOUND_QUEUE);
            let (says_tx, says) = mpsc::unbounded_channel();
            let queued = Arc::new(AtomicUsize::new(0));
            let showing = screens
                .watch(
                    session,
                    room,
                    target,
                    decode.to_vec(),
                    sound,
                    WatchLine {
                        frames: frames_tx,
                        sound: sound_tx,
                        says: says_tx,
                        queued: Arc::clone(&queued),
                    },
                )
                .expect("watching");
            Self {
                socket: showing.socket,
                frames,
                sound: sound_rx,
                says,
                queued,
            }
        }

        /// The sound packets waiting for it.
        fn heard(&mut self) -> usize {
            let mut heard = 0;
            while self.sound.try_recv().is_ok() {
                heard += 1;
            }
            heard
        }

        /// Take what's waiting, as the socket does: the bytes go with it.
        fn got(&mut self) -> usize {
            let mut got = 0;
            while let Ok(frame) = self.frames.try_recv() {
                self.queued.fetch_sub(frame.len(), Ordering::Relaxed);
                got += 1;
            }
            got
        }
    }

    #[test]
    fn the_server_picks_one_format_everybody_plays_or_each_their_own() {
        // Everybody plays H.264: H.264 alone, the sharer's first.
        assert_eq!(
            choose(&[AVC, VP8], &[&[AVC, VP8], &[AVC]]),
            (vec![AVC], vec![Some(AVC), Some(AVC)])
        );
        // One can't: VP8 for everybody, rather than two encoders.
        assert_eq!(
            choose(&[AVC, VP8], &[&[AVC, VP8], &[VP8]]),
            (vec![VP8], vec![Some(VP8), Some(VP8)])
        );
        // An iPhone that plays only H.264 and a Linux app that plays only
        // VP8: the sharer makes both.
        assert_eq!(
            choose(&[AVC, VP8], &[&[AVC], &[VP8]]),
            (vec![AVC, VP8], vec![Some(AVC), Some(VP8)])
        );
        // A watcher that plays nothing the sharer makes gets nothing.
        assert_eq!(choose(&[VP8], &[&[AVC]]), (vec![], vec![None]));
        // Nobody watching: nothing made.
        assert_eq!(choose(&[AVC, VP8], &[]), (vec![], vec![]));
    }

    #[test]
    fn a_fourth_share_in_a_room_is_refused_and_sharing_again_replaces() {
        let screens = Screens::default();
        let here = room();
        let _a = Sharer::start(&screens, "a", here, &[VP8]);
        let mut b = Sharer::start(&screens, "b", here, &[VP8]);
        let _c = Sharer::start(&screens, "c", here, &[VP8]);
        let (tx, _rx) = mpsc::unbounded_channel();
        assert_eq!(
            screens.share("d", here, 30, vec![VP8], false, tx),
            Err(Closing::RoomFull)
        );
        // Another room has room.
        let _elsewhere = Sharer::start(&screens, "d", room(), &[VP8]);
        // One of the three sharing again at 60 is allowed, and closes its
        // old socket; the old socket closing then ends nothing.
        let (tx, _rx) = mpsc::unbounded_channel();
        let again = screens
            .share("b", here, 60, vec![VP8], false, tx)
            .expect("again");
        assert!(replaced(&mut b.says));
        assert_eq!(screens.unshare("b", b.socket), None);
        assert_eq!(screens.peer("b").0, Some(ScreenShare { fps: 60 }));
        assert_eq!(screens.unshare("b", again), Some(here));
        assert_eq!(screens.peer("b").0, None);
    }

    #[test]
    fn a_watcher_waits_for_a_key_frame_and_the_sharer_is_asked_for_one() {
        let screens = Screens::default();
        let here = room();
        let mut sharer = Sharer::start(&screens, "s", here, &[AVC, VP8]);
        // Nobody watching: the sharer is asked for nothing.
        assert_eq!(
            sharer.heard(),
            vec![ScreenShareSays::Want {
                codecs: vec![],
                sound: None
            }]
        );
        assert!(!screens.frame("s", sharer.socket, &frame(VP8, true, 10)));

        let mut watcher = Watcher::start(&screens, "w", here, "s", &[VP8]);
        assert_eq!(
            sharer.heard(),
            vec![
                ScreenShareSays::Want {
                    codecs: vec![VP8],
                    sound: None
                },
                ScreenShareSays::Keyframe { codec: VP8 },
            ]
        );
        assert_eq!(screens.peer("w").1.as_deref(), Some("s"));
        // A frame in a format nobody asked for goes nowhere.
        assert!(!screens.frame("s", sharer.socket, &frame(AVC, true, 10)));
        // An ordinary frame before the key frame goes nowhere either.
        assert!(!screens.frame("s", sharer.socket, &frame(VP8, false, 10)));
        assert!(screens.frame("s", sharer.socket, &frame(VP8, true, 10)));
        assert!(screens.frame("s", sharer.socket, &frame(VP8, false, 10)));
        assert_eq!(watcher.got(), 2);
        // The watcher asking again holds it until the next key frame.
        screens.keyframe("w", watcher.socket);
        assert!(!screens.frame("s", sharer.socket, &frame(VP8, false, 10)));
        assert!(screens.frame("s", sharer.socket, &frame(VP8, true, 10)));
        assert_eq!(watcher.got(), 1);
    }

    #[test]
    fn a_watcher_that_falls_behind_is_skipped_forward_and_the_others_dont_wait() {
        let screens = Screens::default();
        let here = room();
        let mut sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let mut slow = Watcher::start(&screens, "slow", here, "s", &[VP8]);
        let mut quick = Watcher::start(&screens, "quick", here, "s", &[VP8]);
        let _ = sharer.heard();
        assert!(screens.frame("s", sharer.socket, &frame(VP8, true, 10)));
        // `quick` reads as it goes; `slow` reads nothing until its queue is
        // full, then one more frame finds it behind.
        let mut quick_got = quick.got();
        for _ in 0..SCREEN_WATCH_QUEUE {
            assert!(screens.frame("s", sharer.socket, &frame(VP8, false, 10)));
            quick_got += quick.got();
        }
        assert_eq!(quick_got, SCREEN_WATCH_QUEUE + 1);
        assert_eq!(slow.got(), SCREEN_WATCH_QUEUE);
        // The asks for a key frame are rate-limited; let the window pass.
        std::thread::sleep(Duration::from_millis(SCREEN_KEYFRAME_EVERY_MS + 50));
        // Behind: the frames it missed aren't sent later, and a key frame is
        // asked for. `quick` keeps getting everything meanwhile.
        for _ in 0..SCREEN_WATCH_QUEUE {
            assert!(screens.frame("s", sharer.socket, &frame(VP8, false, 10)));
        }
        assert_eq!(
            slow.got(),
            0,
            "nothing reached `slow` past where it fell behind"
        );
        assert_eq!(quick.got(), SCREEN_WATCH_QUEUE);
        assert!(sharer
            .heard()
            .contains(&ScreenShareSays::Keyframe { codec: VP8 }));
        // Once caught up, it carries on from the next key frame.
        assert!(screens.frame("s", sharer.socket, &frame(VP8, true, 10)));
        assert!(screens.frame("s", sharer.socket, &frame(VP8, false, 10)));
        assert_eq!(slow.got(), 2);
    }

    #[test]
    fn a_watcher_that_stays_behind_asks_for_no_key_frames_until_it_can_take_one() {
        let screens = Screens::default();
        let here = room();
        let mut sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let mut stuck = Watcher::start(&screens, "stuck", here, "s", &[VP8]);
        let mut quick = Watcher::start(&screens, "quick", here, "s", &[VP8]);
        let start = Instant::now() + Duration::from_millis(1);
        let at = |tenths: u64| start + Duration::from_millis(tenths * 100);
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, true, 10), at(0)));
        let _ = sharer.heard();
        // `stuck` reads nothing (a phone in the background, a line that
        // stalled): its queue fills, and it falls behind. Ten seconds of
        // frames go by, key frames among them, while `quick` reads as it goes.
        let mut quick_got = quick.got();
        for tenth in 1..=100 {
            assert!(screens.frame_at(
                "s",
                sharer.socket,
                &frame(VP8, tenth % 20 == 0, 10),
                at(tenth)
            ));
            quick_got += quick.got();
        }
        assert_eq!(quick_got, 101);
        // No key frame was asked for on its behalf: it could take none.
        assert_eq!(sharer.heard(), vec![]);
        // It was told its picture was behind, again at each key frame it
        // couldn't take; `quick` heard nothing of it.
        let behind = |says: &mut mpsc::UnboundedReceiver<ToWatch>| {
            let mut told = 0;
            while let Ok(said) = says.try_recv() {
                told += usize::from(matches!(said, ToWatch::Say(ScreenWatchSays::Behind)));
            }
            told
        };
        assert!(behind(&mut stuck.says) >= 1);
        assert_eq!(behind(&mut quick.says), 0);
        // Once it has read what it holds, one is asked for, and it carries on from it.
        assert_eq!(stuck.got(), SCREEN_WATCH_QUEUE);
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, false, 10), at(101)));
        assert_eq!(
            sharer.heard(),
            vec![ScreenShareSays::Keyframe { codec: VP8 }]
        );
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, true, 10), at(102)));
        assert_eq!(stuck.got(), 1);
    }

    #[test]
    fn a_share_over_its_ceiling_is_dropped_and_its_watchers_wait_for_a_key_frame() {
        let screens = Screens::default();
        let here = room();
        let sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let mut watcher = Watcher::start(&screens, "w", here, "s", &[VP8]);
        // One moment for all of it: the bucket fills only as time passes.
        let at = Instant::now() + Duration::from_millis(1);
        let big = usize::try_from(SCREEN_BURST_BYTES / 4).expect("fits") - 2_000;
        // Four nearly quarter-bursts at once fit; a fifth is over.
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, true, big), at));
        for _ in 0..3 {
            assert!(screens.frame_at("s", sharer.socket, &frame(VP8, false, big), at));
        }
        assert!(!screens.frame_at("s", sharer.socket, &frame(VP8, false, big), at));
        assert_eq!(watcher.got(), 4);
        // A small frame after it is under the ceiling, but follows a dropped
        // one, so it waits for a key frame.
        assert!(!screens.frame_at("s", sharer.socket, &frame(VP8, false, 10), at));
        // A fifth of a second later the bucket holds a quarter of a megabyte.
        let later = at + Duration::from_millis(200);
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, true, 10), later));
        assert_eq!(watcher.got(), 1);
    }

    #[test]
    fn a_share_ending_tells_its_watchers_and_leaving_voice_ends_both() {
        let screens = Screens::default();
        let here = room();
        let sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let mut watcher = Watcher::start(&screens, "w", here, "s", &[VP8]);
        while watcher.says.try_recv().is_ok() {}
        assert_eq!(screens.unshare("s", sharer.socket), Some(here));
        assert!(matches!(
            watcher.says.try_recv(),
            Ok(ToWatch::Say(ScreenWatchSays::Showing {
                target: None,
                codec: None,
                sound: None,
            }))
        ));
        assert_eq!(screens.peer("w").1, None);

        // Leaving voice closes a watch socket with 4007.
        let _again = Sharer::start(&screens, "s", here, &[VP8]);
        assert!(screens.switch("w", watcher.socket, "s", None).is_ok());
        assert!(screens.leave("w"));
        let mut closed = false;
        while let Ok(say) = watcher.says.try_recv() {
            closed |= matches!(say, ToWatch::Close(Closing::Ended));
        }
        assert!(closed);
        assert!(!screens.leave("w"));
    }

    #[test]
    fn a_watcher_holding_too_many_bytes_is_skipped_forward_however_few_frames() {
        let screens = Screens::default();
        let here = room();
        let sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let mut watcher = Watcher::start(&screens, "w", here, "s", &[VP8]);
        // Frames of most of a megabyte, a second apart so the ceiling allows
        // each: the watcher reads none of them.
        let start = Instant::now() + Duration::from_millis(1);
        let big = 900 * 1024;
        let sent = (0..6)
            .filter(|at| {
                screens.frame_at(
                    "s",
                    sharer.socket,
                    &frame(VP8, *at == 0, big),
                    start + Duration::from_secs(*at),
                )
            })
            .count();
        // Four fit under MAX_SCREEN_WATCH_BYTES; past that it's held, not queued.
        assert_eq!(sent, MAX_SCREEN_WATCH_BYTES / (big + 12));
        assert!(watcher.queued.load(Ordering::Relaxed) <= MAX_SCREEN_WATCH_BYTES);
        // Once it has read them it carries on, from a key frame.
        assert_eq!(watcher.got(), sent);
        assert_eq!(watcher.queued.load(Ordering::Relaxed), 0);
        let later = start + Duration::from_secs(10);
        assert!(!screens.frame_at("s", sharer.socket, &frame(VP8, false, 10), later));
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, true, 10), later));
    }

    #[test]
    fn nobody_watches_themselves_or_a_share_in_another_room() {
        let screens = Screens::default();
        let here = room();
        let _sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let line = || {
            let (frames, _f) = mpsc::channel(1);
            let (sound, _a) = mpsc::channel(1);
            let (says, _s) = mpsc::unbounded_channel();
            WatchLine {
                frames,
                sound,
                says,
                queued: Arc::new(AtomicUsize::new(0)),
            }
        };
        assert_eq!(
            screens.watch("s", here, "s", vec![VP8], false, line()),
            Err(Closing::NothingToWatch)
        );
        assert_eq!(
            screens.watch("w", room(), "s", vec![VP8], false, line()),
            Err(Closing::NothingToWatch)
        );
        assert_eq!(
            screens.watch("w", here, "nobody", vec![VP8], false, line()),
            Err(Closing::NothingToWatch)
        );
    }

    fn sound(size: usize) -> Bytes {
        let mut bytes = ScreenSoundHead { micros: 0 }.write().to_vec();
        bytes.resize(bytes.len() + size, 3);
        Bytes::from(bytes)
    }

    /// A share that carries sound, as its hello says.
    fn sounding(screens: &Screens, session: &str, room: RoomId) -> Sharer {
        let (tx, says) = mpsc::unbounded_channel();
        let socket = screens
            .share(session, room, 30, vec![VP8], true, tx)
            .expect("a share");
        Sharer { socket, says }
    }

    #[test]
    fn sound_goes_to_the_watchers_who_asked_and_the_sharer_is_told_when_anybody_has() {
        let screens = Screens::default();
        let here = room();
        let mut sharer = sounding(&screens, "s", here);
        let mut deaf = Watcher::start(&screens, "deaf", here, "s", &[VP8]);
        // Nobody asked for sound yet: the sharer is asked for none.
        assert!(sharer.heard().iter().all(|said| !matches!(
            said,
            ScreenShareSays::Want {
                sound: Some(true),
                ..
            }
        )));
        assert!(!screens.sound("s", sharer.socket, &sound(300)));
        // A watcher who asks: the sharer is told to send it, and it goes to
        // that watcher alone, with no key frame first.
        let mut ears = Watcher::listening(&screens, "ears", here, "s", &[VP8], true);
        assert_eq!(
            sharer.heard(),
            vec![ScreenShareSays::Want {
                codecs: vec![VP8],
                sound: Some(true)
            }]
        );
        assert!(screens.sound("s", sharer.socket, &sound(300)));
        assert_eq!(ears.heard(), 1);
        assert_eq!(deaf.heard(), 0);
        // A frame isn't sound, nor is sound a frame.
        assert!(!screens.sound("s", sharer.socket, &frame(VP8, true, 300)));
        assert!(!screens.frame("s", sharer.socket, &sound(300)));
        assert_eq!(ears.got() + deaf.got(), 0);
        // Its sound button off: none goes, and the sharer is told nobody wants it.
        screens.hear("ears", ears.socket, false);
        assert_eq!(
            sharer.heard(),
            vec![ScreenShareSays::Want {
                codecs: vec![VP8],
                sound: None
            }]
        );
        assert!(!screens.sound("s", sharer.socket, &sound(300)));
        screens.hear("ears", ears.socket, true);
        assert!(screens.sound("s", sharer.socket, &sound(300)));
        assert_eq!(ears.heard(), 1);
        // Both are told the share carries sound.
        let carries = |says: &mut mpsc::UnboundedReceiver<ToWatch>| {
            let mut told = false;
            while let Ok(said) = says.try_recv() {
                told |= matches!(
                    said,
                    ToWatch::Say(ScreenWatchSays::Showing {
                        sound: Some(true),
                        ..
                    })
                );
            }
            told
        };
        assert!(carries(&mut deaf.says));
        assert!(carries(&mut ears.says));
    }

    #[test]
    fn sound_from_a_share_that_never_said_so_or_too_big_is_dropped() {
        let screens = Screens::default();
        let here = room();
        let silent = Sharer::start(&screens, "quiet", here, &[VP8]);
        let mut ears = Watcher::listening(&screens, "ears", here, "quiet", &[VP8], true);
        assert!(!screens.sound("quiet", silent.socket, &sound(300)));
        assert_eq!(ears.heard(), 0);
        // A share that does carry sound, but a packet over the biggest.
        let loud = sounding(&screens, "loud", here);
        let mut other = Watcher::listening(&screens, "other", here, "loud", &[VP8], true);
        assert!(!screens.sound("loud", loud.socket, &sound(MAX_SCREEN_SOUND_BYTES)));
        assert!(screens.sound("loud", loud.socket, &sound(300)));
        assert_eq!(other.heard(), 1);
        // Nothing of another share reaches the first's watcher.
        assert_eq!(ears.heard(), 0);
    }

    #[test]
    fn sound_counts_toward_the_ceiling_and_never_waits_for_a_key_frame() {
        let screens = Screens::default();
        let here = room();
        let sharer = sounding(&screens, "s", here);
        let mut watcher = Watcher::listening(&screens, "w", here, "s", &[VP8], true);
        let at = Instant::now() + Duration::from_millis(1);
        // The watcher is still waiting for its first key frame: sound goes anyway.
        assert!(!screens.frame_at("s", sharer.socket, &frame(VP8, false, 10), at));
        assert!(screens.sound_at("s", sharer.socket, &sound(300), at));
        assert_eq!(watcher.heard(), 1);
        // Spend the whole ceiling on frames, all at one moment.
        let big = usize::try_from(SCREEN_BURST_BYTES / 4).expect("fits") - 2_000;
        assert!(screens.frame_at("s", sharer.socket, &frame(VP8, true, big), at));
        for _ in 0..3 {
            assert!(screens.frame_at("s", sharer.socket, &frame(VP8, false, big), at));
        }
        let left = SCREEN_BURST_BYTES as usize - 4 * (big + 12) - (300 + 12);
        // What's left goes on sound, a packet at a time, until it's gone.
        let packet = 1_000;
        let fits = left / (packet + 12);
        for _ in 0..fits {
            assert!(screens.sound_at("s", sharer.socket, &sound(packet), at));
            watcher.heard();
        }
        assert!(!screens.sound_at("s", sharer.socket, &sound(packet), at));
        // Sound took the room a frame would have had.
        assert!(!screens.frame_at("s", sharer.socket, &frame(VP8, true, packet), at));
        // A moment later there's room again, for both.
        let later = at + Duration::from_millis(100);
        assert!(screens.sound_at("s", sharer.socket, &sound(packet), later));
    }

    #[test]
    fn a_watcher_whose_sound_line_is_full_goes_without_and_nothing_else_waits() {
        let screens = Screens::default();
        let here = room();
        let sharer = sounding(&screens, "s", here);
        let mut slow = Watcher::listening(&screens, "slow", here, "s", &[VP8], true);
        let mut quick = Watcher::listening(&screens, "quick", here, "s", &[VP8], true);
        let mut quick_heard = 0;
        for _ in 0..SCREEN_SOUND_QUEUE * 3 {
            assert!(screens.sound("s", sharer.socket, &sound(200)));
            quick_heard += quick.heard();
        }
        // `slow` read nothing: it holds a queue's worth, and the rest were
        // dropped rather than queued. `quick` had every one.
        assert_eq!(slow.heard(), SCREEN_SOUND_QUEUE);
        assert_eq!(quick_heard, SCREEN_SOUND_QUEUE * 3);
        // It isn't told its picture is behind: sound isn't its picture.
        while let Ok(said) = slow.says.try_recv() {
            assert!(!matches!(said, ToWatch::Say(ScreenWatchSays::Behind)));
        }
        // And it carries on once it has read them.
        assert!(screens.sound("s", sharer.socket, &sound(200)));
        assert_eq!(slow.heard(), 1);
    }

    /// Whether the board told this share socket it was replaced.
    fn replaced(says: &mut mpsc::UnboundedReceiver<ToShare>) -> bool {
        let mut closed = false;
        while let Ok(said) = says.try_recv() {
            closed |= matches!(said, ToShare::Close(Closing::Replaced));
        }
        closed
    }
}
