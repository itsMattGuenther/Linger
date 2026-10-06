import { type RefObject, useEffect, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { volumeLabel } from "../../../lib/voice";
import { Button, Name, Popover, Slider } from "../../kit";
import { useAbove } from "./useAbove";
import "./VolumeCard.css";

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
  onTakeOut,
  onClose,
}: {
  user: User;
  /** 0 to 2; 1 is as they sent it. */
  volume: number;
  /** The chip (or a big room's crowd, #197) that opened it: the card sits over it, wherever it has moved to. */
  anchor: RefObject<HTMLElement | null>;
  onVolume: (volume: number) => void;
  /**
   * The host taking them out of voice (#423): null when it's done, or why
   * not. Left out for everybody but the host.
   */
  onTakeOut?: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [taking, setTaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // Over the chip (the voice bar is at the bottom of the list), never off the window.
  const at = useAbove(anchor, body);

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
        {onTakeOut ? (
          <>
            {/* For everybody, not just you: somebody who walked away with
                their microphone on (#423). They can join again. */}
            <Button
              size="sm"
              variant="danger"
              icon="leave"
              busy={taking}
              onClick={() => {
                setTaking(true);
                setProblem(null);
                void onTakeOut().then((said) => {
                  setTaking(false);
                  if (said === null) onClose();
                  else setProblem(said);
                });
              }}
            >
              Take out of voice
            </Button>
            {problem ? (
              <p className="nx-volume-problem" role="alert">
                {problem}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Popover>
  );
}
