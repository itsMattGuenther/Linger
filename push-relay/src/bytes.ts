// Small byte helpers the relay shares: base64url, PEM keys, hashing, and
// reading a request body with a ceiling.

/** base64url without padding, as JWTs and Linger's wire use it. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url or base64, with or without padding; `null` when it isn't. */
export function fromBase64(text: string): Uint8Array | null {
  const plain = text.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(plain) || plain.length % 4 === 1) return null;
  try {
    const decoded = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
    return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A PEM key's body (`-----BEGIN PRIVATE KEY-----`, PKCS #8) as bytes. */
export function pem(text: string): Uint8Array {
  const bytes = fromBase64(text.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""));
  if (!bytes || bytes.length === 0) throw new Error("not a PEM key");
  return bytes;
}

/**
 * A short hex hash, for the rate limits' keys: the limiter counts by it and
 * never sees the address or the sealed token itself.
 */
export async function hashKey(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A request's body as text, or `null` when it is longer than `max` bytes.
 * Read a chunk at a time, so a body that never ends costs `max` bytes and no
 * more, whatever its Content-Length says.
 */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(whole);
}
