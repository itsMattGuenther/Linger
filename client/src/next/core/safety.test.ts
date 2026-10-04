import { describe, expect, it } from "vitest";
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import type { AuthedApi } from "../../lib/api";
import { type GatewayState, serverState } from "../../lib/gateway";
import { cardSafety, hostName, reportsReachCohosts } from "./safety";

// What a person's card offers behind its ···: the host or a co-host taking
// somebody out of voice (#423), and the co-host switch, which is the host's
// alone (#424).

function person(id: string, name: string, extra: Partial<User> = {}): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    is_cohost: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
    ...extra,
  };
}

function room(id: string, name: string, extra: Partial<Room> = {}): Room {
  return { id, slug: name, name, topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null, ...extra };
}

const matt = person("u-matt", "Matt", { is_host: true });
const eli = person("u-eli", "Eli");
const dave = person("u-dave", "Dave", { is_cohost: true });

function state(me: User, voice: GatewayState["voice"], users: User[] = [matt, eli, dave]): GatewayState {
  return {
    ...serverState("https://safety.example"),
    me,
    users: users.map((user) => (user.id === me.id ? me : user)),
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

  it("is offered to a co-host too, but never on the host's card (#424)", () => {
    expect(cardSafety(api([]), state(dave, inGeneral), eli)?.takeOut?.room).toBe("general");
    const hostInVoice = { "r-general": [{ session_id: "s-matt", user_id: "u-matt" }] };
    expect(cardSafety(api([]), state(dave, hostInVoice), matt)?.takeOut).toBeUndefined();
  });
});

describe("the co-host switch on a card (#424)", () => {
  it("is the host's, on anybody else", () => {
    expect(cardSafety(api([]), state(matt, {}), eli)?.cohost?.on).toBe(false);
    expect(cardSafety(api([]), state(matt, {}), dave)?.cohost?.on).toBe(true);
  });

  it("isn't a member's or a co-host's", () => {
    expect(cardSafety(api([]), state(eli, {}), dave)?.cohost).toBeUndefined();
    expect(cardSafety(api([]), state(dave, {}), eli)?.cohost).toBeUndefined();
  });

  it("is never on the host's card, or your own", () => {
    expect(cardSafety(api([]), state(dave, {}), matt)?.cohost).toBeUndefined();
    expect(cardSafety(api([]), state(matt, {}), matt)).toBeUndefined();
  });
});

describe("who a report goes to (#424)", () => {
  it("names the host, whoever else gets it", () => {
    expect(hostName(state(eli, {}))).toBe("Matt");
    expect(hostName(state(dave, {}))).toBe("Matt");
    expect(hostName(state(matt, {}))).toBeNull();
  });

  it("reaches co-hosts besides you when there are any", () => {
    expect(reportsReachCohosts(state(eli, {}))).toBe(true);
    expect(reportsReachCohosts(state(eli, {}, [matt, eli]))).toBe(false);
    // The only co-host is you: you know what you sent.
    expect(reportsReachCohosts(state(dave, {}))).toBe(false);
  });
});
