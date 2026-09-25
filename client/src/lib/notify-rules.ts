/**
 * Who deserves to be interrupted, and what the interruption says.
 *
 * SPEC §4.2 allows exactly one thing to push itself at you: somebody naming
 * you, or somebody you have explicitly asked to hear from. Everything else in
 * the app is pull. So this file is small on purpose — it is the whole list of
 * reasons a notification may exist, and it is pure, so the list can be tested
 * rather than argued about.
 *
 * There is no `@everyone` and there will not be one (AGENTS rule 5): a rule
 * that matches everybody is a rule anybody can use to ring every phone in the
 * server, and that is the thing group chats are worst at.
 */
import type { Message } from "../generated/Message";
import type { NotifyRule } from "../generated/NotifyRule";
import type { User } from "../generated/User";
import { mentionHandles } from "./markdown";

/** Why a message is worth saying something about. */
export type Reason = "mention" | "rule";

/**
 * The reason this message should reach `me`, or `null` for the ordinary case.
 *
 * Mentions are matched against the *username*, which is the thing that is
 * unique on a server and the thing that was actually typed. Display names are
 * neither.
 */
export function notifyReason(
  message: Message,
  me: User,
  rules: readonly NotifyRule[],
): Reason | null {
  // Your own words, and a message that has since been taken back.
  if (message.author_id === me.id) return null;
  if (message.deleted_at !== null) return null;

  if (mentionHandles(message.body).includes(me.username)) return "mention";

  const asked = rules.some(
    (rule) =>
      rule.target_user_id === message.author_id &&
      (rule.room_id === null || rule.room_id === message.room_id),
  );
  return asked ? "rule" : null;
}

/**
 * Names, in the shape a sentence wants them.
 *
 * Past three it trails off rather than saying how many. That is not fussiness:
 * a number of people in a notification is a tally arriving on your lock screen,
 * which is the shape SPEC §4.2 deleted from the app.
 */
export function peopleList(names: readonly string[]): string {
  if (names.length === 0) return "someone";
  if (names.length === 1) return names[0] ?? "someone";
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and others`;
  const last = names[names.length - 1] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${last}`;
}

/** How much of a message a notification carries before it trails off. */
const EXCERPT_CHARS = 140;

/** What the notification actually says. */
export function notificationText(
  slug: string,
  names: readonly string[],
  excerpt: string,
): { title: string; body: string } {
  const trimmed =
    excerpt.length <= EXCERPT_CHARS ? excerpt : `${excerpt.slice(0, EXCERPT_CHARS).trimEnd()}…`;
  return { title: `${peopleList(names)} in #${slug}`, body: trimmed };
}
