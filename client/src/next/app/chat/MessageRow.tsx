import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { LinkPreview } from "../../../generated/LinkPreview";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { messageFontVar } from "../../../lib/fonts";
import { linkTargets, mentionHandles } from "../../../lib/markdown";
import { ageOpacity, clockTime, fullTime } from "../../../lib/time";
import { cardOnly, excerpt } from "../../core/chat/words";
import { IconButton, Menu, type MenuAnchor, type MenuItem, Name } from "../../kit";
import { Attachments } from "./Attachments";
import { EditBox } from "./EditBox";
import { LinkCard } from "./LinkCard";
import { type MentionLookup, MessageText } from "./MessageText";
import "./MessageRow.css";

/** What a message row can ask for. Stable, so a scroll doesn't redraw rows (L-14). */
export interface MessageActions {
  reply: (message: Message) => void;
  /** Start or stop editing a message in place. */
  edit: (message: Message | null) => void;
  /** Save an edit. A refusal rejects with a sentence, shown on the message. */
  save: (message: Message, body: string) => Promise<void>;
  /** Delete. A refusal rejects with a sentence, shown on the message. */
  remove: (message: Message) => Promise<void>;
  jumpTo: (id: MessageId) => void;
  openLink: (href: string) => void;
  openImage: (file: Attachment) => void;
  download: (file: Attachment) => void;
  /** This row's links are on screen: ask the server about them, for their cards. */
  wantCards?: (urls: readonly string[]) => void;
  /** Open the card of whoever a name belongs to, beside the name (PPL-6). */
  openPerson?: (user: User, anchor: { top: number; bottom: number; left: number }) => void;
}

/**
 * One message, with its author's name inline (docs/design/system.md, "The
 * conversation"): `Eli: words`, the time faint on the right, and the words of
 * every line and every following message in the group starting on one edge.
 *
 * A continuation row draws the same name, invisible, so its words start
 * exactly where the head's do in any face, with nothing measured. A reply's
 * quote sits above its own line and belongs to it (L-17).
 */
export const MessageRow = memo(function MessageRow({
  message,
  head,
  pending,
  author,
  quoted,
  quotedAuthor,
  me,
  canDelete,
  now,
  editing,
  flashing,
  previews,
  mentions,
  mediaUrl,
  actions,
}: {
  message: Message;
  head: boolean;
  pending: boolean;
  author: User | undefined;
  /** The message this one replies to, when it is loaded. */
  quoted: Message | undefined;
  quotedAuthor: User | undefined;
  me: User | null;
  /** You may delete it: it's yours, or you are the host. */
  canDelete: boolean;
  now: number;
  editing: boolean;
  flashing: boolean;
  previews: Readonly<Record<string, LinkPreview>>;
  mentions: MentionLookup;
  mediaUrl: (path: string) => string;
  actions: MessageActions;
}) {
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; confirming: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  const deleted = message.deleted_at !== null;
  const mine = me !== null && message.author_id === me.id;
  const namesMe = me !== null && !deleted && mentionHandles(message.body).includes(me.username);
  const links = deleted || editing ? [] : linkTargets(message.body);
  const justCard = cardOnly(message.body, links, (url) => previews[url] !== undefined);
  // Rows exist only while on screen (the list is virtualized), so this asks
  // about the links people can see and nothing further back. Keyed on the
  // joined list: the array is rebuilt every render.
  const linkKey = links.join(" ");
  const wantCards = actions.wantCards;
  useEffect(() => {
    if (linkKey !== "") wantCards?.(linkKey.split(" "));
  }, [linkKey, wantCards]);
  const who = author?.display_name ?? "someone";

  const run = (work: Promise<void>): void => {
    setProblem(null);
    void work.catch((error: unknown) => setProblem(error instanceof Error ? error.message : "Couldn't reach the server."));
  };

  const closeMenu = (refocus: boolean) => {
    setMenu(null);
    if (refocus) trigger.current?.focus();
  };

  const items: MenuItem[] = menu?.confirming
    ? [
        {
          id: "delete-for-good",
          label: "Delete for good",
          icon: "close",
          tone: "danger",
          onSelect: () => {
            closeMenu(true);
            run(actions.remove(message));
          },
        },
        { id: "keep", label: "Keep it", icon: "check", onSelect: () => closeMenu(true) },
      ]
    : [
        {
          id: "reply",
          label: "Reply",
          icon: "message",
          onSelect: () => {
            closeMenu(false);
            actions.reply(message);
          },
        },
        ...(mine
          ? [
              {
                id: "edit",
                label: "Edit",
                icon: "pencil" as const,
                onSelect: () => {
                  closeMenu(false);
                  actions.edit(message);
                },
              },
            ]
          : []),
        ...(canDelete
          ? [{ id: "delete", label: "Delete", icon: "close" as const, tone: "danger" as const, onSelect: () => setMenu((open) => (open ? { ...open, confirming: true } : open)) }]
          : []),
      ];

  const reply = !deleted && message.reply_to !== null;

  return (
    <div
      className="nx-msg"
      data-head={head ? "yes" : undefined}
      data-reply={reply ? "yes" : undefined}
      data-pending={pending ? "yes" : undefined}
      data-names-me={namesMe ? "yes" : undefined}
      data-flash={flashing ? "yes" : undefined}
      data-menu={menu ? "yes" : undefined}
      data-message={message.id}
    >
      {reply ? <Quote target={quoted} author={quotedAuthor} onJump={actions.jumpTo} /> : null}

      <span className="nx-msg-who" aria-hidden={head ? undefined : true}>
        {author && head && actions.openPerson && author.id !== me?.id ? (
          <button
            type="button"
            className="nx-msg-person"
            aria-haspopup="dialog"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              actions.openPerson?.(author, { top: box.top, bottom: box.bottom, left: box.left });
            }}
          >
            <Name person={author} size="body" />
          </button>
        ) : author ? (
          <Name person={author} size="body" />
        ) : (
          <span className="nx-msg-someone">someone</span>
        )}
        <span className="nx-msg-colon">:</span>
      </span>

      <div className="nx-msg-body" style={bodyStyle(ageOpacity(message.created_at, now), author)}>
        {deleted ? (
          <p className="nx-msg-gone">deleted</p>
        ) : editing ? (
          <EditBox message={message} onSave={(body) => actions.save(message, body)} onDone={() => actions.edit(null)} />
        ) : justCard ? null : (
          <MessageText
            source={message.body}
            mentions={mentions}
            onOpenLink={actions.openLink}
            trailing={message.edited_at === null ? undefined : <span className="nx-msg-edited">edited</span>}
          />
        )}
        {deleted || editing ? null : (
          <>
            <Attachments files={message.attachments} mediaUrl={mediaUrl} onOpenImage={actions.openImage} onDownload={actions.download} />
            {links.map((url) => (
              <LinkCard key={url} url={url} preview={previews[url]} onOpen={actions.openLink} />
            ))}
          </>
        )}
        {problem ? (
          <p className="nx-msg-problem" role="alert">
            {problem}
          </p>
        ) : null}
      </div>

      <time className="nx-msg-time" dateTime={new Date(message.created_at).toISOString()} title={fullTime(message.created_at)}>
        {pending ? "sending" : clockTime(message.created_at)}
      </time>

      <span className="nx-msg-actions">
        {deleted || editing || pending ? null : (
          <span
            ref={(node) => {
              trigger.current = node?.querySelector("button") ?? null;
            }}
          >
            <IconButton
              icon="more"
              label={`Actions for ${who}'s message`}
              size="sm"
              expanded={menu !== null}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu((open) => (open ? null : { anchor: { top: box.top, left: box.left, right: box.right, bottom: box.bottom }, confirming: false }));
              }}
            />
          </span>
        )}
      </span>

      {menu ? (
        <Menu
          label={`Actions for ${who}'s message`}
          items={items}
          anchor={menu.anchor}
          onClose={(reason) => closeMenu(reason === "escape" || reason === "tab")}
        />
      ) : null}
    </div>
  );
});

/** The line above a reply saying what it answers. It jumps there when loaded. */
function Quote({ target, author, onJump }: { target: Message | undefined; author: User | undefined; onJump: (id: MessageId) => void }) {
  if (target === undefined) {
    return (
      <p className="nx-quote" data-missing="yes">
        <span className="nx-quote-mark" aria-hidden="true">
          ↩
        </span>
        <span className="nx-quote-text">an earlier message</span>
      </p>
    );
  }
  const who = author?.display_name ?? "someone";
  const words = target.deleted_at !== null ? "deleted" : excerpt(target.body) || "a file";
  return (
    <button type="button" className="nx-quote" aria-label={`Replying to ${who}: ${words}. Go to it.`} onClick={() => onJump(target.id)}>
      <span className="nx-quote-mark" aria-hidden="true">
        ↩
      </span>
      <span className="nx-quote-text">
        {author ? <Name person={author} size="inline" /> : who} <span className="nx-quote-words">{words}</span>
      </span>
    </button>
  );
}

/**
 * A message body's look: how far it has faded with age, and the sender's
 * message face (NAME-3), which is only ever one of the four sans faces
 * (`messageFontVar`); nothing else about a message is styleable (SPEC §4.5).
 */
function bodyStyle(opacity: number, author: User | undefined): CSSProperties {
  return { opacity, "--msg-font": messageFontVar(author?.style.msg_font_key) } as CSSProperties;
}
