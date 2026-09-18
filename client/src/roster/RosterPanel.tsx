/**
 * Who's around: the card stack, and the thesis of the whole app (SPEC §3).
 *
 * Discord puts people in a gutter. Linger puts them on the right-hand panel and
 * gives each of them a card: their name in their own styling, a presence dot,
 * the room they are in, what they are doing if they chose to share it, and their
 * status underneath. People who are gone stay on the stack with when they were
 * last here and whatever they left as an away message. An empty server should
 * still read as a house with the lights on, and this panel is the only thing
 * that can do that.
 *
 * Three rules it follows.
 *
 * **Nothing here is a count** (SPEC §4.2). Cards are cards; there is no "3
 * online", and the durations are how long ago, never how many.
 *
 * The wire type has no field for one, so this file could not render one if it
 * wanted to — which is the point of putting the rule in the type.
 *
 * Narrow windows open this same card stack from the People button.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { User } from "../generated/User";
import type { UserId } from "../generated/UserId";
import { ApiError, type AuthedApi } from "../lib/api";
import { useNow } from "../lib/clock";
import { useGateway } from "../lib/gateway";
import { dmWhere } from "../dm/dm";
import { nameProps, personStyle } from "../lib/names";
import StatusCard from "../status/StatusCard";
import StatusEditor from "../status/StatusEditor";
import { emptyRoster } from "../settings/copy";
import {
  buildRoster,
  hasStatus,
  type RosterEntry,
  shortAgo,
  stateWord,
} from "./roster";
import { usersInVoice } from "../voice/voice";
import ContextPanel from "../lib/ContextPanel";
import Button from "../lib/Button";
import "./roster.css";

export default function RosterPanel({
  api,
  onOpenDm,
}: {
  api: AuthedApi;
  /**
   * Start (or find) a DM with this person and open it (SPEC §4.13, T-1302).
   *
   * The roster is where it starts because a DM is about a person, and their
   * card is the only place in the app that is. The frame owns what happens
   * next — which room is open is its state, not this panel's.
   */
  onOpenDm: (userId: UserId) => Promise<void>;
}) {
  const gateway = useGateway(api.baseUrl);
  const now = useNow();
  // Writing your own status replaces the card stack until you finish.
  const [editing, setEditing] = useState(false);
  // One card open at a time. Two open cards is a list of statuses, which is a
  // different panel and a worse one.
  const [open, setOpen] = useState<string | null>(null);

  const { users, presence, me, offlineAt } = gateway;
  // Rooms *and* DMs: presence names whichever a person is standing in, and a
  // room this client cannot look up draws as a vague "in a room". The server
  // only ever names a DM to somebody who is in it (PROTOCOL §8), so nothing
  // private arrives here to be looked up in the first place.
  const allRooms = useMemo(
    () => [...gateway.rooms, ...gateway.dms],
    [gateway.rooms, gateway.dms],
  );
  const entries = useMemo(
    () =>
      buildRoster({
        users,
        presence,
        // Every room, not just the unarchived ones: if somebody is standing in
        // a room that was archived under them, the card should say where.
        rooms: allRooms,
        meId: me?.id ?? null,
        offlineAt,
        now,
        inVoice: usersInVoice(gateway.voice),
      }),
    [users, presence, allRooms, me?.id, offlineAt, now, gateway.voice],
  );

  // `me` is null until the first `ready`, and goes null again if the connection
  // resets under an open editor. The heading and the body have to agree about
  // that, or the panel says "your status" over the card stack.
  const showEditor = editing && me !== null;

  return (
    <aside className="roster" id="people-panel" aria-label="People">
      <div className="roster-head">
        <h2 className="panel-label">
          {showEditor ? "your status" : "who’s around"}
        </h2>
        {editing ? (
          <button
            type="button"
            className="roster-switch meta"
            onClick={() => setEditing(false)}
          >
            done
          </button>
        ) : null}
      </div>
      {showEditor && me !== null ? (
        <div className="roster-editor">
          <StatusEditor api={api} me={me} onDone={() => setEditing(false)} />
        </div>
      ) : entries.length === 0 ? (
        <p className="placeholder">
          {emptyRoster(gateway.status.kind === "ready")}
        </p>
      ) : (
        <ul className="roster-list">
          {entries.map((entry) => (
            <PersonCard
              key={entry.user.id}
              api={api}
              entry={entry}
              now={now}
              onOpenDm={onOpenDm}
              users={users}
              meId={me?.id ?? null}
              open={open === entry.user.id}
              onToggle={() =>
                setOpen((held) =>
                  held === entry.user.id ? null : entry.user.id,
                )
              }
              onClose={() =>
                setOpen((held) => (held === entry.user.id ? null : held))
              }
              onEdit={() => setEditing(true)}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * One person.
 *
 * The head is a button only when there is something under it. An affordance
 * that does nothing is worse than no affordance, and most cards, most of the
 * time, have nothing to open.
 *
 * Your own card is the exception: it opens whether or not you have written
 * anything, because "edit" is under there and a blank status would otherwise
 * have no way in.
 */
function PersonCard({
  api,
  entry,
  now,
  onOpenDm,
  users,
  meId,
  open,
  onToggle,
  onClose,
  onEdit,
}: {
  api: AuthedApi;
  entry: RosterEntry;
  now: number;
  /** For naming a DM somebody is standing in — it has no name of its own. */
  users: User[];
  meId: UserId | null;
  onOpenDm: (userId: UserId) => Promise<void>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { user, state } = entry;
  const trigger = useRef<HTMLButtonElement | null>(null);
  // Knocking at somebody who has nothing open lands nowhere — the server holds
  // no knocks and there is nothing to deliver it to — so the control is absent
  // rather than present and useless (SPEC §4.9, T-1102).
  const canKnock = !entry.isMe && state !== "offline";
  // Unlike a knock, a DM works on somebody who is not here: it is a message,
  // and a message waits. That is the whole difference between the two controls
  // sitting next to each other.
  const canMessage = !entry.isMe;
  // Every ordinary member can open a card to start a conversation.
  const openable = hasStatus(entry) || entry.isMe || canKnock || canMessage;
  const head = (
    <>
      {/* The dot is decoration; the word beside it is what a screen reader
          reads, so presence is never carried by color alone. */}
      <span className="person-dot" data-state={state} aria-hidden="true" />
      <span {...nameProps(user, "person-name")}>{user.display_name}</span>
      <span className="sr-only">{stateWord(state)}</span>
      {entry.isMe ? <span className="person-you meta">you</span> : null}
    </>
  );

  return (
    <li
      className="person"
      data-state={state}
      data-open={open ? "true" : undefined}
      style={personStyle(user)}
    >
      {openable ? (
        <button
          ref={trigger}
          type="button"
          className="person-head"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={onToggle}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!open) onToggle();
          }}
        >
          {head}
        </button>
      ) : (
        <p className="person-head">{head}</p>
      )}
      <PersonLines entry={entry} users={users} meId={meId} now={now} />
      {entry.awayMessage === null && user.status?.line ? (
        <p className="person-preview">{user.status.line}</p>
      ) : null}
      {open && trigger.current ? (
        <ContextPanel
          anchor={trigger.current}
          label={`${user.display_name}'s profile`}
          side="left"
          className="member-panel"
          onClose={onClose}
        >
          <div className="member-identity">
            <h3 {...nameProps(user, "context-name")}>{user.display_name}</h3>
            <p className="context-hint">@{user.username}</p>
          </div>
          <PersonLines entry={entry} users={users} meId={meId} now={now} />
          {/* The away message is already on the lines above, so the card
              leaves the status line out rather than saying it twice. */}
          <StatusCard
            user={user}
            awayShown={entry.awayMessage !== null && entry.awayMessage !== ""}
            baseUrl={api.baseUrl}
          />
          {entry.isMe ? (
            <p className="person-mine">
              {hasStatus(entry) ? null : (
                <span className="meta">nothing set</span>
              )}
              <Button
                onClick={() => {
                  onClose();
                  onEdit();
                }}
              >
                Edit status
              </Button>
            </p>
          ) : (
            <div className="member-actions">
              {canMessage ? (
                <MessageButton
                  user={user}
                  onOpenDm={onOpenDm}
                  onDone={onClose}
                />
              ) : null}
              {canKnock ? <KnockButton api={api} user={user} /> : null}
            </div>
          )}
        </ContextPanel>
      ) : null}
    </li>
  );
}

/**
 * Start a DM with this person (SPEC §4.13, T-1302).
 *
 * One control, no dialog, no "who else?" step. Create-or-find on the server
 * means pressing it twice is the same as pressing it once — you land in the
 * conversation you already had rather than starting a second one — so it needs
 * no confirmation and no guard against a double click.
 *
 * A group DM is not started from here. Three people is a different gesture and
 * this card knows about one person; building a picker onto it would put a form
 * inside a card, which the roster is already careful not to do.
 */
function MessageButton({
  user,
  onOpenDm,
  onDone,
}: {
  user: User;
  onOpenDm: (userId: UserId) => Promise<void>;
  onDone: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const start = async (): Promise<void> => {
    setOpening(true);
    setProblem(null);
    try {
      await onOpenDm(user.id);
      onDone();
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : "Couldn't open that.",
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="person-knock">
      <p className="person-mine">
        <button
          type="button"
          className="person-edit meta"
          disabled={opening}
          onClick={() => void start()}
        >
          {opening ? "Opening…" : "Message"}
        </button>
      </p>
      {problem === null ? null : <p className="person-host-note">{problem}</p>}
    </div>
  );
}

/**
 * The knock (SPEC §4.9, T-1102): one control, on the card of the person it is
 * about.
 *
 * One click, no confirmation. A knock is the smallest thing you can send
 * somebody and it costs them a card that fades — asking "are you sure" about
 * that would make it feel like more than it is.
 *
 * The brief "knocked" feedback acknowledges the request, not delivery. It
 * clears after three seconds; the server still enforces the hourly limit.
 * If they were not connected it landed nowhere. No knock history is retained.
 *
 * Being refused is the interesting case. Three an hour, per person, is a rule
 * about not nagging somebody, so the refusal is said in those words rather than
 * as the server's generic "slow down".
 */
export function KnockButton({ api, user }: { api: AuthedApi; user: User }) {
  // A late answer belongs to the old card, never another server or person.
  return (
    <KnockAction key={`${api.baseUrl}:${user.id}`} api={api} user={user} />
  );
}

function KnockAction({ api, user }: { api: AuthedApi; user: User }) {
  const [phase, setPhase] = useState<"idle" | "knocking" | "knocked">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== "knocked") return;
    const timer = window.setTimeout(() => setPhase("idle"), 3000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const knock = async (): Promise<void> => {
    setPhase("knocking");
    setProblem(null);
    try {
      await api.knock(user.id);
      if (!mounted.current) return;
      setPhase("knocked");
    } catch (error) {
      if (!mounted.current) return;
      setPhase("idle");
      setProblem(
        error instanceof ApiError && error.code === "RATE_LIMITED"
          ? "That's three this hour. Give them a bit."
          : error instanceof ApiError
            ? error.message
            : "Couldn't knock.",
      );
    }
  };

  return (
    <div className="person-knock">
      <p className="person-mine">
        <button
          type="button"
          className="person-edit meta"
          disabled={phase !== "idle"}
          onClick={() => void knock()}
        >
          {phase === "idle"
            ? "Knock"
            : phase === "knocking"
              ? "Knocking…"
              : "Knocked"}
        </button>
      </p>
      {problem === null ? null : <p className="person-host-note">{problem}</p>}
    </div>
  );
}

/**
 * Where they are, what they are doing, and how long it has been.
 *
 * Order matters twice over: it is reading order, and on a narrow window the
 * strip shows only the first of these lines, so the most locating one has to
 * come first.
 */
function PersonLines({
  entry,
  users,
  meId,
  now,
}: {
  entry: RosterEntry;
  users: User[];
  meId: UserId | null;
  now: number;
}) {
  const { state, room, awayMessage } = entry;

  // "around" says nothing here on purpose — the dot has already said it, and a
  // card that spends a line on "around" is a card that says less.
  //
  // A DM is named by who is in it rather than by a slug (SPEC §4.13), and only
  // ever reaches this line for somebody who is in it: the server sends `null`
  // for the room to everybody else, so `room` is null and this says nothing.
  const where =
    state === "in_room"
      ? room === null
        ? "in a room"
        : room.kind === "dm"
          ? dmWhere(room, users, entry.user.id, meId)
          : `in #${room.slug}`
      : null;
  const stateLine =
    state === "idle" || state === "away" ? stateWord(state) : null;

  const since = sinceOf(entry, now);
  const away = awayMessage === null || awayMessage === "" ? null : awayMessage;

  return (
    <div className="person-lines">
      {where !== null || stateLine !== null || entry.inVoice ? (
        <p className="person-where">
          {where ?? stateLine}
          {/* A microphone on is said in a word, at the weight of "in a
              room" (SPEC §4.14): no badge, no icon, no colour. */}
          {entry.inVoice ? (
            <span className="person-voice meta">
              {where !== null || stateLine !== null ? " · " : ""}voice
            </span>
          ) : null}
        </p>
      ) : null}
      {/* Gone, and what they left behind: SPEC §3 draws these on one line. */}
      {state === "offline" ? (
        since === null && away === null ? null : (
          <p className="person-gone">
            {since === null ? null : <span className="meta">{since}</span>}
            {away === null ? null : (
              <span className="person-away">“{away}”</span>
            )}
          </p>
        )
      ) : (
        <>
          {since === null ? null : <p className="person-since meta">{since}</p>}
          {away === null ? null : <p className="person-away">“{away}”</p>}
        </>
      )}
    </div>
  );
}

/**
 * The one duration on a card, and what it is counting.
 *
 * Gone: how long since we saw them. Away: since they said so. Here: how long
 * they have been in whatever they are in. There is never more than one, because
 * a card with three durations on it is a card nobody reads.
 */
function sinceOf(entry: RosterEntry, now: number): string | null {
  if (entry.state === "offline") {
    return entry.seenAt === null ? null : shortAgo(entry.seenAt, now);
  }
  const awaySince = entry.user.status?.away_since ?? null;
  if (entry.state === "away" && awaySince !== null)
    return shortAgo(awaySince, now);
  return null;
}
