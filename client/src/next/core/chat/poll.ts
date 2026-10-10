/**
 * Polls (SPEC §4.18, #474): the box's half of `/poll`, and the words a poll
 * and its closed line are drawn with. The host or a co-host types `/poll` in
 * a room's own box, with the question after it if they like, and Enter opens
 * the panel to finish asking.
 */
import type { Poll } from "../../../generated/Poll";

/** `linger-core::limits`, mirrored to refuse what the server would before it's sent. */
export const MAX_POLL_QUESTION_CHARS = 300;
export const MAX_POLL_CHOICE_CHARS = 80;
export const MIN_POLL_CHOICES = 2;
export const MAX_POLL_CHOICES = 10;

/** How long a poll runs before it closes on its own (`linger-core::limits::POLL_DAYS`). */
export const POLL_LENGTHS = [
  { value: "1", label: "1 day" },
  { value: "3", label: "3 days" },
  { value: "7", label: "1 week" },
  { value: "14", label: "2 weeks" },
  { value: "28", label: "4 weeks" },
] as const;
export type PollLength = (typeof POLL_LENGTHS)[number]["value"];
/** A week, unless whoever asks says otherwise (Matt, 2026-10-10). */
export const DEFAULT_POLL_LENGTH: PollLength = "7";

const COMMAND = "/poll";

/**
 * The box read as `/poll`: the question typed after it (`""` when there's
 * none yet), or null when it's an ordinary message. `/polls` is a word, not
 * the command.
 */
export function pollCommand(draft: string): string | null {
  const text = draft.trim();
  if (text.slice(0, COMMAND.length).toLowerCase() !== COMMAND) return null;
  const rest = text.slice(COMMAND.length);
  if (rest !== "" && !/^\s/.test(rest)) return null;
  return rest.trim();
}

/** The box is on its way to `/poll`, or holds it, from `/p` on. */
export function typingPoll(draft: string): boolean {
  if (pollCommand(draft) !== null) return true;
  const start = draft.trimStart().toLowerCase();
  return start.length >= 2 && !/\s/.test(start) && COMMAND.startsWith(start);
}

/** "Horde won.", "Horde and Alliance tied.", or "Nobody voted.", as the server's closed line says it. */
export function resultWords(winners: readonly string[]): string {
  if (winners.length === 0) return "Nobody voted.";
  if (winners.length === 1) return `${winners[0]} won.`;
  return `${winners.slice(0, -1).join(", ")} and ${winners[winners.length - 1]} tied.`;
}

/** Whether a poll can still be voted in at `now`: not closed, and its time not up. */
export function pollOpen(poll: Poll, now: number): boolean {
  return poll.closed_at === null && poll.closes_at > now;
}

/** What picking choice `at` makes your vote: pick-one moves it or takes it back, pick-any toggles it. */
export function nextVote(poll: Poll, mine: readonly number[], at: number): number[] {
  if (mine.includes(at)) return mine.filter((one) => one !== at);
  return poll.multi ? [...mine, at].sort((a, b) => a - b) : [at];
}

/** The choices `userId` picked. */
export function votesOf(poll: Poll, userId: string | null): number[] {
  if (userId === null) return [];
  return poll.choices.flatMap((choice, at) => (choice.voter_ids.includes(userId) ? [at] : []));
}
