/**
 * Drawing a parsed message body.
 *
 * Every node kind in `markdown.ts` gets exactly one element here, and text goes
 * in as a React child, which means React escapes it. That is the allowlist
 * ARCHITECTURE §7 asks for, expressed as a `switch` the compiler checks rather
 * than as a list of tags to strip: there is no `dangerouslySetInnerHTML` in the
 * client, so there is no way for a message body to become markup in the first
 * place. `<img onerror=alert(1)>` in a message is fourteen characters on
 * screen.
 *
 * Mono type appears here for code, and only for code. SPEC §5.2 lists code as
 * one of mono's roles alongside timestamps and numerals; prose in a message
 * body stays sans, which is the rule AGENTS 11 is protecting.
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { openExternal } from "../lib/external";
import { type Block, type Inline, parseMarkdown } from "./markdown";

/**
 * Turning `@handle` into a person, or not.
 *
 * The parser has no idea who is on this server, so this is the step that
 * decides. A handle nobody answers to renders as the characters that were
 * typed — the same rule the rest of the file follows for anything it does not
 * recognise.
 */
export type MentionLookup = (handle: string) => { name: string; me: boolean } | null;

const Mentions = createContext<MentionLookup | null>(null);

/**
 * Render one message body.
 *
 * `trailing` is for the small marks that belong *after* the words rather than
 * under them — the "edited" note, today. It rides inside the last paragraph
 * when the body ends in one, because a block element after a block element is
 * a new line, and "edited" on a line of its own reads like a message somebody
 * sent.
 */
export default function MarkdownBody({
  source,
  trailing,
  mentions = null,
}: {
  source: string;
  trailing?: ReactNode;
  mentions?: MentionLookup | null;
}) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  const last = blocks.length - 1;
  const inline = trailing !== undefined && blocks[last]?.kind === "paragraph";
  return (
    <Mentions.Provider value={mentions}>
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          trailing={inline && index === last ? trailing : null}
        />
      ))}
      {inline ? null : trailing}
    </Mentions.Provider>
  );
}

function BlockView({ block, trailing }: { block: Block; trailing?: ReactNode }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="md-p">
          <InlineView nodes={block.children} />
          {trailing}
        </p>
      );
    case "quote":
      return (
        <blockquote className="md-quote">
          {block.children.map((child, index) => (
            <BlockView key={index} block={child} />
          ))}
        </blockquote>
      );
    case "code":
      return (
        <pre className="md-code">
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}>
          <InlineView nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      );
    }
  }
}

function InlineView({ nodes }: { nodes: readonly Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <InlineNode key={index} node={node} />
      ))}
    </>
  );
}

function InlineNode({ node }: { node: Inline }) {
  const lookup = useContext(Mentions);
  switch (node.kind) {
    case "text":
      return <>{node.text}</>;
    case "mention": {
      const person = lookup?.(node.handle) ?? null;
      // Nobody by that name: it is a word with an @ in front of it, and that is
      // how it renders.
      if (person === null) return <>@{node.handle}</>;
      // The handle is what gets drawn, not the display name — a display name
      // can contain spaces, and a mark whose end you cannot see is a mark you
      // cannot trust. The name is on the hover instead.
      //
      // Deliberately not painted in the person's palette color: that would put
      // a value from someone's profile into a message body's markup, and the
      // body is the one place this client keeps free of attributes it did not
      // choose itself.
      return (
        <span className={person.me ? "mention mention-me" : "mention"} title={person.name}>
          @{node.handle}
        </span>
      );
    }
    case "code":
      return <code className="md-inline-code">{node.text}</code>;
    case "strong":
      return (
        <strong>
          <InlineView nodes={node.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <InlineView nodes={node.children} />
        </em>
      );
    case "strike":
      return (
        <del>
          <InlineView nodes={node.children} />
        </del>
      );
    case "link":
      return (
        // `href` is here so the link reads as one to the browser and to a
        // screen reader, and so "copy link address" works. Nothing follows it:
        // the click is taken and handed to the system browser instead.
        //
        // `title` is the real destination, always, because the text of a link
        // is whatever the sender wrote and does not have to match where it
        // goes. Hovering is how you check.
        <a
          className="md-link"
          href={node.href}
          title={node.href}
          rel="noreferrer noopener"
          onClick={(event) => {
            event.preventDefault();
            openExternal(node.href);
          }}
        >
          <InlineView nodes={node.children} />
        </a>
      );
  }
}
