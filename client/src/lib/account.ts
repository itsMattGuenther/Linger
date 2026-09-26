/**
 * The bits of the settings panel that can be wrong without looking wrong:
 * request bodies, the password floor, the display-name cap.
 *
 * The server is still the authority (PROTOCOL §5). These copies exist so the
 * form can refuse a no-op before the round trip, not so it can second-guess
 * the server's sentences.
 */
import type { ChangePasswordRequest } from "../generated/ChangePasswordRequest";
import type { UpdateMeRequest } from "../generated/UpdateMeRequest";

/**
 * `linger-core::limits::MAX_DISPLAY_NAME_CHARS`. ts-rs exports types, not
 * constants, so the number is written here. The server refuses anything longer.
 */
export const MAX_DISPLAY_NAME_CHARS = 32;

/**
 * `linger-core::limits::MIN_PASSWORD_CHARS`. Same reason as the display-name
 * cap: the form greys the button out before the round trip. Minimum length is
 * the only rule — no symbols, no digits, no expiry (PROTOCOL §2).
 */
export const MIN_PASSWORD_CHARS = 8;

/** A PATCH /me that only touches the display name. Other fields stay put. */
export function displayNameRequest(name: string): UpdateMeRequest {
  return {
    display_name: name.trim(),
    style: null,
    status: null,
    entrance_sound: null,
  };
}

export function passwordRequest(
  current: string,
  next: string,
): ChangePasswordRequest {
  return { current_password: current, new_password: next };
}

/** Empty, unchanged, or over the cap: not worth sending. */
export function displayNameReady(next: string, current: string): boolean {
  const name = next.trim();
  if (name.length === 0 || name.length > MAX_DISPLAY_NAME_CHARS) return false;
  return name !== current.trim();
}

/** Both boxes filled, new one long enough, and actually different. */
export function passwordReady(current: string, next: string): boolean {
  return current.length > 0 && next.length >= MIN_PASSWORD_CHARS && current !== next;
}
