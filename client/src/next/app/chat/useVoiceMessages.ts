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

/** How long a start waits for the one before it to settle: one that hangs mustn't hold every later Record (#920). */
const LONGEST_WAIT_MS = 5_000;

/**
 * Voice messages (#401), per conversation, in one window: the panel's state
 * in each, and the one recording (`recorders.ts`): the desktop shell's on a
 * computer, the page's own on the phone. Moving to another conversation
 * while recording stops it, and the clip waits where it was recorded, to
 * hear back and send or discard. Closing the window throws it away.
 *
 * Undefined where there's no recorder: outside the apps, and on a phone whose
 * web view can't record (no microphone, or no Opus encoder, as on an iPhone
 * before iOS 26), which then offers no microphone button.
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
  /**
   * Which recorder this app has, if any: decided once, as the app doesn't
   * change. A phone's web view takes a moment to say whether it can make
   * Opus, so its microphone button comes once it has.
   */
  const [kind, setKind] = useState<"shell" | "page" | null>(() => (!isTauri() || onPhone() ? null : "shell"));
  useEffect(() => {
    if (!isTauri() || !onPhone()) return;
    let gone = false;
    void canRecordInPage().then((can) => {
      if (can && !gone) setKind("page");
    });
    return () => {
      gone = true;
    };
  }, []);
  const recorder = useRef<Recorder | null>(null);
  /**
   * The start under way (its microphone opening), if any: Escape, another
   * conversation or the window going call it off, and only the start that's
   * still this one may use its answer (#920). Each start is its own object.
   */
  const startingIn = useRef<{ conversation: string } | null>(null);
  /**
   * The last start, settled either way: the next waits for it, so a
   * microphone is never being opened twice at once (#920).
   */
  const lastStart = useRef<Promise<unknown>>(Promise.resolve());
  /** Starts not yet settled: with none, the next starts in the tap itself. */
  const pending = useRef(0);

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
        put(conversation, { kind: "kept", url: URL.createObjectURL(file), file, ms, note, sending: false, problem: null, nonce: crypto.randomUUID(), attachment: null });
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
      // The window going (or, docked, the chat folding away): what's
      // recording or starting is called off here, before the recorder goes.
      if (recordingIn.current !== null || startingIn.current !== null) void made.cancel();
      made.dispose();
      if (recorder.current === made) recorder.current = null;
    };
  }, [kind, finish]);

  // Another conversation shown while recording: stop, and keep the clip where
  // it was made. One still starting has nothing to keep: it's called off.
  useEffect(() => {
    const recording = recordingIn.current;
    if (recording !== null && recording !== paneId) void finish(recording, null);
    const starting = startingIn.current;
    if (starting !== null && starting.conversation !== paneId) {
      startingIn.current = null;
      void recorder.current?.cancel();
      put(starting.conversation, { kind: "ready", problem: null });
    }
  }, [paneId, finish, put]);

  // The window going: every kept clip let go of. What was recording or
  // starting was called off with the recorder (above).
  useEffect(
    () => () => {
      recordingIn.current = null;
      startingIn.current = null;
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
    if (conversation === null || recordingIn.current !== null || startingIn.current !== null) return;
    put(conversation, { kind: "starting" });
    const mine = { conversation };
    startingIn.current = mine;
    const devices = loadVoicePrefs().devices;
    // The recorder this start uses, kept: if it's called off and starts
    // anyway, it's stopped through this one, even once the page has let the
    // recorder go (#920).
    const using = recorder.current;
    // Only if this one wasn't called off meanwhile.
    const go = () => (startingIn.current !== mine ? Promise.reject(new Error("called off")) : (using?.start() ?? Promise.reject(new Error("no input device available"))));
    // With nothing before it, now, in the tap that pressed Record: an iPhone
    // starts a page's sound only from a tap (#687). After one still settling
    // (Escape, then Record again), once it has, or a while if it hangs.
    let starting: Promise<void>;
    if (pending.current === 0) starting = go();
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((done) => (timer = setTimeout(done, LONGEST_WAIT_MS)));
      starting = Promise.race([lastStart.current, waited]).finally(() => clearTimeout(timer)).then(go);
    }
    pending.current += 1;
    // Only this start's answer counts, and only while it's still the one
    // starting: called off meanwhile, its answer is nobody's (#920).
    const stillThisOne = () => {
      if (startingIn.current !== mine) return false;
      startingIn.current = null;
      return true;
    };
    const answered = starting.then(
      async () => {
        // Called off, and it started anyway (the shell heard the cancel
        // before the start): stopped now, and the next start waits for that.
        if (!stillThisOne()) {
          await using?.cancel();
          return;
        }
        recordingIn.current = conversation;
        put(conversation, { kind: "recording", since: Date.now(), levels: [] });
      },
      (error: unknown) => {
        if (!stillThisOne()) return;
        put(conversation, { kind: "ready", problem: startProblemWords(voiceStartProblem(error instanceof Error ? error.message : String(error), onWindows(), devices, onPhone())) });
      },
    );
    lastStart.current = answered.catch(() => undefined).finally(() => {
      pending.current -= 1;
    });
  }, [paneId, put]);

  const stop = useCallback(() => {
    if (paneId !== null) void finish(paneId, null);
  }, [paneId, finish]);

  const discard = useCallback(() => {
    if (paneId === null) return;
    const now = clipsNow.current.get(paneId);
    if (recordingIn.current === paneId || startingIn.current?.conversation === paneId) {
      recordingIn.current = null;
      startingIn.current = null;
      void recorder.current?.cancel();
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
      // Sent again after a failure, it's the same send (#524): the file that
      // already went up, and the same one-time key, so a send that did land
      // is answered with its message rather than posted twice.
      let attachment = now.attachment;
      try {
        attachment ??= await uploadFile(api, now.file, {});
        await sendMessage(api, tab.roomId, "", null, [attachment], now.nonce);
        URL.revokeObjectURL(now.url);
        put(conversation, null);
      } catch (error: unknown) {
        const words = error instanceof ApiError || error instanceof UnconfirmedError ? error.message : "Couldn't reach the server. The voice message is kept here.";
        put(conversation, { ...now, attachment, sending: false, problem: words });
      }
    })();
  }, [paneId, apis, find, put]);

  return useMemo(() => (kind !== null ? { state, open, record, stop, discard, send } : undefined), [kind, state, open, record, stop, discard, send]);
}
