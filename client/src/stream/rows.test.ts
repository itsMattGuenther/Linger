/**
 * Grouping and session breaks. The interesting cases are the boundaries: a gap
 * of exactly ten minutes, a session break that also has to break the group, and
 * a page of older history whose top is not the start of anything.
 */
import { describe, expect, it } from "vitest";

import type { Message } from "../generated/Message";
import { buildRows, type StreamRow } from "./rows";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

let counter = 0;

/** A message that is only as real as these tests need it to be. */
function message(author: string, at: number): Message {
  counter += 1;
  return {
    id: `m${String(counter).padStart(4, "0")}`,
    room_id: "room",
    author_id: author,
    body: "hello",
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: at,
  };
}

function shape(rows: StreamRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === "divider") return "divider";
    if (row.kind === "left-off") return "left-off";
    return row.head ? `head:${row.message.author_id}` : "cont";
  });
}

const grouped = { atStart: false };

describe("buildRows", () => {
  it("returns nothing for an empty room", () => {
    expect(buildRows([], { atStart: true })).toEqual([]);
  });

  it("groups consecutive messages from one author", () => {
    const start = Date.now();
    const rows = buildRows(
      [message("matt", start), message("matt", start + MINUTE), message("matt", start + 2 * MINUTE)],
      grouped,
    );
    expect(shape(rows)).toEqual(["head:matt", "cont", "cont"]);
  });

  it("breaks the group when the author changes", () => {
    const start = Date.now();
    const rows = buildRows([message("matt", start), message("callie", start + MINUTE)], grouped);
    expect(shape(rows)).toEqual(["head:matt", "head:callie"]);
  });

  it("breaks the group after ten minutes of the same author's silence", () => {
    const start = Date.now();
    const justUnder = buildRows([message("matt", start), message("matt", start + 10 * MINUTE)], grouped);
    expect(shape(justUnder)).toEqual(["head:matt", "cont"]);

    const justOver = buildRows(
      [message("matt", start), message("matt", start + 10 * MINUTE + 1)],
      grouped,
    );
    expect(shape(justOver)).toEqual(["head:matt", "head:matt"]);
  });

  it("breaks the session after three hours, and breaks the group with it", () => {
    const start = Date.now();
    const rows = buildRows([message("matt", start), message("matt", start + 3 * HOUR + 1)], grouped);
    expect(shape(rows)).toEqual(["head:matt", "divider", "head:matt"]);
  });

  it("labels the start of history, but not the top of a page", () => {
    const start = Date.now();
    const messages = [message("matt", start)];
    expect(shape(buildRows(messages, { atStart: true }))).toEqual([
      "divider",
      "head:matt",
    ]);
    expect(shape(buildRows(messages, grouped))).toEqual(["head:matt"]);
  });

  it("gives every row a key that survives older history arriving above it", () => {
    const start = Date.now();
    const older = [message("matt", start - 4 * HOUR)];
    const newer = [message("callie", start)];

    const before = buildRows(newer, grouped);
    const after = buildRows([...older, ...newer], grouped);

    const keptKeys = after.map((row) => row.key);
    for (const row of before) expect(keptKeys).toContain(row.key);
    expect(new Set(keptKeys).size).toBe(keptKeys.length);
  });
});

describe("the you-left-off-here line", () => {
  it("goes above the first message newer than the marker", () => {
    const messages = [
      message("a", 0),
      message("a", MINUTE),
      message("b", 2 * MINUTE),
      message("b", 3 * MINUTE),
    ];
    const marker = messages[1]?.id ?? "";
    expect(shape(buildRows(messages, { ...grouped, leftOff: marker }))).toEqual([
      "head:a",
      "cont",
      "left-off",
      "head:b",
      "cont",
    ]);
  });

  it("is not drawn when the marker is older than everything loaded", () => {
    // Otherwise the line would sit at the top of a page of history and claim
    // that is where you stopped, when really it is where the fetch ended.
    const messages = [message("a", 0), message("a", MINUTE)];
    expect(shape(buildRows(messages, { ...grouped, leftOff: "m0000" }))).toEqual([
      "head:a",
      "cont",
    ]);
  });

  it("is drawn at the very top once there is nothing older to load", () => {
    const messages = [message("a", 0), message("a", MINUTE)];
    const rows = buildRows(messages, { atStart: true, leftOff: "m0000" });
    expect(shape(rows)).toEqual(["divider", "left-off", "head:a", "cont"]);
  });

  it("is not drawn when you have read to the end", () => {
    const messages = [message("a", 0), message("a", MINUTE)];
    const marker = messages[1]?.id ?? "";
    expect(shape(buildRows(messages, { ...grouped, leftOff: marker }))).toEqual([
      "head:a",
      "cont",
    ]);
  });

  it("appears once, however much is unread", () => {
    const messages = [message("a", 0), message("b", MINUTE), message("c", 2 * MINUTE)];
    const marker = messages[0]?.id ?? "";
    const rows = buildRows(messages, { ...grouped, leftOff: marker });
    expect(rows.filter((row) => row.kind === "left-off")).toHaveLength(1);
  });

  it("sits below a session divider, not above it", () => {
    // The divider is about time passing. The line is about this exact message,
    // so it is the last thing before it.
    const messages = [message("a", 0), message("b", 4 * HOUR)];
    const marker = messages[0]?.id ?? "";
    expect(shape(buildRows(messages, { ...grouped, leftOff: marker }))).toEqual([
      "head:a",
      "divider",
      "left-off",
      "head:b",
    ]);
  });

  it("makes the first unseen message say who said it", () => {
    // Same author either side, so grouping would normally hide the name — and a
    // run of unattributed lines under the line is the one place that costs more
    // than it saves.
    const messages = [message("a", 0), message("a", MINUTE)];
    const marker = messages[0]?.id ?? "";
    const rows = buildRows(messages, { ...grouped, leftOff: marker });
    expect(shape(rows)).toEqual(["head:a", "left-off", "head:a"]);
  });
});
