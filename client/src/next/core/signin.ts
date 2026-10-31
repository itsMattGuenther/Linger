/**
 * Signing in, in the new client (parity SIGN-1…6): a person arrives holding a
 * link, not a model of servers and invite codes, so the first thing is one
 * box, and what they paste decides the next form: sign in, join from an
 * invite, or set up a brand new server. The rules here are pure; the list
 * window asks the server (app/signin/SignInView.tsx and its wiring).
 */
import type { AuthResponse } from "../../generated/AuthResponse";
import type { LoginRequest } from "../../generated/LoginRequest";
import type { RegisterRequest } from "../../generated/RegisterRequest";
import type { SetupRequest } from "../../generated/SetupRequest";
import type { UseSignInLinkRequest } from "../../generated/UseSignInLinkRequest";
import { displayNameProblem, lookAlikeIn, MIN_PASSWORD_CHARS, type NameSaid } from "../../lib/account";
import { type PastedLink, parsePastedLink } from "../../lib/link";
import { needsNewerApp } from "../../lib/updates";

/** Where the flow is. */
export type SignInStep =
  | { kind: "paste" }
  | { kind: "login"; baseUrl: string; serverName: string | null }
  | { kind: "register"; baseUrl: string; code: string; serverName: string | null }
  | { kind: "setup"; baseUrl: string; token: string }
  /** A sign-in link the host made (#581): choose a new password for `username`. */
  | { kind: "newPassword"; baseUrl: string; code: string; serverName: string | null; username: string; madeBy: string | null };

/** What was pasted, read, or why it can't be. */
export function readPasted(raw: string): { link: PastedLink } | { problem: string } {
  const link = parsePastedLink(raw);
  return link ? { link } : { problem: "That doesn't look like a server address or a link." };
}

/** A username as the server keeps it: trimmed, lowercase. */
export function usernameOf(typed: string): string {
  return typed.trim().toLowerCase();
}

export function loginReady(username: string, password: string): boolean {
  return usernameOf(username) !== "" && password !== "";
}

export function registerReady(username: string, displayName: string, password: string): boolean {
  return usernameOf(username) !== "" && displayName.trim() !== "" && displayNameProblem(displayName) === null && password.length >= MIN_PASSWORD_CHARS;
}

export function setupReady(serverName: string, username: string, displayName: string, password: string): boolean {
  return serverName.trim() !== "" && registerReady(username, displayName, password);
}

export function newPasswordReady(password: string): boolean {
  return password.length >= MIN_PASSWORD_CHARS;
}

export { displayNameProblem, MIN_PASSWORD_CHARS, type NameSaid };

/**
 * What the sign-in screen says when this device can't keep a sign-in (SIGN-9,
 * #702): what it means for you, in plain words. The system's own reason is
 * D-Bus and platform jargon, and was most of what a new person read on the
 * first screen, so it never goes in the sentence: the screen puts it on the
 * line's tooltip, as the list's foot does (`core/notes.ts`). `device` is
 * `thisDevice` (`core/phone.ts`). On Linux a keyring is something you can
 * turn on, so there it says how (`isLinuxApp`); on Windows, a Mac or a phone
 * the store is part of the system, and there's nothing to suggest.
 */
export function keyringWords(device: string, linux: boolean): string {
  const said = `Linger can't remember your sign-in on ${device}, so you'll sign in each time it starts.`;
  return linux ? `${said} Turning on a keyring, such as GNOME Keyring or KWallet, fixes that.` : said;
}

/** The server calls that decide which form comes after the paste box. */
export interface Door {
  setupPreview(token: string): Promise<{ valid: boolean }>;
  invitePreview(code: string): Promise<{ valid: boolean; server_name: string | null }>;
  signInLinkPreview(code: string): Promise<{ valid: boolean; server_name: string | null; username: string | null; made_by: string | null }>;
  /** Whether anything answers, and the oldest app release it works with (#793). */
  health(): Promise<{ oldestClient: string | null }>;
}

/**
 * What the paste box says when the server needs a newer app than this one
 * (#793), before any form asks for a password: no form here could work.
 * Words true for any copy, however it's updated.
 */
export function newerAppWords(oldest: string): string {
  return `This server needs a newer Linger. It works with Linger ${oldest} or newer. Update Linger, then try again.`;
}

/**
 * Which form a paste leads to, asking the server at that address: a setup
 * link that still works leads to setting the server up, a live invite to
 * joining, and a bare address to signing in once something answers there.
 * First of all, a server that needs a newer app than `version` says so
 * (#793), whatever was pasted, so nobody types a password into a form that
 * can't work. A link asks `/health` only when this copy knows its version;
 * a bare address asks it anyway, to know something answers.
 */
export async function stepFor(
  pasted: string,
  doorAt: (baseUrl: string) => Door,
  version: string | null = null,
): Promise<{ step: SignInStep } | { problem: string }> {
  const read = readPasted(pasted);
  if ("problem" in read) return read;
  const { link } = read;
  const door = doorAt(link.baseUrl);
  try {
    if (link.kind === "server") {
      const { oldestClient } = await door.health();
      if (needsNewerApp(version, oldestClient) && oldestClient !== null) return { problem: newerAppWords(oldestClient) };
      return { step: { kind: "login", baseUrl: link.baseUrl, serverName: null } };
    }
    // A link: no answer here says nothing; its own preview says whether
    // anybody's there.
    if (version !== null) {
      const said = await door.health().catch(() => null);
      const oldestClient = said?.oldestClient ?? null;
      if (needsNewerApp(version, oldestClient) && oldestClient !== null) return { problem: newerAppWords(oldestClient) };
    }
    if (link.kind === "setup") {
      const preview = await door.setupPreview(link.token);
      return preview.valid
        ? { step: { kind: "setup", baseUrl: link.baseUrl, token: link.token } }
        : { problem: "That setup link has already been used. Restart the server for a new one." };
    }
    if (link.kind === "invite") {
      const preview = await door.invitePreview(link.code);
      return preview.valid
        ? { step: { kind: "register", baseUrl: link.baseUrl, code: link.code, serverName: preview.server_name } }
        : { problem: "That invite isn't good anymore. Ask for a new one." };
    }
    const preview = await door.signInLinkPreview(link.code);
    return preview.valid && preview.username !== null
      ? {
          step: {
            kind: "newPassword",
            baseUrl: link.baseUrl,
            code: link.code,
            serverName: preview.server_name,
            username: preview.username,
            madeBy: preview.made_by,
          },
        }
      : { problem: "That sign-in link doesn't work any more. It works once, for a day. Ask the host for a new one." };
  } catch (caught) {
    return { problem: problemIn(caught) };
  }
}

/** Anything thrown on the way in, as a sentence worth showing. The server's own errors are already in words. */
export function problemIn(caught: unknown): string {
  return caught instanceof Error && caught.message !== "" ? caught.message : "Something went wrong.";
}

/** Everything on the way in to a server: `PublicApi` in the app, a fake in tests. */
export interface Entrance extends Door {
  login(request: LoginRequest): Promise<AuthResponse>;
  register(request: RegisterRequest): Promise<AuthResponse>;
  setup(request: SetupRequest): Promise<AuthResponse>;
  redeemSignInLink(request: UseSignInLinkRequest): Promise<AuthResponse>;
}

/**
 * What the sign-in screen asks for; each answers with the problem in words, or
 * null once signed in. Joining can also answer that the display name looks
 * like somebody's already here (#574), which the form says on that field.
 */
export interface SignInActions {
  /** Read what was pasted and ask the server which form comes next. */
  check: (pasted: string) => Promise<{ step: SignInStep } | { problem: string }>;
  login: (baseUrl: string, username: string, password: string) => Promise<string | null>;
  register: (baseUrl: string, code: string, username: string, displayName: string, password: string) => Promise<NameSaid>;
  setup: (baseUrl: string, token: string, serverName: string, username: string, displayName: string, password: string) => Promise<string | null>;
  /** A sign-in link (#581): set a new password and sign in. */
  newPassword: (baseUrl: string, code: string, password: string) => Promise<string | null>;
}

/**
 * The sign-in screen's actions, against the server at each address. A
 * sign-in that works is handed to `signedIn`, which keeps it (the owner's
 * sessions); anything that fails comes back as a sentence. `version` is this
 * copy's (`thisVersion` in lib/updates.ts), for a server that needs a newer
 * one (#793); null where it can't be read, which never blocks.
 */
export function signInActions(
  entranceAt: (baseUrl: string) => Entrance,
  signedIn: (baseUrl: string, auth: AuthResponse) => Promise<void>,
  version: () => Promise<string | null> = () => Promise.resolve(null),
): SignInActions {
  const enter = async <Said>(baseUrl: string, attempt: (entrance: Entrance) => Promise<AuthResponse>, said: (caught: unknown) => Said): Promise<Said | null> => {
    try {
      await signedIn(baseUrl, await attempt(entranceAt(baseUrl)));
      return null;
    } catch (caught) {
      return said(caught);
    }
  };
  const nameSaid = (caught: unknown): NameSaid => {
    const onName = lookAlikeIn(caught);
    return onName === null ? problemIn(caught) : { onName };
  };
  return {
    check: async (pasted) => stepFor(pasted, entranceAt, await version()),
    login: (baseUrl, username, password) => enter(baseUrl, (entrance) => entrance.login({ username: usernameOf(username), password }), problemIn),
    register: (baseUrl, code, username, displayName, password) =>
      enter(
        baseUrl,
        (entrance) => entrance.register({ invite_code: code, username: usernameOf(username), display_name: displayName.trim(), password }),
        nameSaid,
      ),
    setup: (baseUrl, token, serverName, username, displayName, password) =>
      enter(
        baseUrl,
        (entrance) => entrance.setup({ token, server_name: serverName.trim(), username: usernameOf(username), display_name: displayName.trim(), password }),
        problemIn,
      ),
    newPassword: (baseUrl, code, password) => enter(baseUrl, (entrance) => entrance.redeemSignInLink({ code, new_password: password }), problemIn),
  };
}
