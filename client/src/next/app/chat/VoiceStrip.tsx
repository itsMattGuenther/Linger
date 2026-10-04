import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "../../../generated/User";
import { startProblemWords, type StartProblem } from "../../../lib/voice";
import { QUIET_MOVE_WORDS, VOICE_ACTION_WORDS, type VoiceStrip as Strip } from "../../core/chat/voice";
import { verbFor } from "../../core/chat/words";
import { copyText } from "../../core/copy";
import { Button, Chip, IconButton, markerOf, Name, Popover, VoiceGlyph } from "../../kit";
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
  takenOut,
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
   * place, on the same one line, so the strip keeps its height (VOICE-17).
   * The whole of it, and the shell's reason, are the tooltip, and a click
   * opens them in a card that stays, with Copy for sending them to the host
   * (#399). The button stays, to try again. When picking a device fixes it,
   * that's a button too, which opens Settings there and is never cut off: on
   * a narrow window the words give way first (#273).
   */
  failed?: StripProblem;
  /**
   * The host or a co-host took you out of voice here (#423, #424): said where the strip's words
   * go, until you join again. Join stays, since it isn't a ban.
   */
  takenOut?: boolean;
}) {
  const showFailed = failed && strip.kind !== "mine" ? failed : undefined;
  const takenOutWords =
    takenOut && strip.kind !== "mine" && !showFailed ? (
      <p className="nx-strip-words" role="status">
        You were taken out of voice.
      </p>
    ) : null;
  const [why, setWhy] = useState<DOMRect | null>(null);
  const lead = showFailed ? `Couldn't start voice. ${startProblemWords(showFailed)}` : "";
  const problem = showFailed ? (
    <p className="nx-strip-words" data-problem="yes" role="alert" title={`${lead}\n${showFailed.detail}`}>
      <button
        type="button"
        className="nx-strip-why-open"
        aria-haspopup="dialog"
        aria-expanded={why !== null}
        onClick={(event) => setWhy(event.currentTarget.getBoundingClientRect())}
      >
        Couldn't start voice. {showFailed.line}
      </button>
      {why ? <WhyCard anchor={why} lead={lead} detail={showFailed.detail} onClose={() => setWhy(null)} /> : null}
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
        {problem ?? takenOutWords ?? <p className="nx-strip-words">Nobody's talking in here.</p>}
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
      {problem ?? takenOutWords ?? (
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

/** Space kept between the card, the strip and the window's edges. */
const GAP = 4;
const EDGE = 8;

/**
 * Why voice didn't start, whole (#399): Linger's sentence and the shell's
 * own words, which say what actually failed, in a card that stays until it's
 * closed. Its words can be selected, and Copy takes both, ready to send the
 * host. It sits under the strip's words, or over them if there's no room
 * below, and never off the window.
 */
function WhyCard({ anchor, lead, detail, onClose }: { anchor: DOMRect; lead: string; detail: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: anchor.bottom + GAP });
  const [copied, setCopied] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const card = box.current?.parentElement;
    if (!card) return;
    const { offsetWidth: width, offsetHeight: height } = card;
    const below = anchor.bottom + GAP;
    const y = below + height <= window.innerHeight - EDGE ? below : Math.max(EDGE, anchor.top - GAP - height);
    const x = Math.max(EDGE, Math.min(Math.round(anchor.left), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  }, [anchor.top, anchor.bottom, anchor.left]);
  // Copy has the focus to start with; a press anywhere else closes it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("[data-copy] button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.parentElement?.contains(event.target)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, []);
  return createPortal(
    <Popover label="Why voice didn't start" at={at} onClose={onClose}>
      <div ref={box} className="nx-strip-why">
        <p className="nx-strip-why-lead">{lead}</p>
        <p className="nx-strip-why-detail">{detail}</p>
        <div className="nx-strip-why-buttons">
          <span data-copy="">
            <Button size="sm" variant="secondary" onClick={() => void copyText(`${lead}\n${detail}`).then(setCopied)}>
              {copied === true ? "Copied" : "Copy"}
            </Button>
          </span>
        </div>
        {copied === false ? (
          <p className="nx-strip-why-said" role="status">
            The clipboard wouldn't take it. Select the words above and copy them instead.
          </p>
        ) : null}
      </div>
    </Popover>,
    document.body,
  );
}
