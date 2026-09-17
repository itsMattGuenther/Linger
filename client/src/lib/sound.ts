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
 * taps out of an oscillator is about twenty lines and no bytes, and it means
 * this task does not have to reach into T-903's curation to ship a sound.
 */

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
 * One knuckle on a door: a low sine struck hard and damped fast, through a
 * lowpass so it reads as wood rather than as a beep.
 */
function tap(ctx: AudioContext, at: number, gain: number): void {
  const osc = ctx.createOscillator();
  const level = ctx.createGain();
  const wood = ctx.createBiquadFilter();

  osc.type = "sine";
  osc.frequency.setValueAtTime(180, at);
  // The pitch drop is most of what makes it sound struck rather than played.
  osc.frequency.exponentialRampToValueAtTime(90, at + 0.08);

  wood.type = "lowpass";
  wood.frequency.setValueAtTime(700, at);

  level.gain.setValueAtTime(gain, at);
  level.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);

  osc.connect(wood).connect(level).connect(ctx.destination);
  osc.onended = () => { osc.disconnect(); wood.disconnect(); level.disconnect(); };
  osc.start(at);
  osc.stop(at + 0.1);
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

// Short sine pairs: soft attack/release, low gain, no assets or network fetches.
const NOTES: Record<Exclude<SoundCue, "knock">, readonly number[]> = {
  "voice-join": [440, 660], "voice-leave": [660, 440], "voice-move": [440, 550, 660],
  "peer-join": [660, 880], "peer-leave": [880, 660],
  mute: [330], unmute: [440, 550], deafen: [440, 330], undeafen: [330, 440],
  dm: [660, 825], room: [550],
};
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
    const at = ctx.currentTime + 0.01;
    if (cue === "knock") {
      tap(ctx, at, 0.16);
      tap(ctx, at + 0.14, 0.12);
    } else {
      for (const [index, frequency] of NOTES[cue].entries()) {
        const start = at + index * 0.11;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.055, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
        osc.start(start);
        osc.stop(start + 0.17);
      }
    }
    return true;
  } catch {
    return false;
  }
}
