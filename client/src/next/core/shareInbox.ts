/**
 * Files shared to Linger from the phone's share sheet (#785, SPEC §4.15).
 *
 * The phone hands them to the app's shell outside the page: Android's intent
 * filter and the iPhone's share extension copy them into an inbox folder
 * (`src-tauri/src/shared.rs`), where they wait ten minutes at most. The list
 * window looks there when it starts, whenever it comes forward, and when the
 * shell or Android says a share arrived. What it finds goes up as a sheet
 * asking which conversation they're for; the chosen conversation opens with
 * them in its message box, unsent, as if they'd been picked with +. Closing
 * the sheet drops them, and either way the shell deletes them from the phone.
 *
 * Only the list of names is read to ask; the bytes are read once a
 * conversation is picked, so a share of a long video doesn't sit in memory
 * while the person decides. Asking takes the share: the shell sets it aside
 * under an id, and reading and deleting name that id, so a share arriving
 * meanwhile can't mix with it or be deleted with it (#792).
 */
import type { RoomId } from "../../generated/RoomId";
import { type Ask, type DroppedFile, readHandoff } from "../../lib/shellDrops";
import type { Bus } from "./bus";
import type { ListModel } from "./list";
import type { Showing } from "./phone";

/** The shell's word that a share may be waiting (`deep_link::SHARED`, from `linger://shared`). It carries nothing. */
export const SHARED = "next:shared";

/** Android's word for the same, raised on the window by `MainActivity.kt` once it has copied a share. */
export const ANDROID_SHARED = "linger:shared";

/** Why a shared thing can't be attached, in words; null when it can. */
export function sharedProblem(file: DroppedFile): string | null {
  if (file.problem === "folder") return `${file.name} is a folder. Share the files in it instead.`;
  if (file.problem === "too_big") return `${file.name} is too big to send. A file can be 500 MB at most.`;
  if (file.problem === "unreadable") return `Linger couldn't open ${file.name}.`;
  return null;
}

/** A share the shell has taken (`shared.rs`, `Share`): the id that names it, and its files. */
export interface Share {
  id: string;
  files: DroppedFile[];
}

/** What's waiting, taken by the shell, by name and size without reading any of it; null when nothing is. */
export async function listShared(ask: Ask): Promise<Share | null> {
  const listed = await ask("shared_files");
  if (typeof listed !== "object" || listed === null || !("id" in listed) || !("files" in listed)) return null;
  const { id, files } = listed;
  return typeof id === "string" && Array.isArray(files) && files.length > 0 ? { id, files: files as DroppedFile[] } : null;
}

/** The share's bytes, for a message box: the files the shell could read, and the first reason one couldn't be. */
export function readShared(ask: Ask, share: Share): Promise<{ files: File[]; problem: string | null }> {
  return readHandoff({ held: share.files, one: (index) => ask("shared_file", { share: share.id, index }), problem: sharedProblem });
}

/** The share is in a message box, or turned down: the shell deletes it from the phone, and nothing newer. */
export function sharedDone(ask: Ask, id: string): Promise<void> {
  return ask("shared_done", { share: id }).then(
    () => undefined,
    () => undefined,
  );
}

/** The parts of a window and its document this watches, as `core/phone.ts` takes them. */
export interface ShareWatch {
  bus: Pick<Bus, "listen">;
  window: {
    addEventListener(type: typeof ANDROID_SHARED, listener: () => void): void;
    removeEventListener(type: typeof ANDROID_SHARED, listener: () => void): void;
  };
  document: Showing;
}

/**
 * Look in the inbox now, and again whenever a share may have arrived: the
 * shell's word, Android's, or the app coming forward (an iPhone may not let
 * its share extension bring Linger forward, so the person does it). Each look
 * answers with what's waiting, which is null once it's gone. Looks never
 * overlap: one asked for during another runs after it.
 */
export function watchShares(watch: ShareWatch, ask: Ask, onLook: (waiting: Share | null) => void): () => void {
  let gone = false;
  let looking = false;
  let again = false;
  let stop: (() => void) | null = null;
  const look = () => {
    if (gone) return;
    if (looking) {
      again = true;
      return;
    }
    looking = true;
    void listShared(ask)
      .catch(() => null)
      .then((waiting) => {
        looking = false;
        if (gone) return;
        onLook(waiting);
        if (again) {
          again = false;
          look();
        }
      });
  };
  const forward = () => {
    if (watch.document.visibilityState === "visible") look();
  };
  watch.window.addEventListener(ANDROID_SHARED, look);
  watch.document.addEventListener("visibilitychange", forward);
  void watch.bus.listen<unknown>(SHARED, look).then(
    (unlisten) => {
      if (gone) unlisten();
      else stop = unlisten;
    },
    () => undefined,
  );
  look();
  return () => {
    gone = true;
    stop?.();
    watch.window.removeEventListener(ANDROID_SHARED, look);
    watch.document.removeEventListener("visibilitychange", forward);
  };
}

/** A conversation a share can go to. */
export interface ShareTarget {
  server: string;
  roomId: RoomId;
  /** As the list names it: a room's name, a group DM's people, a DM's person. */
  label: string;
  kind: "room" | "group" | "dm";
}

/** One server's conversations, in the list's order. */
export interface ShareSection {
  server: string;
  name: string;
  targets: ShareTarget[];
}

/**
 * Every conversation a share can go to, server by server as the list shows
 * them: rooms, then group DMs, then the people you have a DM with. A group
 * DM nobody else is in any more is left out, since nobody would see it.
 */
export function shareTargets(servers: readonly { id: string; name: string; model: ListModel }[]): ShareSection[] {
  return servers
    .map(({ id, name, model }) => {
      const rooms = model.rooms.map((room): ShareTarget => ({ server: id, roomId: room.id, label: room.name, kind: "room" }));
      const groups = model.groups.filter((group) => !group.last).map((group): ShareTarget => ({ server: id, roomId: group.id, label: group.label, kind: "group" }));
      const people = [...model.people.here, ...model.people.away, ...model.people.offline];
      const dms = people.flatMap((row): ShareTarget[] => (row.dm === null ? [] : [{ server: id, roomId: row.dm, label: row.user.display_name, kind: "dm" }]));
      return { server: id, name, targets: [...rooms, ...groups, ...dms] };
    })
    .filter((section) => section.targets.length > 0);
}

/** What the sheet's head says: what's being shared. */
export function shareHead(waiting: readonly DroppedFile[]): string {
  const one = waiting.length === 1 ? waiting[0] : undefined;
  return one ? `Share ${one.name} to…` : `Share ${waiting.length} files to…`;
}

/**
 * Files on their way to a conversation's message box, by its tab key
 * (`core/tabs.ts`, `keyOf`). The list window holds them here and opens the
 * conversation; that conversation's box takes them as soon as it's showing
 * (`useFileDrafts`), and its box says why any were left out (`Composer`).
 * Held in the module, as `shellDrops.ts` holds its drop zones, because the
 * box and the list window are far apart in the tree.
 */
const held = new Map<string, File[]>();
const heldProblems = new Map<string, string>();
const heldListeners = new Set<() => void>();

/** Hold `files` for the conversation with tab key `key`, and why any of the share didn't come with them. */
export function holdForConversation(key: string, files: File[], problem: string | null = null): void {
  if (files.length === 0) return;
  held.set(key, [...(held.get(key) ?? []), ...files]);
  if (problem !== null) heldProblems.set(key, problem);
  for (const listener of [...heldListeners]) listener();
}

/** Why some of what was shared to `key` was left out, once: taking it clears it. */
export function takeHeldProblem(key: string): string | null {
  const problem = heldProblems.get(key) ?? null;
  heldProblems.delete(key);
  return problem;
}

/** The files held for `key`, once: taking them clears them. */
export function takeHeld(key: string): File[] | null {
  const files = held.get(key);
  if (!files) return null;
  held.delete(key);
  return files;
}

/** Hear whenever files are held for any conversation. Answers how to stop. */
export function onHeld(listener: () => void): () => void {
  heldListeners.add(listener);
  return () => {
    heldListeners.delete(listener);
  };
}
