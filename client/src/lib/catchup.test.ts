import { describe, expect, it } from "vitest";
import type { ServerFrame } from "../generated/ServerFrame";
import { START, admit, advance, catchUp, type Position } from "./catchup";

// A model of the store: what matters for catching up is that `ready` starts
// over and every other sequenced frame adds one thing, so a copy that dropped
// or repeated a frame differs from one that didn't. The real `apply` is
// exercised against the same stream shapes in `catchup.apply.test.ts`.
interface Model {
  epoch: string | null;
  seen: number[];
}
const EMPTY: Model = { epoch: null, seen: [] };

function fold(model: Model, frame: ServerFrame): Model {
  if (frame.op === "ready") return { epoch: frame.d.session_id, seen: [] };
  if (frame.s === undefined) return model;
  return { epoch: model.epoch, seen: [...model.seen, frame.s] };
}

function ready(session: string, s: number): ServerFrame {
  // Only the fields the catch-up logic reads matter here.
  return {
    s,
    op: "ready",
    d: { session_id: session, user: null, users: [], rooms: [], dms: [], presence: [] },
  } as unknown as ServerFrame;
}

function event(s: number): ServerFrame {
  return { s, op: "typing.start", d: { room_id: "r", user_id: "u" } } as unknown as ServerFrame;
}

/**
 * A stream as the Rust gateway would emit it: connections that each begin
 * with `ready` and count up, separated by re-identifies that start over.
 */
function stream(epochs: readonly number[]): ServerFrame[] {
  const frames: ServerFrame[] = [];
  epochs.forEach((length, index) => {
    frames.push(ready(`session-${index}`, 1));
    for (let s = 2; s <= length + 1; s += 1) frames.push(event(s));
  });
  return frames;
}

/** The owner: applies everything, tracking its position. */
function owner(frames: readonly ServerFrame[], upTo: number): { model: Model; position: Position } {
  let model = EMPTY;
  let position = START;
  for (const frame of frames.slice(0, upTo)) {
    model = fold(model, frame);
    position = advance(position, frame);
  }
  return { model, position };
}

/**
 * A viewer that starts listening before frame `listenAt` is emitted, and
 * whose snapshot request the owner answers after applying `answerAt` frames.
 * Listening always starts before the request is sent, and the owner handles
 * frames in the order they were emitted, so `listenAt <= answerAt`.
 */
function viewer(frames: readonly ServerFrame[], listenAt: number, answerAt: number, liveTo: number): Model {
  const snapshot = owner(frames, answerAt);
  const bufferedTo = answerAt + extraBuffered(answerAt, liveTo);
  const { apply, position } = catchUp(snapshot.position, frames.slice(listenAt, bufferedTo));
  let model = apply.reduce(fold, snapshot.model);
  let at = position;
  for (const frame of frames.slice(bufferedTo, liveTo)) {
    if (!admit(at, frame)) continue;
    model = fold(model, frame);
    at = advance(at, frame);
  }
  return model;
}

// Frames that reach the viewer's buffer after the owner answered but before
// the answer reached the viewer. Varied so that boundary is exercised too.
let jitter = 0;
function extraBuffered(answerAt: number, liveTo: number): number {
  jitter = (jitter + 1) % 3;
  return Math.min(jitter, liveTo - answerAt);
}

describe("catching a late window up", () => {
  const shapes: number[][] = [[0], [1], [5], [3, 0], [4, 2], [2, 3, 1], [0, 0, 4], [6, 1, 0, 3]];

  it("ends in exactly the owner's state for every listen and answer point", () => {
    for (const shape of shapes) {
      const frames = stream(shape);
      const final = owner(frames, frames.length).model;
      for (let listenAt = 0; listenAt <= frames.length; listenAt += 1) {
        for (let answerAt = listenAt; answerAt <= frames.length; answerAt += 1) {
          const got = viewer(frames, listenAt, answerAt, frames.length);
          expect(got, `shape ${shape.join(",")} listen ${listenAt} answer ${answerAt}`).toEqual(final);
        }
      }
    }
  });

  it("drops frames from an epoch older than the snapshot's", () => {
    const frames = stream([3, 2]); // ready A, A2..A4, ready B, B2..B3
    const snapshot = owner(frames, 6); // up to B2
    const { apply } = catchUp(snapshot.position, frames.slice(1, 6));
    expect(apply).toEqual([]);
  });

  it("keeps everything after a ready newer than the snapshot", () => {
    const frames = stream([2, 2]); // ready A, A2, A3, ready B, B2, B3
    const snapshot = owner(frames, 3); // up to A3
    const { apply, position } = catchUp(snapshot.position, frames.slice(2));
    expect(apply.map((frame) => frame.op)).toEqual(["ready", "typing.start", "typing.start"]);
    expect(position).toEqual({ epoch: "session-1", seq: 3 });
  });

  it("applies everything when the owner has not seen a ready yet", () => {
    const frames = stream([2]);
    const { apply } = catchUp(START, frames);
    expect(apply).toHaveLength(frames.length);
  });

  it("refuses a live frame it already applied", () => {
    const at: Position = { epoch: "session-0", seq: 4 };
    expect(admit(at, event(4))).toBe(false);
    expect(admit(at, event(5))).toBe(true);
    expect(admit(at, ready("session-0", 1))).toBe(true);
  });
});
