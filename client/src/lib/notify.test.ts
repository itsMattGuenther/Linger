import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayState } from "./gateway";
import type { Message } from "../generated/Message";
import type { Room } from "../generated/Room";

const played: string[] = [];
const banners: unknown[] = [];
let looking = false;
vi.mock("./sound", () => ({ playSound: (cue: string) => { played.push(cue); } }));
vi.mock("./looking", () => ({ isLooking: () => looking }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: async (_cmd: string, args: unknown) => { banners.push(args); } }));
vi.mock("@tauri-apps/plugin-notification", () => ({ isPermissionGranted: async () => true, requestPermission: async () => "granted" }));
const { considerFrame, resetNotifications, setViewing } = await import("./notify");
const { serverState } = await import("./gateway");
const server = "https://sound.example";
const room: Room = { id: "room", name: "room", slug: "room", kind: "room", topic: null, member_ids: null, position: 0, archived_at: null, last_message_id: null };
const snapshot: GatewayState = { ...serverState(server), rooms: [room], dms: [{ ...room, id: "dm", kind: "dm", member_ids: ["me", "friend"] }], me: {
  id: "me", username: "me", display_name: "Me", is_host: false, status: null, entrance_sound: null, last_seen_at: null,
  style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
} };
const message: Message = { id: "message", room_id: "dm", author_id: "friend", body: "hello", attachments: [], reply_to: null, reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: 0 };
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", { setTimeout, clearTimeout }); played.length = 0; banners.length = 0; looking = false; });
afterEach(() => { resetNotifications(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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

it("replay is silent while preserving existing mention-banner batching", async () => {
  considerFrame(server, { op: "message.create", s: 1, d: { ...message, body: "@me hello" } }, snapshot, true);
  considerFrame(server, { op: "message.create", s: 2, d: { ...message, id: "next", body: "@me another" } }, snapshot, true);
  await vi.advanceTimersByTimeAsync(1200);
  expect(played).toEqual([]);
  expect(banners).toHaveLength(1);
});
