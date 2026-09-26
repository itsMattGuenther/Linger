import { memo } from "react";
import type { User } from "../../../generated/User";
import { QUIET_MOVE_WORDS, VOICE_ACTION_WORDS, type VoiceStrip as Strip } from "../../core/chat/voice";
import { verbFor } from "../../core/chat/words";
import { Button, Chip, markerOf, Name, VoiceGlyph } from "../../kit";
import "./VoiceStrip.css";

/** Chips that fit on the strip's one line; past this it says "and others". */
const MAX_CHIPS = 4;

/**
 * A conversation's voice, in one line under its header (docs/design/
 * buddy-list.md, "Voice belongs to the room"). It says who's talking here
 * and offers one way in; mute, deafen and leave live in the list's voice bar.
 * It is one height in every state, so a change in voice never moves the
 * conversation (VOICE-17).
 */
export const VoiceStrip = memo(function VoiceStrip({
  strip,
  people,
  meId,
  speaking,
  mics,
  onJoin,
}: {
  strip: Strip;
  /** Everyone the strip names, by id. */
  people: ReadonlyMap<string, User>;
  /** You, shown as "you". */
  meId: string | null;
  /** Who is talking right now (only known while you are in voice). */
  speaking: ReadonlySet<string>;
  /** Whose microphone is off, as shared (VOICE-6), by user id. */
  mics?: ReadonlyMap<string, "muted" | "deafened">;
  /** Join, move here, or start: the window knows which from `strip`. */
  onJoin: () => void;
}) {
  if (strip.kind === "quiet") {
    return (
      <div className="nx-strip" data-kind="quiet" role="group" aria-label="Voice in this conversation">
        <VoiceGlyph speaking={false} />
        <p className="nx-strip-words">Nobody's talking in here.</p>
        <Button size="sm" variant="secondary" icon="mic" onClick={onJoin}>
          {strip.action === "move" ? QUIET_MOVE_WORDS : VOICE_ACTION_WORDS[strip.action]}
        </Button>
      </div>
    );
  }

  const here = strip.people.flatMap((id) => people.get(id) ?? []);
  const shown = here.slice(0, MAX_CHIPS);
  const talking = here.some((user) => speaking.has(user.id));
  return (
    <div className="nx-strip" data-kind={strip.kind} role="group" aria-label="Voice in this conversation">
      <VoiceGlyph speaking={talking} mine={strip.kind === "mine"} />
      <ul className="nx-strip-people" aria-label="In voice here">
        {shown.map((user) => (
          <li key={user.id}>
            <Chip
              label={user.id === meId ? "you" : user.display_name}
              marker={markerOf(user, "in_room")}
              active={speaking.has(user.id)}
              state={micState(mics?.get(user.id))}
            >
              {user.id === meId ? "you" : <Name person={user} size="control" />}
            </Chip>
          </li>
        ))}
      </ul>
      <p className="nx-strip-words">
        {here.length > shown.length ? "and others " : ""}
        {strip.kind === "others" ? `${verbFor(here.length, "is", "are")} talking` : ""}
      </p>
      {strip.kind === "mine" ? (
        <span className="nx-strip-here" title="Mute, deafen and leave are in the voice bar in your list">
          You're in voice here
        </span>
      ) : (
        <Button size="sm" variant={strip.action === "join" ? "primary" : "secondary"} icon="mic" onClick={onJoin}>
          {VOICE_ACTION_WORDS[strip.action]}
        </Button>
      )}
    </div>
  );
});

/** A microphone that's off, as its control's glyph and word. */
function micState(off: "muted" | "deafened" | undefined): { icon: "micOff" | "headOff"; word: string } | undefined {
  if (off === "deafened") return { icon: "headOff", word: "Deafened" };
  if (off === "muted") return { icon: "micOff", word: "Muted" };
  return undefined;
}
