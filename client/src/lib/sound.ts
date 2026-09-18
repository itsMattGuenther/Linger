/**
 * The sound player. There is exactly one, and this is it.
 *
 * Knock and notification chimes (SPEC §4.2/§4.9). Future personal entrance
 * sounds (T-901) extend this player rather than creating another one.
 *
 * The gate is SPEC §4.1's, and it applies to knocks too:
 *
 * - **Global mute.** Off by default; one switch in settings.
 * - **Quiet hours, 22:00–08:00 in the listener's own time, default on.** The
 *   listener's clock, never the sender's — 2am for you is what matters, and
 *   somebody knocking from another timezone does not get to decide that.
 *
 * Both are the reader's preference about their own machine, so they live in
 * local storage beside appearance preferences rather than in the gateway store.
 *
 * The knock itself is synthesized rather than played from a file. Two soft
 * taps from an oscillator need no audio asset. The shared score in chimes.ts
 * does not reach into T-903's separate entrance-sound curation.
 */
import { scheduleChime } from "./chimes";

/** Quiet hours run from 22:00 to 08:00, listener-local (SPEC §4.1). */
export const QUIET_FROM_HOUR = 22;
export const QUIET_UNTIL_HOUR = 8;

const MUTE_KEY = "linger.sound.muted";
const QUIET_KEY = "linger.sound.quietHours";
const CATEGORY_KEY = "linger.sound.categories";

export const SOUND_CATEGORIES = ["voice", "controls", "dms", "rooms", "knocks"] as const;
export type SoundCategory = typeof SOUND_CATEGORIES[number];
export type SoundCue = "voice-join" | "voice-leave" | "voice-move" | "peer-join" | "peer-leave"
  | "mute" | "unmute" | "deafen" | "undeafen" | "dm" | "room" | "knock";

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  muted: false, quietHours: true,
  categories: { voice: true, controls: true, dms: true, rooms: false, knocks: true },
};
let fallbackPrefs = DEFAULT_SOUND_PREFS;
let storageUnavailable = false;

/** What the listener has decided about noise on this computer. */
export interface SoundPrefs {
  /** Nothing makes a sound. Off by default. */
  muted: boolean;
  /** Nothing makes a sound between 22:00 and 08:00. **On** by default. */
  quietHours: boolean;
  categories: Record<SoundCategory, boolean>;
}

/** Whether `at` falls inside quiet hours. Wraps midnight, hence the `||`. */
export function inQuietHours(at: Date): boolean {
  const hour = at.getHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/**
 * Whether a sound may be played right now. Pure, so the rule can be tested
 * without a clock, an audio device or a browser.
 */
export function soundAllowed(prefs: SoundPrefs, at: Date): boolean {
  if (prefs.muted) return false;
  return !(prefs.quietHours && inQuietHours(at));
}

/**
 * The saved preferences, or the defaults. Quiet hours default **on**: a
 * product that wakes people up at 3am has to be opted into, not out of.
 */
export function loadSoundPrefs(): SoundPrefs {
  if (storageUnavailable) return fallbackPrefs;
  try {
    let saved: unknown = null;
    try { saved = JSON.parse(window.localStorage.getItem(CATEGORY_KEY) ?? "null"); } catch { /* old or damaged setting */ }
    const categories = { ...DEFAULT_SOUND_PREFS.categories };
    if (typeof saved === "object" && saved !== null) {
      for (const key of SOUND_CATEGORIES) {
        const value: unknown = Reflect.get(saved, key);
        if (typeof value === "boolean") categories[key] = value;
      }
    }
    return {
      muted: window.localStorage.getItem(MUTE_KEY) === "true",
      quietHours: window.localStorage.getItem(QUIET_KEY) !== "false",
      categories,
    };
  } catch {
    storageUnavailable = true;
    return fallbackPrefs;
  }
}

/** Remember them for next launch. Storage can be switched off; that is fine. */
export function saveSoundPrefs(prefs: SoundPrefs): void {
  fallbackPrefs = prefs;
  try {
    window.localStorage.setItem(MUTE_KEY, String(prefs.muted));
    window.localStorage.setItem(QUIET_KEY, String(prefs.quietHours));
    window.localStorage.setItem(CATEGORY_KEY, JSON.stringify(prefs.categories));
  } catch {
    // The setting still holds for this session.
    storageUnavailable = true;
  }
}

/**
 * One `AudioContext` for the app, made on the first sound and kept.
 *
 * Contexts are a limited resource in every engine — making one per knock is
 * how a browser eventually refuses to make any. `null` means there is no audio
 * here at all (a test runner, a headless session), which is not an error.
 */
let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  context ??= new window.AudioContext();
  return context;
}

/**
 * Somebody knocked. Two taps, quietly, if the listener is letting sounds
 * through right now.
 *
 * Returns whether it made a noise, which is what the caller needs in order to
 * be honest in a test. Never throws: a machine with no audio device still gets
 * the card.
 */
export function playKnock(now: Date = new Date()): Promise<boolean> {
  return playSound("knock", now);
}

export function categoryOf(cue: SoundCue): SoundCategory {
  if (cue === "knock") return "knocks";
  if (cue === "dm") return "dms";
  if (cue === "room") return "rooms";
  if (cue.startsWith("voice-") || cue.startsWith("peer-")) return "voice";
  return "controls";
}

export function cueAllowed(cue: SoundCue, prefs: SoundPrefs, at: Date): boolean {
  return soundAllowed(prefs, at) && prefs.categories[categoryOf(cue)];
}

const lastPlayed = new Map<SoundCategory, number>();

/** Never queues an old cue for later or throws when the audio device refuses. */
export async function playSound(cue: SoundCue, now: Date = new Date()): Promise<boolean> {
  if (!cueAllowed(cue, loadSoundPrefs(), now)) return false;
  const category = categoryOf(cue);
  const cooldown = category === "dms" || category === "rooms" ? 1200 : 100;
  const started = Date.now();
  if (started - (lastPlayed.get(category) ?? -Infinity) < cooldown) return false;
  try {
    const ctx = audio();
    if (ctx === null || ctx.state === "closed") return false;
    if (ctx.state === "suspended") {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ctx.resume(), new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1000);
        })]);
      } finally { clearTimeout(timeout); }
    }
    if (ctx.state !== "running") return false;
    // Recheck after the await: preferences may have changed, or another cue
    // won the same burst. Never play something saved by a suspended context.
    if (Date.now() - started > 1000 || !cueAllowed(cue, loadSoundPrefs(), new Date(now.getTime() + Date.now() - started))) return false;
    if (Date.now() - (lastPlayed.get(category) ?? -Infinity) < cooldown) return false;
    lastPlayed.set(category, Date.now());
    scheduleChime(ctx, cue, ctx.currentTime + 0.01);
    return true;
  } catch {
    return false;
  }
}
