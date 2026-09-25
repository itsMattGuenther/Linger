/**
 * The icon set: every glyph the new client draws, from the approved prototype
 * (`client/prototypes/buddy-list/app.js`), on a 16×16 grid in `currentColor`.
 *
 * Generated once from the prototype and then owned here. Add a glyph by drawing
 * it on the same grid with the same stroke weights (1.3–1.6), then list it in
 * the gallery (`tests/fixtures/kit.tsx`).
 */
import type { ReactElement } from "react";

export const ICON_NAMES = [
  "close",
  "caret",
  "knock",
  "message",
  "speaker",
  "note",
  "book",
  "pencil",
  "moon",
  "sun",
  "door",
  "media",
  "search",
  "send",
  "mic",
  "micOff",
  "link",
  "audio",
  "file",
  "star",
  "quiet",
  "popout",
  "plus",
  "more",
  "up",
  "down",
  "check",
  "gear",
  "tag",
  "windows",
  "bell",
  "key",
  "stack",
  "hash",
  "people",
  "house",
  "play",
  "compose",
  "head",
  "headOff",
  "leave",
  "go",
  "intoTabs",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

export const ICON_PATHS: Record<IconName, ReactElement> = {
  close: (
    <>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  caret: (
    <>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  knock: (
    <>
      <rect x="2.5" y="2" width="7" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="7.5" cy="8.4" r=".9" fill="currentColor" /><path d="M11.6 5.6c.8.7 1.2 1.5 1.2 2.4s-.4 1.7-1.2 2.4M13.4 4.2c1.2 1.1 1.8 2.4 1.8 3.8s-.6 2.7-1.8 3.8" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </>
  ),
  message: (
    <>
      <path d="M2.5 4.2c0-1 .8-1.7 1.7-1.7h7.6c1 0 1.7.8 1.7 1.7v5.1c0 1-.8 1.7-1.7 1.7H7.2L4.4 13.3v-2.3h-.2c-1 0-1.7-.8-1.7-1.7z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </>
  ),
  speaker: (
    <>
      <path d="M2.5 6h2.4L8.4 3v10L4.9 10H2.5z" fill="currentColor" /><path d="M10.6 5.6c.8.7 1.2 1.5 1.2 2.4s-.4 1.7-1.2 2.4M12.4 4c1.2 1.1 1.8 2.5 1.8 4s-.6 2.9-1.8 4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </>
  ),
  note: (
    <>
      <path d="M6 11.5V3.5l7-1.5v8" stroke="currentColor" strokeWidth="1.4" fill="none" /><circle cx="4.4" cy="11.6" r="1.8" fill="currentColor" /><circle cx="11.4" cy="10.1" r="1.8" fill="currentColor" />
    </>
  ),
  book: (
    <>
      <path d="M8 4.3C6.6 3.2 4.8 2.8 2.5 3v9.2c2.3-.2 4.1.2 5.5 1.3 1.4-1.1 3.2-1.5 5.5-1.3V3c-2.3-.2-4.1.2-5.5 1.3zM8 4.3v9.2" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </>
  ),
  pencil: (
    <>
      <path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.1.6.6-3.1z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </>
  ),
  moon: (
    <>
      <path d="M12.8 10.2A5.5 5.5 0 0 1 5.8 3.2a5.5 5.5 0 1 0 7 7z" fill="currentColor" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" fill="currentColor" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </>
  ),
  door: (
    <>
      <path d="M3 14V2.8c0-.4.3-.8.8-.8H10c.4 0 .8.3.8.8V14" stroke="currentColor" strokeWidth="1.4" fill="none" /><path d="M3 2.4l5 1.4V15L3 14" fill="currentColor" opacity=".35" /><circle cx="6.6" cy="8.6" r=".8" fill="currentColor" /><path d="M1.5 14h13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  media: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="5.8" cy="6.6" r="1.2" fill="currentColor" /><path d="M2.5 11.5l3.5-3 2.6 2.2 2-1.6 3 2.4" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.3 10.3l3.4 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  send: (
    <>
      <path d="M2.5 8h9M8 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  mic: (
    <>
      <rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" fill="currentColor" /><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  ),
  micOff: (
    <>
      <rect x="5.6" y="1.8" width="4.8" height="8" rx="2.4" fill="currentColor" opacity=".5" /><path d="M3.5 7.6a4.5 4.5 0 0 0 9 0M8 12.1v2M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  ),
  link: (
    <>
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  ),
  audio: (
    <>
      <path d="M2 8h1.6M4.8 5v6M7.4 3v10M10 5.5v5M12.6 7v2M14.2 8H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.8h5l3.2 3.2v9.2H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="M9 1.8V5h3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  star: (
    <>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor" />
    </>
  ),
  quiet: (
    <>
      <path d="M4.2 10.8V7.4a3.8 3.8 0 0 1 6.3-2.9M11.8 7.2v3.6l1.2 1.4H3.2M6.6 13.6a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinecap="round" strokeLinejoin="round" /><path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </>
  ),
  popout: (
    <>
      <path d="M9 2.5h4.5V7M13.3 2.7L7.5 8.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </>
  ),
  plus: (
    <>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
    </>
  ),
  up: (
    <>
      <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  down: (
    <>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  check: (
    <>
      <path d="M3.5 8.4l3 3 6-6.6" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  gear: (
    <>
      <path d="M7.03 2.89 L7.17 0.95 L8.83 0.95 L8.97 2.89 A5.2 5.2 0 0 1 10.92 3.70 L12.40 2.42 L13.58 3.60 L12.30 5.08 A5.2 5.2 0 0 1 13.11 7.03 L15.05 7.17 L15.05 8.83 L13.11 8.97 A5.2 5.2 0 0 1 12.30 10.92 L13.58 12.40 L12.40 13.58 L10.92 12.30 A5.2 5.2 0 0 1 8.97 13.11 L8.83 15.05 L7.17 15.05 L7.03 13.11 A5.2 5.2 0 0 1 5.08 12.30 L3.60 13.58 L2.42 12.40 L3.70 10.92 A5.2 5.2 0 0 1 2.89 8.97 L0.95 8.83 L0.95 7.17 L2.89 7.03 A5.2 5.2 0 0 1 3.70 5.08 L2.42 3.60 L3.60 2.42 L5.08 3.70 A5.2 5.2 0 0 1 7.03 2.89 Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.35" />
    </>
  ),
  tag: (
    <>
      <path d="M2.5 8.2V3.3c0-.5.4-.8.8-.8h4.9l5.3 5.3-5.7 5.7z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><circle cx="5.6" cy="5.6" r="1.1" fill="currentColor" />
    </>
  ),
  windows: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.35" /><path d="M1.8 5.6h12.4M6.4 5.6v7.9" stroke="currentColor" strokeWidth="1.35" />
    </>
  ),
  bell: (
    <>
      <path d="M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1.2 1.3H3z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><path d="M6.6 13.9a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinecap="round" />
    </>
  ),
  key: (
    <>
      <circle cx="5.4" cy="10.6" r="2.9" fill="none" stroke="currentColor" strokeWidth="1.35" /><path d="M7.5 8.5l5.8-5.8M11.3 4.7l1.6 1.6M9.7 6.3l1.4 1.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </>
  ),
  stack: (
    <>
      <path d="M8 2.2l6 3-6 3-6-3z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /><path d="M2 8.2l6 3 6-3M2 11l6 3 6-3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </>
  ),
  hash: (
    <>
      <path d="M6.2 2.5L5 13.5M11 2.5L9.8 13.5M2.8 5.8h11M2.2 10.2h11" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </>
  ),
  people: (
    <>
      <circle cx="5.6" cy="5.4" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.35" /><circle cx="11.2" cy="6.2" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.35" /><path d="M1.8 13.2c.4-2.2 2-3.5 3.8-3.5s3.4 1.3 3.8 3.5M10 9.7c1.9-.3 3.6.8 4.1 3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </>
  ),
  house: (
    <>
      <path d="M2.5 7.3L8 2.8l5.5 4.5M4 6.2v7.3h8V6.2" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" strokeLinecap="round" /><path d="M6.8 13.5v-3.3h2.4v3.3" fill="none" stroke="currentColor" strokeWidth="1.35" />
    </>
  ),
  play: (
    <>
      <path d="M5 3.4v9.2l7.4-4.6z" fill="currentColor" />
    </>
  ),
  compose: (
    <>
      <path d="M13.5 8.6v3.9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3.9" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" /><path d="M11.6 2.2l2.2 2.2-5.6 5.6-2.8.6.6-2.8z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    </>
  ),
  head: (
    <>
      <path d="M2.8 10.5V8.3a5.2 5.2 0 0 1 10.4 0v2.2" stroke="currentColor" strokeWidth="1.4" fill="none" /><rect x="2" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor" /><rect x="10.8" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor" />
    </>
  ),
  headOff: (
    <>
      <path d="M2.8 10.5V8.3a5.2 5.2 0 0 1 10.4 0v2.2" stroke="currentColor" strokeWidth="1.4" fill="none" opacity=".55" /><rect x="2" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor" opacity=".55" /><rect x="10.8" y="9.4" width="3.2" height="4.4" rx="1.2" fill="currentColor" opacity=".55" /><path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  leave: (
    <>
      <path d="M6.5 2.5H3.3a.8.8 0 0 0-.8.8v9.4c0 .4.4.8.8.8h3.2M10 5l3 3-3 3M13 8H6.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  go: (
    <>
      <path d="M5.5 3.5h7v7M12.3 3.7L3.5 12.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  intoTabs: (
    <>
      <path d="M1.8 5.5h12.4M1.8 5.5V13a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V5.5M1.8 5.5V3a1 1 0 0 1 1-1h3.4a1 1 0 0 1 .9.6l.6 1.3" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinejoin="round" /><path d="M8 7.8v4M6.2 10.2L8 12l1.8-1.8" stroke="currentColor" strokeWidth="1.35" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};
