/**
 * Which emoji this computer's emoji font can draw (#359). Emoji are drawn by
 * the system's font (Segoe UI Emoji on Windows, usually Noto Color Emoji on
 * Linux, Apple Color Emoji on a Mac), and an older font draws the newest as
 * an empty box. The picker and the `:` list leave those out rather than
 * offer something that arrives as a box.
 *
 * One emoji from each recent Unicode version is drawn on a hidden canvas: a
 * drawn emoji is in colour and one glyph wide; a missing one is a grey box,
 * or (a sequence the font doesn't know) its parts side by side.
 */

/** The newest emoji of each version, newest first. */
const PROBES: readonly [number, string][] = [
  [17, "🫪"],
  [16, "🫩"],
  [15.1, "🙂‍↔️"],
  [15, "🫨"],
  [14, "🫠"],
  [13.1, "😮‍💨"],
  [13, "🥲"],
  [12, "🥱"],
  [11, "🥰"],
];

let known: number | null = null;

/**
 * The newest Unicode emoji version this computer draws. Everything, when it
 * can't tell (no canvas, or no colour emoji font at all): then nothing is
 * hidden, and the font draws what it can.
 */
export function supportedVersion(): number {
  known ??= probe();
  return known;
}

function probe(): number {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return Number.POSITIVE_INFINITY;
    ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    ctx.textBaseline = "top";
    const one = ctx.measureText("😀").width;
    const draws = (glyph: string) => {
      if (ctx.measureText(glyph).width > one * 1.5) return false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillText(glyph, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let at = 0; at < data.length; at += 4) {
        const [r = 0, g = 0, b = 0, a = 0] = [data[at], data[at + 1], data[at + 2], data[at + 3]];
        if (a > 0 && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24)) return true;
      }
      return false;
    };
    // No colour emoji at all: nothing to tell versions apart by.
    if (!draws("😀")) return Number.POSITIVE_INFINITY;
    for (const [version, glyph] of PROBES) if (draws(glyph)) return version;
    return 10;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
