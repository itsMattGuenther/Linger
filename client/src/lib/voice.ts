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
import type { VoiceDeviceChoice } from "./ipc";

const INPUT_KEY = "linger.voice.input";
const OUTPUT_KEY = "linger.voice.output";
const PTT_KEY = "linger.voice.pushToTalk";
const TALK_KEY = "linger.voice.pushToTalkKey";

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
  /** Keep the microphone closed, without muting, except while the key is held (#232). */
  pushToTalk: boolean;
  /**
   * The key held to talk, as a `KeyboardEvent.code` (decision 6).
   */
  pushToTalkKey: string;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  devices: { input: null, output: null },
  pushToTalk: false,
  pushToTalkKey: "ControlRight",
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
      pushToTalkKey: window.localStorage.getItem(TALK_KEY) || DEFAULT_VOICE_PREFS.pushToTalkKey,
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
    store.setItem(TALK_KEY, prefs.pushToTalkKey);
  } catch {
    // Storage refused; the preference lasts for this run and no longer.
  }
}

/**
 * The microphone picked in Settings, when it wouldn't open and the system
 * default is in its place (#398): its name as picked, and why, in the
 * system's words. From the desktop shell's `voice:microphone` event.
 */
export interface RefusedMicrophone {
  name: string;
  why: string;
}

/**
 * The one line the bar says about your own microphone, or null when there
 * is nothing worth a word. The mute button already says "muted"; this is for
 * the states a button cannot carry. `waitingForKey` is push-to-talk with its
 * key up and nothing else closing the microphone (`waitingForKey` in
 * lib/gateway.ts): the one time holding the key would open it.
 *
 * `refused` is the microphone picked in Settings that wouldn't open (#398).
 * Linger carries on with the system default, which keeps you talking, but on
 * its own that looks like the microphone you picked not hearing you, so it's
 * said, ahead of the push-to-talk reminder.
 */
export function microphoneLine(
  audio: string,
  waitingForKey: boolean,
  talkKey = PUSH_TO_TALK_KEY.toLowerCase(),
  refused: RefusedMicrophone | null = null,
): string | null {
  switch (audio) {
    case "opening":
      return "opening the microphone…";
    case "sending":
      if (refused !== null) return `${refused.name} wouldn't open, so you're on the system default (${refused.why})`;
      return waitingForKey ? `hold ${talkKey} to talk` : null;
    case "stopped":
      return "the microphone stopped — leave and join again";
    default:
      return audio.startsWith("encoder") ? "the microphone could not start" : null;
  }
}

/** Why voice didn't start, as the room's voice strip says it (#261). */
export interface StartProblem {
  /** What went wrong, in a line. */
  line: string;
  /**
   * What fixes it, when that is something to do in Linger (#273): the label
   * of a button beside the line, so it's never cut off. On a narrow window
   * the line gives way first.
   */
  fix: string | null;
}

/**
 * The fix for a system default that wouldn't open (#273), and the label of
 * the strip's button that opens Settings on Sound & Voice. Written out as
 * "Pick yours in Settings → Sound & Voice" it doesn't fit on the strip's one
 * line even at a chat window's usual width, so it stops at Settings; the
 * button lands on Sound & Voice.
 */
export const PICK_A_DEVICE = "Pick yours in Settings";

/**
 * Why voice didn't start, short, for the room's voice strip (#261).
 * `problem` is the desktop shell's reason, which names the device ("the
 * microphone wouldn't open: …"); the whole of it goes in the tooltip. A known
 * cause says what to do about it. `windows` because the usual causes there
 * are Windows' own: its microphone privacy switch, which Linger can't turn
 * on, and a system default that points at something that won't open.
 *
 * `asked` is what Settings → Sound & Voice asked the shell to open, with
 * `null` for the system default (#273). A default that won't open is fixed
 * by picking a device by name, as it was in the Windows 10 report, so that
 * is what the strip says. Linger doesn't try other devices on its own when
 * the default fails: it could quietly pick a webcam's microphone or the
 * wrong speakers.
 */
export function voiceStartProblem(problem: string, windows: boolean, asked: VoiceDeviceChoice): StartProblem {
  const speakers = /^the speakers wouldn't open/i.test(problem);
  const device = speakers ? "speakers" : "microphone";
  const only = (line: string): StartProblem => ({ line, fix: null });
  if (/no input device/i.test(problem)) return only("No microphone found. Plug one in, or pick one in Settings.");
  if (/no output device/i.test(problem)) return only("No speakers found. Plug some in, or pick them in Settings.");
  if (/denied|access|permission/i.test(problem)) {
    return only(
      !speakers && windows
        ? "Windows' privacy settings are blocking the microphone."
        : `Linger isn't allowed to use the ${device}.`,
    );
  }
  if (/busy|in use/i.test(problem)) return only(`The ${device} ${speakers ? "are" : "is"} in use by another app.`);
  if (/wouldn't open/i.test(problem)) {
    const byName = (speakers ? asked.output : asked.input) !== null;
    if (byName) return only(`The ${device} wouldn't open.`);
    return { line: `${windows ? "Windows'" : "The"} default ${device} wouldn't open.`, fix: PICK_A_DEVICE };
  }
  if (/desktop app/i.test(problem)) return only("Voice only works in the desktop app.");
  if (/the old way/i.test(problem)) return only("This server needs an update for voice. Ask its host.");
  return only("Something went wrong. Try again.");
}

/** A start problem as the words the strip shows, fix and all, for its tooltip and for tests. */
export function startProblemWords(said: StartProblem): string {
  return said.fix === null ? said.line : `${said.line} ${said.fix}.`;
}

/** Whether this is Windows, where WebView2 says so in its user agent. For advice only, never a gate. */
export function onWindows(): boolean {
  return typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
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
