/**
 * How a viewer window catches up with the owner window
 * (docs/design/architecture.md, "How windows share state").
 *
 * Every window folds the same gateway frames with the same pure `apply`, so
 * windows agree without telling each other anything, except when one opens
 * late and has missed the `ready` snapshot. It then:
 *
 *   1. starts buffering frames at once,
 *   2. asks the owner for its state and the position that state is at,
 *   3. adopts that state and applies only the buffered frames it lacks.
 *
 * This file is step 3's arithmetic, kept pure so every interleaving of
 * listening, reconnecting and answering can be tested without a window.
 *
 * A **position** is the epoch plus the last sequence number applied. The
 * epoch is the connection's session id, taken from `ready`. A re-identify
 * starts a new session with its own numbering, so sequence numbers only
 * compare within one epoch. Frames do not carry their epoch; the buffer
 * reveals it, because every epoch begins with its own `ready`.
 */
import type { ServerFrame } from "../generated/ServerFrame";

/** Where a copy of one server's state stands. */
export interface Position {
  /** The session id of the `ready` this copy was built from; null before one. */
  epoch: string | null;
  /** The last sequence number applied in that epoch; null if none carried one. */
  seq: number | null;
}

export const START: Position = { epoch: null, seq: null };

/** The position after applying `frame` at `position`. */
export function advance(position: Position, frame: ServerFrame): Position {
  if (frame.op === "ready") return { epoch: frame.d.session_id, seq: frame.s ?? null };
  if (frame.s === undefined) return position;
  return { epoch: position.epoch, seq: frame.s };
}

/**
 * Which buffered frames a viewer applies on top of a snapshot taken at `mark`.
 *
 * The buffer holds every frame the viewer received from when it started
 * listening until the snapshot arrived, in order. It can begin in an older
 * epoch than the snapshot's (a reconnect happened after the viewer started
 * listening but before the owner answered), in the snapshot's own epoch, and
 * can run on into newer epochs. Frames the snapshot already contains are
 * dropped. Frames of an older epoch are dropped. Everything newer applies.
 *
 * Returns the frames to apply, in order, and the position they leave the
 * viewer at, which `admit` then continues from for live frames.
 */
export function catchUp(
  mark: Position,
  buffered: readonly ServerFrame[],
): { apply: ServerFrame[]; position: Position } {
  // Frames before the snapshot's own `ready`, if the buffer holds it, belong
  // to an older epoch. Without it in the buffer, listening began inside the
  // snapshot's epoch (or before any epoch at all).
  const ownReady =
    mark.epoch === null
      ? -1
      : buffered.findIndex((frame) => frame.op === "ready" && frame.d.session_id === mark.epoch);

  const apply: ServerFrame[] = [];
  let position = mark;
  // True once past a `ready` newer than the snapshot: from there on the
  // snapshot has nothing, and every frame applies.
  let beyond = false;
  for (let index = 0; index < buffered.length; index += 1) {
    const frame = buffered[index];
    if (frame === undefined) continue;
    if (index < ownReady) continue; // an older epoch
    if (index === ownReady) continue; // the snapshot already has this `ready`
    if (frame.op === "ready" && frame.d.session_id !== mark.epoch) beyond = true;
    if (beyond || isNew(position, frame)) {
      apply.push(frame);
      position = advance(position, frame);
    }
  }
  return { apply, position };
}

/**
 * Whether a live frame arriving after catch-up is new at `position`. Only a
 * repeat of something already applied in the same epoch is refused, which
 * guards against the same frame being delivered twice.
 */
export function admit(position: Position, frame: ServerFrame): boolean {
  return frame.op === "ready" || isNew(position, frame);
}

function isNew(position: Position, frame: ServerFrame): boolean {
  if (frame.s === undefined || position.seq === null) return true;
  return frame.s > position.seq;
}
