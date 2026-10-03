import { describe, expect, it } from "vitest";
import { clipTime, isVoiceMessage, LINES, withLevel } from "./voiceMessage";

describe("a voice message in the box (#401)", () => {
  it("keeps the latest levels for the moving lines, each from nothing to one", () => {
    let levels: number[] = [];
    for (let n = 0; n < LINES + 5; n += 1) levels = withLevel(levels, n / 100);
    expect(levels).toHaveLength(LINES);
    expect(levels[0]).toBe(0.05);
    expect(levels.at(-1)).toBe((LINES + 4) / 100);
    expect(withLevel([], 3)).toEqual([1]);
    expect(withLevel([], -1)).toEqual([0]);
  });

  it("tells a clip's length in minutes and seconds", () => {
    expect(clipTime(0)).toBe("0:00");
    expect(clipTime(7_900)).toBe("0:07");
    expect(clipTime(65_000)).toBe("1:05");
    expect(clipTime(5 * 60_000)).toBe("5:00");
    expect(clipTime(-20)).toBe("0:00");
  });

  it("knows a voice message by the name and kind it went up as", () => {
    expect(isVoiceMessage("Voice message.webm", "audio/webm")).toBe(true);
    expect(isVoiceMessage("Voice message.webm", "video/webm")).toBe(false);
    expect(isVoiceMessage("rain sounds.webm", "audio/webm")).toBe(false);
  });
});
