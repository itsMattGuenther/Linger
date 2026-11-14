/**
 * A Linger server on the phone's own network, such as one run at home (#842,
 * SPEC §4.15). From Android 17, Linger can't reach an address on the Wi-Fi
 * the phone is on until the person allows it, and a request there doesn't
 * fail: it waits until it gives up. So before the page reaches a server
 * (`api.ts`, and the gateway in `gateway.ts`), it asks the phone
 * (`src-tauri/src/phone_network.rs`), which asks the person only when that
 * server's address is on their network. A server on the internet never asks.
 *
 * Nothing here stops a request. A "no" still tries, since a server reached
 * through a VPN gets through anyway, and only changes the words when it
 * can't get through. Off the phone app, and on an iPhone, which asks by
 * itself, there's nothing to wait for.
 */

import type { IceServer } from "../generated/IceServer";

/**
 * What the phone says about reaching `server`, asking the person if `ask`
 * (`phone_local_network`): `allowed`, `public`, `unresolved`, `asking` or
 * `denied`.
 */
export type LocalNetworkPhone = (server: string, ask: boolean) => Promise<string>;

/** The person's answer, on Android (MainActivity): `granted`, `denied` or `unanswered`. */
export const ANSWER_EVENT = "linger:local-network";

/**
 * How a server stands, as far as the phone goes: `blocked` when it's on the
 * phone's network and Linger isn't allowed there, or the person hasn't
 * answered.
 */
export type Reach = "clear" | "blocked";

/** A minute is long enough to read the dialog; no answer reads as not yet. */
const WAIT_FOR_ANSWER = 60_000;

let phone: { ask: LocalNetworkPhone; answers: EventTarget } | null = null;
/**
 * The person's answer, once they've given one. It holds for every server,
 * since the permission is the app's, until the app starts again.
 */
let answer: "granted" | "denied" | null = null;
/** The dialog being waited on, so a request that comes meanwhile waits for it too. */
let answering: Promise<void> | null = null;

/** The answer as it is now: another request can have heard it while this one waited. */
function given(): typeof answer {
  return answer;
}

/** Ask the phone before reaching a server, from now on (the phone app, `main.tsx`). */
export function askAboutLocalNetwork(ask: LocalNetworkPhone, answers: EventTarget): void {
  phone = { ask, answers };
  answer = null;
  answering = null;
}

/** For tests: nothing to ask, as off the phone. */
export function resetLocalNetwork(): void {
  phone = null;
  answer = null;
  answering = null;
}

/**
 * Wait, before reaching `server`, until the phone has said whether Linger
 * may, asking the person once if it's on their network. Never rejects.
 * Answers at once, not as a promise, when there's nothing to wait for (off
 * the phone, or once Linger's allowed), so a request starts as it always did.
 */
export function reachLocal(server: string): Reach | Promise<Reach> {
  if (phone === null || answer === "granted") return "clear";
  return askPhone(phone, server);
}

async function askPhone(
  { ask, answers }: { ask: LocalNetworkPhone; answers: EventTarget },
  server: string,
): Promise<Reach> {
  while (answering !== null) await answering;
  if (given() === "granted") return "clear";
  // Listening before asking: an answer Android gives at once, for a
  // permission it won't ask about again, can arrive before the phone's reply.
  const heard = listen(answers);
  try {
    let said: string;
    try {
      said = await ask(server, given() === null);
    } catch {
      return "clear";
    }
    if (said === "allowed") {
      answer = "granted";
      return "clear";
    }
    if (said === "denied") return "blocked";
    if (said !== "asking") return "clear";
    const waiting = heard.answer.then((state) => {
      if (state === "granted" || state === "denied") answer = state;
      answering = null;
    });
    answering = waiting;
    await waiting;
    return given() === "granted" ? "clear" : "blocked";
  } finally {
    heard.stop();
  }
}

function listen(answers: EventTarget): { answer: Promise<string>; stop: () => void } {
  let stop = (): void => undefined;
  const answer = new Promise<string>((resolve) => {
    const heard = (event: Event): void =>
      resolve(event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : "unanswered");
    const timer = setTimeout(() => resolve("unanswered"), WAIT_FOR_ANSWER);
    answers.addEventListener(ANSWER_EVENT, heard);
    stop = () => {
      clearTimeout(timer);
      answers.removeEventListener(ANSWER_EVENT, heard);
    };
  });
  return { answer, stop };
}

/**
 * The addresses a phone's voice call reaches (#842): the server's own, from
 * the candidates in its offer, and its relay's, as `udp://host:port`,
 * `tcp://host:port` or `turn://host:port` (the phone looks at the host and
 * port; the scheme only says which). Android 17 holds a voice address on the
 * phone's network back as it does a server's, and a call's address can be
 * there when its server's isn't: a voice address the host set to a home
 * one, or the emulator reaching this computer at 10.0.2.2.
 */
export function voiceAddresses(sdp: string, ice: readonly IceServer[]): string[] {
  const found = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const [, transport, host, port] = /^a=candidate:\S+ \d+ (\w+) \d+ (\S+) (\d+) typ\b/i.exec(line) ?? [];
    if (transport && host && port) found.add(address(transport.toLowerCase(), host, port));
  }
  for (const server of ice) {
    for (const url of server.urls) {
      const [, scheme, host, port] = /^(stuns?|turns?):(\[[^\]]+\]|[^:?\s]+)(?::(\d+))?/i.exec(url.trim()) ?? [];
      if (scheme && host) found.add(address("turn", host, port ?? (scheme.toLowerCase().endsWith("s") ? "5349" : "3478")));
    }
  }
  return [...found];
}

function address(scheme: string, host: string, port: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return `${scheme}://${bare.includes(":") ? `[${bare}]` : bare}:${port}`;
}

/**
 * Wait, before a voice call reaches its addresses (`voiceAddresses`), until
 * the phone has said whether Linger may, each as `reachLocal`. `null` when
 * there's nothing to wait for, so a call off the phone starts as it always
 * did. Never rejects.
 */
export function reachVoice(sdp: string, ice: readonly IceServer[]): Promise<void> | null {
  if (phone === null || answer === "granted") return null;
  const addresses = voiceAddresses(sdp, ice);
  return (async () => {
    for (const each of addresses) {
      const reach = reachLocal(each);
      if (typeof reach !== "string") await reach;
    }
  })();
}
