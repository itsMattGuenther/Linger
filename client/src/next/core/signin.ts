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
import { MIN_PASSWORD_CHARS } from "../../lib/account";
import { type PastedLink, parsePastedLink } from "../../lib/link";

/** Where the flow is. */
export type SignInStep =
  | { kind: "paste" }
  | { kind: "login"; baseUrl: string; serverName: string | null }
  | { kind: "register"; baseUrl: string; code: string; serverName: string | null }
  | { kind: "setup"; baseUrl: string; token: string };

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
  return usernameOf(username) !== "" && displayName.trim() !== "" && password.length >= MIN_PASSWORD_CHARS;
}

export function setupReady(serverName: string, username: string, displayName: string, password: string): boolean {
  return serverName.trim() !== "" && registerReady(username, displayName, password);
}

export { MIN_PASSWORD_CHARS };

/** The server calls that decide which form comes after the paste box. */
export interface Door {
  setupPreview(token: string): Promise<{ valid: boolean }>;
  invitePreview(code: string): Promise<{ valid: boolean; server_name: string | null }>;
  health(): Promise<void>;
}

/**
 * Which form a paste leads to, asking the server at that address: a setup
 * link that still works leads to setting the server up, a live invite to
 * joining, and a bare address to signing in once something answers there.
 */
export async function stepFor(pasted: string, doorAt: (baseUrl: string) => Door): Promise<{ step: SignInStep } | { problem: string }> {
  const read = readPasted(pasted);
  if ("problem" in read) return read;
  const { link } = read;
  const door = doorAt(link.baseUrl);
  try {
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
    await door.health();
    return { step: { kind: "login", baseUrl: link.baseUrl, serverName: null } };
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
}

/** What the sign-in screen asks for; each answers with the problem in words, or null once signed in. */
export interface SignInActions {
  /** Read what was pasted and ask the server which form comes next. */
  check: (pasted: string) => Promise<{ step: SignInStep } | { problem: string }>;
  login: (baseUrl: string, username: string, password: string) => Promise<string | null>;
  register: (baseUrl: string, code: string, username: string, displayName: string, password: string) => Promise<string | null>;
  setup: (baseUrl: string, token: string, serverName: string, username: string, displayName: string, password: string) => Promise<string | null>;
}

/**
 * The sign-in screen's actions, against the server at each address. A
 * sign-in that works is handed to `signedIn`, which keeps it (the owner's
 * sessions); anything that fails comes back as a sentence.
 */
export function signInActions(entranceAt: (baseUrl: string) => Entrance, signedIn: (baseUrl: string, auth: AuthResponse) => Promise<void>): SignInActions {
  const enter = async (baseUrl: string, attempt: (entrance: Entrance) => Promise<AuthResponse>): Promise<string | null> => {
    try {
      await signedIn(baseUrl, await attempt(entranceAt(baseUrl)));
      return null;
    } catch (caught) {
      return problemIn(caught);
    }
  };
  return {
    check: (pasted) => stepFor(pasted, entranceAt),
    login: (baseUrl, username, password) => enter(baseUrl, (entrance) => entrance.login({ username: usernameOf(username), password })),
    register: (baseUrl, code, username, displayName, password) =>
      enter(baseUrl, (entrance) =>
        entrance.register({ invite_code: code, username: usernameOf(username), display_name: displayName.trim(), password }),
      ),
    setup: (baseUrl, token, serverName, username, displayName, password) =>
      enter(baseUrl, (entrance) =>
        entrance.setup({ token, server_name: serverName.trim(), username: usernameOf(username), display_name: displayName.trim(), password }),
      ),
  };
}
