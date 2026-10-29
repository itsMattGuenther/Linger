/**
 * Lines the server writes into a room that nobody typed: a message of the day
 * being set (#464), somebody joining voice (#473), a poll closing (#474),
 * somebody leaving a group DM (#565), and somebody sharing their screen
 * (#746).
 *
 * They're in the room for whoever comes in, and they call nobody over: no
 * sound, no banner, no taskbar, no room turning bold and no DM lit. One check,
 * asked everywhere that decides any of those, so no kind of line can be
 * quiet in one place and loud in another.
 */
import type { Message } from "../generated/Message";

export function isQuietLine(message: Message): boolean {
  return message.motd === true || message.voice_join === true || message.poll_closed != null || message.left === true || message.screen_share === true;
}
