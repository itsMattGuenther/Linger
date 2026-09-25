/**
 * The voice surface, worked out as data (SPEC §4.14, T-1404).
 *
 * Everything the bar and the picker decide — who to draw, in what order,
 * what to remember between runs — is here as pure functions and plain
 * objects, so it can be tested instead of squinted at. The components draw
 * what these return and call the store; they decide nothing themselves.
 *
 * Nothing in here counts anything (SPEC §4.2). A list of people in voice is
 * a list of names, and the bar shows the names.
 */
import type { User } from "../generated/User";
import type { VoicePeer } from "../generated/VoicePeer";
import type { VoiceControls } from "../generated/VoiceControls";
import type { VoiceDeviceChoice } from "./ipc";

const INPUT_KEY = "linger.voice.input";
const OUTPUT_KEY = "linger.voice.output";
const PTT_KEY = "linger.voice.pushToTalk";

/**
 * The key you hold to talk, when push-to-talk is on. `Control` because it
 * is on every keyboard, in the same place, and holding it while you speak
 * does not type anything into the composer. Shortcuts that use it still
 * work; the microphone is simply open for the moment they are pressed.
 */
export const PUSH_TO_TALK_KEY = "Control";

/** What voice remembers on this machine between runs. */
export interface VoicePrefs {
  /** Devices by name, or the system default for `null`. */
  devices: VoiceDeviceChoice;
  /** Start every call muted and open the microphone only while the key is held. */
  pushToTalk: boolean;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  devices: { input: null, output: null },
  pushToTalk: false,
};

/** Read the preferences, tolerating storage that is absent or refuses. */
export function loadVoicePrefs(): VoicePrefs {
  try {
    const input = window.localStorage.getItem(INPUT_KEY);
    const output = window.localStorage.getItem(OUTPUT_KEY);
    const ptt = window.localStorage.getItem(PTT_KEY);
    return {
      devices: {
        input: input === null || input === "" ? null : input,
        output: output === null || output === "" ? null : output,
      },
      pushToTalk: ptt === "true",
    };
  } catch {
    return DEFAULT_VOICE_PREFS;
  }
}

export function saveVoicePrefs(prefs: VoicePrefs): void {
  try {
    const store = window.localStorage;
    if (prefs.devices.input === null) store.removeItem(INPUT_KEY);
    else store.setItem(INPUT_KEY, prefs.devices.input);
    if (prefs.devices.output === null) store.removeItem(OUTPUT_KEY);
    else store.setItem(OUTPUT_KEY, prefs.devices.output);
    store.setItem(PTT_KEY, prefs.pushToTalk ? "true" : "false");
  } catch {
    // Storage refused; the preference lasts for this run and no longer.
  }
}

/** One seat in the bar: a session, drawn as the person holding it. */
export interface Seat {
  sessionId: string;
  /** Undefined for somebody the store has never heard of. */
  user: User | undefined;
  /** What to draw when there is no user to draw. */
  name: string;
  isMe: boolean;
  controls: VoiceControls | null;
}

/**
 * The seats in a room, you first and then by name, so the bar stops
 * shuffling itself while you are looking at it.
 *
 * Two sessions of one person (a laptop and a desktop) are two seats: they
 * are two connections, and both use the same saved volume for that person.
 */
export function seatsOf(
  peers: readonly VoicePeer[],
  users: readonly User[],
  mySessionId: string | null,
): Seat[] {
  const byId = new Map(users.map((user) => [user.id, user]));
  return peers
    .map((peer): Seat => {
      const user = byId.get(peer.user_id);
      return {
        sessionId: peer.session_id,
        user,
        name: user?.display_name ?? "somebody",
        isMe: peer.session_id === mySessionId,
        controls: peer.controls ?? null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isMe) - Number(a.isMe) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.sessionId.localeCompare(b.sessionId),
    );
}

/**
 * The room's voice list as this client knows it to be right now (#141). The
 * server lists you a few hundred milliseconds after you join and stops a few
 * hundred after you leave; drawn as-is, the bar would show you missing from a
 * call you are in, then present in one you have left, and rebuild itself when
 * the server caught up. So your own session follows what you did: `me` when
 * you are in voice here adds your seat if the server has not yet, and null
 * drops `mySessionId` if the server still lists it.
 */
export function withMySeat(
  peers: readonly VoicePeer[],
  mySessionId: string | null,
  me: { userId: string; controls: VoiceControls } | null,
): readonly VoicePeer[] {
  if (mySessionId === null) return peers;
  const listed = peers.some((peer) => peer.session_id === mySessionId);
  if (me === null) return listed ? peers.filter((peer) => peer.session_id !== mySessionId) : peers;
  if (listed) return peers;
  return [...peers, { session_id: mySessionId, user_id: me.userId, controls: me.controls }];
}

/** Everybody who is in voice anywhere we can see, as a set of user ids. */
export function usersInVoice(voice: Readonly<Record<string, VoicePeer[]>>): Set<string> {
  const out = new Set<string>();
  for (const peers of Object.values(voice)) {
    for (const peer of peers) out.add(peer.user_id);
  }
  return out;
}

/**
 * The one line the bar says about your own microphone, or null when there
 * is nothing worth a word. The mute button already says "muted"; this is for
 * the states a button cannot carry.
 */
export function microphoneLine(audio: string, pushToTalk: boolean, muted: boolean): string | null {
  switch (audio) {
    case "opening":
      return "opening the microphone…";
    case "sending":
      return pushToTalk && muted ? `hold ${PUSH_TO_TALK_KEY.toLowerCase()} to talk` : null;
    case "stopped":
      return "the microphone stopped — leave and join again";
    default:
      return audio.startsWith("encoder") ? "the microphone could not start" : null;
  }
}

/** A volume as a label: 100% is as sent. Numerals are metadata, so the caller draws it mono. */
export function volumeLabel(volume: number): string {
  return `${Math.round(volume * 100)}%`;
}

/** Clamp a slider value into what the core accepts: silent to twice as sent. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(2, Math.max(0, volume));
}

/** Per-server, per-person levels stay on this computer, never on the wire. */
export function loadVoiceVolumes(server: string): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(`linger.voice.volumes:${server}`) ?? "{}");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 2,
    ));
  } catch { return {}; }
}

/** Saving volume never stores session ids or changes microphone/deafen choices. */
export function saveVoiceVolume(server: string, userId: string, volume: number): void {
  const levels = { ...loadVoiceVolumes(server), [userId]: clampVolume(volume) };
  try { localStorage.setItem(`linger.voice.volumes:${server}`, JSON.stringify(levels)); } catch {
    // The active visit still uses the chosen level if storage is unavailable.
  }
}
