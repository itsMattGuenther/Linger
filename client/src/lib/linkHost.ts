/**
 * Where a link really goes, when its words say somewhere else (#580).
 *
 * A link in a message draws whatever words its sender wrote, so
 * `[www.paypal.com](https://evil.example)` reads as paypal.com and opens
 * evil.example. Pointing at a link has always shown the real address (its
 * `title`), but a phone can't point. So when a link's words are themselves an
 * address or a domain, and the link goes to another site, the real site is
 * drawn beside the words. Ordinary words ("the menu") are left alone: they
 * make no claim about where they go.
 *
 * Hosts are compared the way the URL parser reads them, never by how they
 * look: letters from another alphabet that pass for Latin ones (`pаypal.com`
 * with a Cyrillic `а`) don't match the Latin name, and the real site is
 * shown as the computer reads it (`xn--pypal-4ve.com`).
 */

import { trimAddress } from "./markdown";

/** An address typed with its scheme: `https://…`. */
const WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Words that read as a bare domain, maybe with a port and a path:
 * `paypal.com`, `www.paypal.com:8443/login`. At least one dot, no spaces.
 */
const BARE_DOMAIN = /^[^\s/?#@:\\]+\.[^\s/?#@:.\\]+(?::\d{1,5})?(?:[/?#]\S*)?$/u;

/** The last label of a name: letters in any alphabet, two or more, or an `xn--` name. */
const TOP_LABEL = /^(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu;

/** Four numbers with dots, as people write an IPv4 address. */
const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * The host a link really goes to, when its `words` name a different one, or
 * null when there's nothing to say: the words aren't an address, the link
 * isn't to a web page, or the words name the same site.
 *
 * The same site is the same host once a leading `www.` is dropped, or one
 * host inside the other at a dot (`login.paypal.com` and `paypal.com`), so
 * `paypal.com.evil.example` is not paypal.com.
 */
export function disguisedHost(words: string, href: string): string | null {
  const real = webHost(href);
  if (real === null) return null;
  const said = wordsHost(words);
  if (said === null) return null;
  // `user@host` in an address is a classic disguise: the words show the
  // part before the `@`, and the browser goes to the part after it.
  if (said.userinfo) return real;
  // Written in letters the computer doesn't read them as: whatever they
  // look like, the real name is the `xn--` one, so it is shown.
  if (!isAscii(said.typed)) return real;
  return sameSite(said.host, real) ? null : real;
}

/** The host of a web link, as the URL parser reads it, or null for anything else. */
function webHost(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

/**
 * The host the words name, when they read as an address or a domain: the
 * parser's reading of it, the letters as typed, and whether a `user@` came
 * before it.
 */
function wordsHost(words: string): { host: string; typed: string; userinfo: boolean } | null {
  // Full stops from other alphabets (`paypal。com`) are read as dots by the
  // URL parser, so they are here too.
  const text = trimAddress(words.trim()).replace(/[\u3002\uff0e\uff61]/gu, ".");
  if (text === "" || /\s/u.test(text)) return null;

  let authority: string;
  let url: URL;
  if (WITH_SCHEME.test(text)) {
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    authority = text.slice(text.indexOf("//") + 2).split(/[/?#\\]/u)[0] ?? "";
  } else if (BARE_DOMAIN.test(text)) {
    try {
      url = new URL(`https://${text}`);
    } catch {
      return null;
    }
    authority = text.split(/[/?#]/u)[0] ?? "";
  } else {
    return null;
  }

  const at = authority.lastIndexOf("@");
  const userinfo = at >= 0;
  const typed = (userinfo ? authority.slice(at + 1) : authority).replace(/:\d*$/u, "").toLowerCase();
  // A name with a dot and a real-looking last part, or an IPv4 address
  // written out: `3.14` and `v1.2` are numbers, not places.
  const labels = typed.replace(/\.$/u, "").split(".");
  const top = labels[labels.length - 1] ?? "";
  if (labels.length < 2 || !(DOTTED_QUAD.test(typed) || TOP_LABEL.test(top))) return null;
  if (!url.hostname) return null;
  return { host: url.hostname, typed, userinfo };
}

function sameSite(a: string, b: string): boolean {
  const left = bare(a);
  const right = bare(b);
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/** A host without a leading `www.` or a trailing dot. */
function bare(host: string): string {
  return host.replace(/\.$/u, "").replace(/^www\./u, "");
}

function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/u.test(text);
}
