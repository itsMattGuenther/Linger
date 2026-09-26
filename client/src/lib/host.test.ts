/**
 * The three pieces of the host panel that can be wrong without looking wrong.
 *
 * The link test is the interesting one: it builds a link and then hands it to
 * the parser the paste box uses, so the two halves of PROTOCOL §2.2 are checked
 * against each other rather than against a string somebody typed twice.
 */
import { describe, expect, it } from "vitest";

import type { Invite } from "../generated/Invite";
import type { Room } from "../generated/Room";
import { parsePastedLink } from "./link";
import { deadWords, expiryWords, inviteState, inviteUrl, moveRoom, useWords } from "./host";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function invite(fields: Partial<Invite> = {}): Invite {
  return {
    code: "abcdefghjkmn",
    created_by: "01900000-0000-7000-8000-000000000001",
    expires_at: null,
    max_uses: 1,
    uses: 0,
    revoked_at: null,
    created_at: NOW - HOUR,
    ...fields,
  };
}

function room(slug: string, position: number): Room {
  return {
    id: `01900000-0000-7000-8000-0000000000${position.toString().padStart(2, "0")}`,
    slug,
    name: slug,
    topic: null,
    kind: "room",
    member_ids: null,
    position,
    archived_at: null,
    last_message_id: null,
  };
}

describe("inviteUrl", () => {
  it("builds a link the paste box understands", () => {
    const link = inviteUrl("https://linger.example", "abcdefghjkmn");
    expect(link).toBe("https://linger.example/invite/abcdefghjkmn");
    expect(parsePastedLink(link)).toEqual({
      kind: "invite",
      baseUrl: "https://linger.example",
      code: "abcdefghjkmn",
    });
  });

  it("survives a base URL with a trailing slash, and a port", () => {
    expect(parsePastedLink(inviteUrl("http://localhost:8080/", "zzz"))).toEqual({
      kind: "invite",
      baseUrl: "http://localhost:8080",
      code: "zzz",
    });
  });
});

describe("inviteState", () => {
  it("is live until something stops it", () => {
    expect(inviteState(invite(), NOW)).toBe("live");
    expect(deadWords(invite(), NOW)).toBeNull();
  });

  it("counts a revoked invite dead even if it has uses left", () => {
    const revoked = invite({ revoked_at: NOW - 1, max_uses: 5 });
    expect(inviteState(revoked, NOW)).toBe("revoked");
    expect(deadWords(revoked, NOW)).toBe("revoked");
  });

  it("expires on the stroke, not after it", () => {
    expect(inviteState(invite({ expires_at: NOW }), NOW)).toBe("expired");
    expect(inviteState(invite({ expires_at: NOW + 1 }), NOW)).toBe("live");
  });

  it("is spent when the uses run out", () => {
    expect(inviteState(invite({ max_uses: 2, uses: 2 }), NOW)).toBe("spent");
    expect(inviteState(invite({ max_uses: 2, uses: 1 }), NOW)).toBe("live");
    expect(inviteState(invite({ max_uses: null, uses: 99 }), NOW)).toBe("live");
  });
});

describe("expiryWords", () => {
  it("says never when there is no expiry", () => {
    expect(expiryWords(invite(), NOW)).toBe("never expires");
  });

  it("rounds down, so a nearly-gone invite never reads as fresh", () => {
    expect(expiryWords(invite({ expires_at: NOW + 3 * DAY + HOUR }), NOW)).toBe(
      "expires in 3 days",
    );
    expect(expiryWords(invite({ expires_at: NOW + DAY - 1 }), NOW)).toBe("expires in 23 hours");
    expect(expiryWords(invite({ expires_at: NOW + 90_000 }), NOW)).toBe("expires in 1 minute");
    expect(expiryWords(invite({ expires_at: NOW - 1 }), NOW)).toBe("expired");
  });
});

describe("useWords", () => {
  it("names the shape of the invite rather than a number", () => {
    expect(useWords(invite())).toBe("for one person");
    expect(useWords(invite({ uses: 1 }))).toBe("used");
    expect(useWords(invite({ max_uses: 5, uses: 2 }))).toBe("3 of 5 uses left");
    expect(useWords(invite({ max_uses: null }))).toBe("for any number of people");
    expect(useWords(invite({ max_uses: null, uses: 4 }))).toBe(
      "for any number of people · 4 so far",
    );
  });
});

describe("moveRoom", () => {
  const rooms = [room("garage", 0), room("music", 1), room("books", 2)];

  it("swaps with the neighbour and sends only what changed", () => {
    const music = rooms[1];
    expect(music).toBeDefined();
    expect(moveRoom(rooms, music!.id, -1)).toEqual([
      { id: music!.id, position: 0 },
      { id: rooms[0]!.id, position: 1 },
    ]);
  });

  it("refuses to walk off either end", () => {
    expect(moveRoom(rooms, rooms[0]!.id, -1)).toEqual([]);
    expect(moveRoom(rooms, rooms[2]!.id, 1)).toEqual([]);
  });

  it("straightens out duplicate and gapped positions while it moves", () => {
    const messy = [room("garage", 7), room("music", 7), room("books", 41)];
    const moved = moveRoom(messy, messy[2]!.id, -1);
    // Every room ends up with its own number, counting from zero.
    expect(moved.map((change) => change.position).sort()).toEqual([0, 1, 2]);
    expect(moved.find((change) => change.id === messy[2]!.id)?.position).toBe(1);
  });

  it("says nothing about a room it has never heard of", () => {
    expect(moveRoom(rooms, "01900000-0000-7000-8000-0000000000ff", 1)).toEqual([]);
  });
});
