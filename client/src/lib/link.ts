/**
 * Reading what someone pasted into the "server or invite link" box.
 *
 * There is one box because there is one thing a person has: a link a friend
 * sent them, or the address of a server they already have an account on. Making
 * them classify it first would be asking them to do the computer's job.
 *
 * Three shapes are understood, all of them anchored on a server origin:
 *
 *   https://linger.example/setup?token=…   the one-time first-run link the
 *                                          server prints to its console
 *   https://linger.example/invite/CODE     an invite (also accepts ?code=CODE)
 *   linger.example                         just a server, for signing in
 */

export type PastedLink =
  | { kind: "setup"; baseUrl: string; token: string }
  | { kind: "invite"; baseUrl: string; code: string }
  | { kind: "server"; baseUrl: string };

/**
 * A hostname as the URL parser leaves it: letters, digits, dots, dashes and
 * underscores (international names arrive as `xn--`), or a bracketed IPv6
 * address. Parsers differ on the rest, so the rest is refused.
 */
const HOST = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|\[[0-9a-f:.]+\])$/i;

/**
 * Bare hostnames get `https://`. Anything already carrying a scheme keeps it,
 * so `http://localhost:8080` still works for a server on your own machine.
 */
function toUrl(raw: string): URL | null {
  const text = raw.trim();
  // A link never has a space in it; a sentence does. Chromium (and so
  // WebView2) would otherwise read "not a link" as the host `not%20a%20link`.
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!HOST.test(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function parsePastedLink(raw: string): PastedLink | null {
  const url = toUrl(raw);
  if (!url) return null;

  const baseUrl = url.origin;
  const segments = url.pathname.split("/").filter((part) => part.length > 0);

  if (segments[0] === "setup") {
    const token = url.searchParams.get("token") ?? segments[1] ?? "";
    if (token) return { kind: "setup", baseUrl, token };
  }

  if (segments[0] === "invite") {
    const code = url.searchParams.get("code") ?? segments[1] ?? "";
    if (code) return { kind: "invite", baseUrl, code };
  }

  return { kind: "server", baseUrl };
}

/** What to show as the server's name before we've asked it: its hostname. */
export function hostOf(baseUrl: string): string {
  const url = toUrl(baseUrl);
  return url ? url.host : baseUrl;
}
