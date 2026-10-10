/**
 * Lines the server writes into a room that nobody typed: a message of the day
 * being set (#464) and somebody joining voice (#473).
 *
 * They're in the room for whoever comes in, and they call nobody over: no
 * sound, no banner, no taskbar, no room turning bold and no DM lit. One check,
 * asked everywhere that decides any of those, so a third kind of line can't
 * be quiet in one place and loud in another.
 */
import type { Message } from "../generated/Message";

export function isQuietLine(message: Message): boolean {
  return message.motd === true || message.voice_join === true;
}
