import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type AuthedApi, UnconfirmedError } from "../../../lib/api";
import { sendMessage } from "../../../lib/gateway";
import { uploadFile, worthTryingAgain } from "../../../lib/upload";
import {
  added,
  type Drafts,
  filesIn,
  NO_DRAFTS,
  NO_FILES,
  previewed,
  previews,
  progressed,
  refused,
  removed,
  restored,
  retrying,
  sent,
  taken,
  uploaded,
  waiting,
} from "../../core/chat/drafts";
import type { Submission } from "../../core/chat/sending";
import { onHeld, takeHeld } from "../../core/shareInbox";
import type { TabKey } from "../../core/tabs";
import { pictureCopy } from "./pictureCopy";

/**
 * Files on their way into a message, per conversation, and sending: each
 * file uploads on its own and reports its progress; a send takes its files
 * for the attempt and holds them until it's through (core/chat/drafts.ts).
 * `api` and `paneId` are the showing conversation's; `find` turns a tab id
 * back into its conversation, so a send lands where it was typed even after
 * a tab switch.
 */
export function useFileDrafts(
  api: AuthedApi | null,
  paneId: string | null,
  apis: ReadonlyMap<string, AuthedApi>,
  find: (id: string) => TabKey | undefined,
) {
  const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
  const draftsNow = useRef(drafts);
  draftsNow.current = drafts;
  // Each file still going up, by key, so taking it out of the box can stop
  // it (#503); and every one is stopped when the window goes, since nothing
  // could ever send them then.
  const going = useRef(new Map<string, AbortController>());
  // Each file not up yet, by key, so Try again can send it from the start
  // (#801): kept until the server has it or it leaves the box.
  const chosen = useRef(new Map<string, File>());
  useEffect(() => {
    const uploads = going.current;
    return () => {
      for (const upload of uploads.values()) upload.abort();
      uploads.clear();
    };
  }, []);

  // A picture's preview is a blob URL (#397): let go of with its file, and
  // every one still held when the window goes.
  useEffect(() => () => previews(draftsNow.current).forEach((url) => URL.revokeObjectURL(url)), []);
  const letGo = useCallback((held: Drafts, keys: readonly string[]) => {
    const urls = previews(held);
    for (const key of keys) {
      const url = urls.get(key);
      if (url) URL.revokeObjectURL(url);
    }
  }, []);

  // One file going up on its own (core/chat/drafts.ts). A refusal that
  // sending it again could get past keeps the file for Try again (#801).
  const upload = useCallback((to: AuthedApi, key: string, file: File) => {
    const stop = new AbortController();
    going.current.set(key, stop);
    chosen.current.set(key, file);
    uploadFile(to, file, {
      signal: stop.signal,
      onProgress: (fraction) => setDrafts((held) => progressed(held, key, fraction)),
      onWaiting: () => setDrafts((held) => waiting(held, key)),
    }).then(
      (attachment) => {
        going.current.delete(key);
        chosen.current.delete(key);
        setDrafts((held) => uploaded(held, key, attachment));
      },
      (error: unknown) => {
        going.current.delete(key);
        // Stopped on purpose: the file is already out of the box.
        if (stop.signal.aborted) return;
        const again = worthTryingAgain(error);
        if (!again) chosen.current.delete(key);
        setDrafts((held) => refused(held, key, error instanceof ApiError ? error.message : "That file didn't go up.", again));
      },
    );
  }, []);

  // Files, per conversation, uploading on their own.
  const onAttach = useCallback(
    (picked: File[]) => {
      if (!api || paneId === null) return;
      const files = picked.map((file) => ({ file, key: `${paneId} ${file.name} ${Date.now()} ${Math.random()}` }));
      setDrafts((held) => added(held, paneId, files.map(({ key, file }) => ({ key, name: file.name }))));
      for (const { file, key } of files) {
        // A picture shows a small copy of itself in the box (#397).
        void pictureCopy(file).then((url) => {
          if (url === null) return;
          setDrafts((held) => {
            const next = previewed(held, key, url);
            if (next !== null) return next;
            // Taken out before its preview was ready.
            URL.revokeObjectURL(url);
            return held;
          });
        });
        upload(api, key, file);
      }
    },
    [api, paneId, upload],
  );

  // Try again (#801): a file that didn't go up, sent from the start, with
  // the showing conversation's server, the only one its row is shown in.
  const onRetryFile = useCallback(
    (key: string) => {
      const file = chosen.current.get(key);
      if (!api || !file || going.current.has(key)) return;
      setDrafts((held) => retrying(held, key));
      upload(api, key, file);
    },
    [api, upload],
  );
  // Files shared to Linger from the phone's share sheet (#785): the list
  // window holds them for the conversation they were shared to and opens it,
  // and they go in its box here, as if picked with +, the moment it shows.
  useEffect(() => {
    if (!api || paneId === null) return;
    const take = () => {
      const files = takeHeld(paneId);
      if (files) onAttach(files);
    };
    take();
    return onHeld(take);
  }, [api, paneId, onAttach]);

  const onRemoveFile = useCallback(
    (key: string) => {
      // Still going up: stop sending, and the upload gives its slot back
      // (lib/upload.ts), so the space is everybody's again at once (#503).
      going.current.get(key)?.abort();
      going.current.delete(key);
      chosen.current.delete(key);
      const { drafts: next, abandoned } = removed(draftsNow.current, key);
      letGo(draftsNow.current, [key]);
      setDrafts(next);
      // A finished upload nothing will point at: give the server its space back.
      if (abandoned && api) void api.cancelUpload(String(abandoned.id)).catch(() => undefined);
    },
    [api, letGo],
  );
  const onRestoreFiles = useCallback((keys: string[]) => setDrafts((held) => restored(held, keys)), []);

  const onSend = useCallback(
    async (submission: Submission) => {
      const tab = find(submission.conversation);
      const sendApi = tab ? apis.get(tab.server) : undefined;
      if (!tab || !sendApi) throw new Error("That conversation is closed. Your message is kept here.");
      const taking = taken(draftsNow.current, submission.conversation, submission.fileKeys);
      if (taking === null) throw new Error("A file is still uploading. Your message is kept here.");
      setDrafts(taking.drafts);
      draftsNow.current = taking.drafts;
      try {
        await sendMessage(sendApi, tab.roomId, submission.body, submission.replyTo, taking.attachments, submission.nonce);
      } catch (error: unknown) {
        // The server's own words, or, for a send nobody answered, that it
        // wasn't confirmed, never that it was lost (#118). Anything else is
        // the network, in the chat's own words.
        throw new Error(
          error instanceof ApiError || error instanceof UnconfirmedError ? error.message : "Couldn't reach the server. Your message is kept here.",
        );
      }
      letGo(draftsNow.current, submission.fileKeys);
      setDrafts((held) => sent(held, submission.fileKeys));
    },
    [apis, find, letGo],
  );

  return { files: paneId === null ? NO_FILES : filesIn(drafts, paneId), onAttach, onRemoveFile, onRetryFile, onRestoreFiles, onSend };
}
