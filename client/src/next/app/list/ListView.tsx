import { useState } from "react";
import type { PresenceState } from "../../../generated/PresenceState";
import type { RoomId } from "../../../generated/RoomId";
import type { User } from "../../../generated/User";
import { paletteKey } from "../../../lib/names";
import type { ListModel, PersonRow } from "../../core/list";
import {
  Marker,
  MarkerCluster,
  type MarkerPerson,
  markerStateOf,
  MARKER_WORDS,
  Name,
  Row,
  RowList,
  SectionLabel,
  TitleBar,
  VoiceGlyph,
} from "../../kit";
import { LogoMark } from "../LogoMark";
import "./ListView.css";

/** A person's marker: their palette color and their presence. */
export function markerFor(user: User, state: PresenceState): MarkerPerson {
  return { color: paletteKey(user) ?? "slate", state: markerStateOf(state) };
}

export interface ListViewProps {
  serverName: string;
  model: ListModel;
  /** Who is talking right now, for the voice glyphs. */
  speaking?: ReadonlySet<string>;
  onOpenRoom?: (id: RoomId) => void;
  onOpenDm?: (id: RoomId) => void;
  onOpenPerson?: (user: User) => void;
  /** Where the desktop draws no close button, Linger draws its own. */
  onClose?: () => void;
}

type Fold = "rooms" | "dms" | "people" | "away" | "offline";

/**
 * The buddy list for one server (docs/design/buddy-list.md): you, the rooms
 * with who's in them, your DMs, and everyone else. Drawn only from the model
 * and the kit, so the same view serves the real window and the fixture page.
 */
export function ListView({ serverName, model, speaking, onOpenRoom, onOpenDm, onOpenPerson, onClose }: ListViewProps) {
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
      onActivate={onOpenPerson ? () => onOpenPerson(row.user) : undefined}
    />
  );

  return (
    <div className="nx-list" data-screen="list">
      <TitleBar leading={<LogoMark />} onClose={onClose}>
        {serverName}
      </TitleBar>

      {model.me ? (
        <section className="nx-list-me" aria-label="You">
          <Name person={model.me.user} size="display" />
          <span className="nx-list-me-where">
            <Marker
              {...markerFor(model.me.user, model.me.state)}
              size="sm"
              label={MARKER_WORDS[markerStateOf(model.me.state)]}
            />
            <span className="nx-list-me-text">{model.me.where}</span>
          </span>
          {model.me.user.status?.line ? <p className="nx-list-me-status">{model.me.user.status.line}</p> : null}
        </section>
      ) : null}

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

        {model.dms.length > 0 ? (
          <>
            <SectionLabel label="DMs" open={open("dms")} onToggle={() => toggle("dms")} controls="nx-dms" />
            {open("dms") ? (
              <div id="nx-dms">
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
              </div>
            ) : null}
          </>
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
