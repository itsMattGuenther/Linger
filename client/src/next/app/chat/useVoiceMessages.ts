import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type AuthedApi, UnconfirmedError } from "../../../lib/api";
import { sendMessage } from "../../../lib/gateway";
import { uploadFile } from "../../../lib/upload";
import { loadVoicePrefs, onWindows, startProblemWords, voiceStartProblem } from "../../../lib/voice";
import { opusWebm, PACKET_MS } from "../../../lib/webm";
import { onPhone } from "../../core/phone";
import { FULL_NOTE, LOST_NOTE, SHORTEST_MS, TOO_SHORT, VOICE_MESSAGE_NAME, type VoiceMessage, withLevel } from "../../core/chat/voiceMessage";
import type { TabKey } from "../../core/tabs";
import { canRecordInPage, pageRecorder, type Recorder, type RecorderEvents, shellRecorder } from "./recorders";

/** What the message box does with a voice message (#401), for the conversation showing. */
export interface VoiceMessageControls {
  /** This conversation's panel, or null when it's closed. */
  state: VoiceMessage | null;
  /** The microphone button: open the panel, ready to record. */
  open: () => void;
  record: () => void;
  stop: () => void;
  /** Throw the recording away and close the panel. */
  discard: () => void;
  send: () => void;
}

/**
 * Voice messages (#401), per conversation, in one window: the panel's state
 * in each, and the one recording (`recorders.ts`): the desktop shell's on a
 * computer, the page's own on the phone. Moving to another conversation
 * while recording stops it, and the clip waits where it was recorded, to
 * hear back and send or discard. Closing the window throws it away.
 *
 * Undefined where there's no recorder: outside the apps, and on a phone whose
 * web view can't record (no microphone, or no Opus encoder), which then
 * offers no microphone button.
 */
export function useVoiceMessages(
  paneId: string | null,
  apis: ReadonlyMap<string, AuthedApi>,
  find: (id: string) => TabKey | undefined,
): VoiceMessageControls | undefined {
  const [clips, setClips] = useState<ReadonlyMap<string, VoiceMessage>>(new Map());
  const clipsNow = useRef(clips);
  clipsNow.current = clips;
  /** The conversation being recorded in, if any. */
  const recordingIn = useRef<string | null>(null);
  /** Which recorder this app has, if any: decided once, as the app doesn't change. */
  const [kind] = useState<"shell" | "page" | null>(() => (!isTauri() ? null : onPhone() ? (canRecordInPage() ? "page" : null) : "shell"));
  const recorder = useRef<Recorder | null>(null);

  const put = useCallback((conversation: string, next: VoiceMessage | null) => {
    setClips((held) => {
      const out = new Map(held);
      if (next === null) out.delete(conversation);
      else out.set(conversation, next);
      return out;
    });
  }, []);

  // Stop, and put the clip together for hearing back. `note` says why when
  // it stopped by itself.
  const finish = useCallback(
    async (conversation: string, note: string | null) => {
      if (recordingIn.current !== conversation) return;
      recordingIn.current = null;
      put(conversation, { kind: "stopping" });
      try {
        const clip = await recorder.current?.stop();
        if (!clip) throw new Error("unreadable");
        const ms = clip.packets.length * PACKET_MS;
        if (ms < SHORTEST_MS) {
          put(conversation, { kind: "ready", problem: TOO_SHORT });
          return;
        }
        const file = new File([opusWebm(clip.packets, clip.preSkip)], VOICE_MESSAGE_NAME, { type: "audio/webm" });
        put(conversation, { kind: "kept", url: URL.createObjectURL(file), file, ms, note, sending: false, problem: null });
      } catch {
        put(conversation, { kind: "ready", problem: "The recording couldn't be kept. Try again." });
      }
    },
    [put],
  );

  // The recorder, telling the panel how loud you are while recording, and
  // when it stopped by itself.
  useEffect(() => {
    if (kind === null) return;
    const events: RecorderEvents = {
      level: (level) => {
        const conversation = recordingIn.current;
        if (conversation === null) return;
        setClips((held) => {
          const now = held.get(conversation);
          if (now?.kind !== "recording") return held;
          return new Map(held).set(conversation, { ...now, levels: withLevel(now.levels, level) });
        });
      },
      ended: (why) => {
        if (recordingIn.current !== null) void finish(recordingIn.current, why === "full" ? FULL_NOTE : LOST_NOTE);
      },
    };
    const made = kind === "shell" ? shellRecorder(events, () => loadVoicePrefs().devices.input) : pageRecorder(events);
    recorder.current = made;
    return () => {
      made.dispose();
      if (recorder.current === made) recorder.current = null;
    };
  }, [kind, finish]);

  // Another conversation shown while recording: stop, and keep the clip where it was made.
  useEffect(() => {
    const recording = recordingIn.current;
    if (recording !== null && recording !== paneId) void finish(recording, null);
  }, [paneId, finish]);

  // The window going: whatever is recording is thrown away, and every kept clip let go of.
  useEffect(
    () => () => {
      if (recordingIn.current !== null) recorder.current?.cancel();
      recordingIn.current = null;
      for (const clip of clipsNow.current.values()) if (clip.kind === "kept") URL.revokeObjectURL(clip.url);
    },
    [],
  );

  const state = paneId === null ? null : (clips.get(paneId) ?? null);

  const open = useCallback(() => {
    if (paneId !== null && !clipsNow.current.has(paneId)) put(paneId, { kind: "ready", problem: null });
  }, [paneId, put]);

  const record = useCallback(() => {
    const conversation = paneId;
    if (conversation === null || recordingIn.current !== null) return;
    put(conversation, { kind: "starting" });
    const devices = loadVoicePrefs().devices;
    const starting = recorder.current?.start() ?? Promise.reject(new Error("no input device available"));
    starting.then(
      () => {
        recordingIn.current = conversation;
        put(conversation, { kind: "recording", since: Date.now(), levels: [] });
      },
      (error: unknown) =>
        put(conversation, { kind: "ready", problem: startProblemWords(voiceStartProblem(error instanceof Error ? error.message : String(error), onWindows(), devices)) }),
    );
  }, [paneId, put]);

  const stop = useCallback(() => {
    if (paneId !== null) void finish(paneId, null);
  }, [paneId, finish]);

  const discard = useCallback(() => {
    if (paneId === null) return;
    const now = clipsNow.current.get(paneId);
    if (recordingIn.current === paneId) {
      recordingIn.current = null;
      recorder.current?.cancel();
    }
    if (now?.kind === "kept") URL.revokeObjectURL(now.url);
    put(paneId, null);
  }, [paneId, put]);

  const send = useCallback(() => {
    const conversation = paneId;
    if (conversation === null) return;
    const now = clipsNow.current.get(conversation);
    if (now?.kind !== "kept" || now.sending) return;
    const tab = find(conversation);
    const api = tab ? apis.get(tab.server) : undefined;
    if (!tab || !api) {
      put(conversation, { ...now, problem: "That conversation is closed. The voice message is kept here." });
      return;
    }
    put(conversation, { ...now, sending: true, problem: null });
    void (async () => {
      try {
        const attachment = await uploadFile(api, now.file, {});
        await sendMessage(api, tab.roomId, "", null, [attachment]);
        URL.revokeObjectURL(now.url);
        put(conversation, null);
      } catch (error: unknown) {
        const words = error instanceof ApiError || error instanceof UnconfirmedError ? error.message : "Couldn't reach the server. The voice message is kept here.";
        put(conversation, { ...now, sending: false, problem: words });
      }
    })();
  }, [paneId, apis, find, put]);

  return useMemo(() => (kind !== null ? { state, open, record, stop, discard, send } : undefined), [kind, state, open, record, stop, discard, send]);
}
