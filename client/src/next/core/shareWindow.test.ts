import { describe, expect, it, vi } from "vitest";
import type { User } from "../../generated/User";
import { ApiError } from "../../lib/api";
import type { ListModel, PersonRow } from "./list";
import {
  hexOf,
  connected,
  keepShareSignIns,
  oneAtATime,
  type ShareStatus,
  type ShareWindowServer,
  shareWindowServers,
  writtenServers,
  RENEW_AFTER_MS,
  SHARE_LIST_VERSION,
  type ShareShell,
  type ShareWindowList,
  type ShareWindowTheme,
  shareWindowList,
} from "./shareWindow";

// The iPhone's share window (#820): the app hands it a sign-in of its own on
// each server and the list it picks from, through the App Group.

function person(id: string, name: string, color: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    is_cohost: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function row(user: User, dm: string | null): PersonRow {
  return { user, state: "around", note: "around", line: null, inVoice: false, sharing: false, dm, fresh: false, talked: dm !== null };
}

function model(parts: Partial<ListModel>): ListModel {
  return { me: null, rooms: [], groups: [], dmMembers: [], people: { here: [], away: [], offline: [] }, ...parts };
}

const THEME: ShareWindowTheme = {
  background: "#182135ff",
  raised: "#1b2436ff",
  field: "#0f1522ff",
  chosen: "#f3b55c1f",
  chosenEdge: "#f3b55c73",
  text: "#f1ebe0ff",
  textSecondary: "#c0c6d2ff",
  textMuted: "#8d96a9ff",
  hairline: "#222d44ff",
  accent: "#f3b55cff",
  onAccent: "#1c1206ff",
  danger: "#ff7a7aff",
};

const colorOf = (key: string) => `#${key}`;

describe("the list the share window picks from", () => {
  const eli = person("u-eli", "Eli", "azure");
  const sam = person("u-sam", "Sam", "sage");
  const jules = person("u-jules", "Jules", "rust");
  const dave = person("u-dave", "Dave", "plum");
  const good = model({
    rooms: [
      { id: "r-general", name: "general", fresh: false, people: [], voice: false, screen: false },
      { id: "r-raid", name: "raid-night", fresh: true, people: [], voice: true, screen: false },
    ],
    groups: [
      { id: "g-trip", label: "Eli and Sam", people: [{ user: eli, state: "around" }, { user: sam, state: "away" }], memberIds: [], fresh: false, leavable: true, last: false },
      { id: "g-empty", label: "Dave", people: [], memberIds: [], fresh: false, leavable: true, last: true },
    ],
    people: { here: [row(eli, "d-eli"), row(sam, null)], away: [], offline: [row(jules, "d-jules"), row(dave, null)] },
  });

  it("is every server's rooms, groups and DMs in the list's order, with people's colours", () => {
    const list = shareWindowList(
      [
        { id: "https://good.example", name: "The Good Company", model: good },
        { id: "https://other.example", name: "Other", model: model({ rooms: [{ id: "r-x", name: "x", fresh: false, people: [], voice: false, screen: false }] }) },
      ],
      new Map([["https://good.example", "ready"], ["https://other.example", "old"]]),
      THEME,
      colorOf,
      1_000,
    );
    const expected: ShareWindowList = {
      version: SHARE_LIST_VERSION,
      written_at: 1_000,
      theme: THEME,
      servers: [
        {
          base_url: "https://good.example",
          name: "The Good Company",
          share: "ready",
          conversations: [
            { room_id: "r-general", kind: "room", name: "general", colors: [] },
            { room_id: "r-raid", kind: "room", name: "raid-night", colors: [] },
            // A group nobody else is in any more is left out: nobody would see it.
            { room_id: "g-trip", kind: "group", name: "Eli and Sam", colors: ["#azure", "#sage"] },
            // People you have a DM with, here first, then offline; not those you haven't.
            { room_id: "d-eli", kind: "dm", name: "Eli", colors: ["#azure"] },
            { room_id: "d-jules", kind: "dm", name: "Jules", colors: ["#rust"] },
          ],
        },
        { base_url: "https://other.example", name: "Other", share: "old", conversations: [{ room_id: "r-x", kind: "room", name: "x", colors: [] }] },
      ],
    };
    expect(list).toEqual(expected);
  });

  it("is `none` for a server whose sign-in nobody has said", () => {
    const list = shareWindowList([{ id: "https://good.example", name: "G", model: good }], new Map(), THEME, colorOf, 0);
    expect(list.servers[0]?.share).toBe("none");
  });

  it("writes a colour the Swift side reads: #rrggbbaa", () => {
    expect(hexOf([243, 181, 92, 255])).toBe("#f3b55cff");
    expect(hexOf([0, 0, 0, 0])).toBe("#00000000");
  });
});

describe("the servers the list is written with (#825)", () => {
  const server = (id: string, room: string, share: ShareStatus = "ready"): ShareWindowServer => ({
    base_url: id,
    name: id,
    share,
    conversations: [{ room_id: room, kind: "room", name: room, colors: [] }],
  });
  const GOOD_ONE = "https://good.example";
  const DOWN = "https://down.example";
  const ready = new Map<string, ShareStatus>([[GOOD_ONE, "ready"], [DOWN, "ready"]]);

  it("a server the app isn't connected to right now is written as it last was", () => {
    const good = server(GOOD_ONE, "r-general");
    // A while in the background: the app holds nothing for it.
    expect(shareWindowServers([GOOD_ONE], [], [good], ready)).toEqual([good]);
    // Connected again: as it is now.
    const later = server(GOOD_ONE, "r-new");
    expect(shareWindowServers([GOOD_ONE], [later], [good], ready)).toEqual([later]);
  });

  it("one still being reached, or waiting for a newer app, stays; one connected while another is down is written", () => {
    const down = server(DOWN, "r-x");
    const good = server(GOOD_ONE, "r-general");
    expect(shareWindowServers([GOOD_ONE, DOWN], [good], [down], ready)).toEqual([good, down]);
    // Neither connected to nor written yet: left out until it's connected.
    expect(shareWindowServers([GOOD_ONE, DOWN], [good], [], ready)).toEqual([good]);
  });

  it("signing out takes a server off at once, whatever else isn't connected", () => {
    const good = server(GOOD_ONE, "r-general");
    const down = server(DOWN, "r-x");
    expect(shareWindowServers([DOWN], [], [good, down], ready)).toEqual([down]);
    expect(shareWindowServers([], [], [good, down], ready)).toEqual([]);
  });

  it("says whether the window can send there as things are now", () => {
    const good = server(GOOD_ONE, "r-general", "none");
    expect(shareWindowServers([GOOD_ONE], [], [good], ready)[0]?.share).toBe("ready");
  });

  it("reads back the list as written, and nothing it can't", () => {
    const good = server(GOOD_ONE, "r-general");
    const written = (servers: unknown[]) => JSON.stringify({ version: SHARE_LIST_VERSION, written_at: 0, theme: THEME, servers });
    expect(writtenServers(written([good]))).toEqual([good]);
    expect(writtenServers(null)).toEqual([]);
    expect(writtenServers("not json")).toEqual([]);
    expect(writtenServers(written([{ ...good, share: "maybe" }, good]))).toEqual([good]);
    expect(writtenServers(JSON.stringify({ version: SHARE_LIST_VERSION + 1, servers: [good] }))).toEqual([]);
    expect(writtenServers(JSON.stringify([good]))).toEqual([]);
  });

  it("a listing is connected once the server has said who you are", () => {
    const eli = person("u-eli", "Eli", "azure");
    expect(connected({ id: GOOD_ONE, name: "G", model: model({ me: row(eli, null) }) })).toBe(true);
    expect(connected({ id: GOOD_ONE, name: "G", model: model({}) })).toBe(false);
  });
});

/** A shell keeping sign-ins in memory, as the Keychain would. */
function memoryShell(kept: Record<string, { token: string; at: number }> = {}) {
  const store = new Map(Object.entries(kept));
  const shell: ShareShell = {
    savedAt: async (baseUrl) => store.get(baseUrl)?.at ?? null,
    save: async (baseUrl, token) => {
      const before = store.get(baseUrl)?.token ?? null;
      store.set(baseUrl, { token, at: NOW });
      return before;
    },
    forget: async (baseUrl) => {
      const before = store.get(baseUrl)?.token ?? null;
      store.delete(baseUrl);
      return before;
    },
    kept: async () => [...store.keys()],
    writeList: async () => undefined,
    readList: async () => null,
  };
  return { shell, store };
}

const NOW = 10 * RENEW_AFTER_MS;
const GOOD = "https://good.example";

describe("keeping the share window's sign-ins", () => {
  it("asks for one on a server that has none, and keeps it", async () => {
    const { shell, store } = memoryShell();
    const logout = vi.fn(async () => undefined);
    const status = await keepShareSignIns([{ baseUrl: GOOD, shareSignIn: async () => "share-1" }], new Set([GOOD]), shell, logout, NOW);
    expect(status.get(GOOD)).toBe("ready");
    expect(store.get(GOOD)?.token).toBe("share-1");
    expect(logout).not.toHaveBeenCalled();
  });

  it("leaves a fresh one alone, without asking", async () => {
    const { shell } = memoryShell({ [GOOD]: { token: "kept", at: NOW - RENEW_AFTER_MS + 1 } });
    const ask = vi.fn(async () => "share-2");
    const status = await keepShareSignIns([{ baseUrl: GOOD, shareSignIn: ask }], new Set([GOOD]), shell, vi.fn(), NOW);
    expect(status.get(GOOD)).toBe("ready");
    expect(ask).not.toHaveBeenCalled();
  });

  it("renews one that's getting old, and signs the old one out", async () => {
    const { shell, store } = memoryShell({ [GOOD]: { token: "old-share", at: NOW - RENEW_AFTER_MS } });
    const logout = vi.fn(async () => undefined);
    await keepShareSignIns([{ baseUrl: GOOD, shareSignIn: async () => "share-2" }], new Set([GOOD]), shell, logout, NOW);
    expect(store.get(GOOD)?.token).toBe("share-2");
    expect(logout).toHaveBeenCalledWith(GOOD, "old-share");
  });

  it("says a server from before it is `old`, and keeps nothing", async () => {
    const { shell, store } = memoryShell();
    const old = async (): Promise<string> => {
      throw new ApiError(404, { code: "NOT_FOUND", message: "Not found.", retry_after_ms: null });
    };
    const status = await keepShareSignIns([{ baseUrl: GOOD, shareSignIn: old }], new Set([GOOD]), shell, vi.fn(), NOW);
    expect(status.get(GOOD)).toBe("old");
    expect(store.has(GOOD)).toBe(false);
  });

  it("keeps using one within its 30 days when a renewal can't reach the server", async () => {
    const { shell, store } = memoryShell({ [GOOD]: { token: "kept", at: NOW - RENEW_AFTER_MS - 5 } });
    const offline = async (): Promise<string> => {
      throw new TypeError("Network unavailable");
    };
    const status = await keepShareSignIns([{ baseUrl: GOOD, shareSignIn: offline }], new Set([GOOD]), shell, vi.fn(), NOW);
    expect(status.get(GOOD)).toBe("ready");
    expect(store.get(GOOD)?.token).toBe("kept");
    const none = await keepShareSignIns([{ baseUrl: "https://new.example", shareSignIn: offline }], new Set(["https://new.example"]), memoryShell().shell, vi.fn(), NOW);
    expect(none.get("https://new.example")).toBe("none");
  });

  it("a Keychain that won't keep it: `none`, and the new one signed out again rather than left about", async () => {
    const { shell } = memoryShell();
    const refusing: ShareShell = { ...shell, save: async () => null, savedAt: async () => null };
    const logout = vi.fn(async () => undefined);
    const status = await keepShareSignIns([{ baseUrl: GOOD, shareSignIn: async () => "share-1" }], new Set([GOOD]), refusing, logout, NOW);
    expect(status.get(GOOD)).toBe("none");
    expect(logout).toHaveBeenCalledWith(GOOD, "share-1");
  });

  it("a sign-out while one is being asked for still ends it, once it's kept (#822)", async () => {
    const { shell, store } = memoryShell();
    const logout = vi.fn(async () => undefined);
    let answer: (token: string) => void = () => undefined;
    const asked = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const queue = oneAtATime();
    const signedIn = queue(() => keepShareSignIns([{ baseUrl: GOOD, shareSignIn: () => asked }], new Set([GOOD]), shell, logout, NOW));
    // Signed out while that's on its way: this run finds nothing kept yet,
    // unless it waits.
    const signedOut = queue(() => keepShareSignIns([], new Set(), shell, logout, NOW));
    answer("share-1");
    await Promise.all([signedIn, signedOut]);
    expect(store.has(GOOD)).toBe(false);
    expect(logout).toHaveBeenCalledWith(GOOD, "share-1");
  });

  it("one run at a time, and a failed run doesn't stop the next", async () => {
    const queue = oneAtATime();
    const order: string[] = [];
    let finish: () => void = () => undefined;
    const first = queue(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }).then(() => {
          order.push("first");
          throw new Error("refused");
        }),
    );
    const second = queue(async () => {
      order.push("second");
      return 2;
    });
    await new Promise((settle) => setTimeout(settle, 5));
    expect(order).toEqual([]);
    finish();
    await expect(first).rejects.toThrow("refused");
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(["first", "second"]);
  });

  it("signs out of a server the app has left, but not one still being reached", async () => {
    const { shell, store } = memoryShell({
      [GOOD]: { token: "gone-share", at: NOW },
      "https://waiting.example": { token: "waiting-share", at: NOW },
    });
    const logout = vi.fn(async () => undefined);
    await keepShareSignIns([], new Set(["https://waiting.example"]), shell, logout, NOW);
    expect(store.has(GOOD)).toBe(false);
    expect(logout).toHaveBeenCalledWith(GOOD, "gone-share");
    expect(store.get("https://waiting.example")?.token).toBe("waiting-share");
  });
});
