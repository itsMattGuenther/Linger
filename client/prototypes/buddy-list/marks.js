// Linger's small mark: the logo redrawn for the 16–20px spot beside a
// server's name, where the porch picture turned to mush. Each is drawn on a
// pixel grid (two screen pixels per cell) so its edges stay sharp. `?mark=`
// picks one; the default is the one the design settled on.

const NIGHT = "#0e1a33";
const CYAN = "#2ec5f2";
const IVORY = "#fff1d6";
const LAMP = "#f6b24e";

// [x, y, w, h, fill, opacity?] in grid cells.
function grid(cols, rows, cells, label) {
  const rects = cells
    .map(([x, y, w, h, fill, o]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${o ? ` opacity="${o}"` : ""}/>`)
    .join("");
  return `<svg viewBox="0 0 ${cols} ${rows}" width="${cols * 2}" height="${rows * 2}" shape-rendering="crispEdges" role="img" aria-label="${label}">${rects}</svg>`;
}

export const MARKS = {
  // The wordmark's "L" on its night panel, inside the cyan sign's pixel
  // border, lit from the lamp side like the logo's letters.
  l: () =>
    grid(10, 10, [
      [1, 1, 8, 8, NIGHT],
      [1, 0, 8, 1, CYAN], [1, 9, 8, 1, CYAN], [0, 1, 1, 8, CYAN], [9, 1, 1, 8, CYAN],
      [5, 2, 1, 4, LAMP], [7, 6, 1, 2, LAMP], [4, 8, 4, 1, LAMP],
      [3, 2, 2, 6, IVORY], [3, 6, 4, 2, IVORY],
    ], "Linger"),
  // The three dots from the logo's tagline: green, amber, blue.
  dots: () =>
    grid(16, 4, [
      [1, 0, 2, 4, "var(--name-fern)"], [0, 1, 4, 2, "var(--name-fern)"],
      [7, 0, 2, 4, "var(--name-amber)"], [6, 1, 4, 2, "var(--name-amber)"],
      [13, 0, 2, 4, "var(--name-azure)"], [12, 1, 4, 2, "var(--name-azure)"],
    ], "Linger"),
  // The porch lamp, lit.
  lamp: () =>
    grid(10, 10, [
      [4, 0, 2, 1, "#5a6d94"],
      [3, 1, 4, 1, "#4a72bd"], [2, 2, 6, 1, "#3560a8"], [1, 3, 8, 1, "#27498a"],
      [3, 4, 4, 1, LAMP, 0.55], [4, 4, 2, 1, "#ffe7b0"],
      [2, 5, 6, 1, LAMP, 0.42], [1, 6, 8, 1, LAMP, 0.26], [1, 7, 8, 1, LAMP, 0.16], [0, 8, 10, 1, LAMP, 0.09],
    ], "Linger"),
  // The name itself, in the logo's pixel face.
  word: () => `<span class="mark-word" role="img" aria-label="Linger">Linger</span>`,
};

export const MARK_KINDS = ["l", "dots", "lamp", "word"];
export const MARK_NAMES = { l: "Pixel L", dots: "Three dots", lamp: "Porch lamp", word: "Wordmark" };

export const markHTML = (kind) => `<span class="mark mark-${kind}">${(MARKS[kind] ?? MARKS.l)()}</span>`;
