import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayState } from "./gateway";
import type { Message } from "../generated/Message";
import type { Room } from "../generated/Room";

// Asking for notification permission (parity NOTE-6): once, and a refusal is
// final and silent. The banner path is lib/notify.ts's `show`, reached by a
// message that names you.

const desktop = vi.hoisted(() => ({ granted: false, answer: "denied", checked: 0, asked: 0, banners: [] as unknown[] }));
vi.mock("./sound", () => ({ playSound: () => undefined }));
vi.mock("./looking", () => ({ isLooking: () => false }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: unknown) => {
    if (cmd === "show_notification") desktop.banners.push(args);
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => {
    desktop.checked += 1;
    return desktop.granted;
  },
  requestPermission: async () => {
    desktop.asked += 1;
    return desktop.answer;
  },
}));

const server = "https://ask.example";
const room: Room = { id: "room", name: "room", slug: "room", kind: "room", topic: null, member_ids: null, position: 0, archived_at: null, last_message_id: null };

async function fresh() {
  vi.resetModules();
  const notify = await import("./notify");
  const { serverState } = await import("./gateway");
  const snapshot: GatewayState = {
    ...serverState(server),
    rooms: [room],
    me: {
      id: "me",
      username: "me",
      display_name: "Me",
      is_host: false,
      status: null,
      entrance_sound: null,
      last_seen_at: null,
      style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    },
  };
  let serial = 0;
  /** Somebody names you, and the batch goes out. */
  const namedAgain = async () => {
    serial += 1;
    const message: Message = { id: `m${serial}`, room_id: "room", author_id: "friend", body: "@me look", attachments: [], reply_to: null, reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: serial };
    notify.considerFrame(server, { op: "message.create", s: serial, d: message }, snapshot);
    await vi.advanceTimersByTimeAsync(1_500);
  };
  return { notify, namedAgain };
}

describe("asking for notification permission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    Object.assign(desktop, { granted: false, answer: "denied", checked: 0, asked: 0, banners: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks once, the first time there's something to show, and shows it when allowed", async () => {
    desktop.answer = "granted";
    const { notify, namedAgain } = await fresh();
    expect(desktop.asked).toBe(0);
    await namedAgain();
    expect(desktop.asked).toBe(1);
    expect(desktop.banners).toHaveLength(1);
    await namedAgain();
    await namedAgain();
    expect(desktop.asked).toBe(1);
    expect(desktop.checked).toBe(1);
    expect(desktop.banners).toHaveLength(3);
    notify.resetNotifications();
  });

  it("a refusal is final and silent: never asked again, nothing shown, nothing said", async () => {
    const { notify, namedAgain } = await fresh();
    await namedAgain();
    expect(desktop.asked).toBe(1);
    // They change their mind in the system later: this run still doesn't pester.
    desktop.answer = "granted";
    for (let again = 0; again < 5; again += 1) await namedAgain();
    expect(desktop.asked).toBe(1);
    expect(desktop.checked).toBe(1);
    expect(desktop.banners).toEqual([]);
    notify.resetNotifications();
  });

  it("already allowed: shows without asking", async () => {
    desktop.granted = true;
    const { notify, namedAgain } = await fresh();
    await namedAgain();
    expect(desktop.asked).toBe(0);
    expect(desktop.banners).toHaveLength(1);
    notify.resetNotifications();
  });
});
