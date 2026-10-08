import { type CSSProperties, memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { LinkPreview } from "../../../generated/LinkPreview";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { messageFontVar } from "../../../lib/fonts";
import { linkTargets, mentionHandles } from "../../../lib/markdown";
import { ageOpacity, clockTime, fullTime } from "../../../lib/time";
import { cardOnly, excerpt } from "../../core/chat/words";
import { Button, Icon, IconButton, Menu, type MenuAnchor, type MenuItem, Name } from "../../kit";
import { Attachments } from "./Attachments";
import { EditBox } from "./EditBox";
import { LinkCard } from "./LinkCard";
import { onPhone } from "../../core/phone";
import { FloatingForm, ReportForm } from "./ReportBlock";
import { type CustomEmojiByName, type MentionLookup, MessageText } from "./MessageText";
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
  /** Hand a file to the browser to download; rejects when the browser couldn't be opened. */
  download: (file: Attachment) => Promise<void>;
  /** This row's links are on screen: ask the server about them, for their cards. */
  wantCards?: (urls: readonly string[]) => void;
  /** Open the card of whoever a name belongs to, beside the name (PPL-6); yours too (#271). */
  openPerson?: (user: User, anchor: { top: number; bottom: number; left: number }) => void;
  /** Pin a message or take its pin off (T-908). A refusal rejects with a sentence. */
  pin?: (message: Message, pinned: boolean) => Promise<void>;
  /**
   * Report somebody else's message to the host (T-1605): the host's name,
   * and sending it, which says null or what went wrong. Left out where
   * there's nobody to report to, as for the host.
   */
  report?: { host: string; cohosts?: boolean; send: (message: Message, note: string | null) => Promise<string | null> };
}

/**
 * One message (docs/design/system.md, "The conversation"). A run's first
 * message has its author's name on a line of its own, with the time faint on
 * the right, and its words underneath, set in from the name (#295). Every
 * line of every message in the run starts on that one edge, whoever wrote it
 * and however long their name is, with nothing measured. A reply's quote sits
 * above the name and belongs to the reply (L-17).
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
  emoji,
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
  /** You may delete it: it's yours, or you are the host or a co-host and it isn't the host's (#424). */
  canDelete: boolean;
  now: number;
  editing: boolean;
  flashing: boolean;
  previews: Readonly<Record<string, LinkPreview>>;
  mentions: MentionLookup;
  /** The server's own emoji (#359). */
  emoji?: CustomEmojiByName;
  mediaUrl: (path: string) => string;
  actions: MessageActions;
}) {
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; confirming: boolean } | null>(null);
  // Reporting it to the host (T-1605): the form floats where the menu was.
  const [reporting, setReporting] = useState<MenuAnchor | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);

  const deleted = message.deleted_at !== null;
  const mine = me !== null && message.author_id === me.id;
  // The line written when somebody set the room's message of the day (#464):
  // who set it, and what to, quoted. It names nobody and isn't edited.
  const motd = message.motd === true;
  const namesMe = me !== null && !deleted && !motd && mentionHandles(message.body).includes(me.username);
  const links = deleted || editing ? [] : linkTargets(message.body);
  const justCard = cardOnly(message.body, links, (url) => previews[url] !== undefined);
  // Pinned and edited, said after the words; or, for a message with none
  // (only pictures, a file, a voice message or a link's card), beside the
  // bottom of what it shows.
  const wordless = justCard || message.body.trim() === "";
  const marks =
    message.edited_at === null && message.pinned_at === null ? undefined : (
      <>
        {message.pinned_at === null ? null : (
          <span className="nx-msg-pinned" title="Pinned">
            <Icon name="pin" size="sm" />
            <span className="k-sr-only">pinned</span>
          </span>
        )}
        {message.edited_at === null ? null : <span className="nx-msg-edited">edited</span>}
      </>
    );
  // What it shows besides its words: files, then the links' cards.
  const shown = (
    <>
      <Attachments files={message.attachments} mediaUrl={mediaUrl} onOpenImage={actions.openImage} onDownload={actions.download} />
      {links.map((url) => (
        <LinkCard key={url} url={url} preview={previews[url]} onOpen={actions.openLink} />
      ))}
    </>
  );
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

  // On the phone a message is held for its actions (SPEC §4.15): there's no
  // hovering for the ··· button, and holding can't select its words, so
  // Copy text is one of them.
  const phone = onPhone();
  const words = message.body.trim();
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
        ...(phone && words !== ""
          ? [
              {
                id: "copy",
                label: "Copy text",
                icon: "copy" as const,
                onSelect: () => {
                  closeMenu(false);
                  void navigator.clipboard?.writeText(message.body).catch(() => undefined);
                },
              },
            ]
          : []),
        ...(actions.pin && !pending
          ? [
              {
                id: "pin",
                label: message.pinned_at === null ? "Pin" : "Unpin",
                icon: "pin" as const,
                onSelect: () => {
                  closeMenu(true);
                  if (actions.pin) run(actions.pin(message, message.pinned_at === null));
                },
              },
            ]
          : []),
        ...(mine && !motd
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
        // Last, and plain: there, not loud (T-1605).
        ...(actions.report && !mine
          ? [
              {
                id: "report",
                label: "Report to host…",
                icon: "flag" as const,
                onSelect: () => {
                  const anchor = menu?.anchor ?? null;
                  closeMenu(false);
                  setReporting(anchor);
                },
              },
            ]
          : []),
      ];

  const reply = !deleted && message.reply_to !== null;

  return (
    <div
      className="nx-msg"
      onContextMenu={
        phone && !deleted && !editing && !pending
          ? (event) => {
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              setMenu({ anchor: { top: box.top, left: box.left, right: box.right, bottom: box.bottom }, confirming: false });
            }
          : undefined
      }
      data-head={head ? "yes" : undefined}
      data-reply={reply ? "yes" : undefined}
      data-pending={pending ? "yes" : undefined}
      data-names-me={namesMe ? "yes" : undefined}
      data-motd={motd ? "yes" : undefined}
      data-flash={flashing ? "yes" : undefined}
      data-menu={menu ? "yes" : undefined}
      data-message={message.id}
    >
      {reply ? <Quote target={quoted} author={quotedAuthor} onJump={actions.jumpTo} /> : null}

      {head ? (
        // The name on a line of its own at the start of a run, with no colon
        // (#295). Later messages in the run are only their words.
        <span className="nx-msg-who">
          {author && actions.openPerson ? (
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
          {motd ? <span className="nx-msg-did">set the message of the day</span> : null}
        </span>
      ) : null}

      <div className="nx-msg-body" style={bodyStyle(ageOpacity(message.created_at, now), author)}>
        {deleted ? (
          <p className="nx-msg-gone">deleted</p>
        ) : editing ? (
          <EditBox message={message} onSave={(body) => actions.save(message, body)} onDone={() => actions.edit(null)} />
        ) : justCard ? null : (
          <Fold id={message.id}>
            <MessageText source={message.body} mentions={mentions} emoji={emoji} onOpenLink={actions.openLink} trailing={wordless ? undefined : marks} />
          </Fold>
        )}
        {deleted || editing ? null : wordless && marks !== undefined ? (
          <div className="nx-msg-tail">
            <div className="nx-msg-tail-shown">{shown}</div>
            <p className="nx-msg-marks">{marks}</p>
          </div>
        ) : (
          shown
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
          sheet={phone ? { head: `${who}: ${excerpt(message.body) || "a file"}` } : undefined}
        />
      ) : null}
      {reporting && actions.report ? (
        <FloatingForm
          anchor={reporting}
          label={`Report ${who}'s message`}
          onClose={() => {
            setReporting(null);
            trigger.current?.focus();
          }}
        >
          <ReportForm
            who={who}
            excerpt={message.body}
            host={actions.report.host}
            cohosts={actions.report.cohosts}
            onSend={(note) => actions.report?.send(message, note) ?? Promise.resolve("Reporting isn't available here.")}
            onDone={() => {
              setReporting(null);
              trigger.current?.focus();
            }}
          />
        </FloatingForm>
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

/**
 * Messages unfolded in this window, by id (#304). Kept outside the rows: the
 * list only draws the rows near the view, so a row scrolled away is thrown
 * out and drawn again later, and it should come back as it was left.
 */
const unfolded = new Set<MessageId>();

/**
 * A message's words, folded when they're drawn taller than `--message-fold`
 * (twenty lines): the first twenty, fading out, and Show all under them
 * (#304). Only the words fold, never a picture or a card. Nothing is taken
 * out of the page, so a screen reader reads the whole message and copying
 * copies all of it; the fold is only how much is drawn. It's measured as
 * drawn, so a long paragraph folds as well as many short lines, and again
 * when the window's width changes.
 */
function Fold({ id, children }: { id: MessageId; children: ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(() => unfolded.has(id));
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const node = box.current;
    // Unfolded, it was tall to be unfolded; there's nothing to measure.
    if (!node || open) return;
    const measure = () => setTall(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, [open]);
  const toggle = () => {
    const next = !open;
    if (next) unfolded.add(id);
    else unfolded.delete(id);
    setOpen(next);
  };
  return (
    <>
      <div ref={box} className="nx-msg-fold" data-open={open ? "yes" : undefined} data-tall={tall ? "yes" : undefined}>
        {children}
      </div>
      {tall || open ? (
        <span className="nx-msg-fold-toggle">
          <Button size="sm" variant="quiet" icon={open ? "up" : "down"} onClick={toggle}>
            {open ? "Show less" : "Show all"}
          </Button>
        </span>
      ) : null}
    </>
  );
}

