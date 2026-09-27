/**
 * What a DM is called, and who it is with (SPEC §4.13).
 *
 * Pure functions, because naming a DM is the one piece of real logic in the
 * feature and it is all edge cases: a DM has no name of its own, so every
 * client works it out from who is in it — and the answer is different for
 * every person looking at it. Callie's DM with Dave is "Dave" to Callie and
 * "Callie" to Dave.
 *
 * The server does send a `slug` and a `name`, and both are generated and mean
 * nothing (`repo::dms`). Nothing in here reads either of them.
 */
import type { MessageId } from "../generated/MessageId";
import type { Room } from "../generated/Room";
import type { User } from "../generated/User";
import type { UserId } from "../generated/UserId";

/** Everybody in a DM except you, in the order the server listed them. */
export function others(room: Room, meId: UserId | null): UserId[] {
  return (room.member_ids ?? []).filter((id) => id !== meId);
}

/**
 * The people in a DM, as `User`s, dropping any the client has not been told
 * about.
 *
 * A member can be missing: somebody removed from the server leaves the roster
 * while the DM they were in stays (T-413, and the membership row survives on
 * purpose). Drawing a gap is better than drawing "unknown" — the DM is still
 * the conversation it was.
 */
export function peopleIn(room: Room, users: User[], meId: UserId | null): User[] {
  const byId = new Map(users.map((person) => [person.id, person]));
  return others(room, meId)
    .map((id) => byId.get(id))
    .filter((person): person is User => person !== undefined);
}

/**
 * The label for a DM: the other people in it.
 *
 * Two names get an "and", because "Callie and Dave" is how somebody would say
 * it. Three or more get commas and a count for the rest, which is the point at
 * which a list stops being a name and starts being a list.
 */
export function dmLabel(room: Room, users: User[], meId: UserId | null): string {
  const names = peopleIn(room, users, meId).map((person) => person.display_name);
  const [first, second, third] = names;
  if (first === undefined) {
    // Everybody else has left the server, or the client has not caught up.
    // A DM you are alone in is still yours and still has what was said in it.
    return "just you";
  }
  if (second === undefined) return first;
  if (third === undefined) return `${first} and ${second}`;
  const rest = names.length - 2;
  return `${first}, ${second} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/**
 * Where somebody is, when where they are is a DM (SPEC §4.13, §4.3).
 *
 * The roster asks this about *another person*, so the names it wants are the
 * DM's members minus the person whose card it is — which always includes the
 * reader, because a reader who was not a member would have been told `null` for
 * the room and would never get here (PROTOCOL §8's redaction).
 *
 * That is why the reader comes out as "you". `dmLabel` answers "what is this
 * conversation called to me" and would say "Callie" for the DM Callie is
 * standing in, which read on Callie's own card is nonsense.
 */
export function dmWhere(
  room: Room,
  users: User[],
  subjectId: UserId,
  meId: UserId | null,
): string {
  const names = peopleIn(room, users, subjectId).map((person) =>
    person.id === meId ? "you" : person.display_name,
  );
  const [first, second] = names;
  if (first === undefined) return "in a message";
  if (second === undefined) return `in a message with ${first}`;
  const rest = names.length - 1;
  return `in a message with ${first} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/**
 * What to call any conversation, wherever both kinds appear in one list — the
 * media grid and the search results (SPEC §4.4, §4.12).
 *
 * A room is its slug with a `#`; a DM is who is in it. Both surfaces draw
 * whatever the server sends them, and since T-1303 the server sends a member
 * their own DMs' files and words — so without this a DM hit reads as a room
 * whose name the client could not find, which is what "archived room" used to
 * mean there.
 */
export function conversationLabel(
  room: Room | undefined,
  users: User[],
  meId: UserId | null,
): string | undefined {
  if (room === undefined) return undefined;
  return room.kind === "dm" ? dmLabel(room, users, meId) : `#${room.slug}`;
}

/**
 * What the DM section calls itself when there is nothing in it.
 *
 * It says how to start one rather than that there are none — an empty list
 * that only reports its emptiness is a dead end, and the way in is not
 * somewhere anybody would look for it.
 */
export function noDms(): string {
  return "empty";
}

/**
 * Sort DMs the way the list draws them: the conversation with something new in
 * it first, then by whichever was spoken in most recently, by you or by them.
 *
 * `hasNew` and `latest` are the store's answers, passed in because this file
 * is pure. `latest` is the store's newest message per room
 * (`GatewayState.newest`), which every arriving message keeps up to date. A
 * DM's own `last_message_id` is only what `ready` said when the app connected,
 * and sorting by it kept the list in its startup order for the whole session
 * (#248); it is the fallback for a DM the store has nothing on. A DM nobody
 * has written in yet goes by when it was made. Ids are UUIDv7 in lowercase
 * hex, so comparing them as strings is comparing times.
 *
 * Note what is *not* here: no count, no ordering by how much is unread (SPEC
 * §4.2, AGENTS rule 3). A DM either has something new in it or it does not.
 */
export function orderDms(
  dms: Room[],
  hasNew: (room: Room) => boolean,
  latest: Readonly<Record<string, MessageId>>,
): Room[] {
  const when = (room: Room): string => latest[room.id] ?? room.last_message_id ?? room.id;
  return [...dms].sort((a, b) => {
    const newA = hasNew(a);
    const newB = hasNew(b);
    if (newA !== newB) return newA ? -1 : 1;
    const lastA = when(a);
    const lastB = when(b);
    if (lastA !== lastB) return lastA < lastB ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}
