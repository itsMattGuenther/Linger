import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../../generated/Message";
import type { Room } from "../../../generated/Room";
import type { User } from "../../../generated/User";
import type { GatewayState } from "../../../lib/gateway";

// The store reaches for a notifier and a sound player at load; neither matters here.
vi.mock("../../../lib/notify", () => ({ considerFrame: () => undefined }));
vi.mock("../../../lib/sound", () => ({ playKnock: () => false, playSound: () => false }));

const { serverState } = await import("../../../lib/gateway");
const { mentionHandles } = await import("../../../lib/markdown");
const { notifyReason } = await import("../../../lib/notify-rules");
const { mentionAt, mentionable, mentionMatches, putMention, sameTyping } = await import("./mentions");

function person(id: string, display_name: string, username = display_name.toLowerCase()): User {
  return {
    id,
    username,
    display_name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function room(id: string, extra: Partial<Room> = {}): Room {
  return { id, slug: id, name: id, topic: null, kind: "room", member_ids: null, position: 0, archived_at: null, last_message_id: null, ...extra };
}

const matt = person("u-matt", "Matt");
const justin = person("u-justin", "Justin B", "bendthebracket");
const callie = person("u-callie", "Callie");
const zoe = person("u-zoe", "Zoë");
const eli = person("u-eli", "Eli");
const dave = person("u-dave", "dave");
// Somebody who registered a handle that reads as everybody.
const here = person("u-here", "Hera", "here");
const everyone = person("u-everyone", "Evie", "everyone");

const general = room("r-general");
const dm = room("d-justin-callie", { kind: "dm", member_ids: ["u-matt", "u-justin", "u-callie"] });

function evening(extra: Partial<GatewayState> = {}): GatewayState {
  return {
    ...serverState("https://home.example"),
    me: matt,
    users: [matt, justin, callie, zoe, eli, dave, here, everyone],
    rooms: [general],
    dms: [dm],
    presence: [
      { user_id: "u-matt", state: "in_room", room_id: "r-general", away_message: null },
      { user_id: "u-zoe", state: "in_room", room_id: "r-general", away_message: null },
      { user_id: "u-eli", state: "in_room", room_id: "r-general", away_message: null },
      { user_id: "u-callie", state: "away", room_id: null, away_message: null },
    ],
    occupancy: { "r-general": ["u-matt", "u-zoe", "u-eli"] },
    ...extra,
  };
}

const names = (list: { user: User }[]) => list.map((one) => one.user.display_name);

describe("where an @ opens the list", () => {
  it("opens at the start of a word, with what's typed up to the caret", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAt("hey @jus", 8)).toEqual({ start: 4, end: 8, query: "jus" });
    expect(mentionAt("(@Jus", 5)).toEqual({ start: 1, end: 5, query: "Jus" });
    // Mid-word: the query stops at the caret, and choosing replaces the whole word.
    expect(mentionAt("hey @justin later", 7)).toEqual({ start: 4, end: 11, query: "ju" });
    // Names find by more than a handle's characters.
    expect(mentionAt("@zoë", 4)).toEqual({ start: 0, end: 4, query: "zoë" });
  });

  it("never opens inside an address, as the parser never draws a mention there", () => {
    expect(mentionAt("you@example.com", 4)).toBeNull();
    expect(mentionAt("you@", 4)).toBeNull();
    expect(mentionAt("you@ex", 6)).toBeNull();
  });

  it("never opens inside code or after an escape", () => {
    expect(mentionAt("`@ju` said", 4)).toBeNull();
    expect(mentionAt("```\n@ju", 7)).toBeNull();
    expect(mentionAt("\\@ju", 4)).toBeNull();
  });

  it("closes once the word ends or the caret leaves it", () => {
    expect(mentionAt("@ju ", 4)).toBeNull();
    expect(mentionAt("@ju-", 4)).toBeNull();
    expect(mentionAt("hey @ju", 3)).toBeNull();
    expect(mentionAt("", 0)).toBeNull();
    expect(mentionAt("nothing here", 7)).toBeNull();
  });

  it("tells two readings of the box apart only when the list would differ", () => {
    expect(sameTyping({ start: 0, end: 3, query: "ju" }, { start: 0, end: 3, query: "ju" })).toBe(true);
    expect(sameTyping({ start: 0, end: 3, query: "ju" }, { start: 0, end: 3, query: "j" })).toBe(false);
    expect(sameTyping(null, null)).toBe(true);
    expect(sameTyping(null, { start: 0, end: 1, query: "" })).toBe(false);
  });
});

describe("who the list offers", () => {
  it("in a room: everyone on the server, the people in the room first, then the rest, each by name", () => {
    expect(names(mentionable(evening(), general))).toEqual(["Eli", "Zoë", "Callie", "dave", "Justin B"]);
  });

  it("in a DM: only the people in it, since nobody else could see the mention", () => {
    expect(names(mentionable(evening(), dm))).toEqual(["Callie", "Justin B"]);
  });

  it("never you, and never a handle that reads as everybody", () => {
    const offered = mentionable(evening(), general).map((one) => one.user.username);
    expect(offered).not.toContain("matt");
    expect(offered).not.toContain("here");
    expect(offered).not.toContain("everyone");
  });

  it("carries where each person is, for their marker", () => {
    const [first] = mentionable(evening(), general);
    expect(first?.state).toBe("in_room");
    expect(mentionable(evening(), dm).find((one) => one.user.id === "u-callie")?.state).toBe("away");
  });

  it("finds by display name or username, ignoring case and accents, and keeps the order", () => {
    const people = mentionable(evening(), general);
    expect(names(mentionMatches(people, "jus"))).toEqual(["Justin B"]);
    expect(names(mentionMatches(people, "bend"))).toEqual(["Justin B"]);
    expect(names(mentionMatches(people, "JUS"))).toEqual(["Justin B"]);
    expect(names(mentionMatches(people, "zoe"))).toEqual(["Zoë"]);
    expect(names(mentionMatches(people, "e"))).toEqual(["Eli", "Zoë", "Callie", "dave", "Justin B"]);
    expect(names(mentionMatches(people, ""))).toEqual(names(people));
    expect(mentionMatches(people, "nobody")).toEqual([]);
  });
});

describe("what choosing somebody puts in the box", () => {
  it("puts @username and a space in place of what was typed, with the caret after", () => {
    const text = "hey @ju";
    const typing = mentionAt(text, text.length);
    if (!typing) throw new Error("no mention");
    expect(putMention(text, typing, "bendthebracket", 8000)).toEqual({ text: "hey @bendthebracket ", caret: 20 });
  });

  it("replaces the whole word, and uses a space already there", () => {
    const text = "hey @jus later";
    const typing = mentionAt(text, 6);
    if (!typing) throw new Error("no mention");
    expect(putMention(text, typing, "bendthebracket", 8000)).toEqual({ text: "hey @bendthebracket later", caret: 20 });
  });

  it("refuses to pass the length limit", () => {
    const text = "@j";
    const typing = mentionAt(text, 2);
    if (!typing) throw new Error("no mention");
    expect(putMention(text, typing, "bendthebracket", 10)).toBeNull();
  });

  it("stores a real mention: it's drawn, and it notifies the person, as a typed one does", () => {
    const text = "@ju the porch light";
    const typing = mentionAt(text, 3);
    if (!typing) throw new Error("no mention");
    const put = putMention(text, typing, justin.username, 8000);
    expect(put?.text).toBe("@bendthebracket the porch light");
    expect(mentionHandles(put?.text ?? "")).toEqual(["bendthebracket"]);
    const message: Message = {
      id: "m1",
      room_id: "r-general",
      author_id: callie.id,
      body: put?.text ?? "",
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: 0,
    };
    expect(notifyReason(message, justin, [])).toBe("mention");
  });
});
