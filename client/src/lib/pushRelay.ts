/**
 * Sealing this phone's push address with the relay (#830, PROTOCOL §5, "The
 * relay"): the one place the page talks to anything but the servers it's
 * signed in to.
 *
 * It talks only to the relay a signed-in server names (`GET /server`'s
 * `push_relay`), only when somebody turns phone notifications on or the
 * phone registers again, and sends it only the push address Apple or Google
 * gave this app. What comes back is a sealed token only that relay can open,
 * which the phone gives its servers instead of the address, so no host ever
 * sees where the phone is. `privacy.test.ts` checks nothing else here fetches.
 */
import type { PushService } from "../generated/PushService";
import type { SealRequest } from "../generated/SealRequest";

/** A relay address the way the server says it: https, no query, no fragment, no trailing slash. */
export function relayAddress(relay: string): string | null {
  const trimmed = relay.trim().replace(/\/+$/, "");
  return /^https:\/\/[^/?#\s@]+(\/[^?#\s]*)?$/.test(trimmed) ? trimmed : null;
}

/** Seal `address` with `relay`, or throw an Error that says what went wrong, in words. */
export async function sealAddress(relayUrl: string, service: PushService, address: string): Promise<string> {
  const relay = relayAddress(relayUrl);
  if (relay === null) throw new Error("This server names a relay that isn't an https address.");
  const request: SealRequest = { service, address };
  let response: Response;
  try {
    response = await fetch(`${relay}/seal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    throw new Error("Couldn't reach Linger's push relay. Check the phone is online.");
  }
  if (response.status === 429) throw new Error("Linger's push relay is busy. Try again in a minute.");
  if (!response.ok) throw new Error("Linger's push relay didn't take this phone's address.");
  const body: unknown = await response.json().catch(() => null);
  const token: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "token") : null;
  if (typeof token !== "string" || token.length === 0) throw new Error("Linger's push relay answered something unexpected.");
  return token;
}
