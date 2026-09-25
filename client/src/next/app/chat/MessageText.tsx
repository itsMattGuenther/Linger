import { type MouseEvent, type ReactNode, memo, useMemo } from "react";
import { type Block, type Inline, parseMarkdown } from "../../../lib/markdown";
import "./MessageText.css";

/**
 * Who a `@handle` is, or null when nobody here answers to it (the characters
 * that were typed are drawn instead).
 */
export type MentionLookup = (handle: string) => { name: string; me: boolean } | null;

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
  onOpenLink,
  trailing,
}: {
  source: string;
  mentions: MentionLookup;
  onOpenLink: (href: string) => void;
  trailing?: ReactNode;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const last = blocks.length - 1;
  const inline = trailing !== undefined && blocks[last]?.kind === "paragraph";
  const ctx: Ctx = { mentions, onOpenLink };
  return (
    <div className="nx-text">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} ctx={ctx} trailing={inline && index === last ? trailing : null} />
      ))}
      {inline ? null : trailing}
    </div>
  );
});

interface Ctx {
  mentions: MentionLookup;
  onOpenLink: (href: string) => void;
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
      const person = ctx.mentions(node.handle);
      if (person === null) return <>@{node.handle}</>;
      return (
        <span className="nx-mention" data-me={person.me ? "yes" : undefined} title={person.name}>
          @{node.handle}
        </span>
      );
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
