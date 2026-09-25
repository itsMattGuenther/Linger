import { describe, expect, it } from "vitest";
import { NO_TABS, closeTab, moveTab, openTab, selectTab, stepTab, type TabsState } from "./tabs";

const three: TabsState = { order: ["general", "listening", "jules"], active: "listening" };

describe("the chat window's tabs", () => {
  it("opens a conversation as a new tab at the end and shows it", () => {
    expect(openTab(NO_TABS, "general")).toEqual({ order: ["general"], active: "general" });
    expect(openTab(three, "plans")).toEqual({ order: ["general", "listening", "jules", "plans"], active: "plans" });
  });

  it("shows an open conversation's tab rather than adding a second", () => {
    expect(openTab(three, "general")).toEqual({ order: ["general", "listening", "jules"], active: "general" });
    expect(openTab(three, "listening")).toBe(three);
  });

  it("adds a tab in the background without taking the view", () => {
    expect(openTab(three, "plans", true)).toEqual({ order: ["general", "listening", "jules", "plans"], active: "listening" });
    expect(openTab(NO_TABS, "plans", true)).toEqual({ order: ["plans"], active: "plans" });
  });

  it("closing the showing tab shows its right-hand neighbor, or the left one at the end", () => {
    expect(closeTab(three, "listening")).toEqual({ order: ["general", "jules"], active: "jules" });
    expect(closeTab({ ...three, active: "jules" }, "jules")).toEqual({ order: ["general", "listening"], active: "listening" });
    expect(closeTab({ order: ["general"], active: "general" }, "general")).toEqual(NO_TABS);
    expect(closeTab(three, "general")).toEqual({ order: ["listening", "jules"], active: "listening" });
    expect(closeTab(three, "nothing")).toBe(three);
  });

  it("selects, reorders and steps", () => {
    expect(selectTab(three, "jules").active).toBe("jules");
    expect(selectTab(three, "nothing")).toBe(three);
    expect(moveTab(three, "jules", 0).order).toEqual(["jules", "general", "listening"]);
    expect(moveTab(three, "general", 9).order).toEqual(["listening", "jules", "general"]);
    expect(moveTab(three, "general", 0)).toBe(three);
    expect(stepTab(three, 1).active).toBe("jules");
    expect(stepTab({ ...three, active: "jules" }, 1).active).toBe("general");
    expect(stepTab({ ...three, active: "general" }, -1).active).toBe("jules");
  });
});
