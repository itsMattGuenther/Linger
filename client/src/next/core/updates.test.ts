import { describe, expect, it } from "vitest";
import { type UpdateCheck, WAIT_MS } from "../../lib/updates";
import { justUpdated, putOff, putOffNow, releaseLine, RESTART_AWAY_MS, restartWhileAway, tomorrow } from "./updates";

/** A store like the page's, in memory. */
function memory(): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
  const held = new Map<string, string>();
  return { getItem: (key) => held.get(key) ?? null, setItem: (key, value) => void held.set(key, value) };
}

describe("the one line about a release (#772)", () => {
  it("is this version's, or nothing", () => {
    expect(releaseLine("0.5.4", { version: "0.5.4", line: " Screen sharing. " })).toBe("Screen sharing.");
    // Left over from the release before: says nothing true about this one.
    expect(releaseLine("0.5.4", { version: "0.5.3", line: "Fixes for voice." })).toBeNull();
    expect(releaseLine("0.5.4", { version: "0.5.4", line: "  " })).toBeNull();
  });
});

describe("the version just installed", () => {
  it("is said once, on the first start after an update", () => {
    const store = memory();
    expect(justUpdated(store, "0.5.3")).toBeNull(); // the first start of all isn't an update
    expect(justUpdated(store, "0.5.3")).toBeNull();
    expect(justUpdated(store, "0.5.4")).toBe("0.5.4");
    expect(justUpdated(store, "0.5.4")).toBeNull();
  });

  it("isn't an older copy started after a newer one", () => {
    const store = memory();
    justUpdated(store, "0.5.4");
    expect(justUpdated(store, "0.5.3")).toBeNull();
  });

  it("is nothing where there's nowhere to remember it", () => {
    expect(justUpdated(null, "0.5.4")).toBeNull();
    const refusing = { getItem: () => null, setItem: () => { throw new Error("full"); } };
    expect(justUpdated(refusing, "0.5.4")).toBeNull();
  });
});

describe("putting a notice off", () => {
  it("lasts until tomorrow starts here, and only for that version", () => {
    const store = memory();
    const evening = new Date(2026, 9, 31, 21, 30).getTime();
    putOff(store, "0.5.4", evening);
    expect(putOffNow(store, "0.5.4", evening + 60_000)).toBe(true);
    expect(putOffNow(store, "0.5.5", evening + 60_000)).toBe(false);
    expect(putOffNow(store, "0.5.4", tomorrow(evening))).toBe(false);
    expect(tomorrow(evening)).toBe(new Date(2026, 10, 1).getTime());
  });

  it("is never on when nothing, or nonsense, is kept", () => {
    expect(putOffNow(memory(), "0.5.4", 0)).toBe(false);
    const store = memory();
    store.setItem("linger.next.update.notnow", "{not json");
    expect(putOffNow(store, "0.5.4", 0)).toBe(false);
    expect(putOffNow(null, "0.5.4", 0)).toBe(false);
  });
});

describe("restarting while nobody's there (#772)", () => {
  const published = 1_800_000_000_000;
  const ready: UpdateCheck = { kind: "newer", version: "0.5.4", line: null, published, downloaded: true, silent: true };
  const now = published + WAIT_MS + RESTART_AWAY_MS;
  const moment = { check: ready, now, lastInputAt: now - RESTART_AWAY_MS, inVoice: false, sharing: false };

  it("happens after half an hour with nobody using Linger, once the update is ready", () => {
    expect(restartWhileAway(moment)).toBe(true);
    expect(restartWhileAway({ ...moment, lastInputAt: now - RESTART_AWAY_MS + 1 })).toBe(false);
  });

  it("never happens in voice or while sharing a screen", () => {
    expect(restartWhileAway({ ...moment, inVoice: true })).toBe(false);
    expect(restartWhileAway({ ...moment, sharing: true })).toBe(false);
  });

  it("waits for the release to be a day old, and for the download", () => {
    expect(restartWhileAway({ ...moment, check: { ...ready, published: now - WAIT_MS + 1 } })).toBe(false);
    expect(restartWhileAway({ ...moment, check: { ...ready, downloaded: false } })).toBe(false);
  });

  it("never happens for a copy that needs a password, or one the system updates", () => {
    expect(restartWhileAway({ ...moment, check: { ...ready, silent: false } })).toBe(false);
    expect(restartWhileAway({ ...moment, check: { kind: "managed", by: "pacman", newer: { version: "0.5.4", line: null } } })).toBe(false);
    expect(restartWhileAway({ ...moment, check: { kind: "current", silent: true } })).toBe(false);
    expect(restartWhileAway({ ...moment, check: null })).toBe(false);
  });
});
