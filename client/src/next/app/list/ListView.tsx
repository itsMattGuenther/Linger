import { useRef, useState } from "react";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import type { ListModel, PersonRow } from "../../core/list";
import {
  IconButton,
  MarkerCluster,
  Name,
  Row,
  RowList,
  SectionLabel,
  TitleBar,
  VoiceGlyph,
} from "../../kit";
import { LogoMark } from "../LogoMark";
import { markerFor } from "../markers";
import "./ListView.css";
import { NewDmPicker } from "./NewDmPicker";
import { type KnockResult, PersonCard } from "./PersonCard";
import { type YouActions, YouCard } from "./YouCard";
import { VoiceDock, type VoiceDockProps } from "./VoiceDock";

export interface ListViewProps {
  serverName: string;
  model: ListModel;
  /** Who is talking right now, for the voice glyphs. */
  speaking?: ReadonlySet<string>;
  onOpenRoom?: (id: RoomId) => void;
  onOpenDm?: (id: RoomId) => void;
  /** From a person's card: open a DM with them (finding the one you already have). */
  onMessage?: (user: User) => void;
  /** From a person's card: knock (SPEC §4.9). */
  onKnock?: (user: User) => Promise<KnockResult>;
  /** From the new-message picker: open the DM with exactly these people; resolves to a problem in words, or null. */
  onStartDm?: (people: User[]) => Promise<string | null>;
  /** Where the desktop draws no close button, Linger draws its own. */
  onClose?: () => void;
  /** You're in voice: the voice bar at the bottom. */
  voice?: VoiceDockProps;
  /** Changing your status and going away, from the top card. */
  you?: YouActions;
}

type Fold = "rooms" | "dms" | "people" | "away" | "offline";

/**
 * The buddy list for one server (docs/design/buddy-list.md): you, the rooms
 * with who's in them, your DMs, and everyone else. Drawn only from the model
 * and the kit, so the same view serves the real window and the fixture page.
 */
export function ListView({ serverName, model, speaking, onOpenRoom, onOpenDm, onMessage, onKnock, onStartDm, onClose, voice, you }: ListViewProps) {
  // Offline starts folded (the design); everything else starts open.
  const [folded, setFolded] = useState<ReadonlySet<Fold>>(() => new Set<Fold>(["offline"]));
  const toggle = (fold: Fold) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(fold)) next.delete(fold);
      else next.add(fold);
      return next;
    });
  const open = (fold: Fold) => !folded.has(fold);
  const talking = (user: User) => speaking?.has(user.id) ?? false;

  // The card that is open, the row it came from, and where that row was.
  const [card, setCard] = useState<{ row: PersonRow; anchor: { top: number; bottom: number } } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState<{ bottom: number } | null>(null);
  const pickerOpener = useRef<HTMLButtonElement | null>(null);
  const everyone = [...model.people.here, ...model.people.away, ...model.people.offline];
  const closeCard = () => {
    setCard(null);
    // Focus goes back to the row that opened it.
    opener.current?.focus();
  };

  const person = (row: PersonRow) => (
    <Row
      key={row.user.id}
      lead={{ kind: "person", person: markerFor(row.user, row.state) }}
      lines="two"
      title={<Name person={row.user} />}
      label={`${row.user.display_name}, ${row.note}`}
      trailing={row.inVoice ? <VoiceGlyph speaking={talking(row.user)} /> : undefined}
      note={row.note}
      detail={row.line ?? undefined}
      away={row.state === "away"}
      selected={card?.row.user.id === row.user.id}
      onActivate={(event) => {
        opener.current = event.currentTarget;
        const box = event.currentTarget.getBoundingClientRect();
        setCard({ row, anchor: { top: box.top, bottom: box.bottom } });
      }}
    />
  );

  return (
    <div className="nx-list" data-screen="list">
      <TitleBar leading={<LogoMark />} onClose={onClose}>
        {serverName}
      </TitleBar>

      {model.me ? <YouCard me={model.me} actions={you} /> : null}

      <div className="nx-list-scroll">
        <SectionLabel label="Rooms" open={open("rooms")} onToggle={() => toggle("rooms")} controls="nx-rooms" />
        {open("rooms") ? (
          <div id="nx-rooms">
            <RowList label="Rooms">
              {model.rooms.map((room) => (
                <Row
                  key={room.id}
                  lead={{ kind: "room" }}
                  lines="one"
                  title={room.name}
                  fresh={room.fresh}
                  label={roomLabel(room.name, room.people.length, room.voice)}
                  end={
                    room.people.length > 0 || room.voice ? (
                      <span className="nx-list-room-end">
                        {room.voice ? (
                          <VoiceGlyph speaking={room.people.some(talking)} />
                        ) : null}
                        <MarkerCluster people={room.people.map((user) => markerFor(user, "in_room"))} />
                      </span>
                    ) : undefined
                  }
                  onActivate={onOpenRoom ? () => onOpenRoom(room.id) : undefined}
                />
              ))}
            </RowList>
          </div>
        ) : null}

        <SectionLabel
          label="DMs"
          open={open("dms")}
          onToggle={() => toggle("dms")}
          controls="nx-dms"
          action={
            onStartDm ? (
              <IconButton
                icon="compose"
                label="New message"
                size="sm"
                onClick={(event) => {
                  pickerOpener.current = event.currentTarget;
                  setPicking({ bottom: event.currentTarget.getBoundingClientRect().bottom });
                }}
              />
            ) : undefined
          }
        />
        {open("dms") ? (
          <div id="nx-dms">
            {model.dms.length === 0 ? (
              <p className="nx-list-empty">No DMs yet.</p>
            ) : (
              <RowList label="DMs">
                {model.dms.map((dm) => (
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
                    onActivate={onOpenDm ? () => onOpenDm(dm.id) : undefined}
                  />
                ))}
              </RowList>
            )}
          </div>
        ) : null}

        <SectionLabel label="People" open={open("people")} onToggle={() => toggle("people")} controls="nx-people" />
        {open("people") ? (
          <div id="nx-people">
            <RowList label="People here">{model.people.here.map(person)}</RowList>
            {model.people.away.length > 0 ? (
              <>
                <SectionLabel label="Away" level="group" open={open("away")} onToggle={() => toggle("away")} controls="nx-away" />
                {open("away") ? (
                  <div id="nx-away">
                    <RowList label="Away">{model.people.away.map(person)}</RowList>
                  </div>
                ) : null}
              </>
            ) : null}
            {model.people.offline.length > 0 ? (
              <>
                <SectionLabel
                  label="Offline"
                  level="group"
                  open={open("offline")}
                  onToggle={() => toggle("offline")}
                  controls="nx-offline"
                />
                {open("offline") ? (
                  <div id="nx-offline">
                    <RowList label="Offline">{model.people.offline.map(person)}</RowList>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {voice ? <VoiceDock {...voice} /> : null}

      {picking && onStartDm ? (
        <NewDmPicker
          people={everyone}
          meId={model.me?.user.id ?? null}
          dms={model.dms.map((dm) => ({ id: dm.id, member_ids: dm.memberIds }))}
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

      {card ? (
        <PersonCard
          key={card.row.user.id}
          user={card.row.user}
          state={card.row.state}
          note={card.row.note}
          anchor={card.anchor}
          onMessage={() => {
            onMessage?.(card.row.user);
            setCard(null);
          }}
          onKnock={() => onKnock?.(card.row.user) ?? Promise.resolve({ ok: false, problem: "Knocking isn't available here." })}
          onClose={closeCard}
        />
      ) : null}
    </div>
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
