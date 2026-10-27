import { useEffect } from "react";
import type { User } from "../../../generated/User";
import { loadVoicePrefs } from "../../../lib/voice";
import { type ScreenWatchState, watchOver } from "../../../lib/screen/watch";
import { isFullScreenKey, typingIn } from "../../core/keys";
import { onPhone } from "../../core/phone";
import { Icon, IconButton, Name } from "../../kit";
import "./ScreenStage.css";

export interface StageProps {
  /** Whose screen this is. */
  sharer: User | null;
  /** Who else is watching it, not you. */
  others: readonly User[];
  status: ScreenWatchState["status"];
  /** Your line can't keep up and the picture is behind: said on your screen alone (#360). */
  behind?: boolean;
  /** Over, and you're still in that voice: their next share opens here (#360). */
  opensNext?: boolean;
  /** Filling the monitor. */
  full: boolean;
  onFull: (full: boolean) => void;
  /** Stop watching. */
  onClose: () => void;
  /** Where the picture is drawn. */
  onCanvas: (canvas: HTMLCanvasElement | null) => void;
}

/** "Eli", "Eli and Dave", "Eli, Dave and Sam": who else is watching, by name. */
function namesOf(people: readonly User[]): string {
  const names = people.map((person) => person.display_name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Somebody's screen, above the room's conversation (SPEC §4.20, #360, concept
 * A): whose it is and who else is watching, Full screen and Stop watching,
 * and the picture as big as the space allows with its shape kept. Until the
 * picture comes, and when it can't or has stopped, it says so in its place.
 * Your line not keeping up says so over the picture's foot, the slowness
 * being yours: the person sharing and everybody else are told nothing.
 * F or a double-click on the picture fills the monitor and gives it back.
 */
export function ScreenStage({ sharer, others, status, behind = false, opensNext = false, full, onFull, onClose, onCanvas }: StageProps) {
  const whose = sharer?.display_name ?? "Somebody";
  const over = watchOver(status);
  // Escape leaves full screen, as everywhere else.
  useEffect(() => {
    if (!full) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, onFull]);
  // F does what Full screen does, while there's a screen to fill.
  useEffect(() => {
    if (over) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isFullScreenKey(event, typingIn(document.activeElement), loadVoicePrefs().pushToTalkKey)) return;
      event.preventDefault();
      onFull(!full);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, onFull, over]);
  const words =
    status === "unplayable"
      ? `This device can't play ${whose}'s screen.`
      : status === "ended"
        ? `${whose} stopped sharing.${opensNext ? " If they share again, it opens here." : ""}`
        : status === "lost"
          ? `Lost the connection to ${whose}'s screen.`
          : `Waiting for ${whose}'s screen…`;
  const size = onPhone() ? "lg" : "md";
  return (
    <section className="nx-stage" data-full={full ? "yes" : undefined} aria-label={`${whose}'s screen`}>
      <div className="nx-stage-bar">
        <span className="nx-stage-mark" aria-hidden="true">
          <Icon name="screen" size="md" />
        </span>
        <span className="nx-stage-whose">
          {sharer ? <Name person={sharer} size="control" /> : whose}
          <span>'s screen</span>
        </span>
        {others.length > 0 ? <span className="nx-stage-others">with {namesOf(others)} watching</span> : null}
        <span className="nx-stage-gap" />
        {over ? null : (
          <IconButton icon={full ? "windowed" : "fullscreen"} label={full ? "Leave full screen" : "Full screen"} shortcut={full ? "Esc" : fullKey()} size={size} onClick={() => onFull(!full)} />
        )}
        <IconButton icon="close" label={over ? "Close" : "Stop watching"} size={size} onClick={onClose} />
      </div>
      <div className="nx-stage-pic" onDoubleClick={over ? undefined : () => onFull(!full)}>
        <canvas ref={onCanvas} className="nx-stage-canvas" hidden={status !== "showing"} role="img" aria-label={`${whose}'s screen`} />
        {status === "showing" ? null : (
          <p className="nx-stage-words" role="status">
            {words}
          </p>
        )}
        {status === "showing" && behind ? (
          <p className="nx-stage-slow" role="status">
            Your connection is slow, so {whose}'s screen is behind.
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** F, named after Full screen, unless it's the push-to-talk key or there's no keyboard. */
function fullKey(): string | undefined {
  return onPhone() || loadVoicePrefs().pushToTalkKey === "KeyF" ? undefined : "F";
}
