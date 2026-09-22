/**
 * The voice surface (SPEC §4.14, T-1404): one line under the room header.
 *
 * Voice happens *in a room*, so the surface lives in the room rather than
 * in a panel of its own: a way in, a way out, who is talking, and the two
 * things that are yours alone — mute and how loud each person is. There is
 * no call to answer and nothing rings; the line is empty until somebody is
 * in voice here, and then it says who.
 *
 * Console rules apply (SPEC §5): no bubbles, no glow, no animated rings.
 * Somebody talking is their name drawn a little brighter, the way a live
 * status is drawn anywhere else in the app.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { Room } from "../generated/Room";
import type { User } from "../generated/User";
import type { AuthedApi } from "../lib/api";
import {
  joinVoice,
  setVoiceVolume,
  useGateway,
  voicePeersIn,
} from "../lib/gateway";
import { nameProps } from "../lib/names";
import { clampVolume, loadVoicePrefs, seatsOf, volumeLabel } from "./voice";
import "./voice.css";
import { useWindowHeight } from "../lib/layout";
import { useInterfaceScale } from "../lib/interface";
import VoiceControls from "./VoiceControls";
import Button from "../lib/Button";
import IconButton from "../lib/IconButton";
import ContextPanel from "../lib/ContextPanel";
import { ActionIcon } from "../lib/icons";

export default function VoiceBar({
  api,
  room,
  users,
}: {
  api: AuthedApi;
  room: Room;
  users: User[];
}) {
  const gateway = useGateway(api.baseUrl);
  const peers = voicePeersIn(gateway, room.id);
  const mine = gateway.myVoice;
  const seatedHere = mine !== null && mine.roomId === room.id;
  const seatedElsewhere = mine !== null && mine.roomId !== room.id;
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const seatsId = useId();
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const closeOptions = (): void => {
    setSelected(null);
    selectedTrigger.current?.focus();
  };
  const shortWindow = useWindowHeight() / (useInterfaceScale() / 100) < 360;
  const [collapsePreference, setCollapsePreference] = useState<boolean | null>(
    () => {
      try {
        const saved = localStorage.getItem("linger.voice.collapsed");
        return saved === null ? null : saved === "true";
      } catch {
        return null;
      }
    },
  );
  const collapsed = collapsePreference ?? shortWindow;
  const togglePeople = (): void => {
    setSelected(null);
    setCollapsePreference(!collapsed);
    try {
      localStorage.setItem("linger.voice.collapsed", String(!collapsed));
    } catch {
      /* Session-only. */
    }
  };
  useEffect(() => {
    setSelected(null);
  }, [room.id, api.baseUrl]);
  const controlProblem = useCallback((error: unknown): void => {
    setProblem(
      error instanceof Error
        ? error.message
        : "Couldn't change voice controls.",
    );
  }, []);

  // Read once per join rather than subscribed: a device changed in settings
  // applies to the next join, which is the honest promise and the simple one.
  const join = async (): Promise<void> => {
    const prefs = loadVoicePrefs();
    setJoining(true);
    setProblem(null);
    try {
      await joinVoice(api, room.id, prefs.devices, prefs.pushToTalk);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "Couldn't join voice.",
      );
    } finally {
      setJoining(false);
    }
  };

  const seats = seatsOf(peers, users, gateway.sessionId);
  const selectedSeat = seats.find((seat) => seat.sessionId === selected);

  return (
    <div
      className="voice-bar"
      aria-label="voice"
      data-collapsed={collapsed || undefined}
    >
      <div className="voice-heading">
        {seats.length > 0 ? (
          <IconButton
            label={
              collapsed
                ? "Expand voice participants"
                : "Collapse voice participants"
            }
            className="voice-collapse"
            tooltipSide="below"
            aria-expanded={!collapsed}
            aria-controls={seatsId}
            onClick={togglePeople}
          >
            <ActionIcon name={collapsed ? "chevronDown" : "chevronUp"} />
          </IconButton>
        ) : (
          <ActionIcon name="mic" />
        )}
        <span className="voice-label">{seatedHere ? "In voice" : "Voice"}</span>
      </div>
      <ul
        id={seatsId}
        className="voice-seats"
        hidden={collapsed || seats.length === 0}
      >
        {seats.map((seat) => {
          const talking = seat.isMe
            ? seatedHere && mine.talking
            : seatedHere && (mine.speaking[seat.sessionId] ?? false);
          const link =
            seatedHere && !seat.isMe ? mine.peers[seat.sessionId] : undefined;
          const controls = seat.isMe && seatedHere ? mine : seat.controls;
          return (
            <li
              key={seat.sessionId}
              className="voice-seat"
              data-talking={talking ? "true" : undefined}
              data-link={link}
            >
              <button
                type="button"
                className="voice-person"
                aria-expanded={selected === seat.sessionId}
                aria-haspopup="dialog"
                aria-label={`${seat.name}, voice options`}
                onClick={(event) => {
                  selectedTrigger.current = event.currentTarget;
                  setSelected(
                    selected === seat.sessionId ? null : seat.sessionId,
                  );
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  selectedTrigger.current = event.currentTarget;
                  setSelected(seat.sessionId);
                }}
              >
                <span {...nameProps(seat.user, "voice-name")}>{seat.name}</span>
              </button>
              <div className="voice-seat-state">
                {seat.isMe ? <span className="meta">you</span> : null}
                {controls === null ? (
                  <span
                    className="meta"
                    title="This client or server does not share voice controls."
                  >
                    mic state unknown
                  </span>
                ) : controls.deafened ? (
                  <span className="meta">deafened</span>
                ) : controls.muted ? (
                  <span className="meta">muted</span>
                ) : null}
                {/* A screen reader gets the word; sighted people get the weight. */}
                {talking ? <span className="sr-only">talking</span> : null}
                {link === "connecting" || link === "new" ? (
                  <span className="meta">connecting…</span>
                ) : link === "failed" || link === "disconnected" ? (
                  <span className="meta">can't reach</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {selectedSeat && !collapsed && selectedTrigger.current ? (
        <ContextPanel
          anchor={selectedTrigger.current}
          className="voice-options"
          label={`Voice options for ${selectedSeat.name}`}
          onClose={closeOptions}
        >
          <h3 {...nameProps(selectedSeat.user, "context-name")}>
            {selectedSeat.name}
          </h3>
          {seatedHere && !selectedSeat.isMe ? (
            <Volume
              value={mine.volumes[selectedSeat.sessionId] ?? 1}
              name={selectedSeat.name}
              onChange={(volume) =>
                setVoiceVolume(api.baseUrl, selectedSeat.sessionId, volume)
              }
            />
          ) : (
            <span className="meta">
              {selectedSeat.isMe
                ? "Use mute and deafen in the voice controls."
                : "Join voice to adjust their volume for you."}
            </span>
          )}
        </ContextPanel>
      ) : null}
      {seatedHere ? (
        <VoiceControls
          server={api.baseUrl}
          mine={mine}
          onProblem={controlProblem}
        />
      ) : (
        <div className="voice-controls">
          <Button
            variant="primary"
            type="button"
            className="voice-action voice-join"
            disabled={joining}
            onClick={() => void join()}
          >
            {joining
              ? "Joining voice…"
              : seatedElsewhere
                ? "Move voice here"
                : "Join Voice"}
          </Button>
        </div>
      )}
      {problem === null ? null : (
        <span className="voice-problem meta">{problem}</span>
      )}
    </div>
  );
}

/**
 * How loud one person is, for you. A plain range: 0 is silent, the middle is
 * as sent, the top is twice that. The number beside it is metadata, so mono.
 */
function Volume({
  value,
  name,
  onChange,
}: {
  value: number;
  name: string;
  onChange: (volume: number) => void;
}) {
  return (
    <label className="voice-volume">
      <span className="voice-volume-label">Volume for {name}</span>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={value}
        onChange={(event) => onChange(clampVolume(Number(event.target.value)))}
      />
      <span className="meta">{volumeLabel(value)}</span>
    </label>
  );
}
