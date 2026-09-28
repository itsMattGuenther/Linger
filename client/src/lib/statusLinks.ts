/**
 * The web addresses in a status field's value (#270, SPEC §4.6).
 *
 * A value is plain words. The only thing in it that becomes a link is a web
 * address, and it opens in the person's browser exactly as a link in a
 * message does (`lib/external.ts`): nothing else is read out of it, so no
 * markdown, no mentions, no `mailto:`.
 *
 * Two shapes are addresses:
 *
 * - **Typed out in full,** `https://…` or `http://…`: the same match, the
 *   same trimming of the sentence around it, and the same `safeHref` gate as
 *   a message (`markdown.ts::autolinkAt`).
 * - **A bare name with somewhere to go,** like `github.com/bendthebracket`
 *   or `www.example.com`: a host name that ends in a word of letters (the
 *   `.com`), followed by a path, or starting with `www.`. It opens over
 *   https. A bare name alone, like `main.rs` or `Node.js`, stays words: it
 *   looks exactly like a file or a library, and a link to wherever that
 *   happens to be registered is worse than no link. Typing `https://` in
 *   front makes any address a link.
 */
import { autolinkAt, safeHref, trimAddress } from "./markdown";

export type ValuePart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

/**
 * A host name, then an optional port and path. Labels are letters, digits
 * and inner hyphens (international names written as `xn--`), and the last
 * one is letters only, so `v1.2/3` and `3.14/pi` aren't addresses.
 */
const BARE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>]*)?/i;

/** Letters, digits and underscore, in any script: the inside of a word. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * A bare address at `at` that has a path or starts with `www.`, or null.
 *
 * It starts a word, and not after the parts of an address or a path, so
 * `me@example.com/x`, `src/main.rs` and the `b.com` of `a.b.com` aren't read
 * from the middle.
 */
function bareAt(source: string, at: number): { href: string; text: string } | null {
  const before = source[at - 1];
  if (before !== undefined && "@./:-~%+=&#".includes(before)) return null;
  const found = BARE.exec(source.slice(at));
  if (!found) return null;
  // Followed straight on by a letter or digit the pattern can't take
  // (`github.com9`, `example.café`), it's part of a longer word.
  if (isWordChar(source[at + found[0].length])) return null;
  const text = trimAddress(found[0]);
  const host = /^[^/:]+/.exec(text)?.[0] ?? "";
  const hasPath = text.length > host.length && text.slice(host.length).replace(/^:\d+/, "").startsWith("/");
  if (!hasPath && !/^www\./i.test(text)) return null;
  // A host must still end in its letters once the sentence is trimmed off.
  if (!/\.[a-z]{2,63}$/i.test(host)) return null;
  const href = safeHref(`https://${text}`);
  return href === null ? null : { href, text };
}

/**
 * A value cut into words and addresses, in order. Joined back together, the
 * parts are exactly the value.
 */
export function valueParts(value: string): ValuePart[] {
  const parts: ValuePart[] = [];
  let plain = "";
  let at = 0;
  while (at < value.length) {
    // A message's rule for where an address starts: not inside a word.
    const found = isWordChar(value[at - 1]) ? null : (autolinkAt(value, at) ?? bareAt(value, at));
    if (found !== null) {
      if (plain !== "") parts.push({ kind: "text", text: plain });
      plain = "";
      parts.push({ kind: "link", text: found.text, href: found.href });
      at += found.text.length;
      continue;
    }
    plain += value[at];
    at += 1;
  }
  if (plain !== "") parts.push({ kind: "text", text: plain });
  return parts;
}
