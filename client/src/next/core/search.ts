/**
 * Search's words (SPEC §4.12, parity SRCH-1…5). Pure; `app/search/SearchView`
 * draws what these say.
 *
 * What a query is and how it's cut short live in `lib/search.ts`, shared with
 * today's client: whole words, all of them, "quoted phrases", 200 characters,
 * a pause before asking. This file is the new client's side: the filters'
 * choices, what one hit says, and the line that says how a search went.
 *
 * Nothing here draws a count as a number (AGENTS rule 3): three matching
 * files are "and others", not "and 2 more".
 */
import type { Room } from "../../generated/Room";
import type { SearchHit } from "../../generated/SearchHit";
import type { SearchSnippetPart } from "../../generated/SearchSnippetPart";
import type { User } from "../../generated/User";
import type { UserId } from "../../generated/UserId";
import { conversationLabel } from "../../lib/dm";
import { snippetText } from "../../lib/search";
import { hitTime } from "../../lib/time";
import type { ViewServer } from "./scope";

/** Who and where on one server, looked up by id. Built once per server, not per hit. */
export interface Directory {
  person: (id: UserId) => User | undefined;
  /** A conversation written out: "#general", or a DM's people. Undefined when it isn't one of yours any more. */
  where: (id: string) => string | undefined;
  /** Whether a conversation is a DM, which is named by its people and needs saying so. */
  isDm: (id: string) => boolean;
}

export function directory(place: Pick<ViewServer, "me" | "users" | "rooms">): Directory {
  const users = [...place.users];
  const people = new Map(users.map((user) => [user.id, user]));
  const rooms = new Map(place.rooms.filter((room) => room.archived_at === null).map((room) => [room.id, room]));
  const named = new Map<string, string | undefined>();
  return {
    person: (id) => people.get(id),
    where: (id) => {
      if (!named.has(id)) named.set(id, conversationLabel(rooms.get(id), users, place.me));
      return named.get(id);
    },
    isDm: (id) => rooms.get(id)?.kind === "dm",
  };
}

/** Newest first, the servers' own order (PROTOCOL §6), for merging several. */
export function hitOrder(a: SearchHit, b: SearchHit): number {
  return b.created_at - a.created_at;
}

/** The room filter's choices: anywhere, then the rooms in the list's order, then your DMs by who's in them. */
export function roomChoices(place: Pick<ViewServer, "me" | "users" | "rooms">): { value: string; label: string }[] {
  const live = place.rooms.filter((room) => room.archived_at === null);
  const users = [...place.users];
  const rooms = live
    .filter((room) => room.kind === "room")
    .sort((a, b) => a.position - b.position)
    .map((room) => ({ value: room.id, label: `#${room.slug}` }));
  const dms = live
    .filter((room) => room.kind === "dm")
    .map((room: Room) => ({ value: room.id, label: conversationLabel(room, users, place.me) ?? "a DM" }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return [{ value: "", label: "Anywhere" }, ...rooms, ...dms];
}

/** The person filter's choices: anyone, then everybody by name, you marked as you. */
export function personChoices(place: Pick<ViewServer, "me" | "users">): { value: string; label: string }[] {
  const people = [...place.users]
    .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }))
    .map((user) => ({ value: user.id, label: user.id === place.me ? `${user.display_name} (you)` : user.display_name }));
  return [{ value: "", label: "From anyone" }, ...people];
}

/**
 * Which files a hit matched on, by name, for a hit whose words didn't match.
 * Past two it stops listing and says "and others", in words.
 */
export function filesNamed(names: readonly string[]): string | null {
  const [first, second, third] = names;
  if (first === undefined) return null;
  if (second === undefined) return first;
  if (third === undefined) return `${first} and ${second}`;
  return `${first}, ${second} and others`;
}

const SHORT_THIS_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const SHORT_OTHER_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * When, short enough for the end of a hit's first line in a narrow window:
 * the day and time this year, the day and year before it. The whole date and
 * time is in the hit's sentence for a screen reader.
 */
export function hitWhen(at: number, now: number): string {
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? SHORT_THIS_YEAR.format(at) : SHORT_OTHER_YEAR.format(at);
}

/**
 * The snippet with its first match in view. A long run of unmatched words
 * before it gives way to "…" and the last few words, so the marked words
 * aren't the part a narrow line cuts off. `lead` is roughly how many
 * characters to keep ahead of the match.
 */
export function hitWords(parts: readonly SearchSnippetPart[], lead = 36): SearchSnippetPart[] {
  const first = parts.findIndex((part) => part.matched);
  const before = parts
    .slice(0, Math.max(0, first))
    .map((part) => part.text)
    .join("");
  if (first <= 0 || before.length <= lead) return [...parts];
  const tail = before.slice(before.length - lead);
  // Start on a whole word: drop the part-word the cut landed in.
  const space = tail.indexOf(" ");
  const kept = space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
  return [{ text: `…${kept}`, matched: false }, ...parts.slice(first)];
}

/** Everything one hit says. */
export interface HitLine {
  who: User | undefined;
  whoName: string;
  /** Where it was said; undefined when that room has been archived, and the hit can't open. */
  where: string | undefined;
  /** Where is a DM, named by who's in it: drawn with a message mark, so "Jules · Jules" reads as Jules in your DM. */
  dm: boolean;
  /** The server's name, when hits from several servers are mixed; otherwise null. */
  serverName: string | null;
  /** When, short, for the end of the first line. */
  when: string;
  /** The words, with the matched ones marked and the first match in view; null when only a file matched. */
  words: readonly SearchSnippetPart[] | null;
  /** The file or files that matched, when the words didn't. */
  file: string | null;
  /** What the words were when only a file matched, unmarked. */
  also: string;
  /** The whole hit as one line, for a screen reader. */
  label: string;
}

/** Where something was said or shared, in a sentence: " in #general", " in a DM with Jules". */
export function inWhere(where: string | undefined, dm: boolean): string {
  if (where === undefined) return " in an archived room";
  return dm ? ` in a DM with ${where}` : ` in ${where}`;
}

/**
 * What one hit says: who, where, when, and the words with the matched ones
 * marked (SRCH-4). A hit found by a file's name says which file, and a screen
 * reader hears the whole thing as one sentence rather than four fragments.
 */
export function hitLine(hit: SearchHit, names: Directory, serverName: string | null, now: number): HitLine {
  const who = names.person(hit.author_id);
  const whoName = who?.display_name ?? "someone";
  const where = names.where(hit.room_id);
  const when = hitTime(hit.created_at);
  const text = snippetText(hit.snippet).trim();
  const matchedWords = hit.snippet.some((part) => part.matched);
  const file = matchedWords ? null : filesNamed(hit.matched_filenames);

  const dm = names.isDm(hit.room_id);
  const place = `${inWhere(where, dm)}${serverName === null ? "" : ` on ${serverName}`}`;
  const said = file === null ? text || "no words" : text === "" ? `the file ${file}` : `${text}, and the file ${file}`;
  return {
    who,
    whoName,
    where,
    dm,
    serverName,
    when: hitWhen(hit.created_at, now),
    words: file === null ? hitWords(hit.snippet) : null,
    file,
    also: file === null ? "" : text,
    label: `${whoName}${place}, ${when}: ${said}`,
  };
}

/**
 * How a search went, for the line above the results. Blank when there is
 * nothing to say. Problems keep the results that were already showing: a
 * refused search is a line, not an empty page.
 */
export function searchStatus(state: { searching: boolean; problems: readonly { name: string | null; words: string }[] }): string {
  if (state.problems.length > 0) {
    return state.problems.map(({ name, words }) => (name === null ? words : `${name}: ${words}`)).join(" ");
  }
  return state.searching ? "Searching…" : "";
}
