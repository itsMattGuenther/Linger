import { type RefObject, useEffect, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import { volumeLabel } from "../../../lib/voice";
import { onPhone, thisDevice } from "../../core/phone";
import { Button, Name, Popover, Slider } from "../../kit";
import { Sheet } from "./Sheet";
import { type CardSide, useBeside } from "./useAbove";
import "./VolumeCard.css";

/**
 * How loud one person plays for you (decision 8, VOICE-10): opened from their
 * chip in the voice bar, just above it, or on a conversation's voice line,
 * just under it (#747); on the phone it rises from the bottom. From silent to twice as loud, saved
 * on this computer for that person on this server and never sent anywhere.
 * Every change is heard at once; there is nothing to save. The phone plays
 * each voice through the web engine's own player, which goes no louder than
 * as sent, so there the most is 100% (#429, lib/pageVoice.ts).
 */
export function VolumeCard({
  user,
  volume,
  anchor,
  onVolume,
  onTakeOut,
  onClose,
  side = "above",
  sheet = false,
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
  /** Over the chip (the voice bar), or under it (the conversation's voice line, #747). */
  side?: CardSide;
  /** On the phone (#747): risen from the bottom over the page dimmed, as its menus are (SPEC §4.15). */
  sheet?: boolean;
}) {
  const phone = onPhone();
  const loudest = phone ? 1 : 2;
  const [taking, setTaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // Beside the chip (over it in the voice bar, under it on a voice line), never off the window.
  const at = useBeside(anchor, body, side);

  // The slider has the keyboard as soon as it opens.
  useEffect(() => {
    body.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const card = (
    <Popover label={`${user.display_name}'s volume`} at={sheet ? undefined : at} onClose={onClose}>
      <div className="nx-volume" ref={body}>
        <p className="nx-volume-who">
          <Name person={user} size="control" />
        </p>
        <div className="nx-volume-row">
          <Slider label={`How loud ${user.display_name} is for you`} value={Math.min(volume, loudest)} min={0} max={loudest} step={0.05} valueText={volumeLabel(Math.min(volume, loudest))} onChange={onVolume} />
          <span className="nx-volume-value">{volumeLabel(Math.min(volume, loudest))}</span>
        </div>
        <p className="nx-volume-note">Only for you, on {thisDevice(phone)}.</p>
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
  return sheet ? <Sheet onClose={onClose}>{card}</Sheet> : card;
}
