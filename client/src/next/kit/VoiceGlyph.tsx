import { Icon } from "./Icon";
import "./VoiceGlyph.css";

/**
 * Voice, as a small mark: a speaker when people are in voice, three moving
 * bars while somebody talks. `mine` draws it in the lamp: the voice you're in.
 * Decoration; the words live in the surrounding label.
 */
export function VoiceGlyph({ speaking, mine = false }: { speaking: boolean; mine?: boolean }) {
  return (
    <span
      className="k-voice"
      data-kit="VoiceGlyph"
      data-speaking={speaking ? "yes" : undefined}
      data-mine={mine ? "yes" : undefined}
      aria-hidden="true"
    >
      {speaking ? (
        <span className="k-voice-bars">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon name="speaker" size="sm" />
      )}
    </span>
  );
}
