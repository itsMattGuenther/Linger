/**
 * Markdown for message bodies.
 *
 * This parser produces a *tree*, never a string of HTML, and that is the whole
 * security design (ARCHITECTURE §7: "allowlist-based sanitizer, no raw HTML
 * passthrough, ever"). The node kinds below are a closed union; `MarkdownBody.tsx`
 * switches over them and hands text to React as text. There is no
 * `dangerouslySetInnerHTML` anywhere in the client and no code path that turns
 * a message body into markup, so a body containing `<img onerror=…>` is a body
 * containing those characters — it renders as the characters and does nothing.
 * An allowlist you cannot get past is better than a denylist you have to keep
 * ahead of.
 *
 * The one place a message body reaches an *attribute* is a link's `href`, which
 * is why `safeHref` exists and why it is the only way a link node is ever
 * built. `javascript:` and `data:` never survive it.
 *
 * The subset is deliberately small — chat, not documentation. Bold, italic,
 * strikethrough, inline code, fenced code, blockquotes, bullet and numbered
 * lists, links, and backslash escapes. No headings, no tables, no images (there
 * is nothing to point one at until uploads land in M5), no raw HTML.
 *
 * It is not CommonMark and does not try to be. CommonMark's emphasis rules are
 * a specification unto themselves, and the cases where this parser differs —
 * emphasis whose delimiters straddle a code span, mostly — are cases nobody
 * types on purpose. The rule followed instead is that anything ambiguous stays
 * literal text: a `*` with no partner is a `*`.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  /** `href` has already been through `safeHref`; `title` is the real target. */
  | { kind: "link"; href: string; text: string; children: Inline[] }
  /**
   * `@someone`. The parser does not know who is on this server, so it records
   * the handle and stops there — `MarkdownBody.tsx` is where a handle either
   * resolves to a person or falls back to the characters that were typed.
   */
  | { kind: "mention"; handle: string };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "quote"; children: Block[] }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] };

/**
 * How deep nesting is allowed to go. Both caps exist because the input is
 * hostile: `>>>>>>…` a thousand deep, or `****…`, would otherwise be a stack
 * overflow anybody could type into a room.
 */
const MAX_BLOCK_DEPTH = 4;
const MAX_INLINE_DEPTH = 6;

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*\S*\s*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^ {0,3}[-*+] +(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)] +(.*)$/;

/** Characters a backslash can make literal. The CommonMark set, minus the
 *  punctuation this subset never gives meaning to. */
const ESCAPABLE = "\\`*_~[]()>#+-.!@";

/** Schemes a link may use. Everything else renders as plain text. */
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * The single gate between a message body and a link target.
 *
 * `new URL` is the parser the browser itself uses, so tricks that only work
 * because a hand-rolled check disagreed with the browser — a newline inside
 * `java\nscript:`, leading whitespace, mixed case — are normalised here and
 * then rejected on the scheme. Relative URLs fail to parse at all, which is
 * correct: there is nowhere in this app for one to point.
 */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Parse one message body. Always returns something; never throws. */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.split("\n"), 0);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function startsBlock(line: string): boolean {
  return FENCE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line);
}

function parseBlocks(lines: readonly string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let at = 0;

  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const opener = fence[1] ?? "```";
      const body: string[] = [];
      at += 1;
      // An unclosed fence runs to the end of the message. That is the standard
      // reading and it is also the kind one: someone who opened a code block
      // and hit send meant everything after it to be code.
      while (at < lines.length) {
        const close = FENCE_CLOSE.exec(lines[at] ?? "");
        const marker = close?.[1];
        if (marker !== undefined && marker[0] === opener[0] && marker.length >= opener.length) {
          at += 1;
          break;
        }
        body.push(lines[at] ?? "");
        at += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? "")) {
        inner.push((lines[at] ?? "").replace(QUOTE, ""));
        at += 1;
      }
      if (depth >= MAX_BLOCK_DEPTH) {
        blocks.push({ kind: "paragraph", children: parseInline(inner.join("\n"), 0) });
      } else {
        blocks.push({ kind: "quote", children: parseBlocks(inner, depth + 1) });
      }
      continue;
    }

    if (BULLET.test(line)) {
      const items: Inline[][] = [];
      while (at < lines.length) {
        const item = BULLET.exec(lines[at] ?? "");
        if (!item) break;
        items.push(parseInline(item[1] ?? "", 0));
        at += 1;
      }
      blocks.push({ kind: "list", ordered: false, start: 1, items });
      continue;
    }

    const first = NUMBERED.exec(line);
    if (first) {
      const items: Inline[][] = [];
      // A list that starts at 7 keeps starting at 7; the numbers after it are
      // the browser's business, the same as in a document.
      const start = Number.parseInt(first[1] ?? "1", 10);
      while (at < lines.length) {
        const item = NUMBERED.exec(lines[at] ?? "");
        if (!item) break;
        items.push(parseInline(item[2] ?? "", 0));
        at += 1;
      }
      blocks.push({ kind: "list", ordered: true, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (at < lines.length) {
      const candidate = lines[at] ?? "";
      if (candidate.trim() === "" || startsBlock(candidate)) break;
      paragraph.push(candidate);
      at += 1;
    }
    // Single newlines inside a paragraph are kept as newlines rather than
    // becoming a `<br>`, because the body renders with `white-space: pre-wrap`.
    // That way the indentation someone typed survives too — which markdown
    // would otherwise eat, and which is half of why people paste text into a
    // chat window at all.
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join("\n"), 0) });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/**
 * Openers, longest first: `**` has to be tried before `*` or every bold run
 * would come out as an italic containing a stray asterisk.
 */
const EMPHASIS: readonly { open: string; kind: "strong" | "em" | "strike" }[] = [
  { open: "~~", kind: "strike" },
  { open: "**", kind: "strong" },
  { open: "__", kind: "strong" },
  { open: "*", kind: "em" },
  { open: "_", kind: "em" },
];

const AUTOLINK = /^https?:\/\/[^\s<>]+/i;

/**
 * `@someone`, using the username shape the server enforces
 * (`crates/linger-server/src/validate.rs`: `[a-z0-9_]{2,24}`). Usernames are
 * lowercase and the server rejects rather than normalizes, so `@Matt` is not a
 * mention of `matt` — it is the word somebody typed.
 */
const MENTION = /^@([a-z0-9_]{2,24})/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

function runLength(source: string, at: number, ch: string): number {
  let length = 0;
  while (source[at + length] === ch) length += 1;
  return length;
}

/** The next run of exactly `length` `ch`s at or after `from`, or -1. */
function findRun(source: string, from: number, ch: string, length: number): number {
  for (let at = from; at < source.length; at += 1) {
    if (source[at] !== ch) continue;
    const run = runLength(source, at, ch);
    if (run === length) return at;
    at += run - 1;
  }
  return -1;
}

interface Match {
  node: Inline;
  next: number;
}

function parseInline(source: string, depth: number): Inline[] {
  const nodes: Inline[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") {
      nodes.push({ kind: "text", text: plain });
      plain = "";
    }
  };

  let at = 0;
  while (at < source.length) {
    const ch = source[at] ?? "";

    if (ch === "\\") {
      const escaped = source[at + 1];
      if (escaped !== undefined && ESCAPABLE.includes(escaped)) {
        plain += escaped;
        at += 2;
        continue;
      }
    }

    // Code first, and always: whatever is inside a code span is characters,
    // not markup, and that has to be true before any other rule gets a look.
    if (ch === "`") {
      const found = matchCode(source, at);
      if (found) {
        flush();
        nodes.push(found.node);
        at = found.next;
        continue;
      }
    }

    if (ch === "[" && depth < MAX_INLINE_DEPTH) {
      const found = matchLink(source, at, depth);
      if (found) {
        flush();
        nodes.push(found.node);
        at = found.next;
        continue;
      }
    }

    if (depth < MAX_INLINE_DEPTH) {
      const found = matchEmphasis(source, at, depth);
      if (found) {
        flush();
        nodes.push(found.node);
        at = found.next;
        continue;
      }
    }

    if ((ch === "h" || ch === "H") && !isWordChar(source[at - 1])) {
      const found = matchAutolink(source, at);
      if (found) {
        flush();
        nodes.push(found.node);
        at = found.next;
        continue;
      }
    }

    if (ch === "@") {
      const found = matchMention(source, at);
      if (found) {
        flush();
        nodes.push(found.node);
        at = found.next;
        continue;
      }
    }

    plain += ch;
    at += 1;
  }

  flush();
  return nodes;
}

function matchCode(source: string, at: number): Match | null {
  const run = runLength(source, at, "`");
  const close = findRun(source, at + run, "`", run);
  if (close < 0) return null;
  let text = source.slice(at + run, close);
  // One space either side is the delimiter's, not the code's — it is how you
  // write a span that itself starts or ends with a backtick.
  if (text.length > 2 && text.startsWith(" ") && text.endsWith(" ")) text = text.slice(1, -1);
  return { node: { kind: "code", text }, next: close + run };
}

/** Scan forward from an opening bracket to its partner, honouring nesting. */
function matchBracket(source: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchLink(source: string, at: number, depth: number): Match | null {
  const labelEnd = matchBracket(source, at, "[", "]");
  if (labelEnd < 0 || source[labelEnd + 1] !== "(") return null;
  const targetEnd = matchBracket(source, labelEnd + 1, "(", ")");
  if (targetEnd < 0) return null;

  // A refused scheme is not an error and not a stripped tag: the whole thing
  // stays on screen as the characters that were typed, so the person reading
  // can see exactly what they were sent.
  const href = safeHref(source.slice(labelEnd + 2, targetEnd));
  if (href === null) return null;

  const label = source.slice(at + 1, labelEnd);
  return {
    node: { kind: "link", href, text: label, children: parseInline(label, depth + 1) },
    next: targetEnd + 1,
  };
}

function matchAutolink(source: string, at: number): Match | null {
  const found = AUTOLINK.exec(source.slice(at));
  if (!found) return null;
  let raw = found[0];

  // Sentence punctuation is the sentence's. `look at https://linger.example.`
  // ends in a full stop, and the full stop is not part of the address.
  while (raw.length > 0 && ".,;:!?'\"".includes(raw[raw.length - 1] ?? "")) {
    raw = raw.slice(0, -1);
  }
  // A closing paren is only the URL's if the URL opened one — `(see
  // https://linger.example)` versus a Wikipedia article about a disambiguation.
  while (raw.endsWith(")") && countOf(raw, ")") > countOf(raw, "(")) {
    raw = raw.slice(0, -1);
  }

  // `https://` with nothing after it fails to parse, which is the answer we
  // want anyway: it is not an address.
  const href = safeHref(raw);
  if (href === null) return null;
  return {
    node: { kind: "link", href, text: raw, children: [{ kind: "text", text: raw }] },
    next: at + raw.length,
  };
}

/**
 * A mention, or nothing.
 *
 * Two boundaries, both there to stop a notification landing on the wrong
 * person. A mention starts a word, so `you@example.com` is an address. And the
 * handle has to *end* a word, so `@matthews` is not a mention of `matt` — the
 * pattern would happily stop short otherwise.
 */
function matchMention(source: string, at: number): Match | null {
  if (isWordChar(source[at - 1])) return null;
  const found = MENTION.exec(source.slice(at));
  const handle = found?.[1];
  if (handle === undefined) return null;
  const next = at + 1 + handle.length;
  if (isWordChar(source[next])) return null;
  return { node: { kind: "mention", handle }, next };
}

function countOf(text: string, ch: string): number {
  let total = 0;
  for (const found of text) if (found === ch) total += 1;
  return total;
}

function matchEmphasis(source: string, at: number, depth: number): Match | null {
  for (const { open, kind } of EMPHASIS) {
    if (!source.startsWith(open, at)) continue;

    // Underscores only open a span at a word boundary, so `snake_case_name`
    // and `__init__` stay the identifiers somebody meant to type.
    const underscore = open.startsWith("_");
    if (underscore && isWordChar(source[at - 1])) continue;

    const from = at + open.length;
    // No span opens on whitespace: `2 * 3 * 4` is arithmetic.
    const opening = source[from];
    if (opening === undefined || /\s/.test(opening)) continue;

    let close = source.indexOf(open, from + 1);
    while (close >= 0) {
      const before = source[close - 1];
      const after = source[close + open.length];
      const closes =
        before !== undefined && !/\s/.test(before) && (!underscore || !isWordChar(after));
      if (closes) break;
      close = source.indexOf(open, close + 1);
    }
    if (close < 0) continue;

    return {
      node: { kind, children: parseInline(source.slice(from, close), depth + 1) },
      next: close + open.length,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * A message body as one line of plain text, with the markdown taken off.
 *
 * This is for the places a body has to be *mentioned* rather than shown — the
 * line quoting what you are replying to, and (T-305) a notification. Running it
 * through the same parser rather than a regex means the two can never disagree
 * about what a body says.
 */
export function plainText(source: string): string {
  return flattenBlocks(parseMarkdown(source)).replace(/\s+/g, " ").trim();
}

function flattenBlocks(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
          return flattenInline(block.children);
        case "quote":
          return flattenBlocks(block.children);
        case "code":
          return block.text;
        case "list":
          return block.items.map(flattenInline).join(" ");
      }
    })
    .join(" ");
}

function flattenInline(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "mention":
          return `@${node.handle}`;
        case "link":
          return flattenInline(node.children);
        case "strong":
        case "em":
        case "strike":
          return flattenInline(node.children);
      }
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/**
 * Every handle a body mentions, in the order they appear, each one once.
 *
 * This walks the parsed tree rather than scanning the text, so what earns
 * somebody a notification is exactly what draws a mention on screen. It is the
 * difference that matters: `` `@matt` `` is a code span, so it is not a mention,
 * and no regex over the raw body would know that.
 */
export function mentionHandles(source: string): string[] {
  const found: string[] = [];
  collectBlocks(parseMarkdown(source), found, "mention");
  return [...new Set(found)];
}

/**
 * Mirrors `linger-core::limits::MAX_LINKS_PER_MESSAGE`. A message with a dozen
 * URLs in it is a link dump, and a dozen one-line cards under it is a wall.
 */
const MAX_LINK_CARDS = 4;

/**
 * Every web address a body links to, in order, each one once, at most four.
 *
 * The same walk as `mentionHandles` and for the same reason: what gets a card
 * is exactly what draws as a link, so `` `https://x` `` in a code span gets
 * neither. `mailto:` is a link but not a page, so it has nothing to preview.
 *
 * The server extracts the same set when it records what a message links to
 * (`linger-server::links::extract`); both normalise through a URL parser, so
 * the string the card is keyed by is the same on both sides.
 */
export function linkTargets(source: string): string[] {
  const found: string[] = [];
  collectBlocks(parseMarkdown(source), found, "link");
  return [...new Set(found.filter((href) => /^https?:/i.test(href)))].slice(0, MAX_LINK_CARDS);
}

type Want = "mention" | "link";

function collectBlocks(blocks: readonly Block[], into: string[], want: Want): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
        collectInline(block.children, into, want);
        break;
      case "quote":
        collectBlocks(block.children, into, want);
        break;
      case "code":
        break;
      case "list":
        for (const item of block.items) collectInline(item, into, want);
        break;
    }
  }
}

function collectInline(nodes: readonly Inline[], into: string[], want: Want): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "mention":
        if (want === "mention") into.push(node.handle);
        break;
      case "link":
        if (want === "link") into.push(node.href);
        collectInline(node.children, into, want);
        break;
      case "strong":
      case "em":
      case "strike":
        collectInline(node.children, into, want);
        break;
      case "text":
      case "code":
        break;
    }
  }
}
