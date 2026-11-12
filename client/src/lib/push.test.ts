/**
 * Phone notifications, the page's side (#830): turning on asks once, seals
 * the address with the relay the server names, and registers; changes reach
 * the server; "Nothing" forgets; a phone the server forgot registers again.
 * The phone and the server are stand-ins; the relay is a stand-in fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PushSettings } from "../generated/PushSettings";
import { ApiError, type AuthedApi } from "./api";
import {
  change,
  FIRST_SETTINGS,
  forgetPush,
  isOnlyMentions,
  keepRegistered,
  onlyMentions,
  phonePush,
  type PushPhone,
  pushSupport,
  resetPhonePush,
  roomChoice,
  turnOff,
  turnOn,
  withRoom,
} from "./push";

const SERVER = "https://linger.example";
const RELAY = "https://push.linger.im";
const INFO = { push: true, push_relay: RELAY };

/** Everything the stand-ins were asked, in order. */
let said: string[];
let permission: string;

function phone(overrides: Partial<PushPhone> = {}): PushPhone {
  return {
    permission: async (ask) => {
      said.push(`permission ${ask}`);
      return ask && permission === "ask" ? "asking" : permission;
    },
    address: async () => {
      said.push("address");
      return { service: "fcm", address: "fcm-address" };
    },
    keys: async (server) => {
      said.push(`keys ${server}`);
      return { public_key: "BPublic", auth_secret: "secret" };
    },
    forget: async (server) => {
      said.push(`forget ${server}`);
    },
    opened: async () => null,
    ...overrides,
  };
}

let posts: unknown[];
let patches: { path: string; body: unknown }[];
let deletes: string[];
let failNext: ApiError | null;

function server(): AuthedApi {
  const stub = {
    refreshToken: "refresh-now",
    post: async (path: string, body: unknown) => {
      said.push(`POST ${path}`);
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      posts.push(body);
      const settings = (body as { settings: PushSettings }).settings;
      return { id: "device-1", settings };
    },
    patch: async (path: string, body: unknown) => {
      said.push(`PATCH ${path}`);
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      patches.push({ path, body });
      return { id: "device-1", settings: (body as { settings: PushSettings }).settings };
    },
    delete: async (path: string) => {
      said.push(`DELETE ${path}`);
      deletes.push(path);
    },
  };
  return stub as unknown as AuthedApi;
}

/** The page's storage, in memory, as Node has none. */
let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
  });
  resetPhonePush();
  said = [];
  permission = "granted";
  posts = [];
  patches = [];
  deletes = [];
  failNext = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      said.push(`seal ${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ token: "v1.sealed" }), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what a server can do", () => {
  it("is said by its info: old servers have no push, a host can turn it off", () => {
    expect(pushSupport(null)).toBe("unknown");
    expect(pushSupport({})).toBe("old");
    expect(pushSupport({ push: false })).toBe("off");
    expect(pushSupport({ push: true })).toBe("off");
    expect(pushSupport(INFO)).toBe("on");
  });
});

describe("choices", () => {
  it("only mentions is one tap, and rooms are one at a time", () => {
    const only = onlyMentions(withRoom(FIRST_SETTINGS, "room-a", "every"));
    expect(only).toEqual({ mentions: true, dms: false, knocks: false, follows: false, rooms: [] });
    expect(isOnlyMentions(only)).toBe(true);
    expect(isOnlyMentions(FIRST_SETTINGS)).toBe(false);
    const rooms = withRoom(withRoom(FIRST_SETTINGS, "room-a", "wakes"), "room-b", "every");
    expect(roomChoice(rooms, "room-a")).toBe("wakes");
    expect(roomChoice(withRoom(rooms, "room-a", "every"), "room-a")).toBe("every");
    expect(roomChoice(withRoom(rooms, "room-a", null), "room-a")).toBeNull();
    expect(roomChoice(rooms, "room-c")).toBeNull();
  });
});

describe("turning on", () => {
  it("seals the address with the server's relay, makes this server's keys, and registers", async () => {
    expect(await turnOn(server(), SERVER, INFO, phone())).toBeNull();
    expect(said).toEqual([
      "permission false",
      "address",
      `seal ${RELAY}/seal {"service":"fcm","address":"fcm-address"}`,
      `keys ${SERVER}`,
      "POST /push/devices",
    ]);
    expect(posts).toEqual([
      { refresh_token: "refresh-now", sealed_token: "v1.sealed", public_key: "BPublic", auth_secret: "secret", settings: FIRST_SETTINGS },
    ]);
    expect(phonePush(SERVER)).toEqual({ on: true, settings: FIRST_SETTINGS, device: "device-1" });
  });

  it("asks once, and waits for the phone's answer", async () => {
    permission = "ask";
    const events = new EventTarget();
    const on = turnOn(server(), SERVER, INFO, phone(), events);
    await vi.waitFor(() => expect(said).toContain("permission true"));
    events.dispatchEvent(new CustomEvent("linger:push-permission", { detail: "granted" }));
    expect(await on).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it("stops at a no, and says where to change it", async () => {
    permission = "ask";
    const events = new EventTarget();
    const on = turnOn(server(), SERVER, INFO, phone(), events);
    await vi.waitFor(() => expect(said).toContain("permission true"));
    events.dispatchEvent(new CustomEvent("linger:push-permission", { detail: "denied" }));
    expect(await on).toMatch(/phone's own settings/);
    expect(said).not.toContain("address");
    expect(phonePush(SERVER).on).toBe(false);

    permission = "denied";
    expect(await turnOn(server(), SERVER, INFO, phone())).toMatch(/phone's own settings/);
    expect(said.filter((line) => line === "permission true")).toHaveLength(1);
  });

  it("says why a server can't, and asks the phone nothing", async () => {
    expect(await turnOn(server(), SERVER, {}, phone())).toMatch(/needs an update/);
    expect(await turnOn(server(), SERVER, { push: false }, phone())).toMatch(/turned phone notifications off/);
    expect(said).toEqual([]);
  });

  it("registers once more when its refresh token was renewed on the way", async () => {
    failNext = new ApiError(422, { code: "VALIDATION_FAILED", message: "That refresh token isn't one of your sign-ins that's still going.", retry_after_ms: null });
    expect(await turnOn(server(), SERVER, INFO, phone())).toBeNull();
    expect(said.filter((line) => line === "POST /push/devices")).toHaveLength(2);
    expect(phonePush(SERVER).on).toBe(true);
  });

  it("says what went wrong when the relay won't seal it, and registers nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    expect(await turnOn(server(), SERVER, INFO, phone())).toMatch(/relay is busy/);
    expect(posts).toEqual([]);
    expect(phonePush(SERVER).on).toBe(false);
  });
});

describe("changing, and Nothing", () => {
  it("keeps choices made while off, for when it's on", async () => {
    expect(await change(server(), SERVER, INFO, onlyMentions(FIRST_SETTINGS), phone())).toBeNull();
    expect(said).toEqual([]);
    expect(phonePush(SERVER)).toEqual({ on: false, settings: onlyMentions(FIRST_SETTINGS), device: null });
    await turnOn(server(), SERVER, INFO, phone());
    expect(posts).toEqual([expect.objectContaining({ settings: onlyMentions(FIRST_SETTINGS) })]);
  });

  it("tells the server, and registers again when it has forgotten the phone", async () => {
    await turnOn(server(), SERVER, INFO, phone());
    said = [];
    const rooms = withRoom(FIRST_SETTINGS, "room-a", "every");
    expect(await change(server(), SERVER, INFO, rooms, phone())).toBeNull();
    expect(patches).toEqual([{ path: "/push/devices/device-1", body: { settings: rooms } }]);

    failNext = new ApiError(404, { code: "NOT_FOUND", message: "That phone isn't registered for notifications here.", retry_after_ms: null });
    said = [];
    expect(await change(server(), SERVER, INFO, FIRST_SETTINGS, phone())).toBeNull();
    expect(said).toContain("POST /push/devices");
    expect(phonePush(SERVER).settings).toEqual(FIRST_SETTINGS);
  });

  it("Nothing forgets it on the server and the phone, and keeps the choices", async () => {
    await change(server(), SERVER, INFO, onlyMentions(FIRST_SETTINGS), phone());
    await turnOn(server(), SERVER, INFO, phone());
    said = [];
    expect(await turnOff(server(), SERVER, phone())).toBeNull();
    expect(said).toEqual(["DELETE /push/devices/device-1", `forget ${SERVER}`]);
    expect(phonePush(SERVER)).toEqual({ on: false, settings: onlyMentions(FIRST_SETTINGS), device: null });
  });
});

describe("keeping it going", () => {
  it("registers again on every start while it's on, and not when it's off or the phone said no", async () => {
    expect(await keepRegistered(server(), SERVER, INFO, phone())).toBeNull();
    expect(posts).toEqual([]);
    await turnOn(server(), SERVER, INFO, phone());
    expect(await keepRegistered(server(), SERVER, INFO, phone())).toBeNull();
    expect(posts).toHaveLength(2);
    permission = "denied";
    await keepRegistered(server(), SERVER, INFO, phone());
    expect(posts).toHaveLength(2);
    await keepRegistered(server(), SERVER, { push: false }, phone());
    expect(posts).toHaveLength(2);
  });

  it("signing out forgets the server's keys, and nothing for a server it never heard from", async () => {
    await forgetPush(SERVER, phone());
    expect(said).toEqual([]);
    await turnOn(server(), SERVER, INFO, phone());
    said = [];
    await forgetPush(SERVER, phone());
    expect(said).toEqual([`forget ${SERVER}`]);
    expect(phonePush(SERVER).on).toBe(false);
  });

  it("keeps what it knows across a restart", async () => {
    await turnOn(server(), SERVER, INFO, phone());
    const kept = JSON.parse(stored.get("linger.push.v1") ?? "{}");
    expect(kept[SERVER]).toEqual({ on: true, settings: FIRST_SETTINGS, device: "device-1" });
  });
});

describe("one change at a time, per server (#888)", () => {
  /** A relay that answers only when told to, so a test can act while it waits. */
  function slowRelay(): () => void {
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        said.push(`seal ${url} ${String(init.body)}`);
        await answered;
        return new Response(JSON.stringify({ token: "v1.sealed" }), { status: 200 });
      }),
    );
    return answer;
  }

  it("turned off while turning on still waits on the relay: off is what's true at the end", async () => {
    const answer = slowRelay();
    const on = turnOn(server(), SERVER, INFO, phone());
    const off = turnOff(server(), SERVER, phone());
    await vi.waitFor(() => expect(said.some((line) => line.startsWith("seal "))).toBe(true));
    // Off waits its turn: nothing deleted or forgotten under the registering.
    expect(said.filter((line) => line.startsWith("forget") || line.startsWith("DELETE"))).toEqual([]);
    answer();
    expect(await on).toBeNull();
    expect(await off).toBeNull();
    expect(said.slice(-3)).toEqual(["POST /push/devices", "DELETE /push/devices/device-1", `forget ${SERVER}`]);
    expect(phonePush(SERVER).on).toBe(false);
    expect(phonePush(SERVER).device).toBeNull();
  });

  it("signed out while registering: the keys go after, and nothing is kept", async () => {
    const answer = slowRelay();
    const on = turnOn(server(), SERVER, INFO, phone());
    const out = forgetPush(SERVER, phone());
    answer();
    await on;
    await out;
    expect(said.at(-1)).toBe(`forget ${SERVER}`);
    expect(phonePush(SERVER).on).toBe(false);
    expect(JSON.parse(stored.get("linger.push.v1") ?? "{}")).toEqual({});
  });

  it("a change that fails doesn't stop the next one", async () => {
    await turnOn(server(), SERVER, INFO, phone());
    failNext = new ApiError(500, { code: "INTERNAL", message: "Something went wrong on the server.", retry_after_ms: null });
    const first = change(server(), SERVER, INFO, onlyMentions(FIRST_SETTINGS), phone());
    const second = change(server(), SERVER, INFO, FIRST_SETTINGS, phone());
    expect(await first).toBe("Something went wrong on the server.");
    expect(await second).toBeNull();
    expect(phonePush(SERVER).settings).toEqual(FIRST_SETTINGS);
  });

  it("another server's change doesn't wait", async () => {
    const answer = slowRelay();
    const on = turnOn(server(), SERVER, INFO, phone());
    expect(await change(server(), "https://other.example", INFO, onlyMentions(FIRST_SETTINGS), phone())).toBeNull();
    expect(phonePush("https://other.example").settings).toEqual(onlyMentions(FIRST_SETTINGS));
    answer();
    await on;
  });
});
