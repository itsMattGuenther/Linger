import { type MouseEvent, type ReactNode, memo, useMemo, useState } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import { disguisedHost } from "../../../lib/linkHost";
import { type Block, type Inline, flattenInline, parseMarkdown } from "../../../lib/markdown";
import { type FoundTime, findTimes, forYou } from "../../../lib/writtenTime";
import { TooltipBubble } from "../../kit";
import "./MessageText.css";
import { useEmojiIndex } from "./useEmojiIndex";

/**
 * Who a `@handle` is, or null when nobody here answers to it (the characters
 * that were typed are drawn instead). Asked on every draw, so a changed
 * display name shows in old messages too.
 */
export type MentionLookup = (handle: string) => { name: string; me: boolean } | null;

/** The message's own server's emoji, by name (#359). */
export type CustomEmojiByName = ReadonlyMap<string, CustomEmoji>;

/** What a `:name:` draws as: a server's picture, a Unicode emoji, or the characters typed. */
type EmojiFound = { kind: "custom"; emoji: CustomEmoji } | { kind: "unicode"; glyph: string } | null;

const NO_EMOJI: CustomEmojiByName = new Map();

/** A message this many emoji or fewer, and nothing else, is drawn big, as Discord does. */
const JUMBO_MAX = 27;
/** One emoji, as it's typed: a pictograph with its modifiers, a flag, a keycap. */
const EMOJI_RUN =
  /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu;

/**
 * A message body, drawn from the parsed tree (`lib/markdown.ts`). Every node
 * kind gets exactly one element and text goes in as a React child, so a
 * message can never become markup: there is no raw HTML anywhere in the
 * client (ARCHITECTURE §7). Mono is for code only (AGENTS rule 11).
 *
 * Links never open in the app: a click is handed to `onOpenLink`, which sends
 * it to the system browser. `trailing` rides inside the last paragraph, so a
 * small "edited" stays on the words' last line.
 *
 * With `writtenAt`, a time written with a zone ("8PM CDT") is read in the
 * reader's own clock, placed on the day the words were written (#584).
 */
export const MessageText = memo(function MessageText({
  source,
  mentions,
  emoji: custom = NO_EMOJI,
  onOpenLink,
  trailing,
  writtenAt,
}: {
  source: string;
  mentions: MentionLookup;
  /** The message's server's own emoji (#359), drawn for their `:name:`. */
  emoji?: CustomEmojiByName;
  onOpenLink: (href: string) => void;
  trailing?: ReactNode;
  /** When the words were written, in milliseconds: the day their times fall on. */
  writtenAt?: number;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  // The emoji list loads only for a message that names one it might hold.
  const names = useMemo(() => shortcodeNames(blocks), [blocks]);
  const index = useEmojiIndex(names.some((name) => !custom.has(name)));
  const emojiOf = (name: string): EmojiFound => {
    const own = custom.get(name);
    if (own) return { kind: "custom", emoji: own };
    const glyph = index?.byShortcode.get(name)?.glyph;
    return glyph ? { kind: "unicode", glyph } : null;
  };
  const jumbo = isJumbo(blocks, emojiOf);
  const last = blocks.length - 1;
  const inline = trailing !== undefined && blocks[last]?.kind === "paragraph";
  const ctx: Ctx = { mentions, emojiOf, onOpenLink, writtenAt };
  return (
    <div className="nx-text" data-jumbo={jumbo ? "yes" : undefined}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} ctx={ctx} trailing={inline && index === last ? trailing : null} />
      ))}
      {inline ? null : trailing}
    </div>
  );
});

interface Ctx {
  mentions: MentionLookup;
  emojiOf: (name: string) => EmojiFound;
  onOpenLink: (href: string) => void;
  /** When the words were written; times are read only when it's known, and never in a link's words. */
  writtenAt: number | undefined;
}

/** Every `:name:` in the message, outside code. */
function shortcodeNames(blocks: readonly Block[]): string[] {
  const found: string[] = [];
  const walk = (nodes: readonly Inline[]) => {
    for (const node of nodes) {
      if (node.kind === "shortcode") found.push(node.name);
      else if (node.kind === "strong" || node.kind === "em" || node.kind === "strike" || node.kind === "link") walk(node.children);
    }
  };
  for (const block of blocks) {
    if (block.kind === "paragraph") walk(block.children);
    else if (block.kind === "list") block.items.forEach(walk);
    else if (block.kind === "quote") found.push(...shortcodeNames(block.children));
  }
  return found;
}

/**
 * A message that is only emoji, a few of them: one paragraph of emoji and
 * `:name:`s that are emoji, with nothing else but spaces.
 */
function isJumbo(blocks: readonly Block[], emojiOf: (name: string) => EmojiFound): boolean {
  const only = blocks.length === 1 ? blocks[0] : undefined;
  if (only?.kind !== "paragraph") return false;
  let count = 0;
  for (const node of only.children) {
    if (node.kind === "shortcode") {
      if (emojiOf(node.name) === null) return false;
      count += 1;
    } else if (node.kind === "text") {
      const runs = node.text.match(EMOJI_RUN) ?? [];
      if (node.text.replace(EMOJI_RUN, "").trim() !== "") return false;
      count += runs.length;
    } else {
      return false;
    }
  }
  return count > 0 && count <= JUMBO_MAX;
}

function BlockView({ block, ctx, trailing }: { block: Block; ctx: Ctx; trailing?: ReactNode }) {
  switch (block.kind) {
    case "paragraph":
      // With "edited" after them, the words are kept to themselves (#488): a
      // message may hold a character that turns the text after it around,
      // and it mustn't reach the mark.
      return (
        <p className="nx-text-p">
          {trailing ? (
            <span className="nx-text-words">
              <Inlines nodes={block.children} ctx={ctx} />
            </span>
          ) : (
            <Inlines nodes={block.children} ctx={ctx} />
          )}
          {trailing}
        </p>
      );
    case "quote":
      return (
        <blockquote className="nx-text-quote">
          {block.children.map((child, index) => (
            <BlockView key={index} block={child} ctx={ctx} />
          ))}
        </blockquote>
      );
    case "code":
      return (
        <pre className="nx-text-code">
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <Inlines nodes={item} ctx={ctx} />
        </li>
      ));
      return block.ordered ? (
        <ol className="nx-text-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="nx-text-list">{items}</ul>
      );
    }
  }
}

function Inlines({ nodes, ctx }: { nodes: readonly Inline[]; ctx: Ctx }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineView key={index} node={node} ctx={ctx} />
      ))}
    </>
  );
}

function InlineView({ node, ctx }: { node: Inline; ctx: Ctx }) {
  switch (node.kind) {
    case "text":
      return ctx.writtenAt === undefined ? <>{node.text}</> : <WrittenTimes text={node.text} writtenAt={ctx.writtenAt} />;
    case "mention": {
      // Read by the name people know (#267): "@Justin B", in the mention's
      // own highlight rather than their name's style, with the handle that
      // was typed, and is stored, in the tooltip.
      const person = ctx.mentions(node.handle);
      if (person === null) return <>@{node.handle}</>;
      return (
        <span className="nx-mention" data-me={person.me ? "yes" : undefined} title={`@${node.handle}`}>
          @{person.name}
        </span>
      );
    }
    case "shortcode": {
      // A server's picture, named for a screen reader and in the tooltip by
      // what was typed; a Unicode emoji typed by its name; or the characters.
      const found = ctx.emojiOf(node.name);
      if (found === null) return <>:{node.name}:</>;
      if (found.kind === "unicode") return <>{found.glyph}</>;
      return <img className="nx-emoji" src={found.emoji.url} alt={`:${node.name}:`} title={`:${node.name}:`} draggable={false} loading="lazy" decoding="async" />;
    }
    case "code":
      return <code className="nx-text-inline-code">{node.text}</code>;
    case "strong":
      return (
        <strong>
          <Inlines nodes={node.children} ctx={ctx} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={node.children} ctx={ctx} />
        </em>
      );
    case "strike":
      return (
        <del>
          <Inlines nodes={node.children} ctx={ctx} />
        </del>
      );
    case "link": {
      // `href` makes it read as a link to the browser and a screen reader,
      // and `title` is always the real destination, since a link's text is
      // whatever the sender wrote. The click is taken and handed on, and
      // goes no further: the parser never puts a link inside a link (#508),
      // but if one ever got here, one click must still open one address.
      // Words that name another site get the real one beside them (#580),
      // outside the link, so it reads without pointing at it.
      const real = disguisedHost(flattenInline(node.children), node.href);
      const link = (
        <a
          className="nx-text-link"
          href={node.href}
          title={node.href}
          rel="noreferrer noopener"
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            event.preventDefault();
            event.stopPropagation();
            ctx.onOpenLink(node.href);
          }}
        >
          <Inlines nodes={node.children} ctx={{ ...ctx, writtenAt: undefined }} />
        </a>
      );
      if (real === null) return link;
      return (
        <>
          {link}
          <span className="nx-text-link-real" title={`This link goes to ${real}`}>
            {" "}({real})
          </span>
        </>
      );
    }
  }
}

/**
 * Words with the times written in them marked (#584), or just the words.
 * Also for a poll's words. `still` is for words inside a control (a poll's
 * choice): pointing still says the time, but it takes no focus or click of
 * its own, since the control's click is what that place is for.
 */
export function WrittenTimes({ text, writtenAt, still = false }: { text: string; writtenAt: number; still?: boolean }) {
  const times = findTimes(text, writtenAt);
  if (times.length === 0) return <>{text}</>;
  const pieces: ReactNode[] = [];
  let from = 0;
  for (const [index, time] of times.entries()) {
    if (time.start > from) pieces.push(text.slice(from, time.start));
    pieces.push(<WrittenTime key={index} words={text.slice(time.start, time.end)} time={time} still={still} />);
    from = time.end;
  }
  if (from < text.length) pieces.push(text.slice(from));
  return <>{pieces}</>;
}

/**
 * A written time, faintly underlined (#584). Pointing at it or focusing it
 * says what it is in the reader's clock; a click or a tap keeps that open
 * until the next one, or until it loses focus, since a phone can't point. A
 * screen reader hears it after the words, from `data-for-you` drawn after
 * them out of sight (MessageText.css): drawn by the stylesheet, it isn't
 * part of the words, so copying a message copies only what was written.
 */
function WrittenTime({ words, time, still }: { words: string; time: FoundTime; still: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [kept, setKept] = useState(false);
  const said = forYou(time);
  if (still) {
    return (
      <>
        <time
          className="nx-text-time"
          dateTime={new Date(time.at).toISOString()}
          data-for-you={` (${said})`}
          onPointerEnter={(event) => setAnchor(event.currentTarget)}
          onPointerLeave={() => setAnchor(null)}
        >
          {words}
        </time>
        {anchor ? <TooltipBubble anchor={anchor}>{said}</TooltipBubble> : null}
      </>
    );
  }
  return (
    <>
      <time
        className="nx-text-time"
        dateTime={new Date(time.at).toISOString()}
        data-for-you={` (${said})`}
        tabIndex={0}
        onPointerEnter={(event) => setAnchor(event.currentTarget)}
        onPointerLeave={() => {
          if (!kept) setAnchor(null);
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) setAnchor(event.currentTarget);
        }}
        onBlur={() => {
          setKept(false);
          setAnchor(null);
        }}
        onClick={(event) => {
          setKept(!kept);
          setAnchor(kept ? null : event.currentTarget);
        }}
        onKeyDown={(event) => {
          // Escape puts away an open time first, and only that.
          if (event.key === "Escape" && anchor !== null) {
            event.stopPropagation();
            setKept(false);
            setAnchor(null);
          }
        }}
      >
        {words}
      </time>
      {anchor ? <TooltipBubble anchor={anchor}>{said}</TooltipBubble> : null}
    </>
  );
}
