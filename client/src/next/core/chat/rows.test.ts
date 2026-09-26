import { describe, expect, it } from "vitest";
import type { Message } from "../../../generated/Message";
import { chatRows, lastEditable, rowIndex } from "./rows";

const MIN = 60_000;
const T0 = Date.parse("2026-09-25T22:00:00Z");

function message(n: number, author: string, at: number, extra: Partial<Message> = {}): Message {
  return {
    id: `m${String(n).padStart(6, "0")}`,
    room_id: "r-general",
    author_id: author,
    body: `message ${n}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: at,
    ...extra,
  };
}

const heads = (rows: ReturnType<typeof chatRows>) =>
  rows.flatMap((row) => (row.kind === "message" ? [[row.message.id, row.head]] : [row.kind]));

describe("the chat window's rows", () => {
  it("groups one person's run of messages under one inline name", () => {
    const rows = chatRows(
      [message(1, "eli", T0), message(2, "eli", T0 + MIN), message(3, "jules", T0 + 2 * MIN), message(4, "eli", T0 + 3 * MIN)],
      [],
      { atStart: true, leftOff: null },
    );
    expect(heads(rows)).toEqual(["divider", ["m000001", true], ["m000002", false], ["m000003", true], ["m000004", true]]);
  });

  it("breaks a group after ten quiet minutes, and a session after three hours", () => {
    const rows = chatRows([message(1, "eli", T0), message(2, "eli", T0 + 11 * MIN), message(3, "eli", T0 + 11 * MIN + 181 * MIN)], [], {
      atStart: true,
      leftOff: null,
    });
    expect(heads(rows)).toEqual(["divider", ["m000001", true], ["m000002", true], "divider", ["m000003", true]]);
  });

  it("always shows who is replying: a reply opens a group", () => {
    const rows = chatRows([message(1, "eli", T0), message(2, "eli", T0 + MIN, { reply_to: "m000009" })], [], { atStart: true, leftOff: null });
    expect(heads(rows)).toEqual(["divider", ["m000001", true], ["m000002", true]]);
  });

  it("lets a deleted reply fall back into its group (its quote is gone too)", () => {
    const rows = chatRows(
      [message(1, "eli", T0), message(2, "eli", T0 + MIN, { reply_to: "m000001", deleted_at: T0 + 2 * MIN })],
      [],
      { atStart: true, leftOff: null },
    );
    expect(heads(rows)).toEqual(["divider", ["m000001", true], ["m000002", false]]);
  });

  it("puts sends still waiting after the confirmed messages, marked pending", () => {
    const rows = chatRows([message(1, "matt", T0)], [message(900001, "matt", T0 + MIN)], { atStart: true, leftOff: null });
    const pending = rows.flatMap((row) => (row.kind === "message" ? [[row.message.id, row.pending]] : []));
    expect(pending).toEqual([
      ["m000001", false],
      ["m900001", true],
    ]);
  });

  it("draws the left-off line above the first message you haven't read, and names its author", () => {
    const rows = chatRows([message(1, "eli", T0), message(2, "eli", T0 + MIN), message(3, "eli", T0 + 2 * MIN)], [], {
      atStart: true,
      leftOff: "m000001",
    });
    expect(heads(rows)).toEqual(["divider", ["m000001", true], "left-off", ["m000002", true], ["m000003", false]]);
  });

  it("indexes messages by row, and finds the last one you can edit", () => {
    const messages = [message(1, "matt", T0), message(2, "eli", T0 + MIN), message(3, "matt", T0 + 2 * MIN, { deleted_at: T0 })];
    const rows = chatRows(messages, [], { atStart: true, leftOff: null });
    expect(rowIndex(rows).get("m000002")).toBe(2);
    expect(lastEditable(messages, "matt", true)?.id).toBe("m000001");
    expect(lastEditable(messages, "matt", false)).toBeNull();
    expect(lastEditable(messages, null, true)).toBeNull();
  });
});
