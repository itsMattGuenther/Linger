import { useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { volumeLabel } from "../../../lib/voice";
import { Button, Chip, IconButton, Name, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import "./VoiceDock.css";
import { serverColor } from "./ServerSection";
import { VolumeCard } from "./VolumeCard";

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

/** A person's shared microphone state as their chip's glyph, in today's client's words. */
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
  muted: boolean;
  deafened: boolean;
  pushToTalk: boolean;
  /** The one thing worth saying about your microphone, if anything (lib/voice.ts). */
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
}

/**
 * The voice bar at the bottom of the list (docs/design/buddy-list.md, "Voice
 * belongs to the room, not the tab or window"). It is the one place with
 * Mute, Deafen and Leave: the list is always open, so they're always in
 * reach, and closing a chat tab or window never ends voice.
 */
export function VoiceDock({ where, people, muted, deafened, pushToTalk, line, server, onGoToRoom, onMute, onDeafen, onLeave, onVolume }: VoiceDockProps) {
  // Whose volume is open, and the chip it opened from.
  const [volumeOf, setVolumeOf] = useState<{ id: string } | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const open = volumeOf ? people.find((person) => person.user.id === volumeOf.id && !person.you) : undefined;
  const closeVolume = () => {
    setVolumeOf(null);
    opener.current?.focus();
  };
  const anyone = people.some((person) => person.speaking);
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
      <ul className="nx-voice-people" aria-label="Who's in voice">
        {people.map((person) => (
          <li key={person.user.id}>
            <Chip
              label={person.you ? "you" : person.user.display_name}
              marker={markerFor(person.user, "in_room")}
              active={person.speaking}
              state={stateOf(person)}
              note={noteOf(person)}
              {...(onVolume && !person.you
                ? {
                    actionLabel: `${person.user.display_name}'s volume, ${volumeLabel(person.volume ?? 1)}`,
                    expanded: volumeOf?.id === person.user.id,
                    onActivate: (event) => {
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
        ))}
      </ul>
      {line ? (
        <p className="nx-voice-line" role="status">
          {line}
        </p>
      ) : null}
      {open && onVolume && volumeOf ? (
        <VolumeCard user={open.user} volume={open.volume ?? 1} anchor={opener} onVolume={(volume) => onVolume(open, volume)} onClose={closeVolume} />
      ) : null}
      <div className="nx-voice-controls">
        {pushToTalk ? null : (
          <Button size="sm" variant="secondary" icon={muted ? "micOff" : "mic"} pressed={muted} onClick={() => onMute(!muted)}>
            {muted ? "Muted" : "Mute"}
          </Button>
        )}
        <Button size="sm" variant="secondary" icon={deafened ? "headOff" : "head"} pressed={deafened} onClick={() => onDeafen(!deafened)}>
          {deafened ? "Deafened" : "Deafen"}
        </Button>
        <Button size="sm" variant="secondary" icon="leave" onClick={onLeave}>
          Leave
        </Button>
      </div>
    </section>
  );
}
