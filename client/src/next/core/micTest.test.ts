import { describe, expect, it } from "vitest";
import { MIC_TEST_IDLE, MIC_TEST_LINES, type MicTest, type MicTestEvent, micTestLine, micTestNext, micTestProblem, micTestWaits } from "./micTest";

const run = (events: MicTestEvent[], from: MicTest = MIC_TEST_IDLE): MicTest => events.reduce(micTestNext, from);

describe("the microphone test (#907)", () => {
  it("opens, listens, plays back and says what it heard", () => {
    expect(run([{ kind: "asked" }])).toEqual({ step: "opening" });
    expect(run([{ kind: "asked" }, { kind: "started" }])).toEqual({ step: "listening", levels: [] });
    const listening = run([{ kind: "asked" }, { kind: "started" }, { kind: "level", level: 0.2 }, { kind: "level", level: 0.6 }]);
    expect(listening).toEqual({ step: "listening", levels: [0.2, 0.6] });
    expect(micTestNext(listening, { kind: "heard", heard: "voice" })).toEqual({ step: "playing", heard: "voice" });
    expect(run([{ kind: "heard", heard: "voice" }, { kind: "done" }], listening)).toEqual({ step: "idle", heard: "voice", problem: null });
  });

  it("keeps only the latest levels, each between 0 and 1", () => {
    const many: MicTestEvent[] = Array.from({ length: MIC_TEST_LINES + 10 }, (_, at) => ({ kind: "level", level: at }));
    const state = run([{ kind: "asked" }, { kind: "started" }, { kind: "level", level: -3 }, ...many]);
    if (state.step !== "listening") throw new Error("not listening");
    expect(state.levels).toHaveLength(MIC_TEST_LINES);
    expect(Math.max(...state.levels)).toBe(1);
    expect(Math.min(...state.levels)).toBeGreaterThanOrEqual(0);
  });

  it("says why when it couldn't start, and can be asked again", () => {
    const refused = run([{ kind: "asked" }, { kind: "refused", why: "No microphone was found." }]);
    expect(refused).toEqual({ step: "idle", heard: null, problem: "No microphone was found." });
    expect(micTestNext(refused, { kind: "asked" })).toEqual({ step: "opening" });
  });

  it("ignores what arrives out of turn", () => {
    // A level with nothing listening, a second ask, a refusal after it started.
    expect(micTestNext(MIC_TEST_IDLE, { kind: "level", level: 0.5 })).toBe(MIC_TEST_IDLE);
    const listening = run([{ kind: "asked" }, { kind: "started" }]);
    expect(micTestNext(listening, { kind: "asked" })).toBe(listening);
    expect(micTestNext(listening, { kind: "refused", why: "late" })).toBe(listening);
    const playing: MicTest = { step: "playing", heard: "quiet" };
    expect(micTestNext(playing, { kind: "level", level: 0.5 })).toBe(playing);
    expect(micTestNext(playing, { kind: "heard", heard: "voice" })).toBe(playing);
    // Done twice is done once.
    const done = micTestNext(playing, { kind: "done" });
    expect(micTestNext(done, { kind: "done" })).toBe(done);
  });

  it("comes back to rest when the shell is done while it still listens", () => {
    // The shell's test ended some other way (its window's test was dropped): no verdict, nothing stuck on "Stop".
    expect(run([{ kind: "asked" }, { kind: "started" }, { kind: "done" }])).toEqual(MIC_TEST_IDLE);
  });

  it("says why when voice was joined while it listened, and plays nothing", () => {
    const why = "You're in voice. Leave it to test your microphone: the test plays out loud, and the room would hear it.";
    const state = run([{ kind: "asked" }, { kind: "started" }, { kind: "level", level: 0.4 }, { kind: "cut", why }, { kind: "done" }]);
    expect(state).toEqual({ step: "idle", heard: null, problem: why });
    // Once it's playing there's nothing to cut.
    const playing: MicTest = { step: "playing", heard: "voice" };
    expect(micTestNext(playing, { kind: "cut", why })).toBe(playing);
  });

  it("takes a verdict that beats the answer to the ask", () => {
    // A microphone that gives nothing at once: "heard" can land before `start` resolves.
    const state = run([{ kind: "asked" }, { kind: "heard", heard: "nothing" }, { kind: "started" }, { kind: "done" }]);
    expect(state).toEqual({ step: "idle", heard: "nothing", problem: null });
  });

  it("says why it couldn't start, as Settings would", () => {
    const picked = { input: null, output: null };
    // The shell's own sentences, as they come.
    const inVoice = "You're in voice. Leave it to test your microphone: the test plays out loud, and the room would hear it.";
    expect(micTestProblem(inVoice, false, picked)).toBe(inVoice);
    // Being in voice is "not now", not something wrong; a missing microphone is.
    expect(micTestWaits(inVoice)).toBe(true);
    expect(micTestWaits("No microphone found. Plug one in, or pick one above.")).toBe(false);
    expect(micTestProblem("A microphone test is already under way.", false, picked)).toBe("A microphone test is already under way.");
    // A microphone that isn't there or won't open, as the voice strip says it, but from inside Settings.
    expect(micTestProblem("no input device", false, picked)).toBe("No microphone found. Plug one in, or pick one above.");
    expect(micTestProblem("the microphone wouldn't open: nope", true, { input: "USB mic", output: null })).toBe("The microphone wouldn't open.");
    expect(micTestProblem("access denied", true, picked)).toBe("Windows' privacy settings are blocking the microphone.");
    expect(micTestProblem("who knows", false, picked)).toBe("Something went wrong. Try again.");
  });

  it("says what to do in plain words", () => {
    const all = { level: true, noise: true, echo: true };
    expect(micTestLine("voice", all)).toBe("That's how you sound to the others.");
    expect(micTestLine("nothing", all)).toMatch(/heard nothing.*Microphone picked above.*muted/);
    expect(micTestLine("quiet", all)).toMatch(/very quiet, even after evening it out.*closer/);
    // With the levelling off, the first answer is the switch right there.
    expect(micTestLine("quiet", { ...all, level: false })).toMatch(/Turn on Even out my volume/);
  });
});
