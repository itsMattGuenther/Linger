import { describe, expect, it } from "vitest";
import type { Message } from "../../../generated/Message";
import { chatRows, lastEditable, newestShareLines, rowIndex, sameRow } from "./rows";

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

  it("gives a message-of-the-day line a group of its own, before and after (#464)", () => {
    const rows = chatRows(
      [message(1, "matt", T0), message(2, "matt", T0 + MIN, { motd: true }), message(3, "matt", T0 + 2 * MIN)],
      [],
      { atStart: true, leftOff: null },
    );
    expect(heads(rows)).toEqual(["divider", ["m000001", true], ["m000002", true], ["m000003", true]]);
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

  it("passes over a message-of-the-day line for Up's edit (#464)", () => {
    const messages = [message(1, "matt", T0), message(2, "matt", T0 + MIN, { motd: true })];
    expect(lastEditable(messages, "matt", true)?.id).toBe("m000001");
  });
});

describe("polls (#474)", () => {
  const poll = { question: "Which faction?", choices: [{ text: "Horde", voter_ids: [] }, { text: "Alliance", voter_ids: [] }], multi: false, closes_at: 9e12, closed_at: null, closed_by: null };
  const heads = (rows: ReturnType<typeof chatRows>) => rows.flatMap((row) => (row.kind === "message" ? [[row.message.id, row.head]] : [row.kind]));

  it("a poll always says who asked, and what's said after it starts a group", () => {
    const rows = chatRows([message(1, "matt", T0), message(2, "matt", T0 + MIN, { poll }), message(3, "matt", T0 + 2 * MIN)], [], { atStart: false, leftOff: null });
    expect(heads(rows)).toEqual([["m000001", true], ["m000002", true], ["m000003", true]]);
  });

  it("a poll's closed line is a line of its own, and so is what follows", () => {
    const closed = { poll_id: "m000001", question: "Which faction?", winners: ["Horde"] };
    const rows = chatRows([message(1, "eli", T0), message(2, "eli", T0 + MIN, { poll_closed: closed }), message(3, "eli", T0 + 2 * MIN)], [], {
      atStart: false,
      leftOff: null,
    });
    expect(heads(rows)).toEqual([["m000001", true], ["m000002", true], ["m000003", true]]);
    expect(lastEditable([message(1, "matt", T0), message(2, "matt", T0 + MIN, { poll_closed: closed })], "matt", true)?.id).toBe("m000001");
  });
});

describe("somebody leaving a group DM (#565)", () => {
  const left = (n: number, author: string, at: number, extra: Partial<Message> = {}) => message(n, author, at, { body: "left", left: true, ...extra });

  it("is a line of its own, and whoever speaks next is named again", () => {
    const rows = chatRows([message(1, "eli", T0), left(2, "eli", T0 + MIN), message(3, "eli", T0 + 2 * MIN)], [], { atStart: false, leftOff: null });
    expect(heads(rows)).toEqual([["m000001", true], ["m000002", true], ["m000003", true]]);
  });

  it("is never what Up edits, and one taken back just isn't there", () => {
    expect(lastEditable([message(1, "matt", T0), left(2, "matt", T0 + MIN)], "matt", true)?.id).toBe("m000001");
    const rows = chatRows([message(1, "eli", T0), left(2, "jules", T0 + MIN, { deleted_at: T0 + 2 * MIN, body: "" })], [], { atStart: false, leftOff: null });
    expect(heads(rows)).toEqual([["m000001", true]]);
  });
});

describe("somebody sharing their screen (#746)", () => {
  const shared = (n: number, author: string, at: number, extra: Partial<Message> = {}) => message(n, author, at, { body: "shared their screen", screen_share: true, ...extra });

  it("is a line of its own, and whoever speaks next is named again", () => {
    const rows = chatRows([message(1, "jules", T0), shared(2, "jules", T0 + MIN), message(3, "jules", T0 + 2 * MIN)], [], { atStart: false, leftOff: null });
    expect(heads(rows)).toEqual([["m000001", true], ["m000002", true], ["m000003", true]]);
  });

  it("is never what Up edits, and one taken back just isn't there", () => {
    expect(lastEditable([message(1, "matt", T0), shared(2, "matt", T0 + MIN)], "matt", true)?.id).toBe("m000001");
    const rows = chatRows([message(1, "eli", T0), shared(2, "jules", T0 + MIN, { deleted_at: T0 + 2 * MIN, body: "" })], [], { atStart: false, leftOff: null });
    expect(heads(rows)).toEqual([["m000001", true]]);
  });

  it("only each person's newest can say they're sharing now", () => {
    const rows = chatRows(
      [shared(1, "jules", T0), message(2, "dave", T0 + MIN), shared(3, "eli", T0 + 2 * MIN), shared(4, "jules", T0 + 3 * MIN)],
      [],
      { atStart: false, leftOff: null },
    );
    expect([...newestShareLines(rows)].sort()).toEqual(["m000003", "m000004"]);
  });
});

describe("somebody joining voice (#473)", () => {
  const join = (n: number, author: string, at: number) => message(n, author, at, { body: "joined voice", voice_join: true });
  const drawn = (rows: ReturnType<typeof chatRows>) =>
    rows.map((row) => (row.kind === "joins" ? `joins:${row.messages.map((one) => one.author_id).join(",")}` : row.kind === "message" ? [row.message.id, row.head] : row.kind));

  it("is a quiet line of its own, and whoever speaks next is named again", () => {
    const rows = chatRows([message(1, "eli", T0), join(2, "jules", T0 + MIN), message(3, "jules", T0 + 2 * MIN), message(4, "jules", T0 + 3 * MIN)], [], {
      atStart: false,
      leftOff: null,
    });
    // Jules speaking straight after their own join line still says who's talking.
    expect(drawn(rows)).toEqual([["m000001", true], "joins:jules", ["m000003", true], ["m000004", false]]);
  });

  it("shares a line with the joins before it when nothing was said between", () => {
    const rows = chatRows([join(1, "dave", T0), join(2, "callie", T0 + MIN), join(3, "sam", T0 + 2 * MIN)], [], { atStart: false, leftOff: null });
    expect(drawn(rows)).toEqual(["joins:dave,callie,sam"]);
    // Every join in it is found at that one row, for jumping to any of them.
    const index = rowIndex(rows);
    expect([index.get("m000001"), index.get("m000002"), index.get("m000003")]).toEqual([0, 0, 0]);
  });

  it("starts a new line after something is said, or after the group break", () => {
    const said = chatRows([join(1, "dave", T0), message(2, "eli", T0 + MIN), join(3, "callie", T0 + 2 * MIN)], [], { atStart: false, leftOff: null });
    expect(drawn(said)).toEqual(["joins:dave", ["m000002", true], "joins:callie"]);
    const later = chatRows([join(1, "dave", T0), join(2, "callie", T0 + 11 * MIN)], [], { atStart: false, leftOff: null });
    expect(drawn(later)).toEqual(["joins:dave", "joins:callie"]);
  });

  it("puts \"you left off here\" between two joins rather than inside a line", () => {
    const rows = chatRows([join(1, "dave", T0), join(2, "callie", T0 + MIN)], [], { atStart: false, leftOff: "m000001" });
    expect(drawn(rows)).toEqual(["joins:dave", "left-off", "joins:callie"]);
  });

  it("leaves out a join line that was taken back, and isn't Up's to edit", () => {
    const rows = chatRows([join(1, "dave", T0), { ...join(2, "callie", T0 + MIN), deleted_at: T0 + 2 * MIN }], [], { atStart: false, leftOff: null });
    expect(drawn(rows)).toEqual(["joins:dave"]);
    expect(lastEditable([message(1, "matt", T0), join(2, "matt", T0 + MIN)], "matt", true)?.id).toBe("m000001");
  });
});

describe("telling whether a row draws the same (#533)", () => {
  it("a message arriving leaves every row before it the same, and only the new one differs", () => {
    const said = [message(1, "eli", T0), message(2, "eli", T0 + MIN), message(3, "jules", T0 + 2 * MIN)];
    const before = chatRows(said, [], { atStart: true, leftOff: null });
    const after = chatRows([...said, message(4, "jules", T0 + 3 * MIN)], [], { atStart: true, leftOff: null });
    expect(after.slice(0, before.length).every((row, at) => before[at] !== undefined && sameRow(before[at], row))).toBe(true);
    expect(after.slice(0, before.length).some((row, at) => row === before[at])).toBe(false);
    expect(after).toHaveLength(before.length + 1);
  });

  it("an edit, a row becoming a group's first, or a send being confirmed is a different row", () => {
    const one = message(1, "eli", T0);
    const [row] = chatRows([one], [], { atStart: false, leftOff: null });
    if (row?.kind !== "message") throw new Error("expected a message row");
    expect(sameRow(row, { ...row, message: { ...one, body: "edited", edited_at: T0 + MIN } })).toBe(false);
    expect(sameRow(row, { ...row, head: !row.head })).toBe(false);
    expect(sameRow(row, { ...row, pending: !row.pending })).toBe(false);
    expect(sameRow(row, { ...row })).toBe(true);
  });

  it("a voice join line with somebody more is a different row", () => {
    const join = (n: number, author: string, at: number) => message(n, author, at, { voice_join: true });
    const [before] = chatRows([join(1, "eli", T0)], [], { atStart: false, leftOff: null });
    const [after] = chatRows([join(1, "eli", T0), join(2, "jules", T0 + MIN)], [], { atStart: false, leftOff: null });
    if (before === undefined || after === undefined) throw new Error("expected join rows");
    expect(sameRow(before, after)).toBe(false);
    expect(sameRow(before, { ...before })).toBe(true);
  });
});
