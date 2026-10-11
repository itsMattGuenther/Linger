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

/**
 * The mouse buttons that can be the talk key (#500), by `MouseEvent.button`:
 * the middle one and the two side buttons, which gamers often hold to talk.
 * Never the left or right: every click would open the microphone. Saved
 * under names of Linger's own, beside the keys' `KeyboardEvent.code`s.
 */
const BUTTONS: Readonly<Record<number, string>> = { 1: "MouseMiddle", 3: "MouseBack", 4: "MouseForward" };

/** The talk key a mouse button would be, or null for one that can't be. */
export function talkButton(button: number): string | null {
  return BUTTONS[button] ?? null;
}

/** Whether the talk key is a mouse button. */
export function isMouseTalkKey(code: string): boolean {
  return Object.values(BUTTONS).includes(code);
}

/**
 * Every talk key the picker can save: the desktop shell maps each to what
 * Windows and Linux call it (`src-tauri/src/talk_key/mod.rs`, `talk_key`),
 * and a test checks that it does.
 */
export const TALK_KEYS: readonly string[] = [
  ...["Control", "Alt", "Shift"].flatMap((key) => [`${key}Left`, `${key}Right`]),
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
  "Pause",
  "ScrollLock",
  "Insert",
  "ContextMenu",
  ...Object.values(BUTTONS),
];

/** A key's name as a person would say it: "Right Ctrl", "F13", "Mouse 4". */
export function talkKeyName(code: string): string {
  const side = /^(Control|Alt|Shift)(Left|Right)$/.exec(code);
  if (side) {
    const key = side[1] === "Control" ? "Ctrl" : side[1];
    return `${side[2]} ${key}`;
  }
  // The side buttons as gamers count them: the wheel is the third.
  const named: Record<string, string> = {
    ScrollLock: "Scroll Lock",
    ContextMenu: "Menu",
    MouseMiddle: "Middle Mouse",
    MouseBack: "Mouse 4",
    MouseForward: "Mouse 5",
  };
  return named[code] ?? code;
}

/** Whether a key press is the push-to-talk key. */
export function isTalkKey(press: { code: string }, code: string): boolean {
  return press.code === code;
}

/** Whether a mouse button press is the push-to-talk key. */
export function isTalkButton(press: { button: number }, code: string): boolean {
  return talkButton(press.button) === code;
}

/**
 * The line that gives Hyprland's key to Linger's shortcut (SPEC §4.14,
 * #500): Lua from Hyprland 0.56, `hyprland.conf` before. `key` is its name
 * there (`Control_R`, `mouse:275`), `shortcut` Linger's (`linger:push-to-talk`).
 * Non-consuming, so the app in front still gets the key; ignoring other
 * modifiers, so it works with Shift held and letting go of a Ctrl, Alt or
 * Shift talk key is heard as letting go.
 */
export function hyprlandBind(config: "lua" | "conf", key: string, shortcut: string): string {
  return config === "lua"
    ? `hl.bind("${key}", hl.dsp.global("${shortcut}"), { non_consuming = true, ignore_mods = true })`
    : `bindni = , ${key}, global, ${shortcut}`;
}
