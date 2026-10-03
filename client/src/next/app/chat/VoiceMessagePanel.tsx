import { useEffect, useRef } from "react";
import { clipTime, LINES, LONGEST_MS } from "../../core/chat/voiceMessage";
import { Button, IconButton } from "../../kit";
import { AudioCard } from "./AudioCard";
import type { VoiceMessageControls } from "./useVoiceMessages";
import "./VoiceMessagePanel.css";

/**
 * A voice message, above the message box (#401). Record when ready; lines
 * that move with your voice while it records, and how long it's been; Stop;
 * then hear it back and Send or Discard. Stopping never sends.
 */
export function VoiceMessagePanel({ controls, title }: { controls: VoiceMessageControls; title: string }) {
  const state = controls.state;
  const panel = useRef<HTMLDivElement>(null);
  const kind = state?.kind ?? null;

  // The keyboard follows the panel along: Record, Stop, then Send.
  useEffect(() => {
    const wanted = kind === "ready" ? "Record" : kind === "recording" ? "Stop" : kind === "kept" ? "Send voice message" : null;
    if (wanted === null) return;
    const button = [...(panel.current?.querySelectorAll("button") ?? [])].find((one) => one.textContent?.trim() === wanted);
    button?.focus();
  }, [kind]);

  if (state === null) return null;
  const busy = state.kind === "starting" || state.kind === "stopping";

  return (
    <div
      ref={panel}
      className="nx-voicemsg"
      role="group"
      aria-label={`Voice message for ${title}`}
      data-state={state.kind}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || state.kind === "recording" || state.kind === "stopping") return;
        event.preventDefault();
        event.stopPropagation();
        if (state.kind === "kept" && state.sending) return;
        controls.discard();
      }}
    >
      {state.kind === "kept" ? (
        <>
          <AudioCard name="Voice message" src={state.url} durationMs={state.ms} voice />
          <div className="nx-voicemsg-row">
            {state.note ? (
              <p className="nx-voicemsg-words" role="status">
                {state.note}
              </p>
            ) : (
              <span className="nx-voicemsg-words" />
            )}
            <Button size="sm" variant="quiet" disabled={state.sending} onClick={controls.discard}>
              Discard
            </Button>
            <Button size="sm" variant="primary" icon="send" busy={state.sending} onClick={controls.send}>
              Send voice message
            </Button>
          </div>
          {state.problem ? (
            <p className="nx-voicemsg-problem" role="alert">
              {state.problem}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <div className="nx-voicemsg-row">
            {state.kind === "recording" || state.kind === "stopping" ? (
              <Button size="sm" icon="stop" busy={state.kind === "stopping"} onClick={controls.stop}>
                Stop
              </Button>
            ) : (
              <Button size="sm" icon="record" busy={busy} onClick={controls.record}>
                Record
              </Button>
            )}
            {state.kind === "recording" ? (
              <>
                <span className="nx-voicemsg-time" role="timer" aria-label={`Recording, ${clipTime(Date.now() - state.since)} of ${clipTime(LONGEST_MS)}`}>
                  {clipTime(Date.now() - state.since)}
                </span>
                <Lines levels={state.levels} />
              </>
            ) : state.kind === "stopping" ? (
              <span className="nx-voicemsg-words">Putting it together…</span>
            ) : (
              <span className="nx-voicemsg-words">{state.kind === "starting" ? "Opening the microphone…" : "Press Record when you're ready."}</span>
            )}
            {state.kind === "ready" ? <IconButton icon="close" label="Close the voice message" size="sm" onClick={controls.discard} /> : null}
          </div>
          {state.kind === "ready" && state.problem ? (
            <p className="nx-voicemsg-problem" role="alert">
              {state.problem}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The lines that move with your voice: the latest levels, oldest on the left. */
function Lines({ levels }: { levels: readonly number[] }) {
  const shown = [...Array.from({ length: Math.max(0, LINES - levels.length) }, () => 0), ...levels];
  return (
    <span className="nx-voicemsg-lines" aria-hidden="true">
      {shown.map((level, at) => (
        // A line is at least a dot, so silence still reads as recording.
        <i key={at} style={{ height: `${Math.round(Math.max(0.12, level) * 100)}%` }} />
      ))}
    </span>
  );
}
