/**
 * Starting a DM from the list (docs/design/buddy-list.md, "The buddy list"):
 * the new-message picker's logic. Pure; the picker draws it.
 *
 * A DM is a set of people (SPEC §4.13): asking for the same set twice gives
 * the same DM, so the picker says whether the set you've chosen already has
 * one ("Open the DM") before you ask.
 */
import type { Room } from "../../generated/Room";
import type { User } from "../../generated/User";
import type { UserId } from "../../generated/UserId";

/** `linger-core::limits::MAX_DM_MEMBERS`: you and seven others. The server refuses more. */
export const MAX_DM_MEMBERS = 8;
export const MAX_PICKS = MAX_DM_MEMBERS - 1;

/** Fold case and accents, so "zoe" finds "Zoë". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}

/** Who can still be picked: not you, not already picked, matching what's typed, by name. */
export function candidates(users: readonly User[], meId: UserId | null, query: string, picked: readonly UserId[]): User[] {
  const wanted = fold(query.trim());
  const chosen = new Set(picked);
  return users
    .filter((user) => user.id !== meId && !chosen.has(user.id))
    .filter((user) => wanted === "" || fold(user.display_name).includes(wanted) || fold(user.username).includes(wanted))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }));
}

/** The DM you already have with exactly these people, if any. */
export function existingDm<T extends Pick<Room, "member_ids">>(dms: readonly T[], meId: UserId | null, picked: readonly UserId[]): T | null {
  if (meId === null || picked.length === 0) return null;
  const wanted = new Set([meId, ...picked]);
  return (
    dms.find((dm) => {
      const members = new Set(dm.member_ids ?? []);
      return members.size === wanted.size && [...wanted].every((id) => members.has(id));
    }) ?? null
  );
}

/** The people chosen, said the way a DM is named: "Eli", "Eli and Jules", "Eli, Jules and 2 others". */
export function pickedLabel(people: readonly User[]): string {
  const names = people.map((person) => person.display_name);
  const [first, second, third] = names;
  if (first === undefined) return "";
  if (second === undefined) return first;
  if (third === undefined) return `${first} and ${second}`;
  const rest = names.length - 2;
  return `${first}, ${second} and ${rest} ${rest === 1 ? "other" : "others"}`;
}
