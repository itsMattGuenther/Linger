/**
 * The iPhone's share window (#820, SPEC §4.15).
 *
 * Sharing to Linger on an iPhone happens in a small program of its own inside
 * the share sheet (`gen/apple/ShareExtension/`): you pick a conversation
 * there, add a message if you like, and it uploads and posts as you, without
 * leaving the app you shared from. It can't run this page, so the app hands it
 * two things, through the App Group the two share:
 *
 * - **A sign-in of its own on each server** (`POST /auth/share-sign-in`,
 *   PROTOCOL §2), kept in the Keychain where it can read it. Its own, so the
 *   window and the app never spend each other's refresh token. Renewed well
 *   before it could expire, and signed out with the server.
 * - **The list it picks from**: each server's rooms, group DMs and people, as
 *   the list shows them, and Linger's colours, read from the design tokens
 *   here so the window looks like the app without a copy of them in Swift.
 *
 * The shapes below are the Swift side's `ShareList` (`ShareList.swift`). A
 * change to one is a change to the other, and `version` says which.
 */
import type { User } from "../../generated/User";
import { ApiError } from "../../lib/api";
import { paletteKey } from "../../lib/names";
import type { ListModel } from "./list";

/** The list's shape, which `ShareList.swift` reads. */
export const SHARE_LIST_VERSION = 1;

/** Linger's colours for the window, each as `#rrggbbaa`. */
export interface ShareWindowTheme {
  /** The sheet itself: a popover's surface. */
  background: string;
  /** A row lifted off it, and the message box. */
  raised: string;
  /** The search box, sunk into it. */
  field: string;
  /** The chosen conversation's row. */
  chosen: string;
  /** The chosen row's edge. */
  chosenEdge: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  hairline: string;
  /** The lamp: Send, and the chosen row's mark. */
  accent: string;
  onAccent: string;
  danger: string;
}

/** Each colour role, and the design token it's read from (`styles/tokens.css`). */
export const THEME_TOKENS: Record<keyof ShareWindowTheme, string> = {
  background: "--surface-popover",
  raised: "--surface-raised",
  field: "--surface-sunken",
  chosen: "--accent-wash-strong",
  chosenEdge: "--accent-edge",
  text: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  hairline: "--hairline",
  accent: "--accent",
  onAccent: "--text-on-accent",
  danger: "--text-danger",
};

/**
 * Whether the window can send to a server: `ready` when its sign-in is kept;
 * `old` when the server is from before the share window's sign-in and needs
 * updating; `none` when there's no sign-in yet (the server couldn't be reached
 * to ask, say).
 */
export type ShareStatus = "ready" | "old" | "none";

export interface ShareWindowConversation {
  room_id: string;
  kind: "room" | "group" | "dm";
  /** As the list names it: a room's name, a group's people, a DM's person. */
  name: string;
  /** People's colours, `#rrggbbaa`: a DM's person, a group's first three; none for a room. */
  colors: string[];
}

export interface ShareWindowServer {
  base_url: string;
  name: string;
  share: ShareStatus;
  conversations: ShareWindowConversation[];
}

export interface ShareWindowList {
  version: typeof SHARE_LIST_VERSION;
  /** When the app wrote it, in Unix milliseconds. */
  written_at: number;
  theme: ShareWindowTheme;
  servers: ShareWindowServer[];
}

/** One server's listing, as the list window has it. */
export interface ShareListing {
  id: string;
  name: string;
  model: ListModel;
}

/**
 * The list the window picks from: every server, its conversations in the
 * list's order (rooms, then group DMs, then the people you have a DM with), as
 * `shareTargets` gives the in-app picker. A group nobody else is in any more is
 * left out. `colorOf` turns a palette key into `#rrggbbaa`.
 */
export function shareWindowList(
  listings: readonly ShareListing[],
  status: ReadonlyMap<string, ShareStatus>,
  theme: ShareWindowTheme,
  colorOf: (key: string) => string,
  now: number,
): ShareWindowList {
  const colorsOf = (people: readonly User[]) => people.slice(0, 3).map((user) => colorOf(paletteKey(user) ?? "slate"));
  return {
    version: SHARE_LIST_VERSION,
    written_at: now,
    theme,
    servers: listings.map(({ id, name, model }): ShareWindowServer => {
      const rooms = model.rooms.map((room): ShareWindowConversation => ({ room_id: room.id, kind: "room", name: room.name, colors: [] }));
      const groups = model.groups
        .filter((group) => !group.last)
        .map((group): ShareWindowConversation => ({ room_id: group.id, kind: "group", name: group.label, colors: colorsOf(group.people.map((one) => one.user)) }));
      const people = [...model.people.here, ...model.people.away, ...model.people.offline];
      const dms = people.flatMap((row): ShareWindowConversation[] =>
        row.dm === null ? [] : [{ room_id: row.dm, kind: "dm", name: row.user.display_name, colors: colorsOf([row.user]) }],
      );
      return { base_url: id, name, share: status.get(id) ?? "none", conversations: [...rooms, ...groups, ...dms] };
    }),
  };
}

/** What the shell keeps for the window (`share_window.rs`). */
export interface ShareShell {
  /** When this server's window sign-in was last saved, by the app or the window renewing it; null when there's none. */
  savedAt(baseUrl: string): Promise<number | null>;
  /** Keep a new one, answering with the one it replaced, to sign out. */
  save(baseUrl: string, refreshToken: string): Promise<string | null>;
  /** Stop keeping it, answering with it, to sign out. */
  forget(baseUrl: string): Promise<string | null>;
  /** Every server one is kept for. */
  kept(): Promise<string[]>;
  /** Write the list the window reads. */
  writeList(list: ShareWindowList): Promise<void>;
}

/**
 * Asked for again once the kept one is this old. A sign-in lasts 30 days from
 * its last renewal (PROTOCOL §2), and the window renews only when somebody
 * shares, so the app keeps it from getting anywhere near.
 */
export const RENEW_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** A signed-in server, as far as the window's sign-in is concerned. */
export interface ShareServer {
  baseUrl: string;
  /** Ask for a sign-in of the window's own (`AuthedApi.shareSignIn`). */
  shareSignIn(): Promise<string>;
}

/**
 * The listings the share window's list is written from (#822): every server
 * signed in here, in order, as it is now if the app is connected to it, or as
 * it was the last time it was. The app lets go of a server's rooms and people
 * while it's a while in the background or offline, and has none of them yet
 * while connecting, and the list written from that had no servers: sharing
 * from Photos a minute after leaving Linger said to sign in. Only signing out
 * of a server takes it off. `null`, and nothing to write, while a server
 * signed in hasn't been connected to since the app started (just opened,
 * offline, or that server down): the list already written has it as it last
 * was, which is better than without it. `kept` holds each server's last
 * connected listing, and is brought up to date.
 */
export function shareListings(signedIn: readonly string[], now: readonly ShareListing[], kept: Map<string, ShareListing>): ShareListing[] | null {
  const current = new Map(now.map((listing) => [listing.id, listing]));
  for (const id of [...kept.keys()]) if (!signedIn.includes(id)) kept.delete(id);
  const servers: ShareListing[] = [];
  for (const id of signedIn) {
    const listing = current.get(id);
    // Connected: the server has said who you are.
    if (listing && listing.model.me !== null) kept.set(id, listing);
    const known = kept.get(id);
    if (!known) return null;
    servers.push(known);
  }
  return servers;
}

/**
 * A queue for `keepShareSignIns`: each run starts once the one before it has
 * settled (#822). Two at once, a sign-out's run could finish before an older
 * run, still asking, saved what it got, which then stayed after the sign-out
 * it should have ended with. One at a time, the sign-out's run finds it kept,
 * and ends it.
 */
export function oneAtATime(): <T>(run: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (run) => {
    const next = last.then(run);
    last = next.catch(() => undefined);
    return next;
  };
}

/**
 * Keep the window's sign-ins as the app's are: one for every server signed in
 * here, renewed once it's `RENEW_AFTER_MS` old, and signed out of a server the
 * app no longer is (`signedIn` counts one still being reached, or waiting for
 * a newer app, as signed in). Answers with whether the window can send to each
 * of `servers`. A replaced or forgotten sign-in is signed out (`logout`), best
 * effort. A server that doesn't know the endpoint is `old`; one that couldn't
 * be asked keeps what it had.
 */
export async function keepShareSignIns(
  servers: readonly ShareServer[],
  signedIn: ReadonlySet<string>,
  shell: ShareShell,
  logout: (baseUrl: string, refreshToken: string) => Promise<void>,
  now: number,
): Promise<Map<string, ShareStatus>> {
  const status = new Map<string, ShareStatus>();
  for (const server of servers) {
    const saved = await shell.savedAt(server.baseUrl);
    if (saved !== null && now - saved < RENEW_AFTER_MS) {
      status.set(server.baseUrl, "ready");
      continue;
    }
    try {
      const token = await server.shareSignIn();
      const replaced = await shell.save(server.baseUrl, token);
      if (replaced !== null) await logout(server.baseUrl, replaced).catch(() => undefined);
      // The Keychain may refuse: then the new one is signed out again, not left about.
      if ((await shell.savedAt(server.baseUrl)) === null) {
        await logout(server.baseUrl, token).catch(() => undefined);
        status.set(server.baseUrl, "none");
        continue;
      }
      status.set(server.baseUrl, "ready");
    } catch (error) {
      if (error instanceof ApiError && error.code === "NOT_FOUND") status.set(server.baseUrl, "old");
      // Couldn't ask now: one still within its 30 days goes on working.
      else status.set(server.baseUrl, saved !== null ? "ready" : "none");
    }
  }
  for (const baseUrl of await shell.kept()) {
    if (signedIn.has(baseUrl)) continue;
    const token = await shell.forget(baseUrl);
    if (token !== null) await logout(baseUrl, token).catch(() => undefined);
  }
  return status;
}

/** A colour as `#rrggbbaa`, from the four 0–255 values a canvas gives back. */
export function hexOf([red, green, blue, alpha]: readonly number[]): string {
  return `#${[red, green, blue, alpha].map((value) => Math.round(value ?? 0).toString(16).padStart(2, "0")).join("")}`;
}

/** Turns CSS colours into `#rrggbbaa`, until `done`. */
export interface ColorReader {
  read(value: string): string;
  done(): void;
}

/**
 * Read CSS colours (a token, `var(--name-azure)`, an `oklch(…)`) as
 * `#rrggbbaa`, which the Swift side can read: each is set on an element here
 * to resolve it, then painted on a one-pixel canvas, which gives it back in
 * sRGB whatever colour space it was written in.
 */
export function colorReader(document: Document): ColorReader {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  return {
    read(value) {
      probe.style.color = "";
      probe.style.color = value;
      const resolved = getComputedStyle(probe).color;
      if (!paint) return "#00000000";
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = "#000000";
      paint.fillStyle = resolved;
      paint.fillRect(0, 0, 1, 1);
      return hexOf([...paint.getImageData(0, 0, 1, 1).data]);
    },
    done() {
      probe.remove();
    },
  };
}

/** Linger's colours for the window, read from the design tokens as they are now. */
export function readTheme(reader: ColorReader): ShareWindowTheme {
  const read = (role: keyof ShareWindowTheme) => reader.read(`var(${THEME_TOKENS[role]})`);
  return {
    background: read("background"),
    raised: read("raised"),
    field: read("field"),
    chosen: read("chosen"),
    chosenEdge: read("chosenEdge"),
    text: read("text"),
    textSecondary: read("textSecondary"),
    textMuted: read("textMuted"),
    hairline: read("hairline"),
    accent: read("accent"),
    onAccent: read("onAccent"),
    danger: read("danger"),
  };
}

/** A person's colour, from their palette key, as the list's markers draw it. */
export function nameColor(reader: ColorReader, key: string): string {
  return reader.read(`var(--name-${key})`);
}
