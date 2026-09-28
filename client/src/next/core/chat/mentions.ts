/**
 * Mentioning somebody by the name you know them by (#267): what's being typed
 * after an `@`, who the message box's list offers for it, and what choosing
 * one puts in the box. Pure; the composer (app/chat/Composer.tsx) draws it.
 *
 * What a message stores is always `@username` (SPEC §4.2). A username never
 * changes, so an old mention never breaks; the list is only a way to find it
 * by the name you know, and a mention is drawn with that name when read.
 */
import type { PresenceState } from "../../../generated/PresenceState";
import type { Room } from "../../../generated/Room";
import type { User } from "../../../generated/User";
import { peopleIn } from "../../../lib/dm";
import type { GatewayState } from "../../../lib/gateway";
import { mentionCanStart } from "../../../lib/markdown";
import { findsPerson } from "../newDm";
import { peopleInRoom, presenceOf } from "./conversation";

/** An `@` being typed, and what's typed after it up to the caret. */
export interface MentionTyping {
  /** Where the `@` is. */
  start: number;
  /** The end of the word it starts, which choosing somebody replaces. */
  end: number;
  /** What's typed between the `@` and the caret: "jus". */
  query: string;
}

/** Somebody the list can offer, with where they are for their marker. */
export interface MentionPerson {
  user: User;
  state: PresenceState;
}

/**
 * Handles that read as a message to everybody. They don't exist and won't
 * (SPEC §4.2, AGENTS rule 5), so the list never offers one, even if
 * somebody registered it as their own username.
 */
const BROADCAST = new Set(["everyone", "here"]);

/** What a query may hold: the word characters a mention ends on (`lib/markdown.ts`). */
const WORD = /^[\p{L}\p{N}_]$/u;

/** The character (a whole code point) just before `at`, or "". */
function before(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  const pair = at >= 2 && low >= 0xdc00 && low <= 0xdfff;
  return text.slice(pair ? at - 2 : at - 1, at);
}

/** The character (a whole code point) at `at`, or "". */
function after(text: string, at: number): string {
  const point = text.codePointAt(at);
  return point === undefined ? "" : String.fromCodePoint(point);
}

/**
 * The mention being typed at the caret, or null. An `@` opens one only where
 * a mention can start, by the parser's own rule (`mentionCanStart`): at the
 * start of a word and outside code, so `you@example.com` opens nothing. The
 * query runs from the `@` to the caret over word characters, any case, since
 * it finds names as well as usernames.
 */
export function mentionAt(text: string, caret: number): MentionTyping | null {
  if (caret < 1 || caret > text.length) return null;
  let at = caret;
  for (let char = before(text, at); char !== "" && WORD.test(char); char = before(text, at)) at -= char.length;
  if (text[at - 1] !== "@") return null;
  const start = at - 1;
  if (!mentionCanStart(text, start)) return null;
  let end = caret;
  for (let char = after(text, end); char !== "" && WORD.test(char); char = after(text, end)) end += char.length;
  return { start, end, query: text.slice(start + 1, caret) };
}

/** Two readings of the box that would draw the same list. */
export function sameTyping(a: MentionTyping | null, b: MentionTyping | null): boolean {
  return a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end && a.query === b.query);
}

function byName(a: User, b: User): number {
  return a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" });
}

/**
 * Who the list may offer in a conversation, in its order. In a room,
 * everyone on the server: the people in the room right now first, then
 * everyone else, each by name. In a DM, only the people in it, since nobody
 * else could see the mention. Never you, and never a handle that reads as
 * everybody.
 */
export function mentionable(state: GatewayState, room: Room): MentionPerson[] {
  const meId = state.me?.id ?? null;
  const offered = (user: User) => user.id !== meId && !BROADCAST.has(user.username);
  const withState = (user: User): MentionPerson => ({ user, state: presenceOf(state, user.id) });
  if (room.kind === "dm") return peopleIn(room, state.users, meId).filter(offered).sort(byName).map(withState);
  const here = peopleInRoom(state, room.id).filter(offered);
  const inRoom = new Set(here.map((user) => user.id));
  const rest = state.users.filter((user) => offered(user) && !inRoom.has(user.id)).sort(byName);
  return [...here, ...rest].map(withState);
}

/** Those the query finds, by name or username (`findsPerson`), keeping the list's order. */
export function mentionMatches(people: readonly MentionPerson[], query: string): MentionPerson[] {
  return people.filter((person) => findsPerson(person.user, query));
}

/**
 * The box after choosing somebody: the `@` and the word it starts become
 * `@username` and a space, with the caret after them. A space already there
 * is used rather than doubled. Null when that would pass `max` characters.
 */
export function putMention(text: string, typing: MentionTyping, username: string, max: number): { text: string; caret: number } | null {
  const rest = text.slice(typing.end);
  const spaced = rest.startsWith(" ");
  const put = `@${username}${spaced ? "" : " "}`;
  const next = text.slice(0, typing.start) + put + rest;
  if (next.length > max) return null;
  return { text: next, caret: typing.start + put.length + (spaced ? 1 : 0) };
}
