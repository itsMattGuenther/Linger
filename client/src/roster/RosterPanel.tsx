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
 * **On a narrow window it becomes a horizontal strip above the composer**, and
 * it is never hidden. Same component, same cards, laid out along instead of
 * down; `lib/layout.ts` owns the one number that decides which.
 */
import { useMemo, useState } from "react";

import type { Room } from "../generated/Room";
import type { User } from "../generated/User";
import type { UserId } from "../generated/UserId";
import { ApiError, type AuthedApi } from "../lib/api";
import { useNow } from "../lib/clock";
import { useGateway } from "../lib/gateway";
import { dmWhere } from "../dm/dm";
import { nameProps, personStyle } from "../lib/names";
import NotifyRules from "../notify/NotifyRules";
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
import "./roster.css";

/** Down the right-hand side, or along the top of the composer. */
export type RosterLayout = "column" | "strip";

export default function RosterPanel({
  api,
  rooms,
  layout,
  onOpenDm,
}: {
  api: AuthedApi;
  rooms: Room[];
  layout: RosterLayout;
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
  // The panel has two modes: who is around, and who you want to hear from.
  // The rules are a list of people too, and a settings screen for one setting
  // would be a screen too many.
  const [notifying, setNotifying] = useState(false);
  // Writing your own. A third mode rather than a form inside your card: in a
  // narrow window the cards are chips in a strip, and a chip is not a form.
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
    <aside className="roster" data-layout={layout}>
      <div className="roster-head">
        <h2 className="panel-label">{headingFor(notifying, showEditor)}</h2>
        <button
          type="button"
          className="roster-switch meta"
          aria-expanded={notifying || editing}
          onClick={() => {
            if (editing) setEditing(false);
            else setNotifying((held) => !held);
          }}
        >
          {editing || notifying ? "done" : "notify"}
        </button>
      </div>
      {showEditor && me !== null ? (
        <div className="roster-editor">
          <StatusEditor api={api} me={me} onDone={() => setEditing(false)} />
        </div>
      ) : notifying ? (
        <div className="roster-notify">
          <NotifyRules api={api} rooms={rooms} />
        </div>
      ) : entries.length === 0 ? (
        <p className="placeholder">{emptyRoster(gateway.status.kind === "ready")}</p>
      ) : (
        <ul className="roster-list">
          {entries.map((entry) => (
            <PersonCard
              key={entry.user.id}
              api={api}
              entry={entry}
              now={now}
              // Host-only, and absent rather than greyed out for everybody
              // else — the same rule the host panel follows (T-410). The lock
              // is the endpoint, which answers FORBIDDEN either way.
              canRemove={(me?.is_host ?? false) && !entry.isMe}
              onOpenDm={onOpenDm}
              users={users}
              meId={me?.id ?? null}
              open={open === entry.user.id}
              onToggle={() =>
                setOpen((held) => (held === entry.user.id ? null : entry.user.id))
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
  canRemove,
  onOpenDm,
  users,
  meId,
  open,
  onToggle,
  onEdit,
}: {
  api: AuthedApi;
  entry: RosterEntry;
  now: number;
  canRemove: boolean;
  /** For naming a DM somebody is standing in — it has no name of its own. */
  users: User[];
  meId: UserId | null;
  onOpenDm: (userId: UserId) => Promise<void>;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const { user, state } = entry;
  // Knocking at somebody who has nothing open lands nowhere — the server holds
  // no knocks and there is nothing to deliver it to — so the control is absent
  // rather than present and useless (SPEC §4.9, T-1102).
  const canKnock = !entry.isMe && state !== "offline";
  // Unlike a knock, a DM works on somebody who is not here: it is a message,
  // and a message waits. That is the whole difference between the two controls
  // sitting next to each other.
  const canMessage = !entry.isMe;
  // A host can open anybody, whether or not they wrote a status: the way to
  // remove somebody is under here, and a card that will not open would hide it
  // for exactly the quiet people it is most likely to be needed for. The same
  // now goes for anybody you can knock at.
  const openable = hasStatus(entry) || entry.isMe || canRemove || canKnock || canMessage;
  const head = (
    <>
      {/* The dot is decoration; the word beside it is what a screen reader
          reads, so presence is never carried by color alone. */}
      <span className="person-dot" data-state={state} aria-hidden="true" />
      <span {...nameProps(user, "person-name")}>
        {user.display_name}
      </span>
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
        <button type="button" className="person-head" aria-expanded={open} onClick={onToggle}>
          {head}
        </button>
      ) : (
        <p className="person-head">{head}</p>
      )}
      <PersonLines entry={entry} users={users} meId={meId} now={now} />
      {open ? (
        <>
          {/* The away message is already on the lines above, so the card
              leaves the status line out rather than saying it twice. */}
          <StatusCard user={user} awayShown={entry.awayMessage !== null && entry.awayMessage !== ""} />
          {entry.isMe ? (
            <p className="person-mine">
              {hasStatus(entry) ? null : <span className="meta">nothing set</span>}
              <button type="button" className="person-edit meta" onClick={onEdit}>
                edit
              </button>
            </p>
          ) : (
            <>
              {canMessage ? <MessageButton user={user} onOpenDm={onOpenDm} /> : null}
              {canKnock ? <KnockButton api={api} user={user} /> : null}
              {canRemove ? <Removal api={api} user={user} /> : null}
            </>
          )}
        </>
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
}: {
  user: User;
  onOpenDm: (userId: UserId) => Promise<void>;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const start = async (): Promise<void> => {
    setOpening(true);
    setProblem(null);
    try {
      await onOpenDm(user.id);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Couldn't open that.");
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
          {opening ? "opening…" : "message"}
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
 * Afterwards it says so and stops, and the "knocked" is the end of it: there is
 * no delivery report, because the server does not keep one. If they were not
 * connected it landed nowhere, and that is the same as knocking on a door with
 * nobody behind it.
 *
 * Being refused is the interesting case. Three an hour, per person, is a rule
 * about not nagging somebody, so the refusal is said in those words rather than
 * as the server's generic "slow down".
 */
function KnockButton({ api, user }: { api: AuthedApi; user: User }) {
  const [phase, setPhase] = useState<"idle" | "knocking" | "knocked">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  const knock = async (): Promise<void> => {
    setPhase("knocking");
    setProblem(null);
    try {
      await api.knock(user.id);
      setPhase("knocked");
    } catch (error) {
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
          {phase === "idle" ? "knock" : phase === "knocking" ? "knocking…" : "knocked"}
        </button>
      </p>
      {problem === null ? null : <p className="person-host-note">{problem}</p>}
    </div>
  );
}

/**
 * The host's one destructive control, on the card of the person it is about
 * (T-413).
 *
 * "Remove from the server", never kick and never ban — SPEC §1's vocabulary,
 * and there is no ban to offer: it would need something durable to ban by, and
 * Linger stores no addresses and no device ids. Two steps, because the card is
 * a thing you open to read and a single click here would be a person gone.
 *
 * Nothing is reset on success: the server fans out `user.remove`, the store
 * drops them from `users`, and this card is unmounted with them.
 */
function Removal({ api, user }: { api: AuthedApi; user: User }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.removeUser(user.id);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : "Couldn't remove them.");
      setBusy(false);
      setAsking(false);
    }
  };

  return (
    <div className="person-host">
      {asking ? (
        <>
          {/* Said before the click rather than apologised for after it. The
              part people get wrong is the reversibility, so lead with that. */}
          <p className="person-host-note meta">
            They lose their sign-in and any invite links they made. What they wrote stays. You can
            let them back in from the host panel.
          </p>
          <p className="person-mine">
            <button
              type="button"
              className="person-edit person-danger meta"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "removing…" : "yes, remove"}
            </button>
            <button
              type="button"
              className="person-edit meta"
              disabled={busy}
              onClick={() => setAsking(false)}
            >
              keep them
            </button>
          </p>
        </>
      ) : (
        <p className="person-mine">
          <button
            type="button"
            className="person-edit meta"
            onClick={() => {
              setProblem(null);
              setAsking(true);
            }}
          >
            remove from the server
          </button>
        </p>
      )}
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
  const stateLine = state === "idle" || state === "away" ? stateWord(state) : null;

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
            {away === null ? null : <span className="person-away">“{away}”</span>}
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
  if (entry.state === "away" && awaySince !== null) return shortAgo(awaySince, now);
  return null;
}

/** What the panel is currently for. Three modes, one label. */
function headingFor(notifying: boolean, editing: boolean): string {
  if (editing) return "your status";
  if (notifying) return "notify me when";
  return "who’s around";
}
