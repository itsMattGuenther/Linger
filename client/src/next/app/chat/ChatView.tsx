import { useCallback, useMemo, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { User } from "../../../generated/User";
import { lastEditable } from "../../core/chat/rows";
import type { VoiceStrip as VoiceStripModel } from "../../core/chat/voice";
import { IconButton, TabStrip, type TabItem, TitleBar } from "../../kit";
import { Composer, type ComposerProps } from "./Composer";
import { Conversation, type ConversationProps } from "./Conversation";
import { ImageViewer } from "./ImageViewer";
import type { MessageActions } from "./MessageRow";
import { PaneHeader, type PaneHeaderProps } from "./PaneHeader";
import { Typing } from "./Typing";
import { VoiceStrip } from "./VoiceStrip";
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
export type ChatMessageActions = Pick<MessageActions, "save" | "remove" | "openLink" | "download" | "wantCards">;

/** What the window does for the box: uploads and sending. */
export type ChatComposer = Pick<ComposerProps, "files" | "onAttach" | "onRemoveFile" | "onRestoreFiles" | "onSend" | "onTyping" | "focusRequest">;

/** The showing conversation. */
export interface ChatPane {
  /** The showing tab's id. */
  id: string;
  header: PaneHeaderProps;
  /** Voice in this conversation, or null where there's none to offer. */
  voice: { strip: VoiceStripModel; onJoin: () => void } | null;
  /** Everyone the pane may name, by id: authors, voice, typing. */
  people: ReadonlyMap<string, User>;
  me: User | null;
  /** Who is talking right now. */
  speaking: ReadonlySet<string>;
  /** Who is writing here right now, not counting you. */
  typing: readonly User[];
  stream: ChatStream;
  actions: ChatMessageActions;
  composer: ChatComposer;
}

export interface ChatViewProps {
  /** The window's tabs, in order. */
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
  /** The window has focus: full-strength title bar. */
  focused?: boolean;
  /** The showing conversation, or null when no tab is open. */
  pane: ChatPane | null;
}

/** "#general", or the people in a DM: what the box and the log are named by. */
function titleOf(header: PaneHeaderProps): string {
  return header.kind === "room" ? `#${header.name}` : header.label;
}

/**
 * The chat window (docs/design/buddy-list.md, "Conversations: tabs or
 * windows"): tabs in the title bar, and under them the showing conversation
 * with its header, its voice, its messages, who's typing and the box.
 *
 * It holds only what the screen itself decides: which message you're
 * replying to or editing in each tab, and the picture that's open. Everything
 * else arrives as props and leaves as callbacks, so the same view serves the
 * real window and the fixture page.
 */
export function ChatView({ tabs, activeId, onSelectTab, onCloseTab, onMoveTab, onPopOut, onCloseWindow, focused = true, pane }: ChatViewProps) {
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
  }, [paneId, parentActions?.save, parentActions?.remove, parentActions?.openLink, parentActions?.download, parentActions?.wantCards, setReply]);

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

  return (
    <div className="nx-chat" data-screen="chat">
      <TitleBar focused={focused} actions={popOut} onClose={onCloseWindow}>
        <TabStrip label="Conversations" tabs={tabs} activeId={activeId ?? ""} onSelect={onSelectTab} onClose={onCloseTab} onMove={onMoveTab} panelIdPrefix="nx-pane-" />
      </TitleBar>

      {pane && actions ? (
        <section className="nx-pane" id={`nx-pane-${pane.id}`} role="tabpanel" aria-label={titleOf(pane.header)}>
          <PaneHeader {...pane.header} />
          {pane.voice ? <VoiceStrip strip={pane.voice.strip} people={pane.people} meId={meId} speaking={pane.speaking} onJoin={pane.voice.onJoin} /> : null}
          <Conversation
            key={pane.id}
            id={pane.id}
            label={pane.header.kind === "room" ? `Messages in ${titleOf(pane.header)}` : `Messages with ${pane.header.label}`}
            {...pane.stream}
            people={pane.people}
            me={pane.me}
            editing={editing?.tab === pane.id ? editing.id : null}
            empty={
              pane.header.kind === "room"
                ? `Nothing's been said in ${titleOf(pane.header)} yet.`
                : `This is the start of your DM with ${pane.header.label}.`
            }
            actions={actions}
          />
          <Typing people={pane.typing} />
          <Composer
            conversation={pane.id}
            title={titleOf(pane.header)}
            isDm={pane.header.kind === "dm"}
            replyTo={replyTo}
            onClearReply={onClearReply}
            onRestoreReply={onRestoreReply}
            onEditLast={onEditLast}
            {...pane.composer}
          />
        </section>
      ) : (
        <p className="nx-chat-none">Nothing open. Pick a room or a person in the list.</p>
      )}

      {viewing && pane ? <ImageViewer file={viewing} url={pane.stream.mediaUrl(viewing.url)} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}
