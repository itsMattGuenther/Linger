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
//! a key frame from the header, and hands every watcher the same bytes.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use linger_core::limits::{
    MAX_SCREENS_PER_ROOM, SCREEN_BURST_BYTES, SCREEN_KEYFRAME_EVERY_MS, SCREEN_MAX_BITS_PER_SECOND,
};
use linger_core::screen::{
    ScreenCodec, ScreenFrameHead, ScreenShare, ScreenShareSays, ScreenWatchSays,
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
/// that falls behind is noticed, and everything else on its own, so nothing
/// the board says is ever dropped.
pub struct WatchLine {
    pub frames: mpsc::Sender<Bytes>,
    pub says: mpsc::UnboundedSender<ToWatch>,
}

struct Share {
    room: RoomId,
    fps: u8,
    encode: Vec<ScreenCodec>,
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
                }));
            }
            if let (true, Some(codec)) = (watch.gated, watch.codec) {
                if !keyframes.contains(&codec) {
                    keyframes.push(codec);
                }
            }
        }
        if let Some(share) = self.shares.get_mut(sharer) {
            if share.wanted != wanted {
                share.wanted.clone_from(&wanted);
                let _ = share
                    .says
                    .send(ToShare::Say(ScreenShareSays::Want { codecs: wanted }));
            }
        }
        for codec in keyframes {
            self.ask_keyframe(sharer, codec, now);
        }
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
        let _ = board.shares[session]
            .says
            .send(ToShare::Say(ScreenShareSays::Want { codecs: Vec::new() }));
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
        let watch = &board.watches[session];
        if watch.codec.is_none() {
            // `settle` tells only a watcher whose format changed; one that
            // can play nothing of this share is told so here.
            let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                target: Some(target.to_owned()),
                codec: None,
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
            }));
        }
        if let Some(before) = before.filter(|before| before != target) {
            board.settle(&before, now);
        }
        if can_watch {
            board.settle(target, now);
            let watch = &board.watches[session];
            if watch.codec.is_none() {
                let _ = watch.line.says.send(ToWatch::Say(ScreenWatchSays::Showing {
                    target: Some(target.to_owned()),
                    codec: None,
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
        // The ceiling: a bucket that fills at SCREEN_MAX_BITS_PER_SECOND and
        // holds SCREEN_BURST_BYTES.
        let elapsed = now.saturating_duration_since(share.filled).as_secs_f64();
        share.filled = now;
        share.budget = (share.budget + elapsed * bytes_per_second()).min(budget_cap());
        #[allow(clippy::cast_precision_loss)]
        let cost = frame.len() as f64;
        let over = share.budget < cost;
        if !over {
            share.budget -= cost;
        }

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
                    behind = true;
                    continue;
                }
                watch.gated = false;
            }
            match watch.line.frames.try_send(frame.clone()) {
                Ok(()) => went = true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // It fell behind: skip it forward to the next key frame.
                    watch.gated = true;
                    behind = true;
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
    use linger_core::limits::SCREEN_WATCH_QUEUE;

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
                .share(session, room, 30, encode.to_vec(), tx)
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
        says: mpsc::UnboundedReceiver<ToWatch>,
    }

    impl Watcher {
        fn start(
            screens: &Screens,
            session: &str,
            room: RoomId,
            target: &str,
            decode: &[ScreenCodec],
        ) -> Self {
            let (frames_tx, frames) = mpsc::channel(SCREEN_WATCH_QUEUE);
            let (says_tx, says) = mpsc::unbounded_channel();
            let showing = screens
                .watch(
                    session,
                    room,
                    target,
                    decode.to_vec(),
                    WatchLine {
                        frames: frames_tx,
                        says: says_tx,
                    },
                )
                .expect("watching");
            Self {
                socket: showing.socket,
                frames,
                says,
            }
        }

        fn got(&mut self) -> usize {
            let mut got = 0;
            while self.frames.try_recv().is_ok() {
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
            screens.share("d", here, 30, vec![VP8], tx),
            Err(Closing::RoomFull)
        );
        // Another room has room.
        let _elsewhere = Sharer::start(&screens, "d", room(), &[VP8]);
        // One of the three sharing again at 60 is allowed, and closes its
        // old socket; the old socket closing then ends nothing.
        let (tx, _rx) = mpsc::unbounded_channel();
        let again = screens.share("b", here, 60, vec![VP8], tx).expect("again");
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
            vec![ScreenShareSays::Want { codecs: vec![] }]
        );
        assert!(!screens.frame("s", sharer.socket, &frame(VP8, true, 10)));

        let mut watcher = Watcher::start(&screens, "w", here, "s", &[VP8]);
        assert_eq!(
            sharer.heard(),
            vec![
                ScreenShareSays::Want { codecs: vec![VP8] },
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
                codec: None
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
    fn nobody_watches_themselves_or_a_share_in_another_room() {
        let screens = Screens::default();
        let here = room();
        let _sharer = Sharer::start(&screens, "s", here, &[VP8]);
        let line = || {
            let (frames, _f) = mpsc::channel(1);
            let (says, _s) = mpsc::unbounded_channel();
            WatchLine { frames, says }
        };
        assert_eq!(
            screens.watch("s", here, "s", vec![VP8], line()),
            Err(Closing::NothingToWatch)
        );
        assert_eq!(
            screens.watch("w", room(), "s", vec![VP8], line()),
            Err(Closing::NothingToWatch)
        );
        assert_eq!(
            screens.watch("w", here, "nobody", vec![VP8], line()),
            Err(Closing::NothingToWatch)
        );
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
