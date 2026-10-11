import { describe, expect, it } from "vitest";
import type { ServerHealth } from "../../generated/ServerHealth";
import type { GatewayStatus } from "../../lib/gateway";
import { type Connection, connectionNote, hostNotes, listNotes, TROUBLE_GRACE_MS, troubleSince, waitingNote } from "./notes";

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
    const notes = listNotes([pine({ kind: "connecting" })], "The keyring is locked.", { kind: "ready", version: "0.4.1", notes: null }, later);
    expect(notes.map((note) => note.kind)).toEqual(["connection", "keyring", "update"]);
    expect(notes[1]).toEqual({ kind: "keyring", words: "Sign-ins aren't remembered on this computer.", detail: "The keyring is locked." });
    expect(notes[2]).toEqual({ kind: "update", version: "0.4.1", words: "Linger 0.4.1 is ready." });
    expect(listNotes([pine({ kind: "ready", latency_ms: 9 }, null)], null, { kind: "current" }, later)).toEqual([]);
  });

  it("only offers an update that's ready: current, managed, unconfigured and failed say nothing here", () => {
    for (const check of [{ kind: "current" }, { kind: "managed", by: "pacman" }, { kind: "unconfigured" }, { kind: "failed", reason: "offline" }] as const) {
      expect(listNotes([], null, check, at)).toEqual([]);
    }
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
    expect(listNotes([], "no keyring", null, 0, [], "this phone")[0]?.words).toBe("Sign-ins aren't remembered on this phone.");
  });

  it("sits with the connections, before the keyring", () => {
    const notes = listNotes([], "no keyring", null, 0, [{ server: "https://a.example", name: "a.example", why: "down" }]);
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
    const notes = listNotes([], "no keyring", { kind: "ready", version: "0.4.1", notes: null }, at, [], "this computer", [pinecone({ disk_nearly_full: true, backup_overdue: true })]);
    expect(notes.map((note) => note.kind)).toEqual(["keyring", "host", "host", "update"]);
  });
});
