/**
 * The push-to-talk key (decision 6): chosen in Settings → Sound & Voice,
 * Right Ctrl unless somebody picks another. Stored as a `KeyboardEvent.code`,
 * which names the key where it sits rather than what it types, so Right Ctrl
 * and Left Ctrl are different keys: every shortcut (Ctrl+K, Ctrl+W, Ctrl+Tab)
 * is pressed with the left one, and none of them opens the microphone.
 */

/** Right Ctrl: it types nothing, and the shortcuts use the left one. */
export const DEFAULT_TALK_KEY = "ControlRight";

/**
 * Whether a key can be the push-to-talk key. Only keys that type nothing:
 * held while you talk, a letter or a space would be typed into the message
 * box, and Caps Lock would toggle. Escape, Tab and Enter already mean things.
 */
export function canBeTalkKey(code: string): boolean {
  return (
    /^(Control|Alt|Shift)(Left|Right)$/.test(code) ||
    /^F([1-9]|1\d|2[0-4])$/.test(code) ||
    ["Pause", "ScrollLock", "Insert", "ContextMenu"].includes(code)
  );
}

/** A key's name as a person would say it: "Right Ctrl", "F13". */
export function talkKeyName(code: string): string {
  const side = /^(Control|Alt|Shift)(Left|Right)$/.exec(code);
  if (side) {
    const key = side[1] === "Control" ? "Ctrl" : side[1];
    return `${side[2]} ${key}`;
  }
  const named: Record<string, string> = { ScrollLock: "Scroll Lock", ContextMenu: "Menu" };
  return named[code] ?? code;
}

/** Whether a key press is the push-to-talk key. */
export function isTalkKey(press: { code: string }, code: string): boolean {
  return press.code === code;
}
