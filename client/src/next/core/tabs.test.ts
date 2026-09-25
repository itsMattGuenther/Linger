import { describe, expect, it } from "vitest";
import { closeTab, keepOnly, loadTabs, moveTab, NO_TABS, openTab, saveTabs, selectTab, stepTab, type TabKey, type Tabs } from "./tabs";

const HOME = "https://home.example";
const WORK = "https://work.example";
const general: TabKey = { server: HOME, roomId: "r-general" };
const listening: TabKey = { server: HOME, roomId: "r-listening" };
const jules: TabKey = { server: HOME, roomId: "d-jules" };
const raid: TabKey = { server: WORK, roomId: "r-general" };

function names(tabs: Tabs): string[] {
  return tabs.open.map((tab) => `${tab.server === WORK ? "work:" : ""}${tab.roomId}`);
}

function opened(...tabs: TabKey[]): Tabs {
  return tabs.reduce(openTab, NO_TABS);
}

describe("the chat window's tabs", () => {
  it("adds a conversation at the end and shows it", () => {
    const tabs = opened(general, listening);
    expect(names(tabs)).toEqual(["r-general", "r-listening"]);
    expect(tabs.active).toEqual(listening);
  });

  it("shows an open conversation instead of adding it twice", () => {
    const tabs = openTab(opened(general, listening), { ...general });
    expect(names(tabs)).toEqual(["r-general", "r-listening"]);
    expect(tabs.active).toEqual(general);
  });

  it("keeps the same room on two servers apart", () => {
    const tabs = opened(general, raid);
    expect(names(tabs)).toEqual(["r-general", "work:r-general"]);
  });

  it("closing the showing tab shows its right-hand neighbor, or the left at the end", () => {
    const tabs = selectTab(opened(general, listening, jules), listening);
    expect(closeTab(tabs, listening).active).toEqual(jules);
    expect(closeTab(opened(general, listening, jules), jules).active).toEqual(listening);
    expect(closeTab(opened(general), general)).toEqual(NO_TABS);
  });

  it("closing another tab leaves the showing one alone", () => {
    const tabs = closeTab(opened(general, listening, jules), general);
    expect(names(tabs)).toEqual(["r-listening", "d-jules"]);
    expect(tabs.active).toEqual(jules);
  });

  it("moves a tab along the row, clamped to the ends", () => {
    const tabs = opened(general, listening, jules);
    expect(names(moveTab(tabs, jules, 0))).toEqual(["d-jules", "r-general", "r-listening"]);
    expect(names(moveTab(tabs, general, 99))).toEqual(["r-listening", "d-jules", "r-general"]);
    expect(moveTab(tabs, general, 99).active).toEqual(jules);
  });

  it("steps through tabs, wrapping at both ends", () => {
    const tabs = selectTab(opened(general, listening, jules), general);
    expect(stepTab(tabs, 1).active).toEqual(listening);
    expect(stepTab(tabs, -1).active).toEqual(jules);
    expect(stepTab(NO_TABS, 1)).toEqual(NO_TABS);
  });

  it("drops tabs for conversations that are gone, showing another if the showing one went", () => {
    const tabs = opened(general, listening, jules);
    const kept = keepOnly(tabs, (tab) => tab.roomId !== "d-jules");
    expect(names(kept)).toEqual(["r-general", "r-listening"]);
    expect(kept.active).toEqual(general);
  });

  it("comes back from storage, and throws away anything malformed", () => {
    const tabs = selectTab(opened(general, raid), general);
    expect(loadTabs(saveTabs(tabs))).toEqual(tabs);
    for (const junk of [null, "", "{", "[]", '{"v":2,"open":[]}', '{"v":1,"open":"x"}']) {
      expect(loadTabs(junk)).toEqual(NO_TABS);
    }
    expect(loadTabs('{"v":1,"open":[{"server":"https://home.example","roomId":"r-general"},{"server":1},{"roomId":""}],"active":null}')).toEqual({
      open: [general],
      active: general,
    });
  });
});
