import { type RefObject, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { volumeLabel } from "../../../lib/voice";
import { Button, Name, Popover, Slider } from "../../kit";
import "./VolumeCard.css";

/** Space kept between the card, its chip and the window's edges. */
const GAP = 4;
const EDGE = 8;

/**
 * How loud one person plays for you (decision 8, VOICE-10): opened from their
 * chip in the voice bar, just above it. From silent to twice as loud, saved
 * on this computer for that person on this server and never sent anywhere.
 * Every change is heard at once; there is nothing to save.
 */
export function VolumeCard({
  user,
  volume,
  anchor,
  onVolume,
  onClose,
}: {
  user: User;
  /** 0 to 2; 1 is as they sent it. */
  volume: number;
  /** The chip that opened it: the card sits over it, wherever it has moved to. */
  anchor: RefObject<HTMLElement | null>;
  onVolume: (volume: number) => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState({ x: EDGE, y: EDGE });

  // Over the chip (the voice bar is at the bottom of the list), never off
  // the window. Measured on every draw, before it is painted: the voice bar
  // grows and shrinks as people come and go, and the chip moves with it.
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    const card = body.current?.parentElement;
    const chip = anchor.current?.getBoundingClientRect();
    if (!card || !chip) return;
    const { offsetWidth: width, offsetHeight: height } = card;
    const y = Math.max(EDGE, Math.round(chip.top) - GAP - height);
    const x = Math.max(EDGE, Math.min(Math.round(chip.left), window.innerWidth - width - EDGE));
    setAt((held) => (held.x === x && held.y === y ? held : { x, y }));
  });
  useEffect(() => {
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, []);

  // The slider has the keyboard as soon as it opens.
  useEffect(() => {
    body.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  return (
    <Popover label={`${user.display_name}'s volume`} at={at} onClose={onClose}>
      <div className="nx-volume" ref={body}>
        <p className="nx-volume-who">
          <Name person={user} size="control" />
        </p>
        <div className="nx-volume-row">
          <Slider label={`How loud ${user.display_name} is for you`} value={volume} min={0} max={2} step={0.05} valueText={volumeLabel(volume)} onChange={onVolume} />
          <span className="nx-volume-value">{volumeLabel(volume)}</span>
        </div>
        <p className="nx-volume-note">Only for you, on this computer.</p>
        {Math.abs(volume - 1) > 0.001 ? (
          <Button size="sm" variant="secondary" onClick={() => onVolume(1)}>
            Back to 100%
          </Button>
        ) : null}
      </div>
    </Popover>
  );
}
