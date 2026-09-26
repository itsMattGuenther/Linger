import { describe, expect, it, vi } from "vitest";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import type { GatewayState, MyVoice } from "../../lib/gateway";

vi.mock("../../lib/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const { serverState } = await import("../../lib/gateway");
const { talkingNow, voiceModel } = await import("./voice");

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

function room(id: string, name: string, kind: Room["kind"] = "room", members: string[] | null = null): Room {
  return { id, slug: name, name, topic: null, kind, member_ids: members, position: 0, archived_at: null, last_message_id: null };
}

const people = { matt: person("u-matt", "Matt"), eli: person("u-eli", "Eli"), jules: person("u-jules", "Jules") };

/** Friday evening, small: three people, #general with voice on, a DM with Jules. */
function evening(empty: GatewayState): GatewayState {
  return {
    ...empty,
    me: people.matt,
    users: Object.values(people),
    rooms: [room("r-general", "general")],
    dms: [room("d-jules", "d-jules", "dm", ["u-matt", "u-jules"])],
    voice: {
      "r-general": [
        { session_id: "s-eli", user_id: "u-eli" },
        { session_id: "s-jules", user_id: "u-jules" },
      ],
    },
  };
}
const SERVER = "https://voice.example";

function seat(extra: Partial<MyVoice> = {}): MyVoice {
  return {
    roomId: "r-general",
    muted: false,
    deafened: false,
    mutedBeforeDeafen: false,
    pushToTalk: false,
    moved: false,
    audio: "sending",
    peers: {},
    speaking: {},
    talking: false,
    volumes: {},
    ...extra,
  };
}

function inVoice(extra: Partial<MyVoice> = {}) {
  const state = evening(serverState(SERVER));
  return {
    ...state,
    voice: { "r-general": [...(state.voice["r-general"] ?? []), { session_id: "s-matt", user_id: people.matt.id }] },
    myVoice: seat(extra),
  };
}

describe("the voice bar's contents", () => {
  it("is nothing when you aren't in voice", () => {
    expect(voiceModel(evening(serverState(SERVER)), new Set())).toBeNull();
  });

  it("names the room and lists everyone in voice there, you included", () => {
    const model = voiceModel(inVoice(), new Set());
    expect(model?.where).toBe("#general");
    expect(model?.people.map(({ user, you }) => [user.display_name, you])).toEqual([
      ["Matt", true],
      ["Eli", false],
      ["Jules", false],
    ]);
  });

  it("carries how loud each person is for you and the session that sets it, and nothing for you (VOICE-10)", () => {
    const model = voiceModel(inVoice({ volumes: { "s-eli": 1.5 } }), new Set());
    expect(model?.people.map(({ user, volume, session }) => [user.display_name, volume, session])).toEqual([
      ["Matt", 1, null],
      ["Eli", 1.5, "s-eli"],
      ["Jules", 1, "s-jules"],
    ]);
  });

  it("names a DM by who's in it", () => {
    const model = voiceModel({ ...inVoice(), myVoice: seat({ roomId: "d-jules" }) }, new Set());
    expect(model?.where).toBe("Jules");
  });

  it("lights whoever is talking, and you when you are", () => {
    const state = inVoice({ talking: true, speaking: { "s-eli": true, "s-jules": false } });
    const model = voiceModel(state, talkingNow(state));
    expect(model?.people.filter((person) => person.speaking).map((person) => person.user.display_name)).toEqual(["Matt", "Eli"]);
  });

  it("says what a button can't: opening the microphone, or how to talk with push-to-talk", () => {
    expect(voiceModel(inVoice({ audio: "opening" }), new Set())?.line).toBe("opening the microphone…");
    expect(voiceModel(inVoice({ pushToTalk: true, muted: true }), new Set())?.line).toBe("hold Right Ctrl to talk");
    expect(voiceModel(inVoice({ pushToTalk: true, muted: true }), new Set(), "F13")?.line).toBe("hold F13 to talk");
    expect(voiceModel(inVoice(), new Set())?.line).toBeNull();
  });

  it("knows who's talking only while you're in voice", () => {
    expect(talkingNow(evening(serverState(SERVER)))).toEqual(new Set());
  });

  it("shows each person's microphone as they share it, and says when a client doesn't (VOICE-6)", () => {
    const state = inVoice({ muted: true });
    const shared = {
      ...state,
      voice: {
        "r-general": [
          { session_id: "s-eli", user_id: "u-eli", controls: { muted: true, deafened: false } },
          // An older client or server: nothing is shared, which isn't a live microphone either.
          { session_id: "s-jules", user_id: "u-jules" },
          { session_id: "s-matt", user_id: "u-matt", controls: { muted: false, deafened: false } },
        ],
      },
    };
    const model = voiceModel(shared, new Set());
    expect(model?.people.map(({ user, controls }) => [user.display_name, controls])).toEqual([
      // Yours from your own controls, not what the server last heard.
      ["Matt", "muted"],
      ["Eli", "muted"],
      ["Jules", "unknown"],
    ]);
    const deaf = voiceModel({ ...shared, voice: { "r-general": [{ session_id: "s-eli", user_id: "u-eli", controls: { muted: true, deafened: true } }] } }, new Set());
    expect(deaf?.people.find((person) => person.user.id === "u-eli")?.controls).toBe("deafened");
  });

  it("says when somebody can't be reached from here, or is still connecting (VOICE-7)", () => {
    const state = inVoice({ peers: { "s-eli": "connecting", "s-jules": "failed" } });
    expect(voiceModel(state, new Set())?.people.map(({ user, link }) => [user.display_name, link])).toEqual([
      ["Matt", null],
      ["Eli", "connecting"],
      ["Jules", "unreachable"],
    ]);
    const settled = inVoice({ peers: { "s-eli": "connected", "s-jules": "disconnected" } });
    expect(voiceModel(settled, new Set())?.people.map(({ link }) => link)).toEqual([null, null, "unreachable"]);
  });
});
