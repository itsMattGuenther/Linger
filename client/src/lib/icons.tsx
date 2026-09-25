/**
 * The few glyphs the frame draws itself (SPEC §5).
 *
 * Inline SVG in `currentColor`, so an icon is text-coloured and follows the
 * theme like any other label — no icon font, no image files, no colour of its
 * own. Console allows no coloured icon squares; a hairline glyph at label
 * weight is the most an icon gets to be here.
 */

const ACTION_PATHS = {
  plus: "M12 5v14M5 12h14",
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4M9 22h6",
  micOff:
    "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1M12 18v4M9 22h6M3 3l18 18",
  headphonesOff:
    "M4 14v-3a8 8 0 0 1 16 0v3M4 13h3v8H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Zm16 0h-3v8h3a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2ZM3 3l18 18",
  headphones:
    "M4 14v-3a8 8 0 0 1 16 0v3M4 13h3v8H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Zm16 0h-3v8h3a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2Z",
  leave: "M10 4H4v16h6M9 12h12m-5-5 5 5-5 5",
  // Both destination glyphs are drawn around the box's center (12, 12), so
  // centering the icon on its label centers what you see, not empty space.
  media:
    "M3 4h18v16H3V4Zm0 12 5-5 5 5 3-3 5 5M14 8.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0Z",
  search: "M21 21l-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  close: "m6 6 12 12M18 6 6 18",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  chevronDown: "m6 9 6 6 6-6",
  chevronUp: "m6 15 6-6 6 6",
  // Three filled dots. Every "more options" control draws this one (#144).
  more:
    "M3.25 12a1.75 1.75 0 1 0 3.5 0a1.75 1.75 0 1 0-3.5 0ZM10.25 12a1.75 1.75 0 1 0 3.5 0a1.75 1.75 0 1 0-3.5 0ZM17.25 12a1.75 1.75 0 1 0 3.5 0a1.75 1.75 0 1 0-3.5 0Z",
  message: "M4 4h16v12H9l-5 4V4Z",
  settings: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  send: "m3 3 18 9-18 9 4-9-4-9Zm4 9h14",
  play: "M8 5.5v13L19 12 8 5.5Z",
  smile:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2M15 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2M8.5 14.5s1.5 2 3.5 2 3.5-2 3.5-2",
} as const;

const FILLED = new Set<keyof typeof ACTION_PATHS>(["play", "more"]);

/** Familiar action glyphs share one stroke and inherit the label color. */
export function ActionIcon({ name }: { name: keyof typeof ACTION_PATHS }) {
  const filled = FILLED.has(name);
  return (
    <svg
      className="action-icon"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ACTION_PATHS[name]} />
    </svg>
  );
}

/** The settings cog: the one icon every application agrees on. */
export function CogIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </svg>
  );
}
