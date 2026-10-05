import { type MouseEvent, type ReactNode, memo, useMemo } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import { type Block, type Inline, parseMarkdown } from "../../../lib/markdown";
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
 */
export const MessageText = memo(function MessageText({
  source,
  mentions,
  emoji: custom = NO_EMOJI,
  onOpenLink,
  trailing,
}: {
  source: string;
  mentions: MentionLookup;
  /** The message's server's own emoji (#359), drawn for their `:name:`. */
  emoji?: CustomEmojiByName;
  onOpenLink: (href: string) => void;
  trailing?: ReactNode;
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
  const ctx: Ctx = { mentions, emojiOf, onOpenLink };
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
      return (
        <p className="nx-text-p">
          <Inlines nodes={block.children} ctx={ctx} />
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
      return <>{node.text}</>;
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
    case "link":
      // `href` makes it read as a link to the browser and a screen reader,
      // and `title` is always the real destination, since a link's text is
      // whatever the sender wrote. The click is taken and handed on.
      return (
        <a
          className="nx-text-link"
          href={node.href}
          title={node.href}
          rel="noreferrer noopener"
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            event.preventDefault();
            ctx.onOpenLink(node.href);
          }}
        >
          <Inlines nodes={node.children} ctx={ctx} />
        </a>
      );
  }
}
