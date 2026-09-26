import { describe, expect, it } from "vitest";
import type { Room } from "../../generated/Room";
import type { SearchHit } from "../../generated/SearchHit";
import type { User } from "../../generated/User";
import { hitTime } from "../../lib/time";
import { directory, filesNamed, hitLine, hitOrder, hitWhen, hitWords, personChoices, roomChoices, searchStatus } from "./search";

function person(id: string, name: string): User {
  return {
    id,
    username: name.toLowerCase(),
    display_name: name,
    is_host: false,
    style: { font_key: "inter", weight: 400, italic: false, fill: { kind: "solid", color: "azure" }, effect: "none", msg_font_key: null },
    status: null,
    entrance_sound: null,
    last_seen_at: null,
  };
}

function room(id: string, slug: string, position: number, archived = false): Room {
  return { id, slug, name: slug, topic: null, kind: "room", member_ids: null, position, archived_at: archived ? 1 : null, last_message_id: null };
}

function dm(id: string, members: string[]): Room {
  return { id, slug: id, name: id, topic: null, kind: "dm", member_ids: members, position: 0, archived_at: null, last_message_id: null };
}

function hit(extra: Partial<SearchHit> = {}): SearchHit {
  return {
    message_id: "m1",
    room_id: "r-general",
    author_id: "u-eli",
    created_at: AT,
    cursor: "c1",
    snippet: [
      { text: "the one with the ", matched: false },
      { text: "rain", matched: true },
      { text: " sounds", matched: false },
    ],
    matched_filenames: [],
    ...extra,
  };
}

const NOW = Date.parse("2026-09-25T22:52:00");
const AT = Date.parse("2026-09-25T22:49:00");
/** The full date and time a hit's sentence says. */
const full = hitTime(AT);

const matt = person("u-matt", "Matt");
const eli = person("u-eli", "Eli");
const jules = person("u-jules", "Jules");
const place = {
  me: matt.id,
  users: [matt, jules, eli],
  rooms: [room("r-plans", "weekend-plans", 2), room("r-general", "general", 0), room("r-old", "old-stuff", 1, true), dm("d-jules", ["u-matt", "u-jules"]), dm("d-eli", ["u-matt", "u-eli"])],
};
const names = directory(place);

describe("search's filters", () => {
  it("offer anywhere, the live rooms in the list's order, then DMs by who's in them", () => {
    expect(roomChoices(place)).toEqual([
      { value: "", label: "Anywhere" },
      { value: "r-general", label: "#general" },
      { value: "r-plans", label: "#weekend-plans" },
      { value: "d-eli", label: "Eli" },
      { value: "d-jules", label: "Jules" },
    ]);
  });

  it("offer anyone, then everybody by name, with you marked", () => {
    expect(personChoices(place)).toEqual([
      { value: "", label: "From anyone" },
      { value: "u-eli", label: "Eli" },
      { value: "u-jules", label: "Jules" },
      { value: "u-matt", label: "Matt (you)" },
    ]);
  });
});

describe("a hit", () => {
  it("says who, where and when, with the matched words marked, and one line for a screen reader", () => {
    const line = hitLine(hit(), names, null, NOW);
    expect(line.whoName).toBe("Eli");
    expect(line.where).toBe("#general");
    expect(line.when).toBe(hitWhen(AT, NOW));
    expect(line.words?.filter((part) => part.matched).map((part) => part.text)).toEqual(["rain"]);
    expect(line.file).toBeNull();
    expect(line.label).toBe(`Eli in #general, ${full}: the one with the rain sounds`);
  });

  it("names a DM by who's in it, never by its id", () => {
    const line = hitLine(hit({ room_id: "d-jules", author_id: "u-jules" }), names, null, NOW);
    expect(line.where).toBe("Jules");
    expect(line.dm).toBe(true);
    expect(line.label).toContain("Jules in a DM with Jules,");
    expect(hitLine(hit(), names, null, NOW).dm).toBe(false);
  });

  it("says which server it's from when several are mixed", () => {
    const line = hitLine(hit(), names, "Ashen Lanterns", NOW);
    expect(line.serverName).toBe("Ashen Lanterns");
    expect(line.label).toBe(`Eli in #general on Ashen Lanterns, ${full}: the one with the rain sounds`);
  });

  it("found by a file's name says which file, with the words it had unmarked", () => {
    const quiet = hitLine(hit({ snippet: [], matched_filenames: ["speakers.png"] }), names, null, NOW);
    expect(quiet.words).toBeNull();
    expect(quiet.file).toBe("speakers.png");
    expect(quiet.also).toBe("");
    expect(quiet.label).toBe(`Eli in #general, ${full}: the file speakers.png`);

    const captioned = hitLine(hit({ snippet: [{ text: "exhibit a", matched: false }], matched_filenames: ["speakers.png"] }), names, null, NOW);
    expect(captioned.file).toBe("speakers.png");
    expect(captioned.also).toBe("exhibit a");
    expect(captioned.label).toBe(`Eli in #general, ${full}: exhibit a, and the file speakers.png`);
  });

  it("keeps to the words when they matched, even with a file on the message", () => {
    const line = hitLine(hit({ matched_filenames: ["rain.mp3"] }), names, null, NOW);
    expect(line.file).toBeNull();
    expect(line.words).not.toBeNull();
  });

  it("from an archived room or a stranger still reads as a sentence", () => {
    const line = hitLine(hit({ room_id: "r-old", author_id: "u-gone" }), names, null, NOW);
    expect(line.where).toBeUndefined();
    expect(line.whoName).toBe("someone");
    expect(line.label).toBe(`someone in an archived room, ${full}: the one with the rain sounds`);
  });

  it("with nothing to say says so", () => {
    expect(hitLine(hit({ snippet: [] }), names, null, NOW).label).toBe(`Eli in #general, ${full}: no words`);
  });

  it("says when, short: the day and time this year, the day and year before", () => {
    const thisYear = hitWhen(AT, NOW);
    expect(thisYear).toContain("25");
    expect(thisYear).not.toContain("2026");
    const lastYear = hitWhen(Date.parse("2025-03-02T09:15:00"), NOW);
    expect(lastYear).toContain("2025");
    expect(lastYear).not.toContain("9:15");
  });

  it("keeps its first match in view, cutting a long run of words before it to a word", () => {
    const long = [
      { text: "surprise idea for Jules's birthday: we fix the ", matched: false },
      { text: "porch", matched: true },
      { text: " light for real", matched: false },
    ];
    const kept = hitWords(long, 24);
    expect(kept[0]).toEqual({ text: "…birthday: we fix the ", matched: false });
    // The default keeps more, still starting on a whole word.
    expect(hitWords(long)[0]).toEqual({ text: "…for Jules's birthday: we fix the ", matched: false });
    expect(kept.slice(1)).toEqual(long.slice(1));
    // Short leads, a match at the start and no match at all are left alone.
    expect(hitWords(hit().snippet)).toEqual(hit().snippet);
    expect(hitWords(long.slice(1))).toEqual(long.slice(1));
    expect(hitWords([{ text: long[0]?.text ?? "", matched: false }])).toEqual([{ text: long[0]?.text ?? "", matched: false }]);
    // The sentence for a screen reader keeps every word.
    const line = hitLine(hit({ snippet: long }), names, null, NOW);
    expect(line.words?.[0]?.text).toBe("…for Jules's birthday: we fix the ");
    expect(line.label).toContain("surprise idea for Jules's birthday: we fix the porch light for real");
  });

  it("sorts newest first", () => {
    const older = hit({ created_at: 1 });
    const newer = hit({ created_at: 2 });
    expect([older, newer].sort(hitOrder)).toEqual([newer, older]);
  });
});

describe("the words around a search", () => {
  it("names up to two files, then says others in words, never as a number", () => {
    expect(filesNamed([])).toBeNull();
    expect(filesNamed(["a.png"])).toBe("a.png");
    expect(filesNamed(["a.png", "b.pdf"])).toBe("a.png and b.pdf");
    const many = filesNamed(["a.png", "b.pdf", "c.txt", "d.mov"]);
    expect(many).toBe("a.png, b.pdf and others");
  });

  it("says it's searching, or what went wrong, by server when there are several", () => {
    expect(searchStatus({ searching: false, problems: [] })).toBe("");
    expect(searchStatus({ searching: true, problems: [] })).toBe("Searching…");
    expect(searchStatus({ searching: false, problems: [{ name: null, words: "Slow down." }] })).toBe("Slow down.");
    expect(
      searchStatus({
        searching: true,
        problems: [
          { name: "Ashen Lanterns", words: "Slow down." },
          { name: "Casa da Ribeira", words: "Couldn't reach the server." },
        ],
      }),
    ).toBe("Ashen Lanterns: Slow down. Casa da Ribeira: Couldn't reach the server.");
  });
});
