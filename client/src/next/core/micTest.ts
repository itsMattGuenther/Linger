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

/** Where the test is. */
export type MicTest =
  /** Not running. After one, what it heard, or why it couldn't start. */
  | { step: "idle"; heard: Heard | null; problem: string | null }
  /** Asked for, and the microphone is being opened. */
  | { step: "opening" }
  /** Listening: the latest levels, oldest first, each from 0 to 1. */
  | { step: "listening"; levels: readonly number[] }
  /** Playing back what it heard. */
  | { step: "playing"; heard: Heard };

export type MicTestEvent =
  | { kind: "asked" }
  | { kind: "started" }
  | { kind: "refused"; why: string }
  | { kind: "level"; level: number }
  | { kind: "heard"; heard: Heard }
  | { kind: "done" };

export const MIC_TEST_IDLE: MicTest = { step: "idle", heard: null, problem: null };

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
      return state.step === "opening" ? { step: "idle", heard: null, problem: event.why } : state;
    case "level":
      return state.step === "listening" ? { step: "listening", levels: [...state.levels, Math.min(1, Math.max(0, event.level))].slice(-MIC_TEST_LINES) } : state;
    case "heard":
      // A microphone that gave nothing at all can be heard before "started" lands.
      return state.step === "listening" || state.step === "opening" ? { step: "playing", heard: event.heard } : state;
    case "done":
      if (state.step === "playing") return { step: "idle", heard: state.heard, problem: null };
      return state.step === "idle" ? state : MIC_TEST_IDLE;
  }
}

/**
 * What to say after a test, and what to do about it. With the levelling off
 * a quiet voice has an answer in Settings itself.
 */
export function micTestLine(heard: Heard, cleanUp: MicrophoneCleanUp): string {
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
  void bus.listen<Heard>("mictest:heard", (heard) => on({ kind: "heard", heard })).then(hold);
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
