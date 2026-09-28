import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayState } from "./gateway";
import type { Message } from "../generated/Message";
import type { Room } from "../generated/Room";

const played: string[] = [];
const banners: unknown[] = [];
const asked: { cmd: string; args: unknown }[] = [];
let looking = false;
vi.mock("./sound", () => ({ playSound: (cue: string) => { played.push(cue); } }));
vi.mock("./looking", () => ({ isLooking: () => looking }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args: unknown) => {
    if (cmd === "show_notification") banners.push(args);
    else asked.push({ cmd, args });
  },
}));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted" }));
const { considerFrame, resetNotifications, setDmAlerts, setQuietServers, setViewing } = await import("./notify");
const { serverState } = await import("./gateway");
const server = "https://sound.example";
const room: Room = { id: "room", name: "room", slug: "room", kind: "room", topic: null, member_ids: null, position: 0, archived_at: null, last_message_id: null };
const snapshot: GatewayState = { ...serverState(server), rooms: [room], dms: [{ ...room, id: "dm", kind: "dm", member_ids: ["me", "friend"] }], me: {
  id: "me", username: "me", display_name: "Me", is_host: false, status: null, entrance_sound: null, last_seen_at: null,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
} };
const message: Message = { id: "message", room_id: "dm", author_id: "friend", body: "hello", attachments: [], reply_to: null, reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: 0 };
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", { setTimeout, clearTimeout }); played.length = 0; banners.length = 0; asked.length = 0; looking = false; });
afterEach(() => { resetNotifications(); setQuietServers(new Set()); setDmAlerts(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("routes DMs and room messages to distinct sound categories, not banner permission", () => {
  considerFrame(server, { op: "message.create", s: 1, d: message }, snapshot);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, room_id: "room" } }, snapshot);
  expect(played).toEqual(["dm", "room"]);
  expect(banners).toEqual([]);
});

it("ignores own, deleted and edited messages, and a room already being read", () => {
  considerFrame(server, { op: "message.create", s: 1, d: { ...message, author_id: "me" } }, snapshot);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, deleted_at: 1 } }, snapshot);
  considerFrame(server, { op: "message.update", s: 3, d: message }, snapshot);
  setViewing({ server, roomId: "dm" }); looking = true;
  considerFrame(server, { op: "message.create", s: 4, d: message }, snapshot);
  expect(played).toEqual([]);
  looking = false;
  considerFrame(server, { op: "message.create", s: 5, d: message }, snapshot);
  expect(played).toEqual(["dm"]);
});

it("visual mentions still use the silent native banner path", async () => {
  considerFrame(server, { op: "message.create", s: 1, d: { ...message, body: "@me hello" } }, snapshot);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toHaveLength(1);
});

it("a banner leads to the latest message in its batch (decision 20)", async () => {
  considerFrame(server, { op: "message.create", s: 1, d: { ...message, body: "@me hello" } }, snapshot);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, id: "later", body: "@me still there?" } }, snapshot);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([expect.objectContaining({ open: { server, room: "dm", message: "later" } })]);
});

it("replay is silent while preserving existing mention-banner batching", async () => {
  considerFrame(server, { op: "message.create", s: 1, d: { ...message, body: "@me hello" } }, snapshot, true);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, id: "next", body: "@me another" } }, snapshot, true);
  await vi.advanceTimersByTimeAsync(1200);
  expect(played).toEqual([]);
  expect(banners).toHaveLength(1);
});
it("a quiet server makes no sound, but a mention there still gets its banner", async () => {
  setQuietServers(new Set([server]));
  considerFrame(server, { op: "message.create", s: 1, d: message }, snapshot);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, id: "named", room_id: "room", body: "@me look" } }, snapshot);
  await vi.advanceTimersByTimeAsync(1200);
  expect(played).toEqual([]);
  expect(banners).toHaveLength(1);
  // Another server isn't quieted by it.
  considerFrame("https://other.example", { op: "message.create", s: 3, d: message }, snapshot);
  expect(played).toEqual(["dm"]);
});

// DM alerts (#291): a DM is addressed to you, so the Buddy list client gives
// every one a banner and asks the taskbar to point at Linger.
const withFriend: GatewayState = {
  ...snapshot,
  users: [{ ...(snapshot.me as NonNullable<GatewayState["me"]>), id: "friend", username: "jules", display_name: "Jules" }],
};

it("with DM alerts on, a DM gets a banner titled by who wrote it, and the taskbar is asked to point at it", async () => {
  setDmAlerts(() => true);
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  expect(asked).toEqual([{ cmd: "next_request_attention", args: { server, room: "dm" } }]);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([expect.objectContaining({ title: "Jules", body: "hello", open: { server, room: "dm", message: "message" } })]);
  expect(played).toEqual(["dm"]);
});

it("with DM alerts off, a DM is only its chime, as before", async () => {
  setDmAlerts(() => false);
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([]);
  expect(asked).toEqual([]);
  expect(played).toEqual(["dm"]);
});

it("the switch is read on every DM, so a change in Settings counts at once", async () => {
  let on = false;
  setDmAlerts(() => on);
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  on = true;
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, id: "second" } }, withFriend);
  expect(asked).toHaveLength(1);
});

it("the previous client never turns DM alerts on, so its DMs get no banner", async () => {
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([]);
  expect(asked).toEqual([]);
});

it("a DM you're looking right at asks for nothing", async () => {
  setDmAlerts(() => true);
  setViewing({ server, roomId: "dm" });
  looking = true;
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([]);
  expect(asked).toEqual([]);
});

it("a Quiet server's DM still gets its banner and the taskbar, with no chime", async () => {
  setDmAlerts(() => true);
  setQuietServers(new Set([server]));
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  await vi.advanceTimersByTimeAsync(1200);
  expect(played).toEqual([]);
  expect(banners).toHaveLength(1);
  expect(asked).toHaveLength(1);
});

it("DM alerts leave room messages alone", async () => {
  setDmAlerts(() => true);
  considerFrame(server, { op: "message.create", s: 1, d: { ...message, room_id: "room" } }, withFriend);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([]);
  expect(asked).toEqual([]);
});

it("a burst of DMs is one banner", async () => {
  setDmAlerts(() => true);
  considerFrame(server, { op: "message.create", s: 1, d: message }, withFriend);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, id: "again", body: "you there?" } }, withFriend);
  await vi.advanceTimersByTimeAsync(1200);
  expect(banners).toEqual([expect.objectContaining({ title: "Jules", body: "you there?" })]);
});
