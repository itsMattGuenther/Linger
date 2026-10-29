import type { ServerFrame } from "../generated/ServerFrame";
import type { VoicePeer } from "../generated/VoicePeer";
import type { GatewayState, MyVoice } from "./gateway";
import type { SoundCue } from "./sound";

/** Membership snapshots are silent unless our own voice session is affected. */
export function voiceCue(frame: ServerFrame, before: GatewayState, after: GatewayState): SoundCue | null {
  if (frame.op !== "voice.state" || before.sessionId === null) return null;
  const mine = before.myVoice;
  if (mine === null || mine.roomId !== frame.d.room_id) return null;
  const old = before.voice[mine.roomId] ?? [];
  const next = after.voice[mine.roomId] ?? [];
  const seated = next.some((peer) => peer.session_id === before.sessionId);
  if (!seated) return null;
  if (!old.some((peer) => peer.session_id === before.sessionId)) return mine.moved ? "voice-move" : "voice-join";
  const oldIds = new Set(old.map((peer) => peer.session_id));
  const nextIds = new Set(next.map((peer) => peer.session_id));
  if (next.some((peer) => !oldIds.has(peer.session_id))) return "peer-join";
  if (old.some((peer) => !nextIds.has(peer.session_id))) return "peer-leave";
  return null;
}

/** A person's arriving, and their leaving, each sound at most this often for you (#473). */
export const PEER_CUE_EVERY_MS = 60_000;

/**
 * Keeps somebody joining and leaving voice over and over from ringing
 * everybody already in it each time (#473). Each person's arriving and
 * leaving sound at most once a minute apiece, for each listener; your own
 * join, leave and move are yours and always sound. By person, not session:
 * one person's laptop and desktop arriving together is one arrival.
 */
export class PeerCueLimit {
  private readonly last = new Map<string, number>();

  constructor(private readonly every = PEER_CUE_EVERY_MS) {}

  /**
   * Whether a cue about these people may sound at `now`, noting it for all
   * of them if so. One of them due is enough: a crowd arriving together
   * sounds once, and anybody new among them is worth it.
   */
  allow(cue: SoundCue, people: readonly string[], now: number): boolean {
    const due = people.some((person) => {
      const at = this.last.get(`${cue}\u0000${person}`);
      return at === undefined || now - at >= this.every;
    });
    if (!due) return false;
    for (const person of people) this.last.set(`${cue}\u0000${person}`, now);
    return true;
  }
}

/**
 * The people whose sessions arrived in the frame's room (`peer-join`), or
 * left it (`peer-leave`), each once.
 */
function peopleWho(moved: "peer-join" | "peer-leave", frame: ServerFrame, before: GatewayState, after: GatewayState): string[] {
  if (frame.op !== "voice.state") return [];
  const old = before.voice[frame.d.room_id] ?? [];
  const next = after.voice[frame.d.room_id] ?? [];
  const [was, is] = moved === "peer-join" ? [old, next] : [next, old];
  const there = new Set(was.map((peer) => peer.session_id));
  return [...new Set(is.filter((peer) => !there.has(peer.session_id)).map((peer) => peer.user_id))];
}

/** The voice cue this frame should play, if any, with other people's cues limited (#473). */
export function voiceCueToPlay(frame: ServerFrame, before: GatewayState, after: GatewayState, limit: PeerCueLimit, now: number): SoundCue | null {
  const cue = voiceCue(frame, before, after);
  if ((cue !== "peer-join" && cue !== "peer-leave") || frame.op !== "voice.state") return cue;
  return limit.allow(cue, peopleWho(cue, frame, before, after), now) ? cue : null;
}

/**
 * Who is watching the screen this connection shares (#735), by person, and
 * not you yourself on another computer: null while it shares nothing in the
 * voice it's in. The server says both in `voice.state` (PROTOCOL §8), so
 * this holds whichever window the share runs in.
 */
export function watchersOfMine(state: GatewayState): ReadonlySet<string> | null {
  const mine = mySeat(state);
  if (!mine?.screen) return null;
  const peers = state.voice[state.myVoice?.roomId ?? ""] ?? [];
  return new Set(peers.filter((peer) => peer.watching === mine.session_id && peer.user_id !== mine.user_id).map((peer) => peer.user_id));
}

/** This connection's seat in the voice it's in, as the server has it. */
function mySeat(state: GatewayState): VoicePeer | undefined {
  const roomId = state.myVoice?.roomId;
  if (state.sessionId === null || roomId === undefined) return undefined;
  return (state.voice[roomId] ?? []).find((peer) => peer.session_id === state.sessionId);
}

/**
 * Who started watching your share in this frame, and who stopped (#735).
 * Starting needs a live `voice.state` to a share that was already going:
 * the first list after a share starts, and a fresh session's snapshot, say
 * where things stand, not who just came. Stopping counts on every frame,
 * a share ending or a session starting over included, for the minute below.
 */
export function watchChange(frame: ServerFrame, before: GatewayState, after: GatewayState): { started: string[]; stopped: string[] } {
  const was = watchersOfMine(before);
  const is = before.sessionId === after.sessionId ? watchersOfMine(after) : null;
  const stopped = was === null ? [] : [...was].filter((person) => is?.has(person) !== true);
  const started = was === null || is === null || frame.op !== "voice.state" ? [] : [...is].filter((person) => !was.has(person));
  return { started, stopped };
}

/**
 * How long somebody's voice join waits while you share, for the Watch that
 * may have brought them (#735). Watch joins the room's voice first, and
 * starts watching once the server has given the seat: a round trip or two,
 * well inside this on any line that can carry a screen.
 */
export const WATCH_JOIN_WAIT_MS = 2_000;

/**
 * The chime for somebody starting to watch your share (#735), with the voice
 * cues it sits beside. One for each server, in the window that holds the
 * connection (the list window), the only one that plays what frames bring:
 * so it rings once, whichever window the share runs in.
 *
 * - It rings when somebody starts watching who hasn't watched your share in
 *   the last minute ({@link PEER_CUE_EVERY_MS}, as voice arrivals, #473). So
 *   it rings at most once a minute for each person, pressing Watch, closing
 *   it and pressing it again rings once, and a watcher back after a dropped
 *   line (#725), which tries again within half a minute, is the same watch.
 * - A Watch from outside voice joins voice first, which would ring the voice
 *   join and then this. While you share, a join waits
 *   {@link WATCH_JOIN_WAIT_MS}: if the same person starts watching in that
 *   time, only this rings, and otherwise the join does, that much late. A
 *   join right after this one rang for them says nothing new either.
 */
export class WatchCues {
  /** When each person last stopped watching your share. */
  readonly #stopped = new Map<string, number>();
  /** When this last rang for each person. */
  readonly #rang = new Map<string, number>();
  /** A voice join held back while you share, and whose it is. */
  #held: { people: Set<string>; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(
    private readonly play: (cue: SoundCue) => void,
    /** Whether a join held back may still play: you're still in that voice. */
    private readonly stillThere: () => boolean = () => true,
    private readonly every = PEER_CUE_EVERY_MS,
    private readonly wait = WATCH_JOIN_WAIT_MS,
  ) {}

  /**
   * Play what one frame calls for: `voice`, the cue {@link voiceCueToPlay}
   * picked for it, and this one if somebody started watching. `live` is
   * false for a frame from a resume's replay: what it changed is noted, so
   * the minute holds across a reconnect, and nothing plays.
   */
  hear(frame: ServerFrame, before: GatewayState, after: GatewayState, voice: SoundCue | null, live: boolean, now: number): void {
    const { started, stopped } = watchChange(frame, before, after);
    for (const person of stopped) this.#stopped.set(person, now);
    const due = started.filter((person) => now - (this.#stopped.get(person) ?? Number.NEGATIVE_INFINITY) >= this.every);
    for (const person of started) this.#stopped.delete(person);
    if (!live) return;
    if (due.length > 0) {
      this.play("watcher");
      for (const person of due) this.#rang.set(person, now);
    }
    // The Watch a held join was waiting for: this rang for it, or, for
    // somebody back within the minute, it didn't, and the join plays now.
    const held = this.#held;
    if (held !== null && started.some((person) => held.people.has(person))) this.#letGo(!due.some((person) => held.people.has(person)));
    if (voice !== "peer-join") {
      if (voice !== null) this.play(voice);
      return;
    }
    const joined = peopleWho("peer-join", frame, before, after);
    if (joined.length > 0 && joined.every((person) => now - (this.#rang.get(person) ?? Number.NEGATIVE_INFINITY) < this.wait)) return;
    // Not sharing, or they're watching already, or it's you on another
    // computer: there's no ring of this one's to wait for.
    const watching = watchersOfMine(after);
    const me = mySeat(after)?.user_id;
    if (watching === null || joined.every((person) => watching.has(person) || person === me)) {
      this.play(voice);
      return;
    }
    if (this.#held !== null) {
      for (const person of joined) this.#held.people.add(person);
      return;
    }
    this.#held = { people: new Set(joined), timer: setTimeout(() => this.#letGo(true), this.wait) };
  }

  /** End a join held back: played, if `play` and you're still in that voice, or not. */
  #letGo(play: boolean): void {
    if (this.#held === null) return;
    clearTimeout(this.#held.timer);
    this.#held = null;
    if (play && this.stillThere()) this.play("peer-join");
  }
}

/** One share, by its session and its person. */
export interface ShareSeat {
  session: string;
  person: string;
}

/**
 * Who started sharing a screen in this frame, and who stopped (#746), in
 * the voice you're in. Both need a live `voice.state` with you seated there
 * before and after: joining a voice where somebody is sharing already, a
 * fresh session's list, and leaving, say where things stand, not who just
 * started or stopped. Your own share is in it too. A share that ended
 * because its person left voice isn't a stop: their leaving says so.
 */
export function shareChange(frame: ServerFrame, before: GatewayState, after: GatewayState): { started: ShareSeat[]; stopped: ShareSeat[] } {
  const none = { started: [], stopped: [] };
  if (frame.op !== "voice.state") return none;
  const roomId = frame.d.room_id;
  const old = before.voice[roomId] ?? [];
  const next = after.voice[roomId] ?? [];
  const me = before.sessionId;
  const seated = (peers: readonly VoicePeer[]) => peers.some((peer) => peer.session_id === me);
  if (me === null || me !== after.sessionId || before.myVoice?.roomId !== roomId || !seated(old) || !seated(next)) return none;
  const sharedBefore = new Set(old.filter((peer) => peer.screen).map((peer) => peer.session_id));
  const sharingNow = new Set(next.filter((peer) => peer.screen).map((peer) => peer.session_id));
  const stillHere = new Set(next.map((peer) => peer.session_id));
  const seat = (peer: VoicePeer): ShareSeat => ({ session: peer.session_id, person: peer.user_id });
  return {
    started: next.filter((peer) => peer.screen && !sharedBefore.has(peer.session_id)).map(seat),
    stopped: old.filter((peer) => peer.screen && !sharingNow.has(peer.session_id) && stillHere.has(peer.session_id)).map(seat),
  };
}

/**
 * The chords for a screen share starting or stopping in the voice you're in
 * (#746): so somebody in voice who's reading another room, or playing a
 * game, knows there's something to watch, and that it's over. One for each
 * server, in the window that holds the connection (the list window), the
 * only one that plays what frames bring.
 *
 * - Everybody in that voice hears them, the person sharing too: for them
 *   they say their share really is going, or has really ended, every time.
 * - For anybody else's share, the start and the stop each sound at most
 *   once a minute for each person ({@link PEER_CUE_EVERY_MS}), as joining
 *   and leaving voice do (#473), Matt's pick: stopping to pick another
 *   window and sharing again sounds the stop, then the start, once, and any
 *   more of it inside that minute is quiet. Their second computer starting
 *   or stopping while the first still shares is the same share.
 * - Nothing for a share already going when you join voice or connect, for a
 *   resume's replay, or for a share that ended because its person left
 *   voice: the leave sound says that.
 * - One frame with a start and a stop in it (two people) sounds the start:
 *   it's the one with something to watch, and the player takes one sound of
 *   a kind at a time.
 */
export class ShareCues {
  readonly #limit: PeerCueLimit;

  constructor(
    private readonly play: (cue: SoundCue) => void,
    every = PEER_CUE_EVERY_MS,
  ) {
    this.#limit = new PeerCueLimit(every);
  }

  /** Play what one frame calls for. `live` is false for a frame from a resume's replay. */
  hear(frame: ServerFrame, before: GatewayState, after: GatewayState, live: boolean, now: number): void {
    if (!live || frame.op !== "voice.state") return;
    const { started, stopped } = shareChange(frame, before, after);
    if (started.length === 0 && stopped.length === 0) return;
    const roomId = frame.d.room_id;
    const sharers = (peers: readonly VoicePeer[]) => new Set(peers.filter((peer) => peer.screen).map((peer) => peer.user_id));
    const sharedBefore = sharers(before.voice[roomId] ?? []);
    const sharingNow = sharers(after.voice[roomId] ?? []);
    const me = before.sessionId;
    // A person's other computer still sharing, or already sharing, is the same share.
    const starts = started.filter((one) => one.session === me || !sharedBefore.has(one.person));
    const stops = stopped.filter((one) => one.session === me || !sharingNow.has(one.person));
    if (this.#due("share", starts, me, now)) this.play("share");
    else if (this.#due("share-stop", stops, me, now)) this.play("share-stop");
  }

  /** Whether these say something: your own share always does, anybody else's once a minute. */
  #due(cue: "share" | "share-stop", shares: readonly ShareSeat[], me: string | null, now: number): boolean {
    if (shares.length === 0) return false;
    if (shares.some((one) => one.session === me)) return true;
    return this.#limit.allow(cue, shares.map((one) => one.person), now);
  }
}

/**
 * The sound that confirms a change to your own mute or deafen, if it makes
 * one. Deafening says so whatever it did to the microphone with it. Only
 * deliberate choices sound: push-to-talk's key opens and closes the
 * microphone without touching `muted` (#232), and turning push-to-talk on or
 * off doesn't either, so neither makes a sound. A Mute you choose under
 * push-to-talk is a real mute, and sounds like one.
 */
export function controlCue(before: MyVoice, after: MyVoice): SoundCue | null {
  if (before.deafened !== after.deafened) return after.deafened ? "deafen" : "undeafen";
  if (before.muted !== after.muted) return after.muted ? "mute" : "unmute";
  return null;
}
