import { describe, expect, it } from "vitest";
import type { GatewayStatus } from "../../lib/gateway";
import { type Connection, connectionNote, listNotes, TROUBLE_GRACE_MS, troubleSince, waitingNote } from "./notes";

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

  it("sits with the connections, before the keyring", () => {
    const notes = listNotes([], "no keyring", null, 0, [{ server: "https://a.example", name: "a.example", why: "down" }]);
    expect(notes.map((note) => note.kind)).toEqual(["waiting", "keyring"]);
  });
});
