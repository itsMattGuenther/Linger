/**
 * Files dropped on the Linux app (#673, COMP-11).
 *
 * Everywhere else a file dropped on the message box reaches the page as a
 * `drop` with its files, and the box takes them (`Composer.tsx`). WebKitGTK
 * stopped handing a page the files dropped on it (WebKit bugs 323277 and
 * 320301): the drop arrives empty. So on Linux the shell takes the drop
 * instead (`src-tauri/src/dropped.rs`), which also keeps the web view from
 * opening the file in place of the app, and tells the page where it landed.
 * This finds the message box under it, asks the shell for the files, and
 * hands them to that box as if they had been dropped there.
 *
 * The page still sees the drag go over it, so the box under the last
 * `dragover` is the one it landed on; the drop's own position is the fallback.
 * Dropped anywhere but a message box, nothing happens, as everywhere else.
 */
import { getCurrentWebview } from "@tauri-apps/api/webview";

/** A message box, as a drop reaches it: take these files, or say why not. */
export interface DropZone {
  attach: (files: File[]) => void;
  say: (words: string) => void;
}

/** One dropped thing, as the shell lists it (`dropped.rs`, `DroppedFile`). */
export interface DroppedFile {
  name: string;
  size: number;
  problem: "folder" | "too_big" | "unreadable" | null;
}

/** How the page asks the shell: `invoke`, or a stand-in. */
export type Ask = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** How long a `dragover` still says where the drop is: the last one comes a moment before it. */
export const OVER_FRESH_MS = 1_000;

/** Every message box in this window, each by its element, with how to reach it now. */
const zones = new Map<Element, () => DropZone>();

/** A message box takes drops from the shell while it's on the page. Answers how to stop. */
export function dropZone(element: Element, zone: () => DropZone): () => void {
  zones.set(element, zone);
  return () => {
    if (zones.get(element) === zone) zones.delete(element);
  };
}

/** The message box `element` is in, if it's in one. */
export function zoneAt(element: Element | null): DropZone | null {
  for (let at = element; at; at = at.parentElement) {
    const zone = zones.get(at);
    if (zone) return zone();
  }
  return null;
}

/** What a dropped file is, by its name, so a picture shows as one before it's sent. */
export function typeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return TYPES[extension] ?? "";
}

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain",
  zip: "application/zip",
};

/** Why a dropped thing wasn't attached, in words; null when it was. */
export function droppedProblem(file: DroppedFile): string | null {
  if (file.problem === "folder") return `${file.name} is a folder. Drop the files in it instead.`;
  if (file.problem === "too_big") return `${file.name} is too big to send. A file can be 500 MB at most.`;
  if (file.problem === "unreadable") return `Linger couldn't open ${file.name}.`;
  return null;
}

/** Bytes as the shell answers them (`tauri::ipc::Response`). */
function bytesOf(answer: unknown): Uint8Array | null {
  if (answer instanceof ArrayBuffer) return new Uint8Array(answer);
  if (ArrayBuffer.isView(answer)) return new Uint8Array(answer.buffer, answer.byteOffset, answer.byteLength);
  if (Array.isArray(answer) && answer.every((byte) => typeof byte === "number")) return Uint8Array.from(answer);
  return null;
}

/** One handoff of files from the shell: dropped ones, or shared ones (`core/shareInbox.ts`). */
export interface Handoff {
  /** The files, as the shell listed them. */
  held: readonly DroppedFile[];
  /** Ask the shell for the bytes of the file at `index` in that list. */
  one: (index: number) => Promise<unknown>;
  problem: (file: DroppedFile) => string | null;
}

/**
 * The files the shell is holding for this window, each by its place in the
 * list: the ones it could read, and the first reason something couldn't be
 * sent.
 */
export async function readHandoff(handoff: Handoff): Promise<{ files: File[]; problem: string | null }> {
  const files: File[] = [];
  let problem: string | null = null;
  for (const [index, file] of handoff.held.entries()) {
    const why = handoff.problem(file);
    if (why !== null) {
      problem ??= why;
      continue;
    }
    const bytes = await handoff
      .one(index)
      .then(bytesOf)
      .catch(() => null);
    if (bytes === null) {
      problem ??= handoff.problem({ ...file, problem: "unreadable" });
      continue;
    }
    // A copy of its own: the answer's buffer may be shared, and a file keeps its bytes.
    files.push(new File([bytes.slice()], file.name, { type: typeFromName(file.name) }));
  }
  return { files, problem };
}

/**
 * What was just dropped on this window, from the shell: the files it could
 * read, and the first reason something couldn't be sent.
 */
export async function readDropped(ask: Ask): Promise<{ files: File[]; problem: string | null }> {
  const listed = await ask("dropped_files");
  const held = Array.isArray(listed) ? (listed as DroppedFile[]) : [];
  return readHandoff({ held, one: (index) => ask("dropped_file", { index }), problem: droppedProblem });
}

/** Where a drop landed, in the page's own pixels. */
export interface Landed {
  x: number;
  y: number;
}

/**
 * Take the shell's drops into the message box they land on. `onDrop` is how
 * this window hears the shell's drop (`getCurrentWebview().onDragDropEvent`).
 * Answers how to stop.
 */
export function takeDropsFromTheShell(page: Window, onDrop: (dropped: (at: Landed) => void) => Promise<() => void>, ask: Ask): () => void {
  let over: { target: EventTarget | null; at: number } | null = null;
  const dragging = (event: Event) => {
    over = { target: event.target, at: performance.now() };
  };
  page.addEventListener("dragover", dragging, true);
  const landed = (at: Landed) => {
    const recent = over !== null && performance.now() - over.at <= OVER_FRESH_MS ? over.target : null;
    const under = recent instanceof Element ? recent : page.document.elementFromPoint(at.x, at.y);
    over = null;
    const zone = zoneAt(under);
    if (!zone) return;
    void readDropped(ask).then(({ files, problem }) => {
      if (files.length > 0) zone.attach(files);
      if (problem !== null) zone.say(problem);
    });
  };
  let stop: (() => void) | null = null;
  let gone = false;
  void onDrop(landed).then((unlisten) => {
    if (gone) unlisten();
    else stop = unlisten;
  });
  return () => {
    gone = true;
    page.removeEventListener("dragover", dragging, true);
    stop?.();
  };
}

/**
 * This window's drops, as the shell hands them over: its position is in the
 * web view's own pixels on Linux (wry passes GTK's widget coordinates), so
 * zoom aside it's where the page has it.
 */
export function hearShellDrops(dropped: (at: Landed) => void): Promise<() => void> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") dropped({ x: event.payload.position.x, y: event.payload.position.y });
  });
}
