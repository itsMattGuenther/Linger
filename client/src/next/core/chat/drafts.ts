/**
 * Files on their way into a message, per conversation (app/chat/Composer.tsx,
 * `DraftFile`). The window uploads them; this keeps the bookkeeping, pure:
 *
 * - each file uploads on its own and reports its own progress;
 * - a send takes its files out of the draft for the attempt and holds them:
 *   on success they're gone, on failure they wait with the unsent message,
 *   or go back into the draft (`restore`);
 * - switching conversations never moves a file: it belongs where it was added.
 */
import type { Attachment } from "../../../generated/Attachment";

export interface DraftFile {
  key: string;
  name: string;
  /** 0 to 1. */
  progress: number;
  /** The server has it: it can go with a message. */
  ready: boolean;
  /** Why it didn't go up, in words. */
  problem: string | null;
}

export interface Drafts {
  /** The files in each conversation's draft, by conversation id. */
  draft: Readonly<Record<string, readonly DraftFile[]>>;
  /** What the server made of each finished upload, by file key. */
  uploaded: Readonly<Record<string, Attachment>>;
  /** Files taken out of a draft by a send still in flight or failed, by key. */
  held: Readonly<Record<string, { conversation: string; file: DraftFile }>>;
}

export const NO_DRAFTS: Drafts = { draft: {}, uploaded: {}, held: {} };
export const NO_FILES: readonly DraftFile[] = [];

/** Files picked, dropped or pasted into a conversation's box. */
export function added(drafts: Drafts, conversation: string, files: readonly { key: string; name: string }[]): Drafts {
  const fresh = files.map((file): DraftFile => ({ key: file.key, name: file.name, progress: 0, ready: false, problem: null }));
  return { ...drafts, draft: { ...drafts.draft, [conversation]: [...(drafts.draft[conversation] ?? []), ...fresh] } };
}

function change(drafts: Drafts, key: string, edit: (file: DraftFile) => DraftFile): Drafts {
  const draft: Record<string, readonly DraftFile[]> = {};
  for (const [conversation, files] of Object.entries(drafts.draft)) {
    draft[conversation] = files.some((file) => file.key === key) ? files.map((file) => (file.key === key ? edit(file) : file)) : files;
  }
  return { ...drafts, draft };
}

export function progressed(drafts: Drafts, key: string, fraction: number): Drafts {
  return change(drafts, key, (file) => ({ ...file, progress: Math.max(file.progress, Math.min(1, fraction)) }));
}

export function uploaded(drafts: Drafts, key: string, attachment: Attachment): Drafts {
  const next = change(drafts, key, (file) => ({ ...file, progress: 1, ready: true, problem: null }));
  return { ...next, uploaded: { ...drafts.uploaded, [key]: attachment } };
}

export function refused(drafts: Drafts, key: string, problem: string): Drafts {
  return change(drafts, key, (file) => ({ ...file, problem }));
}

/**
 * A file taken out of its draft. Returns what the server had for it, if the
 * upload finished, so the caller can let the server know it's not wanted.
 */
export function removed(drafts: Drafts, key: string): { drafts: Drafts; abandoned: Attachment | null } {
  const draft: Record<string, readonly DraftFile[]> = {};
  for (const [conversation, files] of Object.entries(drafts.draft)) draft[conversation] = files.filter((file) => file.key !== key);
  const { [key]: abandoned = null, ...uploadedRest } = drafts.uploaded;
  const { [key]: _held, ...heldRest } = drafts.held;
  return { drafts: { draft, uploaded: uploadedRest, held: heldRest }, abandoned };
}

/**
 * A send takes these files for its attempt: out of the draft, held apart.
 * Returns the attachments to send with, in the order given, or null if any
 * isn't ready (the box refuses to send then, so this is a seatbelt).
 */
export function taken(drafts: Drafts, conversation: string, keys: readonly string[]): { drafts: Drafts; attachments: Attachment[] } | null {
  const attachments: Attachment[] = [];
  const held: Record<string, { conversation: string; file: DraftFile }> = { ...drafts.held };
  const files = drafts.draft[conversation] ?? NO_FILES;
  for (const key of keys) {
    const attachment = drafts.uploaded[key];
    if (attachment === undefined) return null;
    attachments.push(attachment);
    const file = files.find((one) => one.key === key) ?? drafts.held[key]?.file;
    if (file) held[key] = { conversation, file };
  }
  const draft = { ...drafts.draft, [conversation]: files.filter((file) => !keys.includes(file.key)) };
  return { drafts: { ...drafts, draft, held }, attachments };
}

/** The send went through: its files are part of a message now. */
export function sent(drafts: Drafts, keys: readonly string[]): Drafts {
  const held = { ...drafts.held };
  const uploadedLeft = { ...drafts.uploaded };
  for (const key of keys) {
    delete held[key];
    delete uploadedLeft[key];
  }
  return { ...drafts, held, uploaded: uploadedLeft };
}

/** A failed send went back into the box: its files are the draft's again. */
export function restored(drafts: Drafts, keys: readonly string[]): Drafts {
  const held = { ...drafts.held };
  const draft: Record<string, readonly DraftFile[]> = { ...drafts.draft };
  for (const key of keys) {
    const one = held[key];
    if (!one) continue;
    delete held[key];
    const files = draft[one.conversation] ?? NO_FILES;
    if (!files.some((file) => file.key === key)) draft[one.conversation] = [...files, one.file];
  }
  return { ...drafts, draft, held };
}

/** The files a conversation's box shows. */
export function filesIn(drafts: Drafts, conversation: string): readonly DraftFile[] {
  return drafts.draft[conversation] ?? NO_FILES;
}
