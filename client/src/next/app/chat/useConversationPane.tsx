import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { Message } from "../../../generated/Message";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import { ApiError, type AuthedApi, TransportError } from "../../../lib/api";
import { useNow } from "../../../lib/clock";
import { dmLabel } from "../../../lib/dm";
import { openExternal, openExternalChecked } from "../../../lib/external";
import {
  deleteMessage,
  editMessage,
  type GatewayState,
  leaveWindow,
  loadNewer,
  loadOlder,
  noteDm,
  openAround,
  pinMessage,
  serverState,
  startedTyping,
  trimHistory,
  useServers,
  sendReport,
} from "../../../lib/gateway";
import { useLinkPreviews, wantPreviews } from "../../../lib/previews";
import { absoluteUrl } from "../../../lib/url";
import { onWindows, voiceStartProblem } from "../../../lib/voice";
import { onPhone } from "../../core/phone";
import { tauriBus } from "../../core/bus";
import { conversationIn, dmPeople, micsHere, peopleInRoom, tabModel, typingIn, voiceHere } from "../../core/chat/conversation";
import { keepDraft, keptDraft } from "../../core/chat/keptDrafts";
import { type MentionPerson, mentionable as mentionableIn } from "../../core/chat/mentions";
import { clipboardImageReader } from "../../core/chat/paste";
import { voiceStrip } from "../../core/chat/voice";
import { knockOfflineLine, knockOn } from "../../core/knock";
import { cardSafety, hostName, reportsReachCohosts, said } from "../../core/safety";
import { personRow } from "../../core/list";
import type { Intent, VoiceControlQuestion } from "../../core/share";
import { keyOf, type TabKey } from "../../core/tabs";
import { talkingNow } from "../../core/voice";
import { pressVoiceControl } from "../../core/voiceControl";
import { markerOf, type TabItem } from "../../kit";
import { PersonCard } from "../list/PersonCard";
import { hostOf, useServerInfos } from "../useServerInfos";
import type { ChatPane } from "./ChatView";
import { useFileDrafts } from "./useFileDrafts";
import { useVoiceMessages } from "./useVoiceMessages";
import { useLanding, useReading } from "./visit";

/** How long a knock's button says "Knocked" (SPEC §4.9), as on the person card. */
const KNOCKED_MS = 3_000;
/**
 * How long a refused knock's reason stays in a DM's header before their
 * status comes back (#288): long enough to read two short sentences, and the
 * same as the knock card a person gets.
 */
const REFUSED_MS = 8_000;
/** "Typing…" goes a few seconds after the last keystroke (`TYPING_TTL_MS`); checked this often. */
const TYPING_CHECK_MS = 2_000;

/** A knock from a DM's header, while there's something to show for it. */
type HeaderKnockNow = { phase: "knocking" | "knocked"; problem?: undefined } | { phase: "idle"; problem: string };

const NO_MESSAGES: readonly Message[] = [];
const NO_PEOPLE: ReadonlyMap<string, User> = new Map();
const NO_MENTIONS: readonly MentionPerson[] = [];

/** Where drafts wait: this computer's storage, or none where it's refused. */
export function draftStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * What a place that shows conversations gives the pane: the sign-ins it
 * works through, the owner to ask for what only the owner may do, and how it
 * shows a conversation (a DM opened from a person's card).
 */
export interface PaneHost {
  apis: ReadonlyMap<string, AuthedApi>;
  intend: (intent: Intent) => Promise<void>;
  /** The showing conversation, or null. */
  active: TabKey | null;
  /** The conversation behind a tab id, for uploads that finish after their tab was left. */
  find: (id: string) => TabKey | undefined;
  /** Show this conversation where this place shows them. */
  show: (server: string, roomId: RoomId) => void;
  /** A draft that came along with the first conversation shown, from another window. */
  firstSeed?: { conversation: string; text: string } | null;
  /** The message the first conversation was opened on (a search hit, a banner), if any. */
  firstMessage?: { tab: TabKey; id: MessageId } | null;
  /**
   * Mute, Deafen and Leave on the voice line. A window of its own asks the
   * list window, which answers with the sound to play (#241); beside the
   * list, the list window acts itself, as its voice bar does.
   */
  voiceControl?: (press: VoiceControlQuestion) => void;
  /** Something was typed in a conversation's box: a preview tab of it is kept (#351). */
  onTyped?: (conversation: string) => void;
}

export interface ConversationPane {
  /** The showing conversation, drawn by `ChatView`; null when there's none to show. */
  pane: ChatPane | null;
  /** A person's card, opened from a name in the conversation, or null. */
  card: ReactNode;
  /** Every server's state, as the pane reads it. */
  servers: Readonly<Record<string, GatewayState>>;
  /** With several servers, every conversation says where it's from (MULTI-6). */
  several: boolean;
  serverTag: (server: string) => { name: string; color: string };
  /** A conversation's tab, as the tab row draws it, or null for one that isn't there (yet). */
  tabItem: (tab: TabKey, showing: boolean) => TabItem | null;
  /** Go to a message in a conversation once it's in reach (CONV-17). */
  goToMessage: (tab: TabKey, id: MessageId) => void;
  /** Put the cursor in the box: the conversation was opened, or its window was. */
  askFocus: () => void;
  /** A draft that came with a conversation from another window, for its box. */
  seedDraft: (conversation: string, text: string) => void;
  /** What a conversation's box holds right now, so it can go along to another window. */
  draftOf: (conversation: string) => string;
}

/**
 * The showing conversation, however it's shown: in a window of its own, or
 * as a tab beside the list (docs/design/architecture.md, "Window
 * management"). Everything about one conversation lives here: its history,
 * its box, its voice line, knocks from a DM's header, and the person card a
 * name opens. The place that holds it decides which conversation shows and
 * what surrounds it.
 */
export function useConversationPane({ apis, intend, active, find, show, firstSeed = null, firstMessage = null, voiceControl = askTheList, onTyped }: PaneHost): ConversationPane {
  const servers = useServers();
  const now = useNow();
  // Its own clock, so the conversation isn't redrawn every two seconds.
  const typingNow = useNow(TYPING_CHECK_MS);
  // Bumped when the cursor should go in the box.
  const [focusAsk, setFocusAsk] = useState(1);
  const askFocus = useCallback(() => setFocusAsk((ask) => ask + 1), []);
  // Each person's knock from a DM's header, by user id, until it has nothing left to say.
  const [knocks, setKnocks] = useState<ReadonlyMap<string, HeaderKnockNow>>(new Map());
  // What each conversation's box holds, so a draft can go with it to another window.
  const typed = useRef(new Map<string, string>());
  const typedNow = useRef(onTyped);
  typedNow.current = onTyped;
  const onDraft = useCallback((conversation: string, text: string) => {
    typed.current.set(conversation, text);
    if (text.trim() !== "") typedNow.current?.(conversation);
  }, []);
  const draftOf = useCallback((conversation: string) => typed.current.get(conversation) ?? "", []);
  // Half-typed lines outlast their tab and a restart (decision 11).
  const keep = useMemo(() => {
    const store = draftStore();
    return store
      ? {
          load: (conversation: string) => keptDraft(store, conversation, Date.now()),
          save: (conversation: string, text: string) => keepDraft(store, conversation, text, Date.now()),
        }
      : undefined;
  }, []);
  // A draft that came with a conversation from another window.
  const [seed, setSeed] = useState<{ conversation: string; text: string } | null>(firstSeed);
  const seedDraft = useCallback((conversation: string, text: string) => setSeed({ conversation, text }), []);

  // Where a search hit or a media tile asked to open (CONV-17): the tab and
  // the message, handed to the conversation once the message is in reach.
  // One already loaded is jumped to; one further back reopens the room
  // around it first (`openAround`), which falls back to the newest page if
  // the message is gone.
  const [goTo, setGoTo] = useState<{ tab: string; id: MessageId } | null>(null);
  const onWentTo = useCallback(() => setGoTo(null), []);
  const goToMessage = useCallback(
    (tab: TabKey, id: MessageId) => {
      const api = apis.get(tab.server);
      if (!api) return;
      const held = serverState(tab.server).streams[tab.roomId];
      if (held?.messages.some((one) => one.id === id)) {
        setGoTo({ tab: keyOf(tab), id });
        return;
      }
      void openAround(api, tab.roomId, id).then(() => setGoTo({ tab: keyOf(tab), id }));
    },
    [apis],
  );
  // Opened on a message: asked for before the conversation's first visit
  // below, so the room is opened once, at the message, rather than at its
  // newest page and then again around the message (#266).
  const wentFirst = useRef(false);
  useEffect(() => {
    if (wentFirst.current) return;
    wentFirst.current = true;
    if (firstMessage) goToMessage(firstMessage.tab, firstMessage.id);
  }, [firstMessage, goToMessage]);

  // Where your voice seat is, as a tab id, on whichever server has it.
  const voiceTab = useMemo(() => {
    for (const [server, state] of Object.entries(servers)) {
      if (state.myVoice) return keyOf({ server, roomId: state.myVoice.roomId });
    }
    return null;
  }, [servers]);

  // With several servers every conversation says where it's from: a stripe
  // on its tab in the server's color, and its name in the header (MULTI-6).
  const infos = useServerInfos(apis);
  const several = apis.size > 1;
  const serverTag = useCallback(
    (server: string) => ({ name: infos[server]?.name ?? hostOf(server), color: infos[server]?.accent ?? "slate" }),
    [infos],
  );

  const tabItem = useCallback(
    (tab: TabKey, showing: boolean): TabItem | null => {
      const state = servers[tab.server];
      const model = state ? tabModel(tab, state, showing, talkingNow(state)) : null;
      if (!model) return null;
      return {
        id: model.id,
        title: model.title,
        label: several ? `${model.label}, ${serverTag(tab.server).name}` : model.label,
        stripe: several ? serverTag(tab.server).color : undefined,
        lead: model.lead === null ? undefined : model.lead.kind === "room" ? { kind: "room" } : { kind: "person", person: markerOf(model.lead.user, model.lead.state) },
        fresh: model.fresh,
        lit: model.lit,
        voice: model.voice ?? undefined,
        speaking: model.speaking,
        closable: true,
      };
    },
    [servers, several, serverTag],
  );

  // ------------------------------------------------------------------
  // The showing conversation.

  const api = active ? (apis.get(active.server) ?? null) : null;
  const state = active ? (servers[active.server] ?? null) : null;
  const roomId = active?.roomId ?? null;
  const room = state && roomId !== null ? conversationIn(state, roomId) : null;
  const paneId = active ? keyOf(active) : null;

  const land = useLanding(api, roomId, state);
  const read = useReading(intend, active, state, land.ready);

  const stream = state && roomId !== null ? state.streams[roomId] : undefined;
  const messages = stream?.messages ?? NO_MESSAGES;
  const pending = useMemo(() => stream?.pending.map((one) => one.message) ?? NO_MESSAGES, [stream?.pending]);
  const people = useMemo(() => (state ? new Map(state.users.map((user) => [user.id, user])) : NO_PEOPLE), [state?.users]);
  const talking = useMemo(() => (state ? talkingNow(state) : new Set<string>()), [state]);
  // Who an @ offers: only what it reads, so a message arriving doesn't
  // redraw the box.
  const mentionable = useMemo(
    () => (state && room ? mentionableIn(state, room) : NO_MENTIONS),
    [state?.users, state?.presence, state?.occupancy, state?.me, room],
  );
  const previews = useLinkPreviews(active?.server ?? "");

  const onNearStart = useCallback(() => {
    if (api && roomId !== null) void loadOlder(api, roomId);
  }, [api, roomId]);
  const onNearEnd = useCallback(() => {
    if (api && roomId !== null) void loadNewer(api, roomId);
  }, [api, roomId]);
  const onLetGo = useCallback(
    (first: MessageId, last: MessageId) => {
      if (api && roomId !== null) trimHistory(api.baseUrl, roomId, first, last);
    },
    [api, roomId],
  );
  const onBackToNewest = useCallback(() => {
    if (api && roomId !== null) void leaveWindow(api, roomId);
  }, [api, roomId]);
  const mediaUrl = useCallback((path: string) => (api ? absoluteUrl(api.baseUrl, path) : path), [api]);

  const save = useCallback(
    async (message: Message, body: string) => {
      if (!api) throw new Error("This conversation isn't connected.");
      await editMessage(api, message, body).catch(rethrowInWords("Couldn't save the edit."));
    },
    [api],
  );
  const remove = useCallback(
    async (message: Message) => {
      if (!api) throw new Error("This conversation isn't connected.");
      await deleteMessage(api, message).catch(rethrowInWords("Couldn't delete it."));
    },
    [api],
  );
  const pin = useCallback(
    async (message: Message, pinned: boolean) => {
      if (!api) throw new Error("This conversation isn't connected.");
      await pinMessage(api, message, pinned).catch(rethrowInWords(pinned ? "Couldn't pin it." : "Couldn't take the pin off."));
    },
    [api],
  );
  const download = useCallback((file: Attachment) => openExternalChecked(mediaUrl(file.url)), [mediaUrl]);
  const wantCards = useCallback(
    (urls: readonly string[]) => {
      if (api) wantPreviews(api, [...urls]);
    },
    [api],
  );
  // A name in a conversation opens that person's card (PPL-6), the same card
  // the list shows, beside the name. Your own opens yours, as friends see it
  // (#271).
  const [card, setCard] = useState<{ server: string; userId: string; anchor: { top: number; bottom: number; left: number } } | null>(null);
  // The name that opened it gets the keyboard back when it closes.
  const cardOpener = useRef<HTMLElement | null>(null);
  const activeNow = useRef(active);
  activeNow.current = active;
  const openPerson = useCallback((user: User, anchor: { top: number; bottom: number; left: number }) => {
    const showing = activeNow.current;
    if (!showing) return;
    cardOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCard({ server: showing.server, userId: user.id, anchor });
  }, []);
  const closeCard = useCallback(() => {
    setCard(null);
    if (cardOpener.current?.isConnected) cardOpener.current.focus();
  }, []);
  // Report to the host (T-1605): nobody to send one to when you're the host.
  const host = state ? hostName(state) : null;
  // It reaches co-hosts too, when there are any (#424).
  const cohosts = state ? reportsReachCohosts(state) : false;
  const report = useMemo(
    () =>
      api && host !== null
        ? {
            host,
            cohosts,
            send: (message: Message, note: string | null) =>
              said(sendReport(api, note === null ? { message_id: message.id } : { message_id: message.id, note }), "Couldn't send the report."),
          }
        : undefined,
    [api, host, cohosts],
  );
  const actions = useMemo(
    () => ({ save, remove, pin, openLink: openExternal, download, wantCards, openPerson, report }),
    [save, remove, pin, download, wantCards, openPerson, report],
  );

  const { files, onAttach, onRemoveFile, onRestoreFiles, onSend } = useFileDrafts(api, paneId, apis, find);
  const onTyping = useCallback(() => {
    if (api && roomId !== null) startedTyping(api, roomId);
  }, [api, roomId]);
  const voiceMessage = useVoiceMessages(paneId, apis, find);
  const composer = useMemo(
    // On the phone the cursor goes in the box when it's tapped: putting it there
    // on opening raises the keyboard over half the conversation (SPEC §4.15).
    () => ({ files, onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping, focusRequest: onPhone() ? undefined : focusAsk, seed, onDraft, keep, clipboardImage: clipboardImageReader(), voiceMessage }),
    [files, onAttach, onRemoveFile, onRestoreFiles, onSend, onTyping, focusAsk, seed, onDraft, keep, voiceMessage],
  );

  const knock = useCallback(
    (user: User) => {
      if (!api) return;
      // Each step replaces the last, and a step's timer clears only itself,
      // so an old timer never ends a newer knock early.
      const step = (now: HeaderKnockNow, forMs?: number) => {
        setKnocks((held) => new Map(held).set(user.id, now));
        if (forMs === undefined) return;
        window.setTimeout(
          () =>
            setKnocks((held) => {
              if (held.get(user.id) !== now) return held;
              const next = new Map(held);
              next.delete(user.id);
              return next;
            }),
          forMs,
        );
      };
      step({ phase: "knocking" });
      // "Knocked" only once the server has taken it: a refused knock (three
      // an hour, SPEC §4.9) never says it, and says why instead (#288).
      void knockOn(api, user.id).then((result) =>
        result.ok ? step({ phase: "knocked" }, KNOCKED_MS) : step({ phase: "idle", problem: result.problem }, REFUSED_MS),
      );
    },
    [api],
  );

  const onJoin = useCallback(() => {
    if (active) void intend({ kind: "voice.join", server: active.server, roomId: active.roomId }).catch(() => undefined);
  }, [active, intend]);
  // A system default that wouldn't open is fixed by picking a device by name (#273).
  const onPickDevice = useCallback(() => void intend({ kind: "settings", section: "sound" }).catch(() => undefined), [intend]);
  // Your voice controls in the room you're in voice in (#216): the list
  // window owns the seat and makes the change.
  const onMute = useCallback((muted: boolean) => voiceControl({ control: "mute", on: muted }), [voiceControl]);
  const onDeafen = useCallback((deafened: boolean) => voiceControl({ control: "deafen", on: deafened }), [voiceControl]);
  const onLeave = useCallback(() => voiceControl({ control: "leave" }), [voiceControl]);

  const pane = ((): ChatPane | null => {
    if (!active || !state || !room || paneId === null) return null;
    const dm = room.kind === "dm";
    const others = dm ? dmPeople(state, room) : [];
    const [only] = others;
    const header: ChatPane["header"] = dm
      ? {
          kind: "dm",
          label: dmLabel(room, state.users, state.me?.id ?? null),
          people: others,
          knock:
            others.length === 1 && only
              ? {
                  onKnock: () => knock(only.user),
                  phase: knocks.get(only.user.id)?.phase ?? "idle",
                  problem: knocks.get(only.user.id)?.problem ?? null,
                  // Offline, Knock stays in the header, greyed out, and says why (#288).
                  unavailable: only.state === "offline" ? knockOfflineLine(only.user.display_name) : undefined,
                }
              : undefined,
          server: several ? serverTag(active.server) : undefined,
          // Beside the list, a one-to-one DM's header is their card (#351).
          person: others.length === 1 && only ? { note: personRow(state, only.user.id, now)?.note ?? "" } : undefined,
        }
      : { kind: "room", name: room.name, topic: room.topic, people: peopleInRoom(state, room.id), server: several ? serverTag(active.server) : undefined };
    return {
      id: paneId,
      header,
      // The phone is text only for now (SPEC §4.15): no voice line to join from.
      voice: onPhone() ? null : {
        strip: voiceStrip(paneId, voiceHere(state, room.id), state.me?.id ?? null, voiceTab, infos[active.server]?.voice !== false),
        onJoin,
        onPickDevice,
        mics: micsHere(state, room.id),
        controls:
          state.myVoice?.roomId === room.id
            ? { muted: state.myVoice.muted, deafened: state.myVoice.deafened, onMute, onDeafen, onLeave }
            : undefined,
        // The last try at starting voice here failed (#261): the strip says why.
        failed:
          state.voiceFailed?.roomId === room.id
            ? {
                ...voiceStartProblem(state.voiceFailed.problem, onWindows(), state.voiceFailed.devices),
                detail: state.voiceFailed.problem,
              }
            : undefined,
        // The host took us out of voice here (#423): the strip says so.
        takenOut: state.voiceTakenOut === room.id && state.myVoice?.roomId !== room.id,
      },
      people,
      me: state.me,
      blocked: new Set(state.blocked),
      speaking: talking,
      typing: typingIn(state, room.id, typingNow),
      mentionable,
      stream: {
        messages,
        pending,
        atStart: stream?.atStart ?? false,
        atEnd: stream?.atEnd ?? true,
        leftOff: state.leftOff[room.id] ?? null,
        land,
        now,
        previews,
        mediaUrl,
        onNearStart,
        onNearEnd,
        onSeenNewest: read,
        onLetGo,
        onBackToNewest,
        goTo: goTo !== null && goTo.tab === paneId ? goTo.id : null,
        onWentTo,
      },
      actions,
      composer,
    };
  })();

  const cardState = card ? servers[card.server] : undefined;
  const cardRow = card && cardState ? personRow(cardState, card.userId, now) : null;
  const messageFromCard = async (server: string, user: User) => {
    const cardApi = apis.get(server);
    if (!cardApi) return;
    try {
      // The server finds the DM you already have, or makes it (SPEC §4.13).
      const dm = await cardApi.openDm([user.id]);
      noteDm(server, dm);
      setCard(null);
      show(server, dm.id);
    } catch (error: unknown) {
      console.error("could not open a DM", error);
    }
  };

  const cardView =
    card && cardRow ? (
      <PersonCard
        key={`${card.server} ${card.userId}`}
        user={cardRow.user}
        state={cardRow.state}
        note={cardRow.note}
        anchor={card.anchor}
        onClose={closeCard}
        {...(cardRow.user.id === cardState?.me?.id
          ? {
              // Your own card (#271): Settings → Profile, through the list window.
              onEditProfile: () => {
                closeCard();
                void intend({ kind: "settings", section: "profile" }).catch(() => undefined);
              },
            }
          : {
              onMessage: () => void messageFromCard(card.server, cardRow.user),
              onKnock: () => {
                const cardApi = apis.get(card.server);
                return cardApi ? knockOn(cardApi, cardRow.user.id) : Promise.resolve({ ok: false, problem: "You're not signed in to that server any more." });
              },
              safety: (() => {
                const cardApi = apis.get(card.server);
                return cardApi && cardState ? cardSafety(cardApi, cardState, cardRow.user) : undefined;
              })(),
            })}
      />
    ) : null;

  return { pane, card: cardView, servers, several, serverTag, tabItem, goToMessage, askFocus, seedDraft, draftOf };
}

/** A window of its own asks the list window, and plays the sound it answers with (#241). */
function askTheList(press: VoiceControlQuestion): void {
  void pressVoiceControl(tauriBus(), press);
}

/** A store or network failure, as a sentence for the message it was about. */
function rethrowInWords(fallback: string): (error: unknown) => never {
  return (error: unknown) => {
    throw new Error(error instanceof ApiError || error instanceof TransportError ? error.message : fallback);
  };
}
