import { describe, expect, it } from "vitest";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import type { AuthedApi } from "../../lib/api";
import { type GatewayState, serverState } from "../../lib/gateway";
import { cardSafety } from "./safety";

// The host taking somebody out of voice from their card (#423).

function person(id: string, name: string, is_host = false): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function room(id: string, name: string, extra: Partial<Room> = {}): Room {
  return { id, slug: name, name, topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null, ...extra };
}

const matt = person("u-matt", "Matt", true);
const eli = person("u-eli", "Eli");

function state(me: User, voice: GatewayState["voice"]): GatewayState {
  return {
    ...serverState("https://safety.example"),
    me,
    users: [matt, eli],
    rooms: [room("r-general", "general")],
    voice,
  };
}

function api(asked: string[]): AuthedApi {
  const stub = {
    baseUrl: "https://safety.example",
    takeOutOfVoice: async (roomId: string, userId: string) => {
      asked.push(`${roomId} ${userId}`);
    },
  };
  return stub as unknown as AuthedApi;
}

describe("taking somebody out of voice, from their card (#423)", () => {
  const inGeneral = { "r-general": [{ session_id: "s-eli", user_id: "u-eli" }] };

  it("is offered to the host, for somebody in a room's voice, and names the room", async () => {
    const asked: string[] = [];
    const safety = cardSafety(api(asked), state(matt, inGeneral), eli);
    expect(safety?.takeOut?.room).toBe("general");
    expect(await safety?.takeOut?.act()).toBeNull();
    expect(asked).toEqual(["r-general u-eli"]);
  });

  it("isn't offered to anybody else, or for somebody who isn't in a room's voice", () => {
    expect(cardSafety(api([]), state({ ...eli }, inGeneral), matt)?.takeOut).toBeUndefined();
    expect(cardSafety(api([]), state(matt, {}), eli)?.takeOut).toBeUndefined();
    // A DM's call isn't a room the host reaches into.
    expect(cardSafety(api([]), state(matt, { "d-eli": [{ session_id: "s-eli", user_id: "u-eli" }] }), eli)?.takeOut).toBeUndefined();
  });
});
