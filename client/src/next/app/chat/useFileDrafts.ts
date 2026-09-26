import { useCallback, useRef, useState } from "react";
import { ApiError, type AuthedApi, UnconfirmedError } from "../../../lib/api";
import { sendMessage } from "../../../lib/gateway";
import { uploadFile } from "../../../lib/upload";
import { added, type Drafts, filesIn, NO_DRAFTS, NO_FILES, progressed, refused, removed, restored, sent, taken, uploaded } from "../../core/chat/drafts";
import type { Submission } from "../../core/chat/sending";
import type { TabKey } from "../../core/tabs";

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

  // Files, per conversation, uploading on their own (core/chat/drafts.ts).
  const onAttach = useCallback(
    (chosen: File[]) => {
      if (!api || paneId === null) return;
      const files = chosen.map((file) => ({ file, key: `${paneId} ${file.name} ${Date.now()} ${Math.random()}` }));
      setDrafts((held) => added(held, paneId, files.map(({ key, file }) => ({ key, name: file.name }))));
      for (const { file, key } of files) {
        uploadFile(api, file, { onProgress: (fraction) => setDrafts((held) => progressed(held, key, fraction)) }).then(
          (attachment) => setDrafts((held) => uploaded(held, key, attachment)),
          (error: unknown) => setDrafts((held) => refused(held, key, error instanceof ApiError ? error.message : "That file didn't go up.")),
        );
      }
    },
    [api, paneId],
  );
  const onRemoveFile = useCallback(
    (key: string) => {
      const { drafts: next, abandoned } = removed(draftsNow.current, key);
      setDrafts(next);
      // A finished upload nothing will point at: give the server its space back.
      if (abandoned && api) void api.cancelUpload(String(abandoned.id)).catch(() => undefined);
    },
    [api],
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
        await sendMessage(sendApi, tab.roomId, submission.body, submission.replyTo, taking.attachments);
      } catch (error: unknown) {
        // The server's own words, or, for a send nobody answered, that it
        // wasn't confirmed, never that it was lost (#118). Anything else is
        // the network, in the chat's own words.
        throw new Error(
          error instanceof ApiError || error instanceof UnconfirmedError ? error.message : "Couldn't reach the server. Your message is kept here.",
        );
      }
      setDrafts((held) => sent(held, submission.fileKeys));
    },
    [apis, find],
  );

  return { files: paneId === null ? NO_FILES : filesIn(drafts, paneId), onAttach, onRemoveFile, onRestoreFiles, onSend };
}
