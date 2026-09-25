import { describe, expect, it, vi } from "vitest";
import type { GatewayState } from "../../../lib/gateway";
import type { Room } from "../../../generated/Room";
import type { User } from "../../../generated/User";

// The store reaches for a notifier and a sound player at load; neither matters here.
vi.mock("../../../lib/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const { serverState } = await import("../../../lib/gateway");
const { conversationIn, openingAt, tabModel, typingIn, voiceHere } = await import("./conversation");

const HOME = "https://home.example";
const NOW = Date.parse("2026-09-25T22:52:00Z");

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function room(id: string, name: string, extra: Partial<Room> = {}): Room {
  return { id, slug: name, name, topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null, ...extra };
}

const matt = person("u-matt", "Matt");
const eli = person("u-eli", "Eli");
const jules = person("u-jules", "Jules");

function evening(extra: Partial<GatewayState> = {}): GatewayState {
  return {
    ...serverState(HOME),
    me: matt,
    users: [matt, eli, jules],
    rooms: [room("r-general", "general"), room("r-old", "old", { archived_at: 1 })],
    dms: [room("d-jules", "d-jules", { kind: "dm", member_ids: ["u-matt", "u-jules"] }), room("d-both", "d-both", { kind: "dm", member_ids: ["u-matt", "u-eli", "u-jules"] })],
    presence: [
      { user_id: "u-eli", state: "in_room", room_id: "r-general", away_message: null },
      { user_id: "u-jules", state: "away", room_id: null, away_message: null },
    ],
    ...extra,
  };
}

const tab = (roomId: string) => ({ server: HOME, roomId });

describe("what the chat window shows about a conversation", () => {
  it("finds rooms and DMs you can see, and not archived rooms", () => {
    const state = evening();
    expect(conversationIn(state, "r-general")?.name).toBe("general");
    expect(conversationIn(state, "d-jules")?.kind).toBe("dm");
    expect(conversationIn(state, "r-old")).toBeNull();
    expect(conversationIn(state, "r-missing")).toBeNull();
  });

  it("names a room's tab by its name with a #, and a DM's by who's in it", () => {
    const state = evening();
    expect(tabModel(tab("r-general"), state, true, new Set())).toMatchObject({ id: `${HOME}#r-general`, title: "general", label: "#general", lead: { kind: "room" } });
    expect(tabModel(tab("d-jules"), state, true, new Set())).toMatchObject({ title: "Jules", label: "DM with Jules", lead: { kind: "person", user: jules, state: "away" } });
    // A group DM has no one person to lead with.
    expect(tabModel(tab("d-both"), state, true, new Set())?.lead).toBeNull();
    expect(tabModel(tab("r-missing"), state, true, new Set())).toBeNull();
  });

  it("is bold only for something new in a tab that isn't showing", () => {
    const state = evening({ newest: { "r-general": "m2" }, read: { "r-general": "m1" } });
    expect(tabModel(tab("r-general"), state, false, new Set())?.fresh).toBe(true);
    expect(tabModel(tab("r-general"), state, true, new Set())?.fresh).toBe(false);
    expect(tabModel(tab("r-general"), { ...state, read: { "r-general": "m2" } }, false, new Set())?.fresh).toBe(false);
  });

  it("says whose voice is in a room, and lights it when someone there is talking", () => {
    const voice = { "r-general": [{ session_id: "s-eli", user_id: "u-eli" }] };
    const state = evening({ voice });
    expect(tabModel(tab("r-general"), state, true, new Set())).toMatchObject({ voice: "others", speaking: false });
    expect(tabModel(tab("r-general"), state, true, new Set(["u-eli"]))?.speaking).toBe(true);
    expect(tabModel(tab("d-jules"), state, true, new Set(["u-eli"]))).toMatchObject({ voice: null, speaking: false });
    const mine = evening({ voice, myVoice: { ...({} as NonNullable<GatewayState["myVoice"]>), roomId: "r-general" } });
    expect(tabModel(tab("r-general"), mine, true, new Set())?.voice).toBe("mine");
    expect(voiceHere(state, "r-general")).toEqual(["u-eli"]);
    expect(voiceHere(state, "d-jules")).toEqual([]);
  });

  it("lists who's typing, without you, and forgets anyone gone quiet", () => {
    const state = evening({ typing: { "r-general": { "u-eli": NOW - 1_000, "u-jules": NOW - 60_000 } } });
    expect(typingIn(state, "r-general", NOW)).toEqual([eli]);
    expect(typingIn(state, "d-jules", NOW)).toEqual([]);
  });

  it("opens on where you left off only when something arrived since", () => {
    const state = evening({ newest: { "r-general": "m9", "d-jules": "m5" }, read: { "r-general": "m4", "d-jules": "m5" } });
    expect(openingAt(state, "r-general")).toBe("m4");
    expect(openingAt(state, "d-jules")).toBeNull();
    // Never read: nothing to come back to, so the newest.
    expect(openingAt(state, "d-both")).toBeNull();
  });
});
