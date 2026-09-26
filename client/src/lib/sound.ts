/**
 * The sound player. There is exactly one, and this is it.
 *
 * Knock and notification chimes (SPEC §4.2/§4.9). Future personal entrance
 * sounds (T-901) extend this player rather than creating another one.
 *
 * The gate is SPEC §4.1's, and it applies to knocks too:
 *
 * - **Global mute.** Off by default; one switch in settings.
 * - **Quiet hours, 22:00–08:00 by default in the listener's own time, off
 *   until they turn it on, and movable (#185).** The listener's clock, never the sender's — 2am for you is
 *   what matters, and somebody knocking from another timezone does not get to
 *   decide that. Quiet hours silence *notifications*: DMs, room messages and
 *   knocks, which arrive on their own. Voice and mic/deafen cues answer
 *   something you are doing in a call, so they still play (#186).
 *
 * Both are the reader's preference about their own machine, so they live in
 * local storage beside appearance preferences rather than in the gateway store.
 *
 * The knock itself is synthesized rather than played from a file. Two soft
 * taps from an oscillator need no audio asset. The shared score in chimes.ts
 * does not reach into T-903's separate entrance-sound curation.
 */
import { renderChime } from "./chimes";

/**
 * Quiet hours start at 22:00 and end at 08:00 unless the listener moves them
 * (#185), listener-local (SPEC §4.2). Minutes after midnight.
 */
export const DEFAULT_QUIET_FROM = 22 * 60;
export const DEFAULT_QUIET_UNTIL = 8 * 60;
/** The steps the window moves in: every half hour. */
export const QUIET_STEP_MINUTES = 30;

const MUTE_KEY = "linger.sound.muted";
const QUIET_KEY = "linger.sound.quietHours";
const QUIET_FROM_KEY = "linger.sound.quietFrom";
const QUIET_UNTIL_KEY = "linger.sound.quietUntil";
const CATEGORY_KEY = "linger.sound.categories";

export const SOUND_CATEGORIES = ["voice", "controls", "dms", "rooms", "knocks", "door"] as const;
export type SoundCategory = typeof SOUND_CATEGORIES[number];
export type SoundCue = "voice-join" | "voice-leave" | "voice-move" | "peer-join" | "peer-leave"
  | "mute" | "unmute" | "deafen" | "undeafen" | "dm" | "room" | "knock" | "door";

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  muted: false, quietHours: false,
  quietFrom: DEFAULT_QUIET_FROM, quietUntil: DEFAULT_QUIET_UNTIL,
  // The door chime (decision 12) starts off: an arrival is a card first.
  categories: { voice: true, controls: true, dms: true, rooms: false, knocks: true, door: false },
};
let fallbackPrefs = DEFAULT_SOUND_PREFS;
let storageUnavailable = false;

/** What the listener has decided about noise on this computer. */
export interface SoundPrefs {
  /** Nothing makes a sound. Off by default. */
  muted: boolean;
  /** No notification chimes between `quietFrom` and `quietUntil`. Off until they opt in. */
  quietHours: boolean;
  /** When quiet hours start, in minutes after midnight on this computer's clock. */
  quietFrom: number;
  /** When they end. Earlier than `quietFrom` means the window crosses midnight. */
  quietUntil: number;
  categories: Record<SoundCategory, boolean>;
}

/**
 * Whether `at` falls inside the quiet window `[from, until)`, in minutes after
 * midnight. A window that ends before it starts crosses midnight (22:00–08:00),
 * hence the `||`. A window that starts and ends at the same minute is empty.
 */
export function inQuietHours(
  at: Date,
  from: number = DEFAULT_QUIET_FROM,
  until: number = DEFAULT_QUIET_UNTIL,
): boolean {
  const minute = at.getHours() * 60 + at.getMinutes();
  if (from === until) return false;
  return from < until ? minute >= from && minute < until : minute >= from || minute < until;
}

/** A saved window edge, if it is a real minute of the day; otherwise `fallback`. */
function minuteOfDay(saved: string | null, fallback: number): number {
  if (saved === null || !/^\d+$/.test(saved)) return fallback;
  const value = Number(saved);
  return Number.isInteger(value) && value >= 0 && value < 24 * 60 ? value : fallback;
}

/**
 * Whether a *notification* may sound right now: not muted, and not inside
 * quiet hours. Voice and control cues skip the quiet-hours half (see
 * {@link cueAllowed}). Pure, so the rule can be tested without a clock, an
 * audio device or a browser.
 */
export function soundAllowed(prefs: SoundPrefs, at: Date): boolean {
  if (prefs.muted) return false;
  return !(prefs.quietHours && inQuietHours(at, prefs.quietFrom, prefs.quietUntil));
}

/**
 * The saved preferences, or the defaults. Quiet hours stay **off** until
 * they turn them on: chimes are opt-in silence, not opt-out noise.
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
      quietHours: window.localStorage.getItem(QUIET_KEY) === "true",
      quietFrom: minuteOfDay(window.localStorage.getItem(QUIET_FROM_KEY), DEFAULT_QUIET_FROM),
      quietUntil: minuteOfDay(window.localStorage.getItem(QUIET_UNTIL_KEY), DEFAULT_QUIET_UNTIL),
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
    window.localStorage.setItem(QUIET_FROM_KEY, String(prefs.quietFrom));
    window.localStorage.setItem(QUIET_UNTIL_KEY, String(prefs.quietUntil));
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
 *
 * WebKitGTK starts the context suspended until a user gesture. Live chimes
 * often arrive from the gateway, which is not a gesture, so the first click
 * or key in the window has to resume it. Listen is itself a gesture.
 */
let context: AudioContext | null = null;

function audioConstructor(): (new () => AudioContext) | undefined {
  if (typeof window === "undefined") return undefined;
  const webkit = (window as unknown as { webkitAudioContext?: new () => AudioContext })
    .webkitAudioContext;
  if (typeof window.AudioContext === "function") return window.AudioContext;
  if (typeof webkit === "function") return webkit;
  return undefined;
}

function audio(create: boolean): AudioContext | null {
  if (context !== null) return context;
  if (!create) return null;
  const Ctor = audioConstructor();
  if (Ctor === undefined) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/**
 * Open the audio device from a click or key. Live chimes arrive later, from
 * the gateway, which WebKitGTK does not treat as a gesture — creating the
 * context there leaves it suspended for good on Linux.
 */
export function unlockAudio(): void {
  const ctx = audio(true);
  if (ctx?.state === "suspended") void ctx.resume().catch(() => {});
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

/**
 * What quiet hours silence: the notifications that arrive on their own. Voice
 * and mic/deafen cues are feedback for a call you are in, and going quiet on
 * those at night only makes the controls feel broken (#186). Mute and each
 * category's own switch still silence them.
 */
export const QUIET_HOURS_SILENCE: readonly SoundCategory[] = ["dms", "rooms", "knocks", "door"];

export function categoryOf(cue: SoundCue): SoundCategory {
  if (cue === "knock") return "knocks";
  if (cue === "door") return "door";
  if (cue === "dm") return "dms";
  if (cue === "room") return "rooms";
  if (cue.startsWith("voice-") || cue.startsWith("peer-")) return "voice";
  return "controls";
}

export function cueAllowed(cue: SoundCue, prefs: SoundPrefs, at: Date): boolean {
  const category = categoryOf(cue);
  if (prefs.muted || !prefs.categories[category]) return false;
  return QUIET_HOURS_SILENCE.includes(category) ? soundAllowed(prefs, at) : true;
}

const lastPlayed = new Map<SoundCategory, number>();
// The one context has a fixed sample rate. Keep each short synthesized cue in
// memory, including an in-flight render shared by simultaneous notifications.
const buffers = new Map<SoundCue, Promise<AudioBuffer>>();

function chimeBuffer(ctx: AudioContext, cue: SoundCue): Promise<AudioBuffer> {
  const cached = buffers.get(cue);
  if (cached) return cached;
  const pending = renderChime(cue, ctx.sampleRate).catch((error: unknown) => {
    buffers.delete(cue);
    throw error;
  });
  buffers.set(cue, pending);
  return pending;
}

/** Never queues an old cue for later or throws when the audio device refuses. */
export async function playSound(cue: SoundCue, now: Date = new Date()): Promise<boolean> {
  return play(cue, now, false);
}

/**
 * Settings Listen. The person asked to hear this cue, so mute, quiet hours,
 * categories and burst protection do not apply. Live events still go through
 * {@link playSound}.
 */
export async function playPreview(cue: SoundCue): Promise<boolean> {
  return play(cue, new Date(), true);
}

async function play(cue: SoundCue, now: Date, preview: boolean): Promise<boolean> {
  if (!preview && !cueAllowed(cue, loadSoundPrefs(), now)) return false;
  const category = categoryOf(cue);
  const cooldown = category === "dms" || category === "rooms" ? 1200 : 100;
  const started = Date.now();
  if (!preview && started - (lastPlayed.get(category) ?? -Infinity) < cooldown) return false;
  try {
    const ctx = audio(preview);
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
    const buffer = await chimeBuffer(ctx, cue);
    if (ctx.state !== "running") return false;
    // Recheck after the await: preferences may have changed, or another cue
    // won the same burst. Never play something saved by a suspended context.
    // A preview is the click itself, so it is not stale.
    if (
      !preview &&
      (Date.now() - started > 1000 ||
        !cueAllowed(
          cue,
          loadSoundPrefs(),
          new Date(now.getTime() + Date.now() - started),
        ))
    ) {
      return false;
    }
    if (!preview && Date.now() - (lastPlayed.get(category) ?? -Infinity) < cooldown) {
      return false;
    }
    // Starting a complete buffer always begins at sample zero, even if the
    // main thread stalls. Scheduling oscillators/envelopes against a time
    // captured before graph construction can miss the quiet attack (#94).
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => source.disconnect();
    source.start();
    if (!preview) lastPlayed.set(category, Date.now());
    return true;
  } catch {
    return false;
  }
}
