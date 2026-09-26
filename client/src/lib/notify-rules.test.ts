/**
 * The list of reasons anything is allowed to interrupt you.
 *
 * These tests are the enforceable version of SPEC §4.2's "one exception".
 * Anything that starts firing notifications for a reason not written down here
 * is a defect, however reasonable it looked at the time.
 */
import { describe, expect, it } from "vitest";

import type { Message } from "../generated/Message";
import type { NotifyRule } from "../generated/NotifyRule";
import type { User } from "../generated/User";
import { notificationText, notifyReason, peopleList } from "./notify-rules";

function person(id: string, username: string): User {
  return {
    id,
    username,
    display_name: username,
    is_host: false,
    style: {
      font_key: "sans",
      weight: 400,
      italic: false,
      fill: { kind: "solid", color: "sky" },
      effect: "none",
      msg_font_key: null,
    },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

const me = person("u-me", "matt");
const callie = person("u-callie", "callie");

function message(body: string, author = callie.id, room = "r-garage"): Message {
  return {
    id: "m1",
    room_id: room,
    author_id: author,
    body,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: 0,
  };
}

describe("what is worth interrupting somebody for", () => {
  it("says nothing about an ordinary message", () => {
    expect(notifyReason(message("what's for dinner"), me, [])).toBeNull();
  });

  it("says something when you are named", () => {
    expect(notifyReason(message("@matt look at this"), me, [])).toBe("mention");
  });

  it("does not fire on your own message, even when you name yourself", () => {
    expect(notifyReason(message("@matt remember this", me.id), me, [])).toBeNull();
  });

  it("does not fire on a message that has been taken back", () => {
    const gone = { ...message("@matt"), deleted_at: 5, body: "" };
    expect(notifyReason(gone, me, [])).toBeNull();
  });

  it("matches the username, not the display name", () => {
    const named = { ...me, display_name: "Matt Guenther" };
    expect(notifyReason(message("@Matt Guenther hello"), named, [])).toBeNull();
    expect(notifyReason(message("@matt hello"), named, [])).toBe("mention");
  });

  it("fires for somebody you asked to hear from, everywhere", () => {
    const rules: NotifyRule[] = [{ target_user_id: callie.id, room_id: null }];
    expect(notifyReason(message("hello"), me, rules)).toBe("rule");
    expect(notifyReason(message("hello", callie.id, "r-porch"), me, rules)).toBe("rule");
  });

  it("keeps a per-room rule to that room", () => {
    const rules: NotifyRule[] = [{ target_user_id: callie.id, room_id: "r-garage" }];
    expect(notifyReason(message("hello"), me, rules)).toBe("rule");
    expect(notifyReason(message("hello", callie.id, "r-porch"), me, rules)).toBeNull();
  });

  it("does not fire for a rule about somebody else", () => {
    const rules: NotifyRule[] = [{ target_user_id: "u-dave", room_id: null }];
    expect(notifyReason(message("hello"), me, rules)).toBeNull();
  });
});

describe("what the notification says", () => {
  it("names one person and quotes them", () => {
    const { title, body } = notificationText("garage", ["Callie"], "look at this");
    expect(title).toBe("Callie in #garage");
    expect(body).toBe("look at this");
  });

  it("never says how many", () => {
    // A tally on a lock screen is the badge SPEC §4.2 deleted, wearing a coat.
    const names = ["Callie", "Dave", "Ash", "Jo", "Sam"];
    const { title } = notificationText("garage", names, "…");
    expect(title).toBe("Callie, Dave, Ash and others in #garage");
    expect(title).not.toMatch(/\d/);
  });

  it("trails off rather than pasting a whole message onto the screen", () => {
    const { body } = notificationText("garage", ["Callie"], "x".repeat(400));
    expect(body.length).toBeLessThanOrEqual(141);
    expect(body.endsWith("…")).toBe(true);
  });

  it("joins two and three names the way a sentence does", () => {
    expect(peopleList(["Callie"])).toBe("Callie");
    expect(peopleList(["Callie", "Dave"])).toBe("Callie and Dave");
    expect(peopleList(["Callie", "Dave", "Ash"])).toBe("Callie, Dave and Ash");
  });
});
