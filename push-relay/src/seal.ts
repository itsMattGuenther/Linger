// Sealing a phone's push address (PROTOCOL §5, "Phone notifications").
//
// A phone's address from Apple or Google is what lets anybody holding Linger's
// keys reach that phone. So a host never sees it: the phone asks the relay to
// seal it, and gives its servers the sealed token instead. Only the relay can
// open one, with SEAL_KEY, and it stores nothing: everything it needs to send
// is inside the token.
//
// AES-256-GCM, with a fresh random nonce each time, so sealing the same
// address twice gives two tokens nobody can tell are the same phone. A token
// that was changed, or sealed with another key, doesn't open.

import type { PushService } from "../../client/src/generated/PushService";
import { base64url, fromBase64, utf8 } from "./bytes";

/** Tokens start with this, so a later key or shape can be told apart. */
const VERSION = "v1.";

/** What a sealed token holds. */
export interface Address {
  service: PushService;
  address: string;
}

/**
 * Whether `address` is the shape `service` hands out: an APNs device token is
 * hex (64 characters today, and Apple says it may grow), an FCM registration
 * token is letters, digits and `:_-`. Bounded so a token stays under the
 * server's 1,024 characters (`MAX_PUSH_SEALED_CHARS`).
 */
export function validAddress(service: PushService, address: string): boolean {
  switch (service) {
    case "apns":
    case "apns_sandbox":
      return /^[0-9a-fA-F]{64,200}$/.test(address);
    case "fcm":
      return /^[A-Za-z0-9_:-]{20,512}$/.test(address);
  }
}

export function isService(value: unknown): value is PushService {
  return value === "apns" || value === "apns_sandbox" || value === "fcm";
}

async function key(secret: string, use: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (!raw || raw.length !== 32) throw new Error("SEAL_KEY isn't 32 bytes in base64");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [use]);
}

/** Seal an address the caller has checked with `validAddress`. */
export async function seal(secret: string, inside: Address): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const words = utf8(JSON.stringify({ s: inside.service, a: inside.address }));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await key(secret, "encrypt"), words),
  );
  const whole = new Uint8Array(nonce.length + sealed.length);
  whole.set(nonce);
  whole.set(sealed, nonce.length);
  return VERSION + base64url(whole);
}

/**
 * Open a sealed token, or `null` when it wasn't sealed by this key.
 *
 * Only as `seal` writes it (#891): no padding, no spaces, no `+` or `/`, no
 * spare bits. A token spelled another way is refused rather than read, so one
 * phone's token has one spelling.
 *
 * A broken `SEAL_KEY` throws instead (#891). It isn't the token's fault, and
 * answering "gone" for it would have every server forget every phone.
 */
export async function open(secret: string, token: string): Promise<Address | null> {
  const opener = await key(secret, "decrypt");
  if (!token.startsWith(VERSION)) return null;
  const text = token.slice(VERSION.length);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const whole = fromBase64(text);
  if (!whole || whole.length < 12 + 16 || base64url(whole) !== text) return null;
  let words: ArrayBuffer;
  try {
    words = await crypto.subtle.decrypt({ name: "AES-GCM", iv: whole.slice(0, 12) }, opener, whole.slice(12));
  } catch {
    return null;
  }
  try {
    const inside: unknown = JSON.parse(new TextDecoder().decode(words));
    if (typeof inside !== "object" || inside === null) return null;
    const s: unknown = Reflect.get(inside, "s");
    const a: unknown = Reflect.get(inside, "a");
    if (!isService(s) || typeof a !== "string" || !validAddress(s, a)) return null;
    return { service: s, address: a };
  } catch {
    return null;
  }
}
