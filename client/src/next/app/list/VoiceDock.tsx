import type { User } from "../../../generated/User";
import { Button, Chip, IconButton, Name, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import "./VoiceDock.css";

export interface VoiceDockPerson {
  user: User;
  speaking: boolean;
  you: boolean;
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
  onGoToRoom: () => void;
  onMute: (muted: boolean) => void;
  onDeafen: (deafened: boolean) => void;
  onLeave: () => void;
}

/**
 * The voice bar at the bottom of the list (docs/design/buddy-list.md, "Voice
 * belongs to the room, not the tab or window"). It is the one place with
 * Mute, Deafen and Leave: the list is always open, so they're always in
 * reach, and closing a chat tab or window never ends voice.
 */
export function VoiceDock({ where, people, muted, deafened, pushToTalk, line, onGoToRoom, onMute, onDeafen, onLeave }: VoiceDockProps) {
  const anyone = people.some((person) => person.speaking);
  return (
    <section className="nx-voice" aria-label={`In voice in ${where}`}>
      <div className="nx-voice-head">
        <VoiceGlyph speaking={anyone} mine />
        <span className="nx-voice-label">In voice</span>
        <span className="nx-voice-where">{where}</span>
        <IconButton icon="go" label={`Go to ${where}`} size="sm" onClick={onGoToRoom} />
      </div>
      <ul className="nx-voice-people" aria-label="Who's in voice">
        {people.map((person) => (
          <li key={person.user.id}>
            <Chip label={person.you ? "you" : person.user.display_name} marker={markerFor(person.user, "in_room")} active={person.speaking}>
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
