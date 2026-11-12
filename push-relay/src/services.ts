// Handing a notification to Apple's or Google's push service.
//
// Each needs a short-lived credential made from Linger's own key: a JWT
// signed with the APNs key for Apple, and an access token Google gives for a
// JWT signed with the Firebase service account. Both are kept in memory and
// reused until they're due to be made again; nothing is written anywhere.
//
// What goes to them is the server's encrypted notification as it came, with
// nothing that says who or what it's about. On an iPhone, the notification
// service extension decrypts it before it shows (#889); the alert below is
// only what shows if it can't. On Android, it's a data message the app's
// messaging service decrypts and shows itself (#888).

import type { RelaySend } from "../../client/src/generated/RelaySend";
import { base64url, pem, utf8 } from "./bytes";
import type { Address } from "./seal";

/** What became of one notification. */
export type Outcome = "sent" | "gone" | "failed";

/** What the relay calls the outside world with: `fetch`, and the time. */
export interface Outside {
  fetch: typeof fetch;
  now: () => number;
}

/** What an iPhone shows if its extension can't decrypt the notification in time. */
export const FALLBACK = { title: "Linger", body: "Open Linger to see it." } as const;

/**
 * Credentials kept between requests in this Worker's memory, never written
 * anywhere. Apple wants its JWT made again within the hour and not more than
 * every twenty minutes; Google says how long its token lasts.
 */
export class Credentials {
  private apple: { jwt: string; madeAt: number } | null = null;
  private google: { token: string; until: number } | null = null;

  /** Forget Apple's, after Apple said it had expired. */
  dropApple(): void {
    this.apple = null;
  }

  async appleJwt(env: Env, now: number): Promise<string> {
    if (this.apple && now - this.apple.madeAt < 40 * 60_000) return this.apple.jwt;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pem(env.APNS_KEY),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const jwt = await signJwt(
      { alg: "ES256", kid: env.APNS_KEY_ID },
      { iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) },
      (bytes) => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes),
    );
    this.apple = { jwt, madeAt: now };
    return jwt;
  }

  async googleToken(account: ServiceAccount, outside: Outside): Promise<string | null> {
    const now = outside.now();
    if (this.google && now < this.google.until) return this.google.token;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pem(account.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const seconds = Math.floor(now / 1000);
    const assertion = await signJwt(
      { alg: "RS256", typ: "JWT" },
      {
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: account.token_uri,
        iat: seconds,
        exp: seconds + 3600,
      },
      (bytes) => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes),
    );
    const answer = await outside.fetch(account.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!answer.ok) return null;
    const body: unknown = await answer.json();
    const token: unknown = typeof body === "object" && body ? Reflect.get(body, "access_token") : null;
    const lasts: unknown = typeof body === "object" && body ? Reflect.get(body, "expires_in") : null;
    if (typeof token !== "string") return null;
    // Made again five minutes before Google says it ends.
    const life = typeof lasts === "number" ? lasts : 3600;
    this.google = { token, until: now + Math.max(0, life - 300) * 1000 };
    return token;
  }
}

async function signJwt(
  header: Record<string, string>,
  claims: Record<string, string | number>,
  sign: (bytes: Uint8Array) => Promise<ArrayBuffer>,
): Promise<string> {
  const unsigned = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(claims)))}`;
  return `${unsigned}.${base64url(await sign(utf8(unsigned)))}`;
}

/** The fields of the Firebase service account's JSON the relay uses. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

export function serviceAccount(text: string): ServiceAccount {
  const parsed: unknown = JSON.parse(text);
  const field = (name: string): string => {
    const value: unknown = typeof parsed === "object" && parsed ? Reflect.get(parsed, name) : null;
    if (typeof value !== "string" || value === "") throw new Error(`the service account has no ${name}`);
    return value;
  };
  return {
    project_id: field("project_id"),
    client_email: field("client_email"),
    private_key: field("private_key"),
    token_uri: field("token_uri"),
  };
}

/** Apple: APNs over HTTP/2 (a Worker's fetch speaks it), one request each. */
export async function toApple(
  to: Address,
  send: RelaySend,
  env: Env,
  outside: Outside,
  credentials: Credentials,
): Promise<Outcome> {
  const host = to.service === "apns_sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const now = outside.now();
  const headers: Record<string, string> = {
    authorization: `bearer ${await credentials.appleJwt(env, now)}`,
    "apns-topic": env.APNS_TOPIC,
    "apns-push-type": "alert",
    "apns-priority": "10",
    // 0 means "now or never", which is what a ttl of 0 asks.
    "apns-expiration": send.ttl === 0 ? "0" : String(Math.floor(now / 1000) + send.ttl),
    "content-type": "application/json",
  };
  if (send.collapse !== undefined) headers["apns-collapse-id"] = send.collapse;
  // No badge, ever (hard rule 3), and the words are the fallback's: the
  // extension puts the real ones in.
  const body = JSON.stringify({
    aps: { alert: FALLBACK, sound: "default", "mutable-content": 1 },
    p: send.payload,
  });
  const answer = await outside.fetch(`https://${host}/3/device/${to.address}`, {
    method: "POST",
    headers,
    body,
  });
  if (answer.ok) return "sent";
  const reason = await reasonOf(answer);
  // The app was removed, or the address isn't this app's or this
  // environment's: it will never work again.
  if (answer.status === 410) return "gone";
  if (answer.status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")) {
    return "gone";
  }
  if (answer.status === 403 && reason === "ExpiredProviderToken") credentials.dropApple();
  return "failed";
}

async function reasonOf(answer: Response): Promise<string | null> {
  try {
    const body: unknown = await answer.json();
    const reason: unknown = typeof body === "object" && body ? Reflect.get(body, "reason") : null;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

/** Google: FCM's HTTP v1 API, a data message the app shows itself. */
export async function toGoogle(
  to: Address,
  send: RelaySend,
  env: Env,
  outside: Outside,
  credentials: Credentials,
): Promise<Outcome> {
  const account = serviceAccount(env.FCM_SERVICE_ACCOUNT);
  const token = await credentials.googleToken(account, outside);
  if (!token) return "failed";
  const android: Record<string, string> = { priority: "HIGH", ttl: `${send.ttl}s` };
  if (send.collapse !== undefined) android["collapse_key"] = send.collapse;
  const answer = await outside.fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: to.address, data: { p: send.payload }, android } }),
    },
  );
  if (answer.ok) return "sent";
  return (await googleGone(answer)) ? "gone" : "failed";
}

/**
 * Whether Google said the address is gone: unregistered (the app removed),
 * from another Firebase project, or not an address at all. Anything else, a
 * notification of ours it didn't like included, isn't the phone's fault.
 */
async function googleGone(answer: Response): Promise<boolean> {
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    return false;
  }
  const error: unknown = typeof body === "object" && body ? Reflect.get(body, "error") : null;
  const details: unknown = typeof error === "object" && error ? Reflect.get(error, "details") : null;
  if (!Array.isArray(details)) return answer.status === 404;
  for (const detail of details) {
    if (typeof detail !== "object" || !detail) continue;
    const code: unknown = Reflect.get(detail, "errorCode");
    if (code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") return true;
    const violations: unknown = Reflect.get(detail, "fieldViolations");
    if (Array.isArray(violations)) {
      for (const violation of violations) {
        if (typeof violation === "object" && violation && Reflect.get(violation, "field") === "message.token") {
          return true;
        }
      }
    }
  }
  return false;
}
