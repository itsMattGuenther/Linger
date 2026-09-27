import { useEffect, useId, useRef, useState } from "react";
import { volumeLabel } from "../../../lib/voice";
import { knownSeconds, loadAudioVolume, onStep, saveAudioVolume, seekStep, timeSizer, timeText, timeWords } from "../../core/audioPlayer";
import { Button, Icon, IconButton, Slider } from "../../kit";
import "./AudioCard.css";

/** Where the last level let go of is kept; a window without storage just starts at full. */
function levelStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A shared audio file (#247): its name and time, then Linger's own player,
 * the same in WebKitGTK and WebView2. The engine's own controls can't be
 * used: WebKitGTK's show a volume slider only on a player 136px tall or more,
 * so a one-line player there had mute and no volume.
 *
 * The file streams from the server as the engine asks for it, a byte range at
 * a time (#222), so a seek fetches only the part it lands in. How loud it
 * plays is kept on this computer for the next file (`core/audioPlayer.ts`).
 * If it stops loading, the row says so and loads it again in place, from
 * where it had got to, as a video does.
 */
export function AudioCard({ name, src, durationMs }: { name: string; src: string; durationMs: number | null }) {
  const nameId = useId();
  // Each go is a new element, as for a video: one that failed keeps its failure.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  // The server's length until the file says its own.
  const [length, setLength] = useState(() => knownSeconds(durationMs === null ? null : durationMs / 1000));
  const [level, setLevel] = useState(() => loadAudioVolume(levelStore()));
  const [muted, setMuted] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const failure = useRef<HTMLDivElement>(null);
  // While the timeline is held, it shows where it's being moved to, not where the sound is.
  const scrubbing = useRef(false);
  // Somebody set this player's own level: it keeps it, whatever another player saved since.
  const ownLevel = useRef(false);
  const resumeAt = useRef(0);
  // The keyboard was on the controls when they gave way to the failure line.
  const focusLost = useRef(false);
  const silent = muted || level === 0;

  useEffect(() => {
    const audio = player.current;
    if (!audio) return;
    audio.volume = level;
    audio.muted = muted;
  }, [level, muted, attempt]);

  // The button that was just pressed goes away; the keyboard lands on Play.
  // And the other way: controls that go while they have the keyboard hand it
  // to Load again, rather than dropping it on the page.
  useEffect(() => {
    if (failed && focusLost.current) failure.current?.querySelector("button")?.focus();
    else if (!failed && attempt > 0) controls.current?.querySelector("button")?.focus();
    focusLost.current = false;
  }, [attempt, failed]);

  const togglePlay = () => {
    const audio = player.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    // The level last let go of in any player, unless this one has its own.
    if (!silent && !ownLevel.current) {
      const saved = loadAudioVolume(levelStore());
      audio.volume = saved;
      setLevel(saved);
    }
    // A refusal (the file failed, or a pause came first) is told by the element's own events.
    audio.play().catch(() => undefined);
  };

  const seek = (to: number) => {
    scrubbing.current = false;
    setPosition(to);
    if (player.current) player.current.currentTime = to;
  };

  const toggleMute = () => {
    if (!silent) {
      setMuted(true);
      return;
    }
    setMuted(false);
    // Slid down to nothing: unmuting brings back the level remembered, never 0.
    if (level === 0) setLevel(loadAudioVolume(levelStore()));
  };

  return (
    <div className="nx-att-card" data-kind="audio" role="group" aria-labelledby={nameId}>
      <Icon name="audio" size="md" />
      <span className="nx-att-name" id={nameId}>
        {name}
      </span>
      <span className="nx-att-meta nx-audio-time">
        <span>{timeText(position, length)}</span>
        <span className="nx-audio-time-sizer" aria-hidden="true">
          {timeSizer(length)}
        </span>
      </span>
      <audio
        key={attempt}
        ref={player}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          if (!scrubbing.current) setPosition(event.currentTarget.currentTime);
        }}
        onDurationChange={(event) => {
          const own = knownSeconds(event.currentTarget.duration);
          if (own !== null) setLength(own);
        }}
        onLoadedMetadata={(event) => {
          const at = resumeAt.current;
          resumeAt.current = 0;
          if (at > 0 && at < event.currentTarget.duration) event.currentTarget.currentTime = at;
        }}
        onError={(event) => {
          resumeAt.current = event.currentTarget.currentTime;
          focusLost.current = controls.current?.contains(document.activeElement) ?? false;
          setPlaying(false);
          setFailed(true);
        }}
      />
      {failed ? (
        <div className="nx-audio-failed" ref={failure}>
          <p className="nx-audio-note" role="alert">
            Couldn't load this audio.
          </p>
          <Button
            size="sm"
            onClick={() => {
              setFailed(false);
              setAttempt((count) => count + 1);
            }}
          >
            Load again
          </Button>
        </div>
      ) : (
        <div className="nx-audio-controls" ref={controls}>
          <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} tone="filled" onClick={togglePlay} />
          <div className="nx-audio-timeline">
            <Slider
              label="Timeline"
              value={onStep(position, length)}
              min={0}
              max={length ?? 0}
              step={seekStep(length)}
              valueText={timeWords(position, length)}
              onChange={(to) => {
                scrubbing.current = true;
                setPosition(to);
              }}
              onCommit={seek}
            />
          </div>
          <div className="nx-audio-volume">
            <IconButton icon={silent ? "speakerOff" : "speaker"} label={silent ? "Unmute" : "Mute"} onClick={toggleMute} />
            <div className="nx-audio-level">
              <Slider
                label="Volume"
                value={silent ? 0 : level}
                min={0}
                max={1}
                step={0.05}
                valueText={silent ? "Muted" : volumeLabel(level)}
                onChange={(to) => {
                  ownLevel.current = true;
                  setLevel(to);
                  setMuted(false);
                }}
                onCommit={(to) => saveAudioVolume(levelStore(), to)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
