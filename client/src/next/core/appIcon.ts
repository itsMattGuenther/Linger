import { invoke } from "@tauri-apps/api/core";

import { oneAtATime } from "./shareWindow";

/**
 * The home screen icon a person picks on a phone (#961, SPEC §4.15), in
 * Settings › Appearance: the door with its light on, which the app has to
 * start, or one of five more looks the app carries. The order is
 * scripts/app-icon-looks.mjs's, whose test checks this list agrees with it,
 * the shell's and the phones'. The choice stays on the phone: the phone
 * itself knows which icon it shows.
 */
export const ICON_LOOKS = [
  { id: "door", name: "The door" },
  { id: "after-dark", name: "After dark" },
  { id: "porch-light", name: "Porch light" },
  { id: "daylight", name: "Daylight" },
  { id: "dusk", name: "Dusk" },
  { id: "original", name: "The original" },
] as const;

export type IconLook = (typeof ICON_LOOKS)[number]["id"];

/** The icon the app has to start, and the answer when the phone can't say. */
export const DEFAULT_LOOK: IconLook = "door";

export function isIconLook(value: unknown): value is IconLook {
  return ICON_LOOKS.some((look) => look.id === value);
}

/** What Settings asks the phone about its icon. */
export interface AppIconShell {
  /** Which phone: the shape its icons take, and what a change does. */
  phone: "iphone" | "android";
  /** The look on the home screen now. */
  current(): Promise<IconLook>;
  /**
   * Puts a look on the home screen: true once the phone has taken it. On an
   * iPhone, iOS then makes the change and says so itself; on Android, the
   * first change closes the app first.
   */
  set(look: IconLook): Promise<boolean>;
}

type Call = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * The phone app's own (src-tauri/src/phone_icon.rs). Anything it can't
 * answer is the door, unchanged. Its asks go one at a time, in the order they
 * came: on Android each runs on a thread of its own, and two changes at once
 * could finish the other way round, leaving the phone on the older look while
 * the picker shows the newer.
 */
export function appIconShell(phone: AppIconShell["phone"], call: Call = invoke): AppIconShell {
  const inTurn = oneAtATime();
  return {
    phone,
    current: () =>
      inTurn(async () => {
        try {
          const look = await call("phone_icon");
          return isIconLook(look) ? look : DEFAULT_LOOK;
        } catch {
          return DEFAULT_LOOK;
        }
      }),
    set: (look) =>
      inTurn(async () => {
        try {
          return (await call("phone_icon_set", { look })) === true;
        } catch {
          return false;
        }
      }),
  };
}

/** Outside the app, such as a test page in a browser: kept in memory, so the picker can be tried. */
export function memoryIconShell(phone: AppIconShell["phone"], start: IconLook = DEFAULT_LOOK): AppIconShell {
  let now = start;
  return {
    phone,
    current: () => Promise.resolve(now),
    set: (look) => {
      now = look;
      return Promise.resolve(true);
    },
  };
}

/**
 * What the picker has chosen once the look in use changes from `shown` to
 * `inUse`: the new look in use, unless the person had already chosen another.
 */
export function keepChoice(chosen: IconLook, shown: IconLook, inUse: IconLook): IconLook {
  return chosen === shown ? inUse : chosen;
}

/**
 * Asks the phone for `look`, and answers the look to show and whether the
 * phone refused it: when it says no, the look it shows instead, and refused
 * only if that isn't the one asked for. Null, yes or no, once `latest` says
 * a newer change came, whose answer is the one that counts.
 */
export async function changeIcon(shell: AppIconShell, look: IconLook, latest: () => boolean): Promise<{ look: IconLook; refused: boolean } | null> {
  if (await shell.set(look)) return latest() ? { look, refused: false } : null;
  if (!latest()) return null;
  const now = await shell.current();
  if (!latest()) return null;
  return { look: now, refused: now !== look };
}
