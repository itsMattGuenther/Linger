/**
 * When the phone's connection to the forwarding server is started afresh
 * (#656, #429): the rules, kept apart from the connection so they can be
 * tested with nothing but a clock. The same rules as the desktop engine's
 * (`src-tauri/src/voice/restart.rs`), which says why each is what it is;
 * PROTOCOL "Voice forwarding" has the numbers the server expects.
 *
 * Three things say the network under a call changed: the connection is still
 * disconnected `DISCONNECTED_FOR` after ICE called it so, it failed, or the
 * gateway's socket resumed while in voice. Restarts don't stack: one is in
 * flight until the server's new offer is answered, one that gets no offer in
 * `RESTART_AFTER` is asked again, and two are never closer than that.
 */

/** How long the connection may stay disconnected before it is started afresh. */
export const DISCONNECTED_FOR_MS = 2_000;

/** The least time between restarts, and how long one waits for the server's offer. */
export const RESTART_AFTER_MS = 3_000;

/** Something that bears on whether to restart. */
export type RestartEvent = "connected" | "disconnected" | "failed" | "answered" | "gateway-resumed" | "tick";

/** What to do after an event: restart now, and when to look again (`tick`), if anything waits on the clock. */
export interface RestartPlan {
  restart: boolean;
  wake: number | null;
}

/** The restart rules for one call. A new call starts with fresh ones. */
export class Restarts {
  /** Since when the connection has been disconnected, while it is. */
  private disconnected: number | null = null;
  /** When the restart still waiting for the server's offer was asked for. */
  private asked: number | null = null;
  /** When the last restart was asked for, answered or not. */
  private last: number | null = null;
  /** A restart is called for, and waits on the one in flight or the gap. */
  private wanted = false;

  /** Take in what happened at `now` (milliseconds), and say what to do. */
  on(event: RestartEvent, now: number): RestartPlan {
    switch (event) {
      case "connected":
        this.disconnected = null;
        this.wanted = false;
        break;
      // Only the first of a run counts: the wait runs from when it went quiet.
      case "disconnected":
        this.disconnected ??= now;
        break;
      case "failed":
        this.disconnected = null;
        this.wanted = true;
        break;
      // The server answered: a fresh connection is on its way, and it answers
      // anything that wanted one meanwhile too.
      case "answered":
        this.asked = null;
        this.wanted = false;
        this.disconnected = null;
        break;
      case "gateway-resumed":
        this.wanted = true;
        break;
      case "tick":
        break;
    }
    return this.plan(now);
  }

  private plan(now: number): RestartPlan {
    if (this.asked !== null && now >= this.asked + RESTART_AFTER_MS) {
      // No offer came for it: ask again.
      this.asked = null;
      this.wanted = true;
    }
    if (this.disconnected !== null && now >= this.disconnected + DISCONNECTED_FOR_MS) this.wanted = true;
    if (this.wanted && this.asked === null) {
      const earliest = this.last === null ? now : this.last + RESTART_AFTER_MS;
      if (now < earliest) return { restart: false, wake: earliest };
      this.wanted = false;
      this.disconnected = null;
      this.asked = now;
      this.last = now;
      return { restart: true, wake: now + RESTART_AFTER_MS };
    }
    const waits = [
      this.asked === null ? null : this.asked + RESTART_AFTER_MS,
      this.disconnected === null ? null : this.disconnected + DISCONNECTED_FOR_MS,
    ].filter((at): at is number => at !== null);
    return { restart: false, wake: waits.length === 0 ? null : Math.min(...waits) };
  }
}
