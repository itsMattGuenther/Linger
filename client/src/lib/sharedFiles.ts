/**
 * Files shared to Linger from the phone's share sheet (#785, SPEC §4.15).
 *
 * The phone hands them to the app's shell outside the page (Android's intent
 * filter, the iPhone's share extension), which holds them for a minute
 * (`src-tauri/src/shared.rs`). The page asks for them the way it asks for
 * files dropped on Linux (`shellDrops.ts`), and they go to a message box as
 * attachments. Nothing is sent from here: the person sends from the box.
 */
import { type Ask, type DroppedFile, readHandoff } from "./shellDrops";

/** Why a shared thing wasn't attached, in words; null when it was. */
export function sharedProblem(file: DroppedFile): string | null {
  if (file.problem === "folder") return `${file.name} is a folder. Share the files in it instead.`;
  if (file.problem === "too_big") return `${file.name} is too big to send. A file can be 500 MB at most.`;
  if (file.problem === "unreadable") return `Linger couldn't open ${file.name}.`;
  return null;
}

/** What was just shared to Linger, from the shell: the files it could read, and the first reason one couldn't be sent. */
export function readShared(ask: Ask): Promise<{ files: File[]; problem: string | null }> {
  return readHandoff(ask, { list: "shared_files", one: "shared_file", problem: sharedProblem });
}

/** The files are in a message box: tell the shell it can forget them and delete them from the phone. */
export function sharedDone(ask: Ask): Promise<void> {
  return ask("shared_done").then(
    () => undefined,
    () => undefined,
  );
}
