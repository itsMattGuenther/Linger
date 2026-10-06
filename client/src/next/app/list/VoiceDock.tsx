import { useMemo, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { volumeLabel } from "../../../lib/voice";
import { Chip, IconButton, MarkerCrowd, Name, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import { useTalkSeats } from "../useTalkSeats";
import { EveryoneCard } from "./EveryoneCard";
import "./VoiceDock.css";
import { serverColor } from "./ServerSection";
import { VolumeCard } from "./VolumeCard";

/**
 * A room shows everybody as chips up to this many people, you included.
 * Past it (#197) the bar keeps this many seats, you and the people who just
 * talked, and everybody is a marker in the crowd under them: two lines of
 * three, whatever the room's size.
 */
export const VOICE_SEATS = 6;

export interface VoiceDockPerson {
  user: User;
  speaking: boolean;
  you: boolean;
  /** Their microphone as shared (VOICE-6); null when it's on. */
  controls?: "muted" | "deafened" | "unknown" | null;
  /** Trouble reaching them from here (VOICE-7). */
  link?: "connecting" | "unreachable" | null;
  /** How loud they play for you, 0 to 2 (VOICE-10). */
  volume?: number;
}

/** A person's shared microphone state as their chip's glyph, and its word. */
function stateOf(person: VoiceDockPerson): { icon: "micOff" | "headOff"; word: string } | undefined {
  if (person.controls === "deafened") return { icon: "headOff", word: "Deafened" };
  if (person.controls === "muted") return { icon: "micOff", word: "Muted" };
  return undefined;
}

/** The one short thing worth saying under a person, if anything: reaching them first. */
function noteOf(person: VoiceDockPerson): string | undefined {
  if (person.link === "connecting") return "connecting…";
  if (person.link === "unreachable") return "can't reach";
  if (person.controls === "unknown") return "mic state unknown";
  return undefined;
}

export interface VoiceDockProps {
  /** "#general", or a DM's people. */
  where: string;
  people: VoiceDockPerson[];
  /** You muted yourself. Push-to-talk's closed microphone isn't a mute, and shows only as the line (#232). */
  muted: boolean;
  deafened: boolean;
  /** The one thing worth saying about your microphone, if anything (lib/voice.ts): "hold Right Ctrl to talk". */
  line: string | null;
  /**
   * With several servers, which one: its name and color, and how full the
   * room is in words when it's nearly full (core/servers.ts `seatsWords`).
   */
  server?: { name: string; accent: string | null; seats: string | null };
  onGoToRoom: () => void;
  onMute: (muted: boolean) => void;
  onDeafen: (deafened: boolean) => void;
  onLeave: () => void;
  /** How loud somebody plays for you, from their chip (decision 8). Left out: chips open nothing. */
  onVolume?: (person: VoiceDockPerson, volume: number) => void;
  /** The host taking somebody out of voice, from their chip's card (#423). Left out for everybody else. */
  onTakeOut?: (person: VoiceDockPerson) => Promise<string | null>;
}

/**
 * The voice bar at the bottom of the list (docs/design/buddy-list.md, "Voice
 * belongs to the room, not the tab or window"). Mute, Deafen and Leave are
 * always here: the list is always open, so they're always in reach, and
 * closing a chat tab or window never ends voice. The room's chat window has
 * the same three (#216), and the tray menu has Mute and Leave.
 *
 * A big room (#197) doesn't show fifty chips: past `VOICE_SEATS` it shows
 * seats for you and whoever just talked, and everybody as a crowd of markers
 * that light while they talk and open everyone by name.
 */
export function VoiceDock({ where, people, muted, deafened, line, server, onGoToRoom, onMute, onDeafen, onLeave, onVolume, onTakeOut }: VoiceDockProps) {
  // Whose volume is open, and the chip (or crowd) it opened from.
  const [volumeOf, setVolumeOf] = useState<{ id: string } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  // A big room's everyone card (#197), and the crowd that opened it.
  const [everyone, setEveryone] = useState(false);
  const crowd = useRef<HTMLButtonElement | null>(null);
  const open = volumeOf ? people.find((person) => person.user.id === volumeOf.id && !person.you) : undefined;
  const closeVolume = () => {
    setVolumeOf(null);
    opener.current?.focus();
  };
  const closeEveryone = () => {
    setEveryone(false);
    crowd.current?.focus();
  };
  const anyone = people.some((person) => person.speaking);

  // The seats: who just talked, kept still (core/seats.ts). Worked out in
  // small rooms too, so a room growing past the chips starts with a memory.
  const others = people.filter((person) => !person.you);
  const talkingKey = others
    .filter((person) => person.speaking)
    .map((person) => person.user.id)
    .join("\n");
  const talking = useMemo(() => new Set(talkingKey === "" ? [] : talkingKey.split("\n")), [talkingKey]);
  const seatIds = useTalkSeats(
    others.map((person) => person.user.id),
    talking,
    VOICE_SEATS - 1,
  );
  const big = people.length > VOICE_SEATS;
  const you = people.find((person) => person.you);
  const seated = [...(you ? [you] : []), ...seatIds.flatMap((id) => others.find((person) => person.user.id === id) ?? [])];

  const chip = (person: VoiceDockPerson, fill: boolean) => (
    <li key={person.user.id}>
      <Chip
        label={person.you ? "you" : person.user.display_name}
        marker={markerFor(person.user, "in_room")}
        active={person.speaking}
        state={stateOf(person)}
        note={noteOf(person)}
        fill={fill}
        {...(onVolume && !person.you
          ? {
              actionLabel: `${person.user.display_name}'s volume, ${volumeLabel(person.volume ?? 1)}`,
              expanded: volumeOf?.id === person.user.id,
              onActivate: (event) => {
                setEveryone(false);
                if (volumeOf?.id === person.user.id) {
                  closeVolume();
                  return;
                }
                opener.current = event.currentTarget;
                setVolumeOf({ id: person.user.id });
              },
            }
          : {})}
      >
        {person.you ? "you" : <Name person={person.user} size="control" />}
      </Chip>
    </li>
  );

  return (
    <section className="nx-voice" aria-label={server ? `In voice in ${where} on ${server.name}` : `In voice in ${where}`}>
      <div className="nx-voice-head">
        <VoiceGlyph speaking={anyone} mine />
        <span className="nx-voice-label">In voice</span>
        <span className="nx-voice-where">{where}</span>
        <IconButton icon="go" label={`Go to ${where}`} size="sm" onClick={onGoToRoom} />
      </div>
      {server ? (
        <p className="nx-voice-server" style={serverColor(server.accent)}>
          <span className="nx-voice-server-mark" aria-hidden="true" />
          <span className="nx-voice-server-name">{server.name}</span>
          {server.seats ? (
            <>
              <span className="nx-voice-server-sep" aria-hidden="true">
                ·
              </span>
              <span className="nx-voice-server-seats">{server.seats}</span>
            </>
          ) : null}
        </p>
      ) : null}
      {big ? (
        <>
          {/* You, then whoever just talked: two lines of three, still while people talk (#197). */}
          <ul className="nx-voice-seats" aria-label="You and who just talked">
            {seated.map((person) => chip(person, true))}
          </ul>
          <div className="nx-voice-crowd">
            <MarkerCrowd
              label="Everyone in voice"
              people={people.map((person) => ({ ...markerFor(person.user, "in_room"), lit: person.speaking }))}
              expanded={everyone}
              onActivate={(event) => {
                crowd.current = event.currentTarget;
                if (volumeOf) setVolumeOf(null);
                setEveryone((shown) => !shown);
              }}
            />
          </div>
        </>
      ) : (
        <ul className="nx-voice-people" aria-label="Who's in voice">
          {people.map((person) => chip(person, false))}
        </ul>
      )}
      {line ? (
        <p className="nx-voice-line" role="status">
          {line}
        </p>
      ) : null}
      {big && everyone ? (
        <EveryoneCard
          people={others}
          where={where}
          anchor={crowd}
          // Somebody found: their volume card, over the crowd, in this one's place.
          onPick={(person) => {
            setEveryone(false);
            opener.current = crowd.current;
            setVolumeOf({ id: person.user.id });
          }}
          onClose={closeEveryone}
        />
      ) : null}
      {open && onVolume && volumeOf ? (
        <VolumeCard
          user={open.user}
          volume={open.volume ?? 1}
          anchor={opener}
          onVolume={(volume) => onVolume(open, volume)}
          // Never on the host's chip (#424): your own chip opens no card, so
          // whoever opened the host's is a co-host, who can't take the host out.
          {...(onTakeOut && !open.user.is_host ? { onTakeOut: () => onTakeOut(open) } : {})}
          onClose={closeVolume}
        />
      ) : null}
      {/* Symbols, as in the room's chat window (#216): each word is the button's name and tooltip (#230).
          Mute shows with push-to-talk too: it's a choice of its own, which the key can't undo (#232). */}
      <div className="nx-voice-controls" role="group" aria-label="Your voice">
        <IconButton icon={muted ? "micOff" : "mic"} label={muted ? "Muted" : "Mute"} size="sm" pressed={muted} onClick={() => onMute(!muted)} />
        <IconButton
          icon={deafened ? "headOff" : "head"}
          label={deafened ? "Deafened" : "Deafen"}
          size="sm"
          pressed={deafened}
          onClick={() => onDeafen(!deafened)}
        />
        <IconButton icon="leave" label="Leave voice" size="sm" onClick={onLeave} />
      </div>
    </section>
  );
}
