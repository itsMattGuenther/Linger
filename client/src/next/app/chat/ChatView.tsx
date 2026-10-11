import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import type { Attachment } from "../../../generated/Attachment";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { Motd } from "../../../generated/Motd";
import type { User } from "../../../generated/User";
import type { MentionPerson } from "../../core/chat/mentions";
import { lastEditable } from "../../core/chat/rows";
import type { VoiceStrip as VoiceStripModel } from "../../core/chat/voice";
import { minimizer } from "../../core/windowControls";
import { IconButton, TabStrip, type TabItem, TitleBar } from "../../kit";
import { Composer, type ComposerProps } from "./Composer";
import { Conversation, type ConversationProps } from "./Conversation";
import { ImageViewer } from "./ImageViewer";
import type { MessageActions } from "./MessageRow";
import { MotdStrip } from "./MotdStrip";
import { PaneHeader, type PaneHeaderProps } from "./PaneHeader";
import { Typing, type TypingNow } from "./Typing";
import { type StripControls, type StripProblem, VoiceStrip } from "./VoiceStrip";
import "./ChatView.css";

/** What the window supplies about the showing conversation's history. */
export type ChatStream = Pick<
  ConversationProps,
  | "messages"
  | "pending"
  | "atStart"
  | "atEnd"
  | "leftOff"
  | "land"
  | "now"
  | "previews"
  | "mediaUrl"
  | "goTo"
  | "onWentTo"
  | "onNearStart"
  | "onNearEnd"
  | "onSeenNewest"
  | "onLetGo"
  | "onBackToNewest"
>;

/** What the window does for a message. Reply, edit and pictures the view handles itself. */
export type ChatMessageActions = Pick<MessageActions, "save" | "remove" | "openLink" | "download" | "wantCards" | "openPerson" | "report" | "react">;

/** What the window does for the box: uploads and sending. */
export type ChatComposer = Pick<
  ComposerProps,
  "files" | "onAttach" | "onRemoveFile" | "onRestoreFiles" | "onSend" | "onTyping" | "focusRequest" | "seed" | "onDraft" | "keep" | "clipboardImage" | "voiceMessage" | "motd" | "poll"
>;

/** The showing conversation. */
export interface ChatPane {
  /** The showing tab's id. */
  id: string;
  header: PaneHeaderProps;
  /**
   * A room's message of the day (#464), and whether it's folded to a line
   * on this device; null when there's none.
   */
  motd?: { motd: Motd; folded: boolean; onFold: (folded: boolean) => void } | null;
  /** Voice in this conversation, or null where there's none to offer. */
  voice: {
    strip: VoiceStripModel;
    onJoin: () => void;
    /** Open Settings on Sound & Voice, to pick a device by name (#273). */
    onPickDevice: () => void;
    mics?: ReadonlyMap<string, "muted" | "deafened">;
    controls?: StripControls;
    /** Starting voice here failed last time: why, short, what fixes it, and the whole reason (#261, #273). */
    failed?: StripProblem;
    /** The host took you out of voice here (#423). */
    takenOut?: boolean;
  } | null;
  /** Everyone the pane may name, by id: authors, voice, typing. */
  people: ReadonlyMap<string, User>;
  /** The conversation's server's own emoji (#359): drawn in messages, offered in the box. */
  customEmoji?: readonly CustomEmoji[];
  /** The conversation's server's name, which the picker calls its own emoji by. */
  serverName?: string;
  me: User | null;
  /** Who you've blocked: each of their messages is a grey line you can open (PROTOCOL §5). */
  blocked?: ReadonlySet<string>;
  /** Who is talking right now. */
  speaking: ReadonlySet<string>;
  /**
   * Who is writing here at a moment, not counting you, and when that next
   * changes by itself: the typing line asks again then (#511).
   */
  typing: (now: number) => TypingNow;
  /** Who an `@` in the box offers, in order (core/chat/mentions.ts). */
  mentionable: readonly MentionPerson[];
  stream: ChatStream;
  actions: ChatMessageActions;
  composer: ChatComposer;
}

export interface ChatViewProps {
  /** The tabs, in order. */
  tabs: TabItem[];
  /** The showing tab, or null when none is open. */
  activeId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** A tab dragged to a new place along the row. */
  onMoveTab?: (id: string, to: number) => void;
  /** Move the showing tab into a window of its own. Leave out for no button. */
  onPopOut?: (id: string) => void;
  /** Draws Linger's own close button, where the desktop draws none. */
  onCloseWindow?: () => void;
  /** Before the tabs: beside the list, the button that folds them away. */
  leading?: ReactNode;
  /** The window has focus: full-strength title bar. */
  focused?: boolean;
  /**
   * One conversation in a window of its own: no tabs, the header in the
   * title bar, and a way back beside the list, as a tab.
   */
  single?: { onBackBeside: () => void };
  /**
   * The phone (SPEC §4.15): one screen at a time over the list, never tabs.
   * The title bar holds the way back and what's showing, as a conversation's
   * own window holds its header.
   */
  stack?: { onBack: () => void };
  /** The showing conversation, or null when no tab is open. */
  pane: ChatPane | null;
  /**
   * The open tabs that aren't conversations (Media or Search beside the
   * list, #337): each one's id, its name and what it shows. The one whose
   * id is `activeId` shows when no conversation does; the rest stay drawn
   * but hidden, so going back to one finds it as it was left, its words and
   * what they found included.
   */
  others?: readonly { id: string; label: string; body: ReactNode }[];
}

/** "#general", or the people in a DM: what the box and the log are named by. */
function titleOf(header: PaneHeaderProps): string {
  return header.kind === "room" ? `#${header.name}` : header.label;
}

/**
 * Conversations (docs/design/buddy-list.md, "Conversations beside the
 * list"): tabs in the title bar, and under them the showing conversation
 * with its header, a room's message of the day, its voice, its messages,
 * who's typing and the box. Beside
 * the list, in the list window; or one conversation in a window of its own.
 *
 * It holds only what the screen itself decides: which message you're
 * replying to or editing in each tab, and the picture that's open. Everything
 * else arrives as props and leaves as callbacks, so the same view serves the
 * real window and the fixture page.
 */
export function ChatView({ tabs, activeId, onSelectTab, onCloseTab, onMoveTab, onPopOut, onCloseWindow, leading, focused = true, single, stack, pane, others = [] }: ChatViewProps) {
  const [replies, setReplies] = useState<ReadonlyMap<string, Message>>(new Map());
  const [editing, setEditing] = useState<{ tab: string; id: MessageId } | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);

  const paneId = pane?.id ?? null;
  const messages = pane?.stream.messages;

  const setReply = useCallback((tab: string, message: Message | null) => {
    setReplies((held) => {
      const next = new Map(held);
      if (message) next.set(tab, message);
      else next.delete(tab);
      return next;
    });
  }, []);

  const parentActions = pane?.actions;
  const actions = useMemo<Omit<MessageActions, "jumpTo"> | null>(() => {
    if (paneId === null || !parentActions) return null;
    return {
      ...parentActions,
      reply: (message) => setReply(paneId, message),
      edit: (message) => setEditing(message ? { tab: paneId, id: message.id } : null),
      openImage: setViewing,
    };
    // The window's callbacks are stable (L-14); each one is listed so a
    // changed one still reaches the rows.
  }, [
    paneId,
    parentActions?.save,
    parentActions?.remove,
    parentActions?.openLink,
    parentActions?.download,
    parentActions?.wantCards,
    parentActions?.openPerson,
    parentActions?.report,
    parentActions?.react,
    setReply,
  ]);

  // The reply target as it is now: an edit since it was chosen shows.
  const held = paneId === null ? undefined : replies.get(paneId);
  const target = held === undefined ? undefined : (messages?.find((one) => one.id === held.id) ?? held);
  const replyTo = useMemo(
    () => (target === undefined ? null : { message: target, author: pane?.people.get(target.author_id) }),
    [target, pane?.people],
  );

  const onClearReply = useCallback(() => {
    if (paneId !== null) setReply(paneId, null);
  }, [paneId, setReply]);

  const onRestoreReply = useCallback(
    (id: MessageId) => {
      const message = messages?.find((one) => one.id === id);
      if (paneId !== null && message) setReply(paneId, message);
    },
    [paneId, messages, setReply],
  );

  const meId = pane?.me?.id ?? null;
  const atEnd = pane?.stream.atEnd ?? true;
  const onEditLast = useCallback(() => {
    const last = messages ? lastEditable(messages, meId, atEnd) : null;
    if (paneId !== null && last) setEditing({ tab: paneId, id: last.id });
  }, [paneId, messages, meId, atEnd]);

  const popOut = onPopOut && activeId !== null ? <IconButton icon="popout" label="Open in its own window" onClick={() => onPopOut(activeId)} /> : undefined;
  // The pop-out button's opposite, drawn as its mirror (#214).
  const backBeside = single ? <IconButton icon="popin" label="Back beside your list" onClick={single.onBackBeside} /> : undefined;

  // One thing at a time, its header in the title bar: a conversation's own
  // window, or the phone.
  const alone = single !== undefined || stack !== undefined;
  const other = pane ? null : (others.find((one) => one.id === activeId) ?? null);
  const back = stack ? <IconButton icon="back" label="Back" size="lg" onClick={stack.onBack} /> : undefined;

  return (
    <div className="nx-chat" data-screen="chat" data-single={single ? "yes" : undefined} data-stack={stack ? "yes" : undefined}>
      <TitleBar leading={back ?? leading} focused={focused} actions={stack ? undefined : single ? backBeside : popOut} onMinimize={onCloseWindow && minimizer()} onClose={onCloseWindow}>
        {alone ? (
          pane ? (
            <PaneHeader {...pane.header} place="title" />
          ) : (
            (other?.label ?? "Linger")
          )
        ) : (
          <TabStrip label="Conversations" tabs={tabs} activeId={activeId ?? ""} onSelect={onSelectTab} onClose={onCloseTab} onMove={onMoveTab} panelIdPrefix="nx-pane-" />
        )}
      </TitleBar>

      {pane && actions ? (
        <section className="nx-pane" id={`nx-pane-${pane.id}`} role={alone ? "region" : "tabpanel"} aria-label={titleOf(pane.header)}>
          {alone ? null : <PaneHeader {...pane.header} />}
          {pane.motd ? (
            <MotdStrip
              motd={pane.motd.motd}
              people={pane.people}
              me={pane.me}
              customEmoji={pane.customEmoji}
              now={pane.stream.now}
              folded={pane.motd.folded}
              onFold={pane.motd.onFold}
              onOpenLink={actions.openLink}
            />
          ) : null}
          {pane.voice ? <VoiceStrip strip={pane.voice.strip} people={pane.people} meId={meId} speaking={pane.speaking} mics={pane.voice.mics} onJoin={pane.voice.onJoin} onPickDevice={pane.voice.onPickDevice} controls={pane.voice.controls} failed={pane.voice.failed} takenOut={pane.voice.takenOut} /> : null}
          <Conversation
            key={pane.id}
            id={pane.id}
            label={pane.header.kind === "room" ? `Messages in ${titleOf(pane.header)}` : `Messages with ${pane.header.label}`}
            {...pane.stream}
            people={pane.people}
            me={pane.me}
            blocked={pane.blocked}
            customEmoji={pane.customEmoji}
            editing={editing?.tab === pane.id ? editing.id : null}
            empty={
              pane.header.kind === "room"
                ? `Nothing's been said in ${titleOf(pane.header)} yet.`
                : `This is the start of your DM with ${pane.header.label}.`
            }
            actions={actions}
          />
          <Typing typing={pane.typing} />
          <Composer
            conversation={pane.id}
            title={titleOf(pane.header)}
            isDm={pane.header.kind === "dm"}
            replyTo={replyTo}
            onClearReply={onClearReply}
            onRestoreReply={onRestoreReply}
            onEditLast={onEditLast}
            mentionable={pane.mentionable}
            customEmoji={pane.customEmoji}
            serverName={pane.serverName}
            {...pane.composer}
          />
        </section>
      ) : other ? null : (
        <p className="nx-chat-none">Nothing open. Pick a room or a person in the list.</p>
      )}
      {others.map((one) => (
        <section key={one.id} className="nx-pane nx-pane-other" id={`nx-pane-${one.id}`} role={alone ? "region" : "tabpanel"} aria-label={one.label} hidden={one !== other}>
          {one.body}
        </section>
      ))}

      {viewing && pane ? <ImageViewer file={viewing} url={pane.stream.mediaUrl(viewing.url)} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
