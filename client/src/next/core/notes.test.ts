import { describe, expect, it } from "vitest";
import type { ServerHealth } from "../../generated/ServerHealth";
import type { GatewayStatus } from "../../lib/gateway";
import type { UpdateCheck } from "../../lib/updates";
import {
  type Connection,
  connectionNote,
  hostNotes,
  listNotes,
  type TooOld,
  tooOldNote,
  TROUBLE_GRACE_MS,
  troubleSince,
  type UpdateState,
  updateNotes,
  waitingNote,
} from "./notes";

const at = 1_000_000;
const pine = (status: GatewayStatus, since: number | null = at): Connection => ({ server: "https://pine", name: "Pinecone", status, troubleSince: since });

describe("the foot's connection lines", () => {
  it("say nothing while connected, or while a connection is younger than the grace", () => {
    expect(connectionNote(pine({ kind: "ready", latency_ms: 20 }, null), at)).toBeNull();
    expect(connectionNote(pine({ kind: "connecting" }), at + TROUBLE_GRACE_MS - 1)).toBeNull();
    expect(connectionNote(pine({ kind: "connecting" }), at + TROUBLE_GRACE_MS)?.words).toBe("Connecting to Pinecone…");
  });

  it("say which server can't be reached, with the reason kept for the tooltip", () => {
    const note = connectionNote(pine({ kind: "waiting", retry_in_ms: 4000, reason: "connection refused" }), at + TROUBLE_GRACE_MS);
    expect(note).toEqual({ kind: "connection", server: "https://pine", words: "Can't reach Pinecone. Still trying.", detail: "connection refused" });
  });

  it("say a renewing sign-in in words, never in protocol", () => {
    expect(connectionNote(pine({ kind: "needs_token" }), at + TROUBLE_GRACE_MS)?.words).toBe("Signing back in to Pinecone…");
    for (const status of [{ kind: "offline" }, { kind: "identifying" }, { kind: "resuming" }, { kind: "connected", tls: true }] as const) {
      expect(connectionNote(pine(status), at + TROUBLE_GRACE_MS)?.words).toBe("Connecting to Pinecone…");
    }
  });
});

describe("when trouble started", () => {
  it("is kept while it lasts, set when it starts and dropped when it's over", () => {
    const first = troubleSince(new Map(), new Map([["a", "connecting"], ["b", "ready"]]), 10);
    expect([...first]).toEqual([["a", 10]]);
    const later = troubleSince(first, new Map([["a", "waiting"], ["b", "offline"]]), 20);
    expect([...later]).toEqual([["a", 10], ["b", 20]]);
    const over = troubleSince(later, new Map([["a", "ready"], ["b", "offline"]]), 30);
    expect([...over]).toEqual([["b", 20]]);
  });
});

describe("the foot", () => {
  it("puts connections first, then the keyring, then an update, and says nothing when all's well", () => {
    const later = at + TROUBLE_GRACE_MS;
    const notes = listNotes([pine({ kind: "connecting" })], "The keyring is locked.", updateNotes(state(ready)), later);
    expect(notes.map((note) => note.kind)).toEqual(["connection", "keyring", "update"]);
    expect(notes[1]).toEqual({ kind: "keyring", words: "Sign-ins aren't remembered on this computer.", detail: "The keyring is locked." });
    expect(listNotes([pine({ kind: "ready", latency_ms: 9 }, null)], null, [], later)).toEqual([]);
  });
});

/** A newer release, as the shell says it: a copy that installs it by itself, downloaded. */
const ready: UpdateCheck = { kind: "newer", version: "0.5.4", line: "Screen sharing, and fixes for voice.", published: 0, downloaded: true, silent: true };
const state = (check: UpdateCheck | null, more: Partial<UpdateState> = {}): UpdateState => ({ check, updated: null, putOff: () => false, problem: null, ...more });

describe("the foot's update lines (#772)", () => {
  it("say a downloaded update is ready, calmly, and when it installs", () => {
    expect(updateNotes(state(ready))).toEqual([
      {
        kind: "update",
        version: "0.5.4",
        words: "Linger 0.5.4 is ready",
        detail: "It installs the next time Linger starts, or while you're away from your computer.",
        problem: null,
      },
    ]);
  });

  it("say nothing while it's on its day's wait or still downloading", () => {
    expect(updateNotes(state({ ...ready, downloaded: false }))).toEqual([]);
  });

  it("say nothing when there's nothing newer, or nothing to update with", () => {
    for (const check of [{ kind: "current", silent: true }, { kind: "managed", by: "pacman", newer: null }, { kind: "unconfigured" }, { kind: "failed", reason: "offline" }, null] as const) {
      expect(updateNotes(state(check))).toEqual([]);
    }
  });

  it("ask a copy that needs a password, in the lamp, with what's in it", () => {
    const notes = updateNotes(state({ ...ready, silent: false }));
    expect(notes).toEqual([
      { kind: "release", version: "0.5.4", words: "Linger 0.5.4 is out", line: "Screen sharing, and fixes for voice.", detail: null, password: true, problem: null },
    ]);
  });

  it("tell an Arch copy it's out, in words that don't name one desktop's menu or promise it's there yet", () => {
    const notes = updateNotes(state({ kind: "managed", by: "pacman", newer: { version: "0.5.4", line: null } }));
    expect(notes).toEqual([
      { kind: "release", version: "0.5.4", words: "Linger 0.5.4 is out", line: null, detail: "It comes with your next system update.", password: false, problem: null },
    ]);
    expect(JSON.stringify(notes)).not.toMatch(/Omarchy/);
  });

  it("can be put off until tomorrow, except the calm line, which needs nothing", () => {
    const putOff = (version: string) => version === "0.5.4";
    expect(updateNotes(state({ ...ready, silent: false }, { putOff }))).toEqual([]);
    expect(updateNotes(state({ kind: "managed", by: "pacman", newer: { version: "0.5.4", line: null } }, { putOff }))).toEqual([]);
    expect(updateNotes(state(ready, { putOff })).map((note) => note.kind)).toEqual(["update"]);
    // A newer version than the one put off brings it back at once.
    expect(updateNotes(state({ ...ready, version: "0.5.5", silent: false }, { putOff })).map((note) => note.kind)).toEqual(["release"]);
  });

  it("say once what was just installed, before anything else about updates", () => {
    const notes = updateNotes(state(ready, { updated: { version: "0.5.3", line: "Fixes for voice." } }));
    expect(notes[0]).toEqual({ kind: "updated", version: "0.5.3", words: "You're on Linger 0.5.3", line: "Fixes for voice." });
    expect(notes.map((note) => note.kind)).toEqual(["updated", "update"]);
  });

  it("carry why the last Update didn't happen", () => {
    expect(updateNotes(state(ready, { problem: "offline" }))[0]).toMatchObject({ kind: "update", problem: "offline" });
  });
});

describe("a server that needs a newer app (#793)", () => {
  const casa: TooOld = { server: "https://casa.example", name: "Casa da Ribeira", oldest: "0.5.4" };
  const lanterns: TooOld = { server: "https://lanterns.example", name: "Ashen Lanterns", oldest: "0.5.10" };
  const current: UpdateCheck = { kind: "current", silent: true };

  it("names it, says which app it works with and that the rest still work, with Update now on a copy that installs itself", () => {
    expect(updateNotes(state(current, { tooOld: [casa], others: true }))).toEqual([
      {
        kind: "tooold",
        servers: ["https://casa.example"],
        words: "Casa da Ribeira needs a newer Linger",
        line: "It works with Linger 0.5.4 or newer. Your other servers still work.",
        detail: null,
        button: true,
        problem: null,
      },
    ]);
    // A copy that needs a password installs with the same button, and one
    // whose last look failed tries again with it.
    for (const check of [ready, { ...ready, silent: false }, { kind: "failed", reason: "offline" }] as const) {
      expect(updateNotes(state(check, { tooOld: [casa] }))[0]).toMatchObject({ kind: "tooold", button: true });
    }
  });

  it("doesn't say the others still work when there are none", () => {
    expect(tooOldNote([casa], false, current, null, null)).toMatchObject({ line: "It works with Linger 0.5.4 or newer." });
  });

  it("says several in one block, with the newest release any of them asks for", () => {
    expect(tooOldNote([casa, lanterns], true, current, null, null)).toMatchObject({
      servers: ["https://casa.example", "https://lanterns.example"],
      words: "Casa da Ribeira and Ashen Lanterns need a newer Linger",
      line: "They work with Linger 0.5.10 or newer. Your other servers still work.",
    });
  });

  it("gives an Arch copy the words and how the new one comes, with no button", () => {
    const note = tooOldNote([casa], true, { kind: "managed", by: "pacman", newer: null }, null, "offline");
    expect(note).toMatchObject({ button: false, detail: "It comes with your next system update (sudo pacman -Syu).", problem: null });
  });

  it("points a phone at where it got Linger, with no button", () => {
    expect(tooOldNote([casa], true, null, "android", null)).toMatchObject({ button: false, detail: "Update Linger from Google Play." });
    expect(tooOldNote([casa], true, null, "iphone", null)).toMatchObject({ button: false, detail: "Update Linger from TestFlight." });
  });

  it("tells a copy that can't update itself where a new one is, and says nothing of how before the shell has said", () => {
    expect(tooOldNote([casa], true, { kind: "unconfigured" }, null, null)).toMatchObject({
      button: false,
      detail: "This copy was not built to update itself. Install a new one from the release page.",
    });
    expect(tooOldNote([casa], true, null, null, null)).toMatchObject({ button: false, detail: null });
  });

  it("says nothing with no such server", () => {
    expect(tooOldNote([], true, current, null, null)).toBeNull();
    expect(updateNotes(state(current, { tooOld: [] }))).toEqual([]);
  });

  it("comes before the update lines, which say the same thing less urgently, and stay away while it shows", () => {
    expect(updateNotes(state(ready, { tooOld: [casa] })).map((note) => note.kind)).toEqual(["tooold"]);
    expect(updateNotes(state({ ...ready, silent: false }, { tooOld: [casa] })).map((note) => note.kind)).toEqual(["tooold"]);
    expect(updateNotes(state({ kind: "managed", by: "pacman", newer: { version: "0.5.4", line: null } }, { tooOld: [casa] })).map((note) => note.kind)).toEqual(["tooold"]);
    const after = updateNotes(state(ready, { tooOld: [casa], updated: { version: "0.5.3", line: null } }));
    expect(after.map((note) => note.kind)).toEqual(["tooold", "updated"]);
  });

  it("carries why the last Update now didn't happen", () => {
    expect(updateNotes(state(current, { tooOld: [casa], problem: "The network is down." }))[0]).toMatchObject({ kind: "tooold", problem: "The network is down." });
  });

  it("goes in the foot after the lines, with the updates", () => {
    const notes = listNotes([], "no keyring", updateNotes(state(current, { tooOld: [casa] })), 0);
    expect(notes.map((note) => note.kind)).toEqual(["keyring", "tooold"]);
  });
});

describe("a saved server not reached yet (T-907)", () => {
  it("says it's connecting while a try is under way, and can't be reached between tries, with the reason kept", () => {
    expect(waitingNote({ server: "https://a.example", name: "a.example", why: null })).toEqual({
      kind: "waiting",
      server: "https://a.example",
      words: "Connecting to a.example…",
      detail: null,
      trying: true,
    });
    expect(waitingNote({ server: "https://a.example", name: "a.example", why: "Couldn't reach it." })).toEqual({
      kind: "waiting",
      server: "https://a.example",
      words: "Can't reach a.example. Still trying.",
      detail: "Couldn't reach it.",
      trying: false,
    });
  });

  it("says which device doesn't remember sign-ins", () => {
    expect(listNotes([], "no keyring", [], 0, [], "this phone")[0]?.words).toBe("Sign-ins aren't remembered on this phone.");
  });

  it("sits with the connections, before the keyring", () => {
    const notes = listNotes([], "no keyring", [], 0, [{ server: "https://a.example", name: "a.example", why: "down" }]);
    expect(notes.map((note) => note.kind)).toEqual(["waiting", "keyring"]);
  });
});

describe("a server you host, when it needs you (#582)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const fine: ServerHealth = { backups: true, last_backup_at: at - DAY, backup_overdue: false, disk_nearly_full: false, file_space_nearly_full: false };
  const pinecone = (health: Partial<ServerHealth>) => ({ server: "https://pine", name: "Pinecone", health: { ...fine, ...health } });

  it("says nothing while all's well", () => {
    expect(hostNotes(pinecone({}), at)).toEqual([]);
  });

  it("says a nearly full disk and nearly used-up file space in words, never a figure", () => {
    const notes = hostNotes(pinecone({ disk_nearly_full: true, file_space_nearly_full: true }), at);
    expect(notes.map((note) => note.words)).toEqual(["The disk Pinecone runs on is nearly full.", "Pinecone is nearly out of room for files."]);
    for (const note of notes) expect(note.words).not.toMatch(/\d/);
  });

  it("says how long it's gone without a backup, or that none has worked yet", () => {
    expect(hostNotes(pinecone({ backup_overdue: true, last_backup_at: at - 4 * DAY - 60_000 }), at)[0]?.words).toBe("Pinecone hasn't been backed up for 4 days.");
    expect(hostNotes(pinecone({ backup_overdue: true, last_backup_at: null }), at)[0]?.words).toBe("Pinecone hasn't been backed up yet.");
  });

  it("says nothing about backups a host turned off", () => {
    expect(hostNotes(pinecone({ backups: false, backup_overdue: true }), at)).toEqual([]);
  });

  it("says when the copies haven't reached the host's bucket, in words (#614)", () => {
    const bucket = (sent: number | null, overdue: boolean) => ({ name: "pine-backups", last_sent_at: sent, overdue });
    expect(hostNotes(pinecone({ bucket: bucket(at - DAY, false) }), at)).toEqual([]);
    const late = hostNotes(pinecone({ bucket: bucket(at - 3 * DAY - 60_000, true) }), at);
    expect(late.map((note) => note.words)).toEqual(["Pinecone's backups haven't reached its bucket for 3 days."]);
    expect(late[0]).toMatchObject({ kind: "host", what: "bucket", detail: expect.stringContaining("pine-backups") });
    expect(hostNotes(pinecone({ bucket: bucket(null, true) }), at)[0]?.words).toBe("Pinecone's backups haven't reached its bucket yet.");
    // No copy at all is the one line: with nothing made, there's nothing to send.
    const neither = hostNotes(pinecone({ backup_overdue: true, bucket: bucket(null, true) }), at);
    expect(neither.map((note) => note.words)).toEqual(["Pinecone hasn't been backed up for 1 day."]);
  });

  it("comes after the keyring and before an update, one line for each thing", () => {
    const notes = listNotes([], "no keyring", updateNotes(state(ready)), at, [], "this computer", [pinecone({ disk_nearly_full: true, backup_overdue: true })]);
    expect(notes.map((note) => note.kind)).toEqual(["keyring", "host", "host", "update"]);
  });

  it("tells the host when their server is behind, with one version in the words (#772)", () => {
    const notes = hostNotes({ ...pinecone({}), runs: "0.5.3" }, at, "0.5.4");
    expect(notes).toEqual([
      { kind: "host", server: "https://pine", what: "behind", words: "Pinecone is behind. 0.5.4 is out.", detail: "It runs 0.5.3. Run ./update.sh in the server's folder to update it." },
    ]);
    expect(hostNotes({ ...pinecone({}), runs: "0.5.4" }, at, "0.5.4")).toEqual([]);
    expect(hostNotes({ ...pinecone({}), runs: "0.5.5" }, at, "0.5.4")).toEqual([]);
    // Not asked yet, or the feed couldn't be read: nothing, never a guess.
    expect(hostNotes({ ...pinecone({}), runs: null }, at, "0.5.4")).toEqual([]);
    expect(hostNotes({ ...pinecone({}), runs: "0.5.3" }, at, null)).toEqual([]);
    // Behind comes after what's more pressing.
    const both = hostNotes({ ...pinecone({ disk_nearly_full: true }), runs: "0.5.3" }, at, "0.5.4");
    expect(both.map((note) => note.kind === "host" && note.what)).toEqual(["disk", "behind"]);
  });
});
