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
 * Beside the gate is one **sound volume** (#234): how loud every cue plays,
 * 100% by default, from silent to {@link MAX_SOUND_VOLUME}. It decides how
 * loud, not whether, except that at 0% nothing plays at all.
 *
 * All of these are the reader's preference about their own machine, so they
 * live in local storage beside appearance preferences rather than in the
 * gateway store. The player reads them again for every cue, so a change made
 * in Settings, which is another window, holds from the next sound on.
 *
 * **Where they play (#250).** In the desktop app a cue is rendered here and
 * its samples handed to the shell, which plays them on the Speakers picked in
 * Settings, the same device voice uses, and in a call mixes them into the
 * call's own output. The webview can't: WebKitGTK plays only to the system
 * default, and WebView2's device names don't match the picker's. That also
 * ends WebKit starting a page's audio late when its window isn't in front
 * (#241). Outside the app (tests, `vite`), or if the shell couldn't play it,
 * a cue plays through Web Audio as before.
 *
 * The knock itself is synthesized rather than played from a file. Two soft
 * taps from an oscillator need no audio asset. The shared score in chimes.ts
 * does not reach into T-903's separate entrance-sound curation.
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { renderChime } from "./chimes";
import { loadVoicePrefs } from "./voice";

/**
 * Quiet hours start at 22:00 and end at 08:00 unless the listener moves them
 * (#185), listener-local (SPEC §4.2). Minutes after midnight.
 */
export const DEFAULT_QUIET_FROM = 22 * 60;
export const DEFAULT_QUIET_UNTIL = 8 * 60;
/** The steps the window moves in: every half hour. */
export const QUIET_STEP_MINUTES = 30;

/**
 * The top of the sound volume: 400% of the score as written (#234).
 *
 * Measured, not guessed. Rendered offline, the loudest chime at 100%,
 * voice-move, peaks at 0.052 of full scale, and a DM at 0.042; at 400% they
 * are 0.21 and 0.17. The knock is written louder (#252: its first tap peaks
 * at 0.32, because a low thud is hard to hear), so it stops getting louder at
 * `KNOCK_TOP_VOLUME` (chimes.ts), about 0.77, clear of clipping (1.0) even
 * when a chime lands on top of it. `chime-onset.spec.ts` renders every cue at
 * this setting and fails if any peaks above 0.8.
 */
export const MAX_SOUND_VOLUME = 4;

const MUTE_KEY = "linger.sound.muted";
const QUIET_KEY = "linger.sound.quietHours";
const QUIET_FROM_KEY = "linger.sound.quietFrom";
const QUIET_UNTIL_KEY = "linger.sound.quietUntil";
const CATEGORY_KEY = "linger.sound.categories";
const VOLUME_KEY = "linger.sound.volume";

export const SOUND_CATEGORIES = ["voice", "controls", "dms", "rooms", "knocks", "door"] as const;
export type SoundCategory = typeof SOUND_CATEGORIES[number];
export type SoundCue = "voice-join" | "voice-leave" | "voice-move" | "peer-join" | "peer-leave"
  | "mute" | "unmute" | "deafen" | "undeafen" | "dm" | "room" | "knock" | "door";

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  muted: false, quietHours: false,
  quietFrom: DEFAULT_QUIET_FROM, quietUntil: DEFAULT_QUIET_UNTIL,
  // The door chime (decision 12) starts off: an arrival is a card first.
  categories: { voice: true, controls: true, dms: true, rooms: false, knocks: true, door: false },
  volume: 1,
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
  /**
   * How loud every cue plays, as a share of the score as written: 1 is 100%
   * and the default, 0 is silent, and the top is {@link MAX_SOUND_VOLUME}.
   * One level for all of them, so the balance between cues stays as designed.
   */
  volume: number;
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
 * A saved sound volume, if it is a plain number from silent to the top of the
 * range; otherwise 100%, the level everyone had before there was a setting.
 */
function soundVolume(saved: string | null): number {
  if (saved === null || !/^\d+(\.\d+)?$/.test(saved)) return 1;
  const value = Number(saved);
  return Number.isFinite(value) && value >= 0 && value <= MAX_SOUND_VOLUME ? value : 1;
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
      volume: soundVolume(window.localStorage.getItem(VOLUME_KEY)),
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
    window.localStorage.setItem(VOLUME_KEY, String(prefs.volume));
  } catch {
    // The setting still holds for this session.
    storageUnavailable = true;
  }
}

/**
 * The window's `AudioContext`, made when a sound needs one and closed again
 * once the window has been quiet for {@link AUDIO_KEEP_OPEN_MS} (#531).
 *
 * A running context holds an output stream open and plays silence into it:
 * 2–5% of a core per window, all day, and a sound device kept awake. It is
 * closed rather than suspended because WebKitGTK as the Linux packages ship
 * it plays nothing after a suspended context is resumed (the packaged audio
 * check, docs/packaged-audio-checks.md), while a new context plays from its
 * first sample. Contexts are a limited resource in every engine, so there is
 * never more than one open: making one per knock and keeping them is how a
 * browser eventually refuses to make any. `null` means none is open, or there
 * is no audio here at all (a test runner, a headless session), which is not
 * an error.
 *
 * In the desktop app the shell plays the sounds (#250), and the webview lets a
 * page play without a click (wry allows autoplay), so a context is made only
 * for a sound the shell couldn't play. Outside the app a browser wants a
 * click or key first: the first one makes the context inside the gesture, and
 * afterwards a sound may make one without (`unlockAudio`). Listen is itself a
 * gesture.
 */
let context: AudioContext | null = null;
/** The window has had a click or key, so a live sound may open the audio. */
let activated = false;
/** Sounds using the context right now. It is never closed under one. */
let playing = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * How long the context stays open after the last sound: the shell's own
 * speaker's `KEEP_OPEN` (src-tauri/src/sounds.rs). Long enough for the rest
 * of a burst (a knock and the chime after it), short enough that a window
 * isn't holding a sound device for nothing. Every cue is under a second.
 */
export const AUDIO_KEEP_OPEN_MS = 10_000;

function audioConstructor(): (new () => AudioContext) | undefined {
  if (typeof window === "undefined") return undefined;
  const webkit = (window as unknown as { webkitAudioContext?: new () => AudioContext })
    .webkitAudioContext;
  if (typeof window.AudioContext === "function") return window.AudioContext;
  if (typeof webkit === "function") return webkit;
  return undefined;
}

function audio(create: boolean): AudioContext | null {
  // One the engine closed (a lost device, say) is replaced like one we did.
  if (context !== null && context.state !== "closed") return context;
  context = null;
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

/** Close the context now, unless a sound is using it. The next sound makes a new one. Never throws. */
function closeAudio(): void {
  clearTimeout(closeTimer);
  closeTimer = undefined;
  const ctx = context;
  if (playing > 0 || ctx === null) return;
  context = null;
  try {
    void ctx.close().catch(() => {});
  } catch {
    // Already gone, or a stand-in without `close`: dropping it is enough.
  }
}

/** Close the context once no sound has used it for {@link AUDIO_KEEP_OPEN_MS}. */
function closeLater(): void {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(closeAudio, AUDIO_KEEP_OPEN_MS);
}

/**
 * The window's first click or key. Live chimes arrive later, from the
 * gateway, which a browser does not treat as a gesture, so outside the app
 * the context is made and resumed here, inside the gesture, and closed after
 * {@link AUDIO_KEEP_OPEN_MS} if nothing plays; after this a live sound may
 * open the audio itself. In the desktop app there is nothing to do: the
 * webview needs no click, and the shell plays the sounds (#531).
 *
 * Resolves `true` once there is nothing left for a gesture to do. `false`
 * means the device refused, and the next click or key should try again.
 */
export async function unlockAudio(): Promise<boolean> {
  if (activated || isTauri() || audioConstructor() === undefined) {
    activated = true;
    return true;
  }
  const ctx = audio(true);
  if (ctx === null) return false;
  try {
    // Called before any wait, so it is still inside the gesture.
    if (ctx.state === "suspended") await ctx.resume();
  } catch {
    return false;
  }
  if (ctx.state !== "running") return false;
  activated = true;
  if (playing === 0) closeLater();
  return true;
}

/**
 * Unlock the window's audio on its first click or key (`next/main.tsx`), and
 * stop listening once that's done. A device that refused is asked again at
 * the next one.
 */
export function unlockAudioOnGesture(target: EventTarget): void {
  const unlock = (): void => {
    void unlockAudio().then((done) => {
      if (!done) return;
      target.removeEventListener("pointerdown", unlock);
      target.removeEventListener("keydown", unlock);
    });
  };
  target.addEventListener("pointerdown", unlock);
  target.addEventListener("keydown", unlock);
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
// A context's sample rate is the device's, and the volume changes only when
// the listener moves it. Keep each short synthesized cue in memory at the
// current rate and volume, including an in-flight render shared by
// simultaneous notifications. A new rate (the next context opened on another
// device) or a new volume starts a fresh set.
const buffers = new Map<SoundCue, Promise<AudioBuffer>>();
let buffersVolume = DEFAULT_SOUND_PREFS.volume;
let buffersRate = 0;

function chimeBuffer(ctx: AudioContext, cue: SoundCue, volume: number): Promise<AudioBuffer> {
  if (volume !== buffersVolume || ctx.sampleRate !== buffersRate) {
    buffers.clear();
    buffersVolume = volume;
    buffersRate = ctx.sampleRate;
  }
  const cached = buffers.get(cue);
  if (cached) return cached;
  const pending = renderChime(cue, ctx.sampleRate, volume).catch((error: unknown) => {
    if (buffers.get(cue) === pending) buffers.delete(cue);
    throw error;
  });
  buffers.set(cue, pending);
  return pending;
}

/**
 * The rate cues are rendered at for the shell: voice's rate, which the shell
 * resamples from to whatever the device runs at.
 */
const SHELL_RATE = 48_000;
// Each cue's samples for the shell, at the current volume, kept like the
// Web Audio buffers above.
const shellSamples = new Map<SoundCue, Promise<number[]>>();
let shellVolume = DEFAULT_SOUND_PREFS.volume;

function samplesFor(cue: SoundCue, volume: number): Promise<number[]> {
  if (volume !== shellVolume) {
    shellSamples.clear();
    shellVolume = volume;
  }
  const cached = shellSamples.get(cue);
  if (cached) return cached;
  const pending = renderChime(cue, SHELL_RATE, volume).then((buffer) =>
    Array.from(buffer.getChannelData(0), (sample) => Math.round(Math.max(-1, Math.min(1, sample)) * 32767)),
  );
  pending.catch(() => {
    if (shellSamples.get(cue) === pending) shellSamples.delete(cue);
  });
  shellSamples.set(cue, pending);
  return pending;
}

/**
 * Play a cue's samples on the chosen Speakers, through the shell (#250).
 * True when the shell played it; false (never a throw) when it couldn't, so
 * the caller plays it through Web Audio instead.
 */
async function playInShell(samples: number[]): Promise<boolean> {
  try {
    // Read for every cue, so a change in Settings holds from the next sound.
    const output = loadVoicePrefs().devices.output;
    return (await invoke<boolean>("sound_play", { samples, output })) === true;
  } catch {
    return false;
  }
}

/**
 * What the phone's own sound setting allows (SPEC §4.15): its ringer at
 * sound, vibrate or silent, with Do Not Disturb counting as silent. Linger's
 * own switches (mute, quiet hours, each kind) are asked first; this comes
 * after. A computer has no such setting, so nothing is followed there.
 */
export type DeviceSound = "sound" | "vibrate" | "silent";

let deviceSound: { ask: () => Promise<DeviceSound>; buzz: (pattern: number[]) => void } | null = null;

/** The phone app follows its ringer: set once, at startup (`next/main.tsx`). */
export function followDeviceSound(ask: () => Promise<DeviceSound>, buzz: (pattern: number[]) => void): void {
  deviceSound = { ask, buzz };
}

/** In place of a cue, with the phone on vibrate: a knock taps twice, everything else once. */
export function vibrationFor(cue: SoundCue): number[] {
  return categoryOf(cue) === "knocks" ? [60, 90, 60] : [40];
}

/** Never queues an old cue for later or throws when the audio device refuses. */
export async function playSound(cue: SoundCue, now: Date = new Date()): Promise<boolean> {
  return play(cue, now, false);
}

/**
 * Settings Listen. The person asked to hear this cue, so mute, quiet hours,
 * categories and burst protection do not apply. It plays at the sound volume,
 * so letting go of that slider plays one to hear the new level; at 0% it is
 * silent like everything else. Live events still go through {@link playSound}.
 */
export async function playPreview(cue: SoundCue): Promise<boolean> {
  return play(cue, new Date(), true);
}

async function play(cue: SoundCue, now: Date, preview: boolean): Promise<boolean> {
  const prefs = loadSoundPrefs();
  // At 0% there is nothing to hear, so nothing is started.
  if (!(prefs.volume > 0)) return false;
  if (!preview && !cueAllowed(cue, prefs, now)) return false;
  const category = categoryOf(cue);
  const cooldown = category === "dms" || category === "rooms" ? 1200 : 100;
  const started = Date.now();
  if (!preview && started - (lastPlayed.get(category) ?? -Infinity) < cooldown) return false;
  // Rechecked after every wait: preferences may have changed, or another cue
  // won the same burst. A preview is the click itself, so it is not stale.
  const stillWanted = (): boolean => {
    if (preview) return true;
    const later = loadSoundPrefs();
    return (
      Date.now() - started <= 1000 &&
      later.volume > 0 &&
      cueAllowed(cue, later, new Date(now.getTime() + Date.now() - started)) &&
      Date.now() - (lastPlayed.get(category) ?? -Infinity) >= cooldown
    );
  };
  // The phone's ringer, a preview included: silent is silent, and vibrate
  // buzzes instead. One that can't be asked plays as before.
  if (deviceSound !== null) {
    const mode = await deviceSound.ask().catch((): DeviceSound => "sound");
    if (mode === "silent") return false;
    if (mode === "vibrate") {
      if (!stillWanted()) return false;
      deviceSound.buzz(vibrationFor(cue));
      if (!preview) lastPlayed.set(category, Date.now());
      return true;
    }
  }
  if (isTauri()) {
    try {
      const samples = await samplesFor(cue, prefs.volume);
      if (!stillWanted()) return false;
      if (await playInShell(samples)) {
        if (!preview) lastPlayed.set(category, Date.now());
        return true;
      }
    } catch {
      // Rendering failed: Web Audio below renders its own, or gives up.
    }
  }
  try {
    // Outside the app, a live sound opens the audio only once the window has
    // had a click or key (`unlockAudio`).
    const ctx = audio(preview || activated || isTauri());
    if (ctx === null) return false;
    // Open while this sound uses it, and for a while after (#531).
    playing += 1;
    clearTimeout(closeTimer);
    try {
      if (ctx.state === "suspended") {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ctx.resume(), new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 1000);
          })]);
        } finally { clearTimeout(timeout); }
      }
      if (ctx.state !== "running") return false;
      const buffer = await chimeBuffer(ctx, cue, prefs.volume);
      if (ctx.state !== "running") return false;
      // Never play something saved by a suspended context.
      if (!stillWanted()) return false;
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
    } finally {
      playing -= 1;
      if (playing === 0) closeLater();
    }
  } catch {
    return false;
  }
}
