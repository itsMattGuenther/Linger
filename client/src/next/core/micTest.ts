import { invoke } from "@tauri-apps/api/core";
import type { VoiceDeviceChoice } from "../../lib/ipc";
import { type MicrophoneCleanUp, startProblemWords, voiceStartProblem } from "../../lib/voice";
import { tauriBus } from "./bus";

/**
 * The microphone test in Settings → Sound & Voice (#907): talk for a few
 * seconds, and hear it back the way a call would send it.
 *
 * The desktop shell does all of it (src-tauri/src/mic_test.rs): it opens the
 * microphone as a call does, keeps up to eight seconds, plays them once on
 * the Speakers picked, and drops them. This window is told how loud each
 * moment was, what was heard in a word, and when the playing is over. It is
 * never handed the sound.
 */

/** What the test heard, as the shell says it. */
export type Heard = "nothing" | "quiet" | "voice";

/**
 * What the shell says once it has listened: what it heard, and whether the
 * Microphone picked wouldn't open, so that this was the system default
 * standing in for it. As a call does (#398): Linger keeps you talking, and
 * says which microphone it is.
 */
export interface Said {
  heard: Heard;
  stoodIn: boolean;
}

/** Where the test is. */
export type MicTest =
  /** Not running. After one, what it said, or why it couldn't start. */
  | { step: "idle"; said: Said | null; problem: string | null }
  /** Asked for, and the microphone is being opened. */
  | { step: "opening" }
  /** Listening: the latest levels, oldest first, each from 0 to 1. */
  | { step: "listening"; levels: readonly number[] }
  /** Playing back what it heard. */
  | { step: "playing"; said: Said };

export type MicTestEvent =
  | { kind: "asked" }
  | { kind: "started" }
  | { kind: "refused"; why: string }
  | { kind: "level"; level: number }
  | { kind: "heard"; said: Said }
  /** It was cut off, and why: voice was joined while it listened or played, or the speakers wouldn't open. */
  | { kind: "cut"; why: string }
  | { kind: "done" };

export const MIC_TEST_IDLE: MicTest = { step: "idle", said: null, problem: null };

/** How many levels the moving lines show: about a second and a half at 25 a second. */
export const MIC_TEST_LINES = 36;

/**
 * The test after something happened. Anything that arrives out of turn is
 * ignored: a level after the listening stopped, a second "done".
 */
export function micTestNext(state: MicTest, event: MicTestEvent): MicTest {
  switch (event.kind) {
    case "asked":
      return state.step === "idle" ? { step: "opening" } : state;
    case "started":
      return state.step === "opening" ? { step: "listening", levels: [] } : state;
    case "refused":
      return state.step === "opening" ? { step: "idle", said: null, problem: event.why } : state;
    case "level":
      return state.step === "listening" ? { step: "listening", levels: [...state.levels, Math.min(1, Math.max(0, event.level))].slice(-MIC_TEST_LINES) } : state;
    case "heard":
      // A microphone that gave nothing at all can be heard before "started" lands.
      return state.step === "listening" || state.step === "opening" ? { step: "playing", said: event.said } : state;
    case "cut":
      // Whatever it was doing: joining voice cuts off the playing too, and what it had said it heard goes with it.
      return state.step === "idle" ? state : { step: "idle", said: null, problem: event.why };
    case "done":
      if (state.step === "playing") return { step: "idle", said: state.said, problem: null };
      return state.step === "idle" ? state : MIC_TEST_IDLE;
  }
}

/**
 * What to say after a test, and what to do about it. With the levelling off
 * a quiet voice has an answer in Settings itself. When the Microphone
 * picked wouldn't open, that comes first: what was heard was another
 * microphone, and advice about the one picked would be about the wrong one.
 */
export function micTestLine({ heard, stoodIn }: Said, cleanUp: MicrophoneCleanUp): string {
  if (stoodIn) {
    const fix = "Close whatever else is using the one you picked, or pick another above.";
    if (heard === "nothing") return `The Microphone you picked wouldn't open, so Linger listened to your computer's default one, and heard nothing. ${fix}`;
    return `The Microphone you picked wouldn't open, so that was your computer's default one${heard === "quiet" ? ", and it was very quiet" : ""}. ${fix}`;
  }
  if (heard === "voice") return "That's how you sound to the others.";
  if (heard === "nothing") {
    return "Linger heard nothing. Check that the Microphone picked above is the one you're talking into, and that it isn't muted, on the microphone itself or in your computer's sound settings.";
  }
  return cleanUp.level
    ? "That was very quiet, even after evening it out. Move closer to the microphone, or turn it up in your computer's sound settings."
    : "That was very quiet. Turn on Even out my volume below, or move closer to the microphone.";
}

/**
 * Why a test couldn't start, in words for Settings. The shell's own two
 * sentences (in voice, or one already under way) are said as they come; a
 * microphone that wouldn't open is said the way the voice strip says it,
 * except that "in Settings" is here.
 */
export function micTestProblem(problem: string, windows: boolean, asked: VoiceDeviceChoice): string {
  if (micTestWaits(problem) || /already under way/.test(problem)) return problem;
  return startProblemWords(voiceStartProblem(problem, windows, asked)).replace(/\bin Settings\b/g, "above");
}

/**
 * Whether a reason not to start is only "not now": you're in voice. Nothing
 * is wrong, so Settings says it in its ordinary voice, not as a problem.
 */
export function micTestWaits(problem: string): boolean {
  return /^You're in voice\b/.test(problem);
}

/** What starts and stops a test. The shell's in the app; a stand-in in the tests. */
export interface MicTester {
  /** Start one, on the microphone and speakers picked (null is the system default). Rejects with the reason in words. */
  start: (input: string | null, output: string | null) => Promise<void>;
  /** Stop listening now and play back what there is. */
  stop: () => void;
  /** Let go of everything it listens to. */
  dispose: () => void;
}

/** The desktop shell's test, telling `on` what happens. */
export function shellMicTester(on: (event: MicTestEvent) => void): MicTester {
  const bus = tauriBus();
  const stops: Array<() => void> = [];
  let gone = false;
  const hold = (unlisten: () => void) => {
    if (gone) unlisten();
    else stops.push(unlisten);
  };
  void bus.listen<number>("mictest:level", (level) => on({ kind: "level", level })).then(hold);
  // As the shell writes it (`Said` in mic_test.rs): `stood_in`, not `stoodIn`.
  void bus.listen<{ heard: Heard; stood_in: boolean }>("mictest:heard", (said) => on({ kind: "heard", said: { heard: said.heard, stoodIn: said.stood_in } })).then(hold);
  void bus.listen<string>("mictest:cut", (why) => on({ kind: "cut", why })).then(hold);
  void bus.listen("mictest:done", () => on({ kind: "done" })).then(hold);
  return {
    start: async (input, output) => {
      await invoke("mic_test_start", { input, output });
    },
    stop: () => void invoke("mic_test_stop").catch(() => undefined),
    dispose: () => {
      gone = true;
      for (const stop of stops) stop();
    },
  };
}
