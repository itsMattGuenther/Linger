import { useEffect } from "react";
import {
  leaveVoice,
  setVoiceDeafened,
  setVoiceMuted,
  type MyVoice,
} from "../lib/gateway";
import { microphoneLine, PUSH_TO_TALK_KEY } from "../lib/voice";
import IconButton from "../lib/IconButton";
import { ActionIcon } from "../lib/icons";

/** One set of controls, whether the room or a destination is being read. */
export default function VoiceControls({
  server,
  mine,
  onProblem,
  showLine = true,
}: {
  server: string;
  mine: MyVoice;
  onProblem: (error: unknown) => void;
  /** False where the surface draws the microphone line itself (the voice bar). */
  showLine?: boolean;
}) {
  const { pushToTalk } = mine;
  useEffect(() => {
    if (!pushToTalk) return;
    const down = (event: KeyboardEvent): void => {
      if (event.key === PUSH_TO_TALK_KEY && !event.repeat)
        void setVoiceMuted(server, false).catch(onProblem);
    };
    const release = (): void => {
      void setVoiceMuted(server, true).catch(onProblem);
    };
    const up = (event: KeyboardEvent): void => {
      if (event.key === PUSH_TO_TALK_KEY) release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      // Changing views while holding the key must not leave the mic open.
      release();
    };
  }, [pushToTalk, server, onProblem]);

  const line =
    !showLine || mine.deafened
      ? null
      : microphoneLine(mine.audio, pushToTalk, mine.muted);
  return (
    <div className="voice-controls">
      {line === null ? null : <span className="voice-line meta">{line}</span>}
      {pushToTalk ? null : (
        <IconButton
          label={mine.muted ? "Muted" : "Mute"}
          type="button"
          className="voice-action"
          tooltipSide="below"
          floatingTooltip
          aria-pressed={mine.muted}
          disabled={mine.deafened}
          onClick={() =>
            void setVoiceMuted(server, !mine.muted).catch(onProblem)
          }
        >
          <ActionIcon name={mine.muted ? "micOff" : "mic"} />
        </IconButton>
      )}
      <IconButton
        label={mine.deafened ? "Undeafen" : "Deafen"}
        type="button"
        className="voice-action"
        tooltipSide="below"
        floatingTooltip
        aria-pressed={mine.deafened}
        title="Silence incoming voice and mute your microphone"
        onClick={() =>
          void setVoiceDeafened(server, !mine.deafened).catch(onProblem)
        }
      >
        <ActionIcon name={mine.deafened ? "headphonesOff" : "headphones"} />
      </IconButton>
      <IconButton
        label="Leave voice"
        type="button"
        className="voice-action"
        tooltipSide="below"
        floatingTooltip
        onClick={() => void leaveVoice(server).catch(onProblem)}
      >
        <ActionIcon name="leave" />
      </IconButton>
    </div>
  );
}
