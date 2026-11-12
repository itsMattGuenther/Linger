// Linger's push relay, at push.linger.im (#887, SPEC §4.15, PROTOCOL §5).
//
// Two routes, and nothing kept between them:
//
// - POST /seal: a phone hands over its push address from Apple or Google and
//   gets back a sealed token only this relay can open (`seal.ts`).
// - POST /send: a Linger server hands over a sealed token and a notification
//   it encrypted to that phone (RFC 8291). The relay opens the token and
//   passes the notification to Apple or Google, unread: it hasn't the key.
//
// Nothing is logged or stored (hard rule 4): nothing in this Worker writes a
// log line (test/quiet.test.ts reads every file for one), and wrangler.jsonc
// turns off Workers Logs, traces and Logpush. The rate limits count in Cloudflare's
// memory by hashes, and keep nothing.

import type { RelaySend } from "../../client/src/generated/RelaySend";
import type { SealRequest } from "../../client/src/generated/SealRequest";
import type { SealResponse } from "../../client/src/generated/SealResponse";
import { hashKey, readCapped } from "./bytes";
import { isService, open, seal, validAddress } from "./seal";
import { Credentials, type Outcome, type Outside, toApple, toGoogle } from "./services";

/** The most a request may carry. A notification is about 2 KB. */
export const MAX_BODY_BYTES = 8 * 1024;
/** The longest sealed token the relay reads: the server keeps 1,024 at most. */
export const MAX_TOKEN_CHARS = 1024;
/**
 * The longest encrypted notification it passes on. Apple takes 4 KB in all,
 * and the server's are well under 2 KB once padded (PROTOCOL §5).
 */
export const MAX_PAYLOAD_CHARS = 3072;
/** The longest anybody may ask Apple or Google to hold one: four weeks, Google's limit. */
export const MAX_TTL_SECS = 28 * 24 * 60 * 60;

/**
 * Where the phone app's own page runs, the same list the server's CORS
 * allows (`crates/linger-server/src/routes/mod.rs`), in case the page seals
 * its address itself. Nothing else gets an answer it can read.
 */
const APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

function json(status: number, body: object, origin: string | null = null): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function refused(status: number, message: string, origin: string | null = null): Response {
  return json(status, { error: message }, origin);
}

/** The relay, calling the outside world with `outside`: tests hand it stand-ins. */
export function relay(outside: Outside): ExportedHandler<Env> {
  // Apple's and Google's credentials, made once and kept in this Worker's
  // memory until they're due again.
  const credentials = new Credentials();
  return { fetch: (request, env) => handle(request, env, outside, credentials) };
}

/** One request, start to finish. */
export async function handle(
  request: Request,
  env: Env,
  outside: Outside,
  credentials: Credentials,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/seal") return await sealRoute(request, env);
    if (path === "/send") return await sendRoute(request, env, outside, credentials);
    return refused(404, "Nothing here.");
  } catch {
    // A missing or broken secret, most likely. What went wrong isn't said,
    // or kept: there's nowhere to keep it.
    return refused(500, "The relay couldn't do that.");
  }
}

export default relay({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

async function sealRoute(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  const allowed = origin !== null && APP_ORIGINS.includes(origin) ? origin : null;
  if (request.method === "OPTIONS") {
    if (allowed === null) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowed,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      },
    });
  }
  if (request.method !== "POST") return refused(405, "POST it.", allowed);

  // Per network address, hashed, so one machine can't seal without end.
  const asker = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.SEAL_LIMIT.limit({ key: await hashKey(asker) })).success) {
    return refused(429, "Too many at once. Try again in a minute.", allowed);
  }

  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return refused(413, "That's too long.", allowed);
  const asked = sealRequest(text);
  if (asked === null) return refused(400, "That isn't a push address this relay knows.", allowed);

  const answer: SealResponse = { token: await seal(env.SEAL_KEY, asked) };
  return json(200, answer, allowed);
}

function sealRequest(text: string): SealRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const service: unknown = Reflect.get(body, "service");
  const address: unknown = Reflect.get(body, "address");
  if (!isService(service) || typeof address !== "string" || !validAddress(service, address)) return null;
  return { service, address };
}

async function sendRoute(
  request: Request,
  env: Env,
  outside: Outside,
  credentials: Credentials,
): Promise<Response> {
  if (request.method !== "POST") return refused(405, "POST it.");
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return refused(413, "That's too long.");
  const send = relaySend(text);
  if (send === null) return refused(400, "That isn't a notification this relay takes.");

  // Per phone: a server, or anybody holding a sealed token, can't buzz one
  // phone without end.
  if (!(await env.SEND_LIMIT.limit({ key: await hashKey(send.token) })).success) {
    return refused(429, "Too many for this phone at once.");
  }

  const to = await open(env.SEAL_KEY, send.token);
  // Not sealed here, or sealed with a key this relay no longer has: either
  // way it will never reach anybody, so the phone should register again.
  if (to === null) return refused(410, "That phone's address doesn't open here.");

  let outcome: Outcome;
  try {
    outcome =
      to.service === "fcm"
        ? await toGoogle(to, send, env, outside, credentials)
        : await toApple(to, send, env, outside, credentials);
  } catch {
    outcome = "failed";
  }
  switch (outcome) {
    case "sent":
      return new Response(null, { status: 204 });
    case "gone":
      return refused(410, "That phone is gone.");
    case "failed":
      return refused(502, "Apple or Google didn't take it.");
  }
}

/** A `RelaySend`, checked field by field, or `null`. */
function relaySend(text: string): RelaySend | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const token: unknown = Reflect.get(body, "token");
  const payload: unknown = Reflect.get(body, "payload");
  const ttl: unknown = Reflect.get(body, "ttl");
  const collapse: unknown = Reflect.get(body, "collapse");
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL_SECS) return null;
  const send: RelaySend = { token, payload, ttl };
  if (collapse !== undefined && collapse !== null) {
    // Apple takes 64 bytes; the server's are 32 hex characters.
    if (typeof collapse !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(collapse)) return null;
    send.collapse = collapse;
  }
  return send;
}
