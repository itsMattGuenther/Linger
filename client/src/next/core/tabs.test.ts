import { describe, expect, it } from "vitest";
import { backTab, closeTab, isPreview, isTool, keepOnly, keepTab, keyOf, loadTabs, moveTab, NO_TABS, openTab, previewTab, pushTab, same, type SideTab, saveTabs, selectTab, stepTab, type TabKey, type Tabs } from "./tabs";

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
  return tabs.reduce<Tabs>((held, tab) => openTab(held, tab), NO_TABS);
}

describe("the tabs beside the list", () => {
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

  it("hold Media and Search too, one of each, kept apart from every conversation (#337)", () => {
    const media: SideTab = { tool: "media" };
    const search: SideTab = { tool: "search" };
    let tabs: Tabs<SideTab> = NO_TABS;
    for (const tab of [general, media, search, { tool: "media" } satisfies SideTab]) tabs = openTab(tabs, tab);
    expect(tabs.open.map(keyOf)).toEqual([`${HOME}#r-general`, "tool:media", "tool:search"]);
    expect(tabs.active).toEqual(media);
    expect(same(media, { tool: "media" })).toBe(true);
    expect(same(media, search)).toBe(false);
    expect(same(media, general)).toBe(false);
    expect(isTool(search)).toBe(true);
    expect(isTool(general)).toBe(false);
    // Kept on this computer with the conversations, and read back defensively.
    expect(loadTabs(saveTabs(tabs))).toEqual(tabs);
    expect(loadTabs('{"v":1,"open":[{"tool":"media"},{"tool":"settings"},{"tool":1}],"active":{"tool":"media"}}')).toEqual({ open: [media], active: media });
  });
});

describe("a person opened from the list is a preview until it's kept (#351)", () => {
  const eli: TabKey = { server: HOME, roomId: "d-eli" };
  const callie: TabKey = { server: HOME, roomId: "d-callie" };

  it("the next person takes the preview's place, where it was, and becomes the preview", () => {
    const looked = previewTab(previewTab(opened(general), jules), eli);
    expect(names(looked)).toEqual(["r-general", "d-eli"]);
    expect(looked.active).toEqual(eli);
    expect(looked.preview).toEqual(eli);
    // In place, not at the end: a kept tab to its right stays to its right.
    const withRoom = openTab(previewTab(opened(general), jules), listening);
    expect(names(previewTab(withRoom, eli))).toEqual(["r-general", "d-eli", "r-listening"]);
  });

  it("typing in it keeps it, so the next person gets a tab of their own", () => {
    const kept = keepTab(previewTab(opened(general), jules), jules);
    expect(kept.preview ?? null).toBeNull();
    expect(names(previewTab(kept, eli))).toEqual(["r-general", "d-jules", "d-eli"]);
  });

  it("opening it another way (a banner, a search hit) keeps it too", () => {
    const kept = openTab(previewTab(opened(general), jules), { ...jules });
    expect(kept.preview ?? null).toBeNull();
    expect(names(previewTab(kept, eli))).toEqual(["r-general", "d-jules", "d-eli"]);
  });

  it("a person whose tab is open already just shows it, kept or not", () => {
    const tabs = previewTab(opened(general, jules), eli);
    const again = previewTab(tabs, jules);
    expect(names(again)).toEqual(["r-general", "d-jules", "d-eli"]);
    expect(again.active).toEqual(jules);
    expect(again.preview).toEqual(eli);
  });

  it("keeping or closing another tab leaves the preview alone; closing the preview ends it", () => {
    const tabs = previewTab(opened(general, listening), jules);
    expect(keepTab(tabs, general).preview).toEqual(jules);
    expect(closeTab(tabs, general).preview).toEqual(jules);
    expect(closeTab(tabs, jules).preview ?? null).toBeNull();
    expect(moveTab(tabs, jules, 0).preview).toEqual(jules);
    expect(stepTab(tabs, 1).preview).toEqual(jules);
    expect(keepOnly(tabs, (tab) => !same(tab, jules)).preview ?? null).toBeNull();
  });

  it("knows the preview by its key, and isn't stored: after a restart every tab is kept", () => {
    const tabs = previewTab(opened(general), callie);
    expect(isPreview(tabs, keyOf(callie))).toBe(true);
    expect(isPreview(tabs, keyOf(general))).toBe(false);
    const back = loadTabs(saveTabs(tabs));
    expect(names(back as Tabs)).toEqual(["r-general", "d-callie"]);
    expect(back.preview ?? null).toBeNull();
  });
});

describe("on a phone, one screen over another (SPEC §4.15)", () => {
  const search: SideTab = { tool: "search" };

  function stack(...tabs: SideTab[]): Tabs<SideTab> {
    return tabs.reduce<Tabs<SideTab>>((held, tab) => pushTab(held, tab), NO_TABS);
  }

  it("puts what opens on top and shows it", () => {
    const tabs = stack(search, general);
    expect(tabs.open.map(keyOf)).toEqual(["tool:search", `${HOME}#r-general`]);
    expect(tabs.active).toEqual(general);
  });

  it("moves something open lower down to the top, so Back never shows it twice", () => {
    const tabs = stack(general, jules, general);
    expect(tabs.open.map(keyOf)).toEqual([`${HOME}#d-jules`, `${HOME}#r-general`]);
    expect(tabs.active).toEqual(general);
  });

  it("Back takes the top off and shows the one under it, down to nothing", () => {
    let tabs = stack(search, general, jules);
    tabs = backTab(tabs);
    expect(tabs.active).toEqual(general);
    tabs = backTab(tabs);
    expect(tabs.active).toEqual(search);
    tabs = backTab(tabs);
    expect(tabs).toEqual(NO_TABS);
    expect(backTab(tabs)).toEqual(NO_TABS);
  });

  it("makes nothing a preview, and takes over one left from before", () => {
    const tabs = pushTab(previewTab(opened(general), jules) as Tabs<SideTab>, listening);
    expect(tabs.preview ?? null).toBeNull();
    expect(tabs.active).toEqual(listening);
  });
});
