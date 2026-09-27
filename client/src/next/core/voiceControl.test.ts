/**
 * Mute, Deafen and Leave pressed in a chat window (#241): the list window
 * makes the change and answers with the sound that confirms it; the window
 * that was pressed plays that, and only that, and only once it's answered.
 * The list window here is a stand-in that answers when the test says; the
 * real one is driven in share.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundCue } from "../../lib/sound";
import { answer } from "./bus";
import { memoryHub } from "./bus.memory";
import { VOICE_CONTROL, type VoiceControlAnswer, type VoiceControlQuestion } from "./share";
import { CONFIRM_WITHIN_MS, pressVoiceControl } from "./voiceControl";

/** A list window whose change finishes when the test says, with the answer given then. */
async function listWindow() {
  const hub = memoryHub();
  const asked: VoiceControlQuestion[] = [];
  let finish: (outcome: VoiceControlAnswer | Error) => void = () => undefined;
  await answer<VoiceControlQuestion, VoiceControlAnswer>(hub.bus("main"), VOICE_CONTROL, async (question) => {
    const { v: _v, id: _id, from: _from, ...press } = question;
    asked.push(press);
    const outcome = await new Promise<VoiceControlAnswer | Error>((settle) => {
      finish = settle;
    });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const heard: SoundCue[] = [];
  const press = (question: VoiceControlQuestion) => pressVoiceControl(hub.bus("chat"), question, (cue) => heard.push(cue));
  return { asked, heard, press, finish: (outcome: VoiceControlAnswer | Error) => finish(outcome) };
}

describe("a voice control pressed in a chat window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the list window, and plays its sound here once the change is made, not before", async () => {
    const list = await listWindow();
    const pressed = list.press({ control: "mute", on: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(list.asked).toEqual([{ control: "mute", on: true }]);
    expect(list.heard).toEqual([]);
    list.finish({ cue: "mute" });
    await expect(pressed).resolves.toBe("mute");
    expect(list.heard).toEqual(["mute"]);
  });

  it("plays nothing when nothing changed, or the change failed", async () => {
    const list = await listWindow();
    const unchanged = list.press({ control: "deafen", on: false });
    await vi.advanceTimersByTimeAsync(10);
    list.finish({ cue: null });
    await expect(unchanged).resolves.toBeNull();

    const failed = list.press({ control: "leave" });
    await vi.advanceTimersByTimeAsync(10);
    list.finish(new Error("Couldn't change voice controls. Voice was disconnected; join again to retry."));
    await expect(failed).resolves.toBeNull();
    expect(list.heard).toEqual([]);
  });

  it("plays nothing when the answer comes too late to be the click's", async () => {
    const list = await listWindow();
    const pressed = list.press({ control: "mute", on: true });
    await vi.advanceTimersByTimeAsync(CONFIRM_WITHIN_MS + 1);
    await expect(pressed).resolves.toBeNull();
    list.finish({ cue: "mute" });
    await vi.advanceTimersByTimeAsync(10);
    expect(list.heard).toEqual([]);
  });
});
