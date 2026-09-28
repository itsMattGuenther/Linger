import { memo } from "react";
import type { User } from "../../../generated/User";
import { startProblemWords, type StartProblem } from "../../../lib/voice";
import { QUIET_MOVE_WORDS, VOICE_ACTION_WORDS, type VoiceStrip as Strip } from "../../core/chat/voice";
import { verbFor } from "../../core/chat/words";
import { Button, Chip, IconButton, markerOf, Name, VoiceGlyph } from "../../kit";
import "./VoiceStrip.css";

/** Chips that fit on the strip's one line; past this it says "and others". */
const MAX_CHIPS = 4;

/**
 * A conversation's voice, in one line under its header (docs/design/
 * buddy-list.md, "Voice belongs to the room"). It says who's talking here
 * and offers one way in. In the room you're in voice in, it has your controls
 * too (#216): mute, deafen and leave, as symbols, the same ones as the list's
 * voice bar, which stays. It is one height in every state, so a change in
 * voice never moves the conversation (VOICE-17).
 */

/** Your voice controls, in the room you're in voice in (#216). The list window acts on them. */
export interface StripControls {
  /** You muted yourself: with push-to-talk too, which the key can't undo (#232). */
  muted: boolean;
  deafened: boolean;
  onMute: (muted: boolean) => void;
  onDeafen: (deafened: boolean) => void;
  onLeave: () => void;
}

/** Why the last start here failed, as the strip says it, and the shell's whole reason (#261, #273). */
export type StripProblem = StartProblem & { detail: string };

export const VoiceStrip = memo(function VoiceStrip({
  strip,
  people,
  meId,
  speaking,
  mics,
  onJoin,
  onPickDevice,
  controls,
  failed,
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
  /** Open Settings on Sound & Voice, where a device is picked by name (#273). */
  onPickDevice: () => void;
  /** Yours, when you're in voice here. */
  controls?: StripControls;
  /**
   * The last try at starting voice here failed (#261). It takes the words'
   * place, on the same one line, so the strip keeps its height (VOICE-17);
   * the whole of it, and the shell's reason, are the tooltip. The button
   * stays, to try again. When picking a device fixes it, that's a button
   * too, which opens Settings there and is never cut off: on a narrow window
   * the words give way first (#273).
   */
  failed?: StripProblem;
}) {
  const showFailed = failed && strip.kind !== "mine" ? failed : undefined;
  const problem = showFailed ? (
    <p
      className="nx-strip-words"
      data-problem="yes"
      role="alert"
      title={`Couldn't start voice. ${startProblemWords(showFailed)}\n${showFailed.detail}`}
    >
      Couldn't start voice. {showFailed.line}
    </p>
  ) : null;
  const fix =
    showFailed && showFailed.fix !== null ? (
      <Button size="sm" variant="secondary" icon="gear" onClick={onPickDevice}>
        {showFailed.fix}
      </Button>
    ) : null;
  if (strip.kind === "off") {
    return (
      <div className="nx-strip" data-kind="off" role="group" aria-label="Voice in this conversation">
        <VoiceGlyph speaking={false} />
        <p className="nx-strip-words">Voice isn't set up on this server.</p>
      </div>
    );
  }
  if (strip.kind === "quiet") {
    return (
      <div className="nx-strip" data-kind="quiet" role="group" aria-label="Voice in this conversation">
        <VoiceGlyph speaking={false} />
        {problem ?? <p className="nx-strip-words">Nobody's talking in here.</p>}
        {fix}
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
      {problem ?? (
        <p className="nx-strip-words">
          {here.length > shown.length ? "and others " : ""}
          {strip.kind === "others" ? `${verbFor(here.length, "is", "are")} talking` : ""}
        </p>
      )}
      {fix}
      {strip.kind === "mine" && controls ? (
        <div className="nx-strip-controls" role="group" aria-label="Your voice">
          <IconButton
            icon={controls.muted ? "micOff" : "mic"}
            label={controls.muted ? "Muted" : "Mute"}
            size="sm"
            pressed={controls.muted}
            onClick={() => controls.onMute(!controls.muted)}
          />
          <IconButton
            icon={controls.deafened ? "headOff" : "head"}
            label={controls.deafened ? "Deafened" : "Deafen"}
            size="sm"
            pressed={controls.deafened}
            onClick={() => controls.onDeafen(!controls.deafened)}
          />
          <IconButton icon="leave" label="Leave voice" size="sm" onClick={controls.onLeave} />
        </div>
      ) : strip.kind === "mine" ? (
        <span className="nx-strip-here">You're in voice here</span>
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
