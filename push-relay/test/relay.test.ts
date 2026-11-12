// The relay against stand-ins for Apple and Google (#887): what it asks of
// them, byte for byte where it matters, and what it answers a phone and a
// server. Keys are made fresh for each run, so no real key is in the repo.

import { beforeEach, describe, expect, it } from "vitest";

import { base64url, fromBase64, utf8 } from "../src/bytes";
import { handle, MAX_BODY_BYTES } from "../src/index";
import { open, seal } from "../src/seal";
import { Credentials, FALLBACK, type Outside } from "../src/services";

// ---------------------------------------------------------------------------
// Keys and the environment
// ---------------------------------------------------------------------------

function toPem(der: ArrayBuffer): string {
  const body = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${body.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

/** A signing key pair, made here and now. */
async function keyPair(algorithm: Parameters<SubtleCrypto["generateKey"]>[0]): Promise<CryptoKeyPair> {
  const made = await crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  if (!("privateKey" in made)) throw new Error("not a key pair");
  return made;
}

/** A private key as PKCS #8, the way a .p8 file or a service account holds it. */
async function pkcs8(key: CryptoKey): Promise<ArrayBuffer> {
  const bytes = await crypto.subtle.exportKey("pkcs8", key);
  if (!(bytes instanceof ArrayBuffer)) throw new Error("not bytes");
  return bytes;
}

const apple = await keyPair({ name: "ECDSA", namedCurve: "P-256" });
const google = await keyPair({
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
});
const sealKey = base64url(crypto.getRandomValues(new Uint8Array(32)));
const otherSealKey = base64url(crypto.getRandomValues(new Uint8Array(32)));

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const account = {
  type: "service_account",
  project_id: "linger-test",
  client_email: "relay@linger-test.iam.gserviceaccount.com",
  private_key: toPem(await pkcs8(google.privateKey)),
  token_uri: TOKEN_URI,
};

/** A rate limit that says yes, or no, and counts what it was asked. */
class Limit implements RateLimit {
  keys: string[] = [];
  constructor(public allow = true) {}
  async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(options.key);
    return { success: this.allow };
  }
}

let sendLimit: Limit;
let sealLimit: Limit;
let env: Env;

/** What the relay asked of the outside world. */
interface Asked {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
let asked: Asked[];
/** How the stand-ins answer, by URL. */
let answer: (url: string, body: string) => Response;
let now: number;
let credentials: Credentials;

const outside: Outside = {
  fetch: async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init?.body === "string" ? init.body : "";
    asked.push({ url, method: init?.method ?? "GET", headers, body });
    return answer(url, body);
  },
  now: () => now,
};

beforeEach(async () => {
  sendLimit = new Limit();
  sealLimit = new Limit();
  env = {
    APNS_KEY: toPem(await pkcs8(apple.privateKey)),
    APNS_KEY_ID: "FGGDB7SBQQ",
    APNS_TEAM_ID: "SFTT38V54H",
    APNS_TOPIC: "io.github.itsmattguenther.linger",
    FCM_SERVICE_ACCOUNT: JSON.stringify(account),
    SEAL_KEY: sealKey,
    SEND_LIMIT: sendLimit,
    SEAL_LIMIT: sealLimit,
  };
  asked = [];
  now = Date.UTC(2026, 10, 12, 12, 0, 0);
  credentials = new Credentials();
  answer = (url) => {
    if (url === TOKEN_URI) return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    return new Response(null, { status: 200 });
  };
});

function request(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://push.linger.im${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

const call = (req: Request) => handle(req, env, outside, credentials);

const APNS_ADDRESS = "ab".repeat(32);
const FCM_ADDRESS = "fYz1:APA91bH" + "x".repeat(140);
/** An encrypted notification, as the server sends one: base64url. */
const PAYLOAD = base64url(crypto.getRandomValues(new Uint8Array(400)));

async function sealed(service: "apns" | "apns_sandbox" | "fcm", address: string): Promise<string> {
  const res = await call(request("/seal", { service, address }));
  expect(res.status).toBe(200);
  const body: unknown = await res.json();
  const token: unknown = typeof body === "object" && body ? Reflect.get(body, "token") : null;
  if (typeof token !== "string") throw new Error("no token");
  return token;
}

/** A JWT's header and claims, after checking its signature with `key`. */
async function verified(jwt: string, key: CryptoKey, algorithm: Parameters<SubtleCrypto["verify"]>[0]): Promise<{
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}> {
  const [head, body, signature] = jwt.split(".");
  if (!head || !body || !signature) throw new Error("not a JWT");
  const ok = await crypto.subtle.verify(algorithm, key, fromBase64(signature) ?? new Uint8Array(), utf8(`${head}.${body}`));
  expect(ok, "the JWT is signed with the key").toBe(true);
  const decode = (part: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64(part) ?? new Uint8Array()));
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return Object.fromEntries(Object.entries(parsed));
  };
  return { header: decode(head), claims: decode(body) };
}

function parsed(body: string): Record<string, unknown> {
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null) throw new Error("not an object");
  return Object.fromEntries(Object.entries(value));
}

// ---------------------------------------------------------------------------
// Seal
// ---------------------------------------------------------------------------

describe("sealing", () => {
  it("seals an address so only this relay's key opens it, differently every time", async () => {
    const one = await sealed("apns", APNS_ADDRESS);
    const two = await sealed("apns", APNS_ADDRESS);
    expect(one).not.toBe(two);
    expect(one).not.toContain(APNS_ADDRESS);
    expect(one.length).toBeLessThanOrEqual(1024);
    expect(await open(sealKey, one)).toEqual({ service: "apns", address: APNS_ADDRESS });
    expect(await open(otherSealKey, one)).toBeNull();
    const fcm = await sealed("fcm", FCM_ADDRESS);
    expect(await open(sealKey, fcm)).toEqual({ service: "fcm", address: FCM_ADDRESS });
    // The longest address a phone may hand over still fits the server's 1,024.
    expect((await sealed("fcm", "a".repeat(512))).length).toBeLessThanOrEqual(1024);
    expect(asked).toEqual([]);
  });

  it("refuses what isn't a push address, a service it doesn't know, and other methods", async () => {
    for (const body of [
      { service: "apns", address: "not hex" },
      { service: "apns", address: "ab".repeat(10) },
      { service: "fcm", address: "has spaces in it, which no token does" },
      { service: "fcm", address: "a".repeat(513) },
      { service: "webpush", address: APNS_ADDRESS },
      { address: APNS_ADDRESS },
      "not json",
    ]) {
      expect((await call(request("/seal", body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(new Request("https://push.linger.im/seal"))).status).toBe(405);
    expect((await call(request("/seal", "x".repeat(MAX_BODY_BYTES + 1)))).status).toBe(413);
  });

  it("answers the phone app's own page and nobody else's", async () => {
    const preflight = (origin: string) =>
      call(new Request("https://push.linger.im/seal", { method: "OPTIONS", headers: { origin } }));
    const ok = await preflight("tauri://localhost");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
    expect((await preflight("https://elsewhere.example")).status).toBe(403);
    const fromApp = await call(
      request("/seal", { service: "apns", address: APNS_ADDRESS }, { headers: { origin: "http://tauri.localhost" } }),
    );
    expect(fromApp.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    const fromSite = await call(
      request("/seal", { service: "apns", address: APNS_ADDRESS }, { headers: { origin: "https://elsewhere.example" } }),
    );
    expect(fromSite.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("is limited per network address, which the limiter only sees hashed", async () => {
    sealLimit.allow = false;
    const res = await call(
      request("/seal", { service: "apns", address: APNS_ADDRESS }, { headers: { "cf-connecting-ip": "203.0.113.9" } }),
    );
    expect(res.status).toBe(429);
    expect(sealLimit.keys).toHaveLength(1);
    expect(sealLimit.keys[0]).not.toContain("203.0.113.9");
  });
});

// ---------------------------------------------------------------------------
// Send, to Apple
// ---------------------------------------------------------------------------

describe("sending to Apple", () => {
  it("hands Apple the notification as it came, signed with Linger's key, and no badge", async () => {
    const token = await sealed("apns", APNS_ADDRESS);
    const res = await call(request("/send", { token, payload: PAYLOAD, ttl: 86_400, collapse: "a1b2c3" }));
    expect(res.status).toBe(204);
    expect(asked).toHaveLength(1);
    const [sent] = asked;
    if (!sent) throw new Error("nothing sent");
    expect(sent.url).toBe(`https://api.push.apple.com/3/device/${APNS_ADDRESS}`);
    expect(sent.method).toBe("POST");
    expect(sent.headers["apns-topic"]).toBe("io.github.itsmattguenther.linger");
    expect(sent.headers["apns-push-type"]).toBe("alert");
    expect(sent.headers["apns-priority"]).toBe("10");
    expect(sent.headers["apns-expiration"]).toBe(String(now / 1000 + 86_400));
    expect(sent.headers["apns-collapse-id"]).toBe("a1b2c3");
    const jwt = sent.headers["authorization"]?.replace(/^bearer /, "") ?? "";
    const { header, claims } = await verified(jwt, apple.publicKey, { name: "ECDSA", hash: "SHA-256" });
    expect(header).toEqual({ alg: "ES256", kid: "FGGDB7SBQQ" });
    expect(claims).toEqual({ iss: "SFTT38V54H", iat: now / 1000 });
    const body = parsed(sent.body);
    expect(body["p"]).toBe(PAYLOAD);
    expect(body["aps"]).toEqual({ alert: FALLBACK, sound: "default", "mutable-content": 1 });
    expect(sent.body).not.toContain("badge");
    // The address and the words appear nowhere but where Apple needs them.
    expect(sent.body).not.toContain(APNS_ADDRESS);
  });

  it("sends a sandbox address to Apple's sandbox, and leaves the collapse key out when there's none", async () => {
    const token = await sealed("apns_sandbox", APNS_ADDRESS);
    expect((await call(request("/send", { token, payload: PAYLOAD, ttl: 0 }))).status).toBe(204);
    expect(asked[0]?.url).toBe(`https://api.sandbox.push.apple.com/3/device/${APNS_ADDRESS}`);
    expect(asked[0]?.headers["apns-collapse-id"]).toBeUndefined();
    expect(asked[0]?.headers["apns-expiration"]).toBe("0");
  });

  it("makes Apple's JWT once, again after 40 minutes, and again after Apple says it expired", async () => {
    const token = await sealed("apns", APNS_ADDRESS);
    const send = () => call(request("/send", { token, payload: PAYLOAD, ttl: 60 }));
    await send();
    now += 39 * 60_000;
    await send();
    expect(asked[1]?.headers["authorization"]).toBe(asked[0]?.headers["authorization"]);
    now += 2 * 60_000;
    await send();
    expect(asked[2]?.headers["authorization"]).not.toBe(asked[1]?.headers["authorization"]);

    answer = () => Response.json({ reason: "ExpiredProviderToken" }, { status: 403 });
    now += 1000;
    expect((await send()).status).toBe(502);
    answer = () => new Response(null, { status: 200 });
    now += 1000;
    await send();
    expect(asked[4]?.headers["authorization"]).not.toBe(asked[3]?.headers["authorization"]);
  });

  it("tells the server a phone is gone only when Apple says so", async () => {
    const token = await sealed("apns", APNS_ADDRESS);
    const send = async (status: number, reason?: string) => {
      answer = () => (reason ? Response.json({ reason }, { status }) : new Response(null, { status }));
      return (await call(request("/send", { token, payload: PAYLOAD, ttl: 60 }))).status;
    };
    expect(await send(410, "Unregistered")).toBe(410);
    expect(await send(400, "BadDeviceToken")).toBe(410);
    expect(await send(400, "DeviceTokenNotForTopic")).toBe(410);
    expect(await send(400, "PayloadTooLarge")).toBe(502);
    expect(await send(429, "TooManyRequests")).toBe(502);
    expect(await send(500)).toBe(502);
    answer = () => {
      throw new TypeError("network down");
    };
    expect((await call(request("/send", { token, payload: PAYLOAD, ttl: 60 }))).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Send, to Google
// ---------------------------------------------------------------------------

describe("sending to Google", () => {
  it("signs in with the service account once, and sends a data message the app shows itself", async () => {
    const token = await sealed("fcm", FCM_ADDRESS);
    const send = () => call(request("/send", { token, payload: PAYLOAD, ttl: 86_400, collapse: "c0ffee" }));
    expect((await send()).status).toBe(204);
    expect((await send()).status).toBe(204);
    const tokenAsks = asked.filter((a) => a.url === TOKEN_URI);
    expect(tokenAsks, "one sign-in for both").toHaveLength(1);

    const form = new URLSearchParams(tokenAsks[0]?.body ?? "");
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const { header, claims } = await verified(form.get("assertion") ?? "", google.publicKey, "RSASSA-PKCS1-v1_5");
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims).toEqual({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: TOKEN_URI,
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });

    const sends = asked.filter((a) => a.url !== TOKEN_URI);
    expect(sends).toHaveLength(2);
    expect(sends[0]?.url).toBe("https://fcm.googleapis.com/v1/projects/linger-test/messages:send");
    expect(sends[0]?.headers["authorization"]).toBe("Bearer ya29.test");
    expect(parsed(sends[0]?.body ?? "{}")).toEqual({
      message: {
        token: FCM_ADDRESS,
        data: { p: PAYLOAD },
        android: { priority: "HIGH", ttl: "86400s", collapse_key: "c0ffee" },
      },
    });
  });

  it("signs in again when Google's token is about to end", async () => {
    const token = await sealed("fcm", FCM_ADDRESS);
    const send = () => call(request("/send", { token, payload: PAYLOAD, ttl: 60 }));
    await send();
    now += 54 * 60_000;
    await send();
    expect(asked.filter((a) => a.url === TOKEN_URI)).toHaveLength(1);
    now += 2 * 60_000;
    await send();
    expect(asked.filter((a) => a.url === TOKEN_URI)).toHaveLength(2);
  });

  it("tells the server a phone is gone only when Google says the address is", async () => {
    const token = await sealed("fcm", FCM_ADDRESS);
    const send = async (status: number, details: unknown[]) => {
      answer = (url) =>
        url === TOKEN_URI
          ? Response.json({ access_token: "ya29.test", expires_in: 3600 })
          : Response.json({ error: { code: status, details } }, { status });
      return (await call(request("/send", { token, payload: PAYLOAD, ttl: 60 }))).status;
    };
    expect(await send(404, [{ errorCode: "UNREGISTERED" }])).toBe(410);
    expect(await send(403, [{ errorCode: "SENDER_ID_MISMATCH" }])).toBe(410);
    expect(await send(400, [{ errorCode: "INVALID_ARGUMENT" }, { fieldViolations: [{ field: "message.token" }] }])).toBe(410);
    expect(await send(400, [{ errorCode: "INVALID_ARGUMENT" }, { fieldViolations: [{ field: "message.data" }] }])).toBe(502);
    expect(await send(429, [{ errorCode: "QUOTA_EXCEEDED" }])).toBe(502);
    expect(await send(503, [])).toBe(502);
  });

  it("can't sign in, and says so as a failure, not a gone phone", async () => {
    const token = await sealed("fcm", FCM_ADDRESS);
    answer = () => new Response(null, { status: 401 });
    expect((await call(request("/send", { token, payload: PAYLOAD, ttl: 60 }))).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// What a send has to be
// ---------------------------------------------------------------------------

describe("what the relay takes", () => {
  it("refuses a notification that isn't the shape the server sends", async () => {
    const token = await sealed("apns", APNS_ADDRESS);
    for (const body of [
      "not json",
      { token, ttl: 60 },
      { token, payload: "", ttl: 60 },
      { token, payload: "has+plus/and=pad", ttl: 60 },
      { token, payload: "x".repeat(3073), ttl: 60 },
      { token, payload: PAYLOAD },
      { token, payload: PAYLOAD, ttl: -1 },
      { token, payload: PAYLOAD, ttl: 1.5 },
      { token, payload: PAYLOAD, ttl: 28 * 24 * 60 * 60 + 1 },
      { token, payload: PAYLOAD, ttl: 60, collapse: "has spaces" },
      { token, payload: PAYLOAD, ttl: 60, collapse: "x".repeat(65) },
      { token: "x".repeat(1025), payload: PAYLOAD, ttl: 60 },
      { payload: PAYLOAD, ttl: 60 },
    ]) {
      expect((await call(request("/send", body))).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await call(request("/send", "x".repeat(MAX_BODY_BYTES + 1)))).status).toBe(413);
    expect(asked).toEqual([]);
  });

  it("refuses a body longer than it may be, even one that doesn't say how long it is", async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    });
    // Node wants `duplex` for a streamed body; a variable skips the check
    // that the Workers types don't know it.
    const init = { method: "POST", body: endless, duplex: "half" };
    const req = new Request("https://push.linger.im/send", init);
    expect((await call(req)).status).toBe(413);
  });

  it("says a token it can't open is gone, so the phone registers again", async () => {
    const token = await sealed("apns", APNS_ADDRESS);
    const elsewhere = await seal(otherSealKey, { service: "apns", address: APNS_ADDRESS });
    const changed = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    for (const bad of [elsewhere, changed, "v2.whatever", "not a token"]) {
      expect((await call(request("/send", { token: bad, payload: PAYLOAD, ttl: 60 }))).status, bad.slice(0, 20)).toBe(410);
    }
    expect(asked).toEqual([]);
  });

  it("is limited per phone, which the limiter only sees hashed, and asks nobody when it is", async () => {
    const token = await sealed("apns", APNS_ADDRESS);
    sendLimit.allow = false;
    expect((await call(request("/send", { token, payload: PAYLOAD, ttl: 60 }))).status).toBe(429);
    expect(sendLimit.keys).toHaveLength(1);
    expect(sendLimit.keys[0]).not.toContain(token.slice(3, 20));
    expect(asked).toEqual([]);
  });

  it("answers nothing else", async () => {
    expect((await call(new Request("https://push.linger.im/"))).status).toBe(404);
    expect((await call(new Request("https://push.linger.im/send"))).status).toBe(405);
  });

  it("says nothing about why when a secret is missing", async () => {
    env = { ...env, SEAL_KEY: "" };
    const res = await call(request("/seal", { service: "apns", address: APNS_ADDRESS }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("SEAL_KEY");
  });
});
