/**
 * Only the list window makes noise (docs/design/architecture.md, the owner):
 * a chime, a knock's sound and a desktop banner come once, from the list
 * window, however many other windows are open (parity NOTE-4, SND-5, WIN-8).
 * A viewer folds the same frames into its copy of the store and does nothing
 * else. The owner and a viewer run as two copies of the store in one
 * process, on an in-memory bus, as in share.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../generated/ServerFrame";
import type { User } from "../../generated/User";

type Handler = (event: { payload: unknown }) => void;
const ownerCore = new Map<string, Handler>();
const noise = vi.hoisted(() => ({ considered: [] as unknown[], sounds: [] as string[], knocks: 0, invoked: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string) => {
    noise.invoked.push(cmd);
    return true;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: Handler) => {
    ownerCore.set(name, handler);
    return () => ownerCore.delete(name);
  },
  emit: async () => undefined,
  emitTo: async () => undefined,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "main", listen: async () => () => undefined }) }));
vi.mock("../../lib/notify", () => ({
  considerFrame: (server: string, frame: ServerFrame) => void noise.considered.push([server, frame.op]),
  setViewing: () => undefined,
}));
vi.mock("../../lib/sound", () => ({
  playKnock: () => {
    noise.knocks += 1;
    return true;
  },
  playSound: (cue: string) => {
    noise.sounds.push(cue);
    return true;
  },
}));

const HOME = "https://home.example";

function person(id: string, name: string): User {
  return {
    id,
    username: name,
    display_name: name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

const matt = person("u-matt", "matt");
const eli = person("u-eli", "eli");
const ready: ServerFrame = {
  s: 1,
  op: "ready",
  d: {
    session_id: "s-1",
    user: matt,
    users: [matt, eli],
    rooms: [
      { id: "r-general", slug: "general", name: "general", topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null },
      { id: "d-eli", slug: "d-eli", name: "", topic: null, kind: "dm", member_ids: ["u-matt", "u-eli"], position: 0, archived_at: null, last_message_id: null },
    ],
    dms: [],
    presence: [],
  },
};

/** An evening's noise: a mention in a room, a DM, and a knock. */
function noisy(from: number): ServerFrame[] {
  const said = (s: number, room: string, body: string): ServerFrame => ({
    s,
    op: "message.create",
    d: { id: `m${s}`, room_id: room, author_id: "u-eli", body, reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: s },
  });
  return [said(from, "r-general", "@matt the porch light"), said(from + 1, "d-eli", "you around?"), { s: from + 2, op: "knock", d: { from_user_id: "u-eli" } }];
}

function ownerApi() {
  return {
    baseUrl: HOME,
    accessToken: vi.fn(async () => ({ token: "token-1", expiresAt: Date.now() + 600_000 })),
    heldToken: () => ({ token: "token-1", expiresAt: Date.now() + 600_000 }),
    get: vi.fn(async () => []),
    post: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

async function windows() {
  const { memoryHub } = await import("./bus.memory");
  const hub = memoryHub();
  vi.resetModules();
  const owner = { gateway: await import("../../lib/gateway"), share: await import("./share"), bus: hub.bus("main") };
  vi.resetModules();
  const viewers = [
    { gateway: await import("../../lib/gateway"), mirror: await import("./mirror"), bus: hub.bus("chat") },
  ];
  vi.resetModules();
  viewers.push({ gateway: await import("../../lib/gateway"), mirror: await import("./mirror"), bus: hub.bus("settings") });
  return { hub, owner, viewers };
}

describe("only the list window makes noise", () => {
  beforeEach(() => {
    ownerCore.clear();
    Object.assign(noise, { considered: [], sounds: [], knocks: 0, invoked: [] });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("other windows take in mentions, DMs and knocks without a chime, a knock's sound or a banner", async () => {
    const { hub, owner, viewers } = await windows();
    await owner.gateway.connect(ownerApi() as never);
    await owner.share.shareAsOwner(owner.bus, () => new Map([[HOME, ownerApi() as never]]));
    ownerCore.get("gateway:frame")?.({ payload: { server: HOME, frame: ready } });
    const following = await Promise.all(viewers.map((viewer) => viewer.mirror.followOwner(viewer.bus)));
    Object.assign(noise, { considered: [], sounds: [], knocks: 0, invoked: [] });

    // The core sends every window the evening; here only the other windows get it.
    for (const frame of noisy(2)) hub.broadcast("gateway:frame", { server: HOME, frame });
    for (const viewer of viewers) {
      await vi.waitFor(() => expect(viewer.gateway.serverState(HOME).knocks).toHaveLength(1));
      expect(viewer.gateway.serverState(HOME).dms.length + viewer.gateway.serverState(HOME).rooms.length).toBeGreaterThan(0);
    }
    await new Promise((settle) => setTimeout(settle, 20));
    expect(noise.considered).toEqual([]);
    expect(noise.sounds).toEqual([]);
    expect(noise.knocks).toBe(0);
    expect(noise.invoked.filter((cmd) => cmd === "show_notification" || cmd.startsWith("voice_"))).toEqual([]);

    // The list window, given the same evening, is the one that speaks up: once.
    for (const frame of noisy(2)) ownerCore.get("gateway:frame")?.({ payload: { server: HOME, frame } });
    await vi.waitFor(() => expect(noise.knocks).toBe(1));
    expect(noise.considered).toEqual([
      [HOME, "message.create"],
      [HOME, "message.create"],
      [HOME, "knock"],
    ]);
    for (const follower of following) follower.stop();
  });
});
