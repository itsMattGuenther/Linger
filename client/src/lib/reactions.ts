// Reactions (SPEC §4.8, PROTOCOL §4, #485): the rules the store and the
// screen share. A reaction's key is one emoji, or `emoji:<id>` for one of the
// server's own; a message holds at most six different ones.

import type { CustomEmoji } from "../generated/CustomEmoji";
import type { ReactionGroup } from "../generated/ReactionGroup";

/** The most different reactions one message holds (`linger-core::limits::MAX_REACTIONS_PER_MESSAGE`). */
export const MAX_REACTIONS = 6;

/** How a reaction names one of the server's own emoji (`linger-core::limits::CUSTOM_REACTION_PREFIX`). */
const CUSTOM_PREFIX = "emoji:";

/** The key for reacting with one of the server's own emoji. */
export function customKey(emoji: Pick<CustomEmoji, "id">): string {
  return `${CUSTOM_PREFIX}${emoji.id}`;
}

/** The id of the server emoji a key names, or null for an ordinary emoji. */
export function customIdOf(key: string): string | null {
  return key.startsWith(CUSTOM_PREFIX) ? key.slice(CUSTOM_PREFIX.length) : null;
}

/**
 * One emoji's reactions as they now are, folded into a message's: in its
 * place if it was there, at the end if it's new, gone when nobody's is left.
 * The same array back when nothing changed, so nothing redraws.
 */
export function withGroup(groups: ReactionGroup[], group: ReactionGroup): ReactionGroup[] {
  const at = groups.findIndex((one) => one.key === group.key);
  if (group.count === 0) return at < 0 ? groups : groups.filter((one) => one.key !== group.key);
  if (at < 0) return [...groups, group];
  const held = groups[at];
  if (held && held.count === group.count && held.user_ids.join() === group.user_ids.join()) return groups;
  return groups.map((one, n) => (n === at ? group : one));
}

/** One emoji's group with you added or taken out, before the server says so. */
export function toggled(groups: readonly ReactionGroup[], key: string, meId: string, on: boolean): ReactionGroup {
  const held = groups.find((one) => one.key === key);
  const others = (held?.user_ids ?? []).filter((id) => id !== meId);
  const user_ids = on ? [...others, meId] : others;
  return { key, count: user_ids.length, user_ids };
}

/**
 * The reactions to draw: one of the server's own whose emoji is gone isn't
 * drawn (#485). Removing an emoji removes its reactions on the server, and no
 * frame says so per message; the set no longer having it is how an app knows.
 */
export function shownGroups(groups: readonly ReactionGroup[], custom: ReadonlyMap<string, CustomEmoji>): ReactionGroup[] {
  return groups.filter((group) => {
    const id = customIdOf(group.key);
    return id === null || custom.has(id);
  });
}

/** Whether a message has room for one more different reaction. */
export function hasRoom(groups: readonly ReactionGroup[]): boolean {
  return groups.length < MAX_REACTIONS;
}

/**
 * What a pill says on hover: who left it, and a server emoji's name, since
 * its picture alone doesn't say what it's called. "You" when it's yours.
 */
export function reactedWords(names: readonly string[], name: string | null): string {
  const who = names.length <= 1 ? (names[0] ?? "Nobody") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return name === null ? `${who} reacted` : `${who} reacted with :${name}:`;
}
