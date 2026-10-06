import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CardSafety } from "../../core/safety";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import { hostsHere } from "../../../lib/host";
import { type DmRow, type ListModel, type PersonRow, type RoomRow, splitPeople, splitRooms } from "../../core/list";
import { onPhone } from "../../core/phone";
import { Button, IconButton, MarkerCluster, Name, Row, RowList, SectionLabel, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import { useOneLine } from "../useOneLine";
import "./ListView.css";
import { NewDmPicker } from "./NewDmPicker";
import { knockOfflineLine, type KnockResult } from "../../core/knock";
import { PersonCard } from "./PersonCard";

/** How long a knocked row rests before it can knock again (SPEC §4.9). */
const KNOCKED_MS = 3_000;

/** What one server's part of the list can do. */
export interface ServerBodyActions {
  onOpenRoom?: (id: RoomId) => void;
  onOpenDm?: (id: RoomId) => void;
  /**
   * A person clicked in the list (#351): them beside the list, card on top and
   * your conversation under it, as a preview the next person takes over.
   * `dm` is your DM with them, when you have one.
   */
  onOpenPerson?: (user: User, dm: RoomId | null) => void;
  /** From a person's card: open a DM with them (finding the one you already have). */
  onMessage?: (user: User) => void;
  /** From a person's card: knock (SPEC §4.9). */
  onKnock?: (user: User) => Promise<KnockResult>;
  /** From a person's card: report and block them (T-1605); nothing for you. */
  safetyFor?: (user: User) => CardSafety | undefined;
  /**
   * For the host, while a report is open (T-1605): one lit row at the top,
   * "A report to look at", that opens them. Never how many.
   */
  onReports?: () => void;
  /** From the picker the + on Rooms opens: open the DM with exactly these people; resolves to a problem in words, or null. */
  onStartDm?: (people: User[]) => Promise<string | null>;
  /** The host's way from an empty place to Settings → Hosting (decision 17). */
  onHost?: (section: "rooms" | "invites") => void;
  /** The conversation showing beside the list, on this server: its row, or its person's, is marked (#351). */
  showing?: RoomId | null;
}

type Fold = "rooms" | "more" | "people" | "away" | "others" | "offline";

/**
 * The most dots a room's row shows (#197): a full raid looks full, still
 * with no number, as a folded server's header does. A room's name gives way
 * first, ending in "…".
 */
const ROOM_DOTS = 16;

/**
 * One server's places and people (docs/design/buddy-list.md, #351): its
 * rooms with your group DMs after them, then everyone on it, each person
 * once, their DM with you on their row. The whole list with one server, a
 * server's section with several. The person card and the picker for a new
 * group are its own, so each server's are about that server's people.
 *
 * `idPrefix` keeps the ids inside unique when several servers share a window
 * (empty with one server); `serverName`, with several, says which server a
 * list or button belongs to, for assistive technology.
 */
export function ServerBody({
  model,
  speaking,
  idPrefix = "",
  serverName,
  onOpenRoom,
  onOpenDm,
  onOpenPerson,
  onMessage,
  onKnock,
  safetyFor,
  onReports,
  onStartDm,
  onHost,
  showing = null,
}: ServerBodyActions & {
  model: ListModel;
  /** Who is talking right now, for the voice glyphs. */
  speaking?: ReadonlySet<string>;
  idPrefix?: string;
  serverName?: string;
}) {
  // Offline, the quiet rooms past eight (decision 22) and, on a big server,
  // everyone you don't talk to (#197) start folded; everything else starts open.
  const [folded, setFolded] = useState<ReadonlySet<Fold>>(() => new Set<Fold>(["offline", "more", "others"]));
  // One line per person, a choice in Settings → Appearance (#197). The
  // phone's rows are sized for a thumb, so it keeps two.
  const oneLine = useOneLine() && !onPhone();
  // The host or a co-host (#424): the ways from an empty place to Hosting.
  const host = hostsHere(model.me?.user);
  const toggle = (fold: Fold) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(fold)) next.delete(fold);
      else next.add(fold);
      return next;
    });
  const open = (fold: Fold) => !folded.has(fold);
  const talking = (user: User) => speaking?.has(user.id) ?? false;
  const id = (fold: Fold) => `nx-${idPrefix}${fold}`;
  const on = (words: string) => (serverName ? `${words} on ${serverName}` : words);

  // The card that is open, the row it came from, and where that row was.
  const [card, setCard] = useState<{ row: PersonRow; anchor: { top: number; bottom: number }; problem?: string } | null>(null);
  // Who was just knocked, for three seconds: their row gives a shake, and its
  // Knock button rests (SPEC §4.9: an acknowledgement, not a record).
  const [knocked, setKnocked] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const held = timers.current;
    return () => {
      for (const timer of held) window.clearTimeout(timer);
    };
  }, []);
  const knockedOn = (userId: string) => {
    setKnocked((held) => new Set(held).add(userId));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setKnocked((held) => {
        const next = new Set(held);
        next.delete(userId);
        return next;
      });
    }, KNOCKED_MS);
    timers.current.add(timer);
  };
  const knock = async (user: User): Promise<KnockResult> => {
    const result = (await onKnock?.(user)) ?? { ok: false, problem: "Knocking isn't available here." };
    if (result.ok) knockedOn(user.id);
    return result;
  };
  const opener = useRef<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState<{ bottom: number } | null>(null);
  const pickerOpener = useRef<HTMLButtonElement | null>(null);
  const everyone = [...model.people.here, ...model.people.away, ...model.people.offline];
  // The open card follows the person as they come and go (#288): coming
  // online brings Knock back while their card is open.
  const cardRow = card ? (everyone.find((row) => row.user.id === card.row.user.id) ?? card.row) : null;
  const closeCard = () => {
    setCard(null);
    // Focus goes back to the row that opened it.
    opener.current?.focus();
  };

  const person = (row: PersonRow) => (
    <Row
      key={row.user.id}
      lead={{ kind: "person", person: markerFor(row.user, row.state) }}
      lines={oneLine ? "one" : "two"}
      // The lights are on only for somebody here (#301): idle, away and
      // offline names are the dim grey, and their mark says which.
      title={<Name person={row.user} dim={row.state === "idle" || row.state === "away" || row.state === "offline"} />}
      // Written to you and not read: said in words too, never a count (SPEC §4.2).
      // One line per person has no second line, so the status goes in the words (#197).
      label={`${row.user.display_name}, ${row.note}${oneLine && row.line ? `, ${row.line}` : ""}${row.fresh ? ", wrote to you" : ""}`}
      trailing={row.inVoice ? <VoiceGlyph speaking={talking(row.user)} /> : undefined}
      note={row.note}
      detail={row.line ?? undefined}
      detailTip
      away={row.state === "away"}
      // Their DM with you lives on their row (#351): unread, it's lit (#291).
      lit={row.fresh}
      // Their card is open, or they're showing beside the list (#351).
      selected={card?.row.user.id === row.user.id || (showing !== null && row.dm === showing)}
      knocked={knocked.has(row.user.id)}
      actions={[
        // Their card, for a look at their fields without opening them (#351).
        <IconButton
          key="card"
          icon="card"
          size="sm"
          label={`${row.user.display_name}'s card`}
          onClick={(event) => {
            const rowButton = event.currentTarget.closest("li")?.querySelector<HTMLButtonElement>(".k-row-main") ?? null;
            if (!rowButton) return;
            opener.current = rowButton;
            const box = rowButton.getBoundingClientRect();
            setCard({ row, anchor: { top: box.top, bottom: box.bottom } });
          }}
        />,
        <IconButton
          key="knock"
          icon="knock"
          size="sm"
          label={knocked.has(row.user.id) ? `Knocked on ${row.user.display_name}'s door` : `Knock on ${row.user.display_name}'s door`}
          disabled={knocked.has(row.user.id)}
          // Offline, it stays greyed out and says why, on hover, on focus
          // and to a screen reader (#288).
          unavailable={row.state === "offline" ? knockOfflineLine(row.user.display_name) : undefined}
          onClick={(event) => {
            const rowButton = event.currentTarget.closest("li")?.querySelector<HTMLButtonElement>(".k-row-main") ?? null;
            void knock(row.user).then((result) => {
              // A knock that didn't go says why, on their card.
              if (result.ok || !rowButton) return;
              opener.current = rowButton;
              const box = rowButton.getBoundingClientRect();
              setCard({ row, anchor: { top: box.top, bottom: box.bottom }, problem: result.problem });
            });
          }}
        />,
      ]}
      // Them beside the list, card and conversation (#351).
      onActivate={() => {
        setCard(null);
        onOpenPerson?.(row.user, row.dm);
      }}
    />
  );

  // A group DM: a small private room, drawn with the rooms (#351).
  const groupRow = (dm: DmRow) => (
    <Row
      key={dm.id}
      lead={
        dm.people.length === 1 && dm.people[0]
          ? { kind: "person", person: markerFor(dm.people[0].user, dm.people[0].state) }
          : { kind: "group", people: dm.people.map(({ user, state }) => markerFor(user, state)) }
      }
      lines="one"
      title={dm.label}
      fresh={dm.fresh}
      // Addressed to you: unread, it's lit, not only bold (#291).
      lit={dm.fresh}
      selected={dm.id === showing}
      onActivate={onOpenDm ? () => onOpenDm(dm.id) : undefined}
    />
  );
  const rooms = splitRooms(model.rooms);
  const roomRow = (room: RoomRow) => (
    <Row
      key={room.id}
      lead={{ kind: "room" }}
      lines="one"
      title={room.name}
      fresh={room.fresh}
      selected={room.id === showing}
      label={roomLabel(room.name, room.people.length, room.voice)}
      end={
        room.people.length > 0 || room.voice ? (
          <span className="nx-list-room-end">
            {room.voice ? <VoiceGlyph speaking={room.people.some(talking)} /> : null}
            <MarkerCluster people={room.people.map((user) => markerFor(user, "in_room"))} max={ROOM_DOTS} />
          </span>
        ) : undefined
      }
      onActivate={onOpenRoom ? () => onOpenRoom(room.id) : undefined}
    />
  );
  const nobodyElse = model.people.here.length + model.people.away.length + model.people.offline.length === 0;
  // A big server (#197): the people you talk to, then everyone else folded.
  const split = splitPeople(model.people);

  return (
    <>
      {onReports ? (
        <RowList label={on("Reports")}>
          <Row lead={{ kind: "icon", icon: "flag" }} lines="one" title="A report to look at" lit label="A report to look at, in Settings, People" onActivate={onReports} />
        </RowList>
      ) : null}
      <SectionLabel
        label="Rooms"
        open={open("rooms")}
        onToggle={() => toggle("rooms")}
        controls={id("rooms")}
        // Folded, it's lit while a group DM inside hasn't been read (#291).
        lit={!open("rooms") && model.groups.some((group) => group.fresh)}
        action={
          onStartDm ? (
            <IconButton
              icon="plus"
              label={on("Start a group")}
              size="sm"
              onClick={(event) => {
                pickerOpener.current = event.currentTarget;
                setPicking({ bottom: event.currentTarget.getBoundingClientRect().bottom });
              }}
            />
          ) : undefined
        }
      />
      {open("rooms") ? (
        <div id={id("rooms")}>
          {model.rooms.length === 0 ? (
            <Empty words="No rooms yet." action={host && onHost ? { label: "Make the first room", run: () => onHost("rooms") } : undefined} />
          ) : null}
          {rooms.shown.length + model.groups.length > 0 ? (
            <RowList label={on("Rooms")}>
              {rooms.shown.map(roomRow)}
              {model.groups.map(groupRow)}
            </RowList>
          ) : null}
          {rooms.more.length > 0 ? (
            <>
              <SectionLabel label="More rooms" level="group" open={open("more")} onToggle={() => toggle("more")} controls={id("more")} />
              {open("more") ? (
                <div id={id("more")}>
                  <RowList label={on("More rooms")}>{rooms.more.map(roomRow)}</RowList>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <SectionLabel
        label="People"
        open={open("people")}
        onToggle={() => toggle("people")}
        controls={id("people")}
        // Folded, it's lit while somebody inside has written to you (#291, #351).
        lit={!open("people") && everyone.some((row) => row.fresh)}
      />
      {open("people") ? (
        <div id={id("people")}>
          {nobodyElse ? (
            <Empty words="Nobody else is here yet." action={host && onHost ? { label: "Invite people", run: () => onHost("invites") } : undefined} />
          ) : split ? (
            // Here and away together, each person's mark and note saying which.
            split.yours.length > 0 ? (
              <RowList label={on("People you talk to")}>{split.yours.map(person)}</RowList>
            ) : null
          ) : (
            <RowList label={on("People here")}>{model.people.here.map(person)}</RowList>
          )}
          {split && split.others.length > 0 ? (
            <>
              <SectionLabel label="Everyone else" level="group" open={open("others")} onToggle={() => toggle("others")} controls={id("others")} />
              <Group fold="others" rows={split.others} open={open("others")} id={id("others")} label={on("Everyone else")} person={person} />
            </>
          ) : null}
          {!split && model.people.away.length > 0 ? (
            <>
              <SectionLabel label="Away" level="group" open={open("away")} onToggle={() => toggle("away")} controls={id("away")} />
              <Group fold="away" rows={model.people.away} open={open("away")} id={id("away")} label={on("Away")} person={person} />
            </>
          ) : null}
          {model.people.offline.length > 0 ? (
            <>
              <SectionLabel label="Offline" level="group" open={open("offline")} onToggle={() => toggle("offline")} controls={id("offline")} />
              <Group fold="offline" rows={model.people.offline} open={open("offline")} id={id("offline")} label={on("Offline")} person={person} />
            </>
          ) : null}
        </div>
      ) : null}

      {picking && onStartDm ? (
        <NewDmPicker
          people={everyone}
          meId={model.me?.user.id ?? null}
          dms={model.dmMembers}
          anchor={picking}
          onStart={async (people) => {
            const problem = await onStartDm(people);
            if (problem === null) setPicking(null);
            return problem;
          }}
          onCancel={() => {
            setPicking(null);
            pickerOpener.current?.focus();
          }}
        />
      ) : null}

      {card && cardRow ? (
        <PersonCard
          key={cardRow.user.id}
          user={cardRow.user}
          state={cardRow.state}
          note={cardRow.note}
          anchor={card.anchor}
          onMessage={() => {
            onMessage?.(card.row.user);
            setCard(null);
          }}
          onKnock={() => knock(card.row.user)}
          safety={safetyFor?.(card.row.user)}
          onClose={closeCard}
          problem={card.problem ?? null}
        />
      ) : null}
    </>
  );
}

/**
 * A room row's accessible name. The markers are decoration, so the words say
 * who is in it and whether voice is on, without a number on screen (a count
 * spoken to a screen reader is allowed, AGENTS rule 3).
 */
function roomLabel(name: string, people: number, voice: boolean): string {
  const parts = [`#${name}`];
  if (people === 1) parts.push("one person in it");
  else if (people > 1) parts.push(`${people} people in it`);
  if (voice) parts.push("voice on");
  return parts.join(", ");
}

/**
 * Away, Everyone else (#197) or Offline under People. Folded, it still shows
 * anybody in it who has written to you and you haven't read (#351): a DM is
 * addressed to you, so folding a group never hides it.
 */
function Group({
  fold,
  rows,
  open,
  id,
  label,
  person,
}: {
  fold: Fold;
  rows: PersonRow[];
  open: boolean;
  id: string;
  label: string;
  person: (row: PersonRow) => ReactNode;
}) {
  const shown = open ? rows : rows.filter((row) => row.fresh);
  if (shown.length === 0) return null;
  return (
    <div id={open ? id : undefined} data-fold={fold}>
      <RowList label={label}>{shown.map(person)}</RowList>
    </div>
  );
}

/**
 * An empty place, said in one quiet line (decision 17), with the host's way
 * to fill it where there is one: "Make the first room", "Invite people".
 */
function Empty({ words, action }: { words: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="nx-list-empty-place">
      <p className="nx-list-empty">{words}</p>
      {action ? (
        <span className="nx-list-empty-action">
          <Button size="sm" variant="secondary" onClick={action.run}>
            {action.label}
          </Button>
        </span>
      ) : null}
    </div>
  );
}

