/**
 * Contrast, computed from the tokens themselves (WCAG 2.1 relative luminance).
 *
 * Every text role must reach 4.5:1 on every surface text can sit on; icons and
 * other marks that are not text must reach 3:1; and all 16 name colors, read
 * out of the generated palette and converted from OKLCH, must reach 4.5:1 on
 * every surface a name can sit on. The test reads `tokens.css`, so changing a
 * value re-checks it; the fix for a failure is a token, never this file.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = readFileSync(resolve(HERE, "tokens.css"), "utf8");
const PALETTE = readFileSync(resolve(HERE, "../../generated/palette.generated.css"), "utf8");

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** Custom properties declared in the first `:root { … }` block of a sheet. */
function rootVars(css: string): Map<string, string> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = clean.indexOf(":root");
  const open = clean.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < clean.length; i += 1) {
    if (clean[i] === "{") depth += 1;
    if (clean[i] === "}") depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const vars = new Map<string, string>();
  for (const found of clean.slice(open + 1, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (found[1] && found[2]) vars.set(found[1], found[2].trim());
  }
  return vars;
}

const CARD = readFileSync(resolve(HERE, "../kit/Card.css"), "utf8");

/** How strong a tinted card's wash of a person's color is, read from `kit/Card.css`, as 0–1. */
function washOf(selector: string): number {
  const rule = new RegExp(`${selector.replace(/[[\]".]/g, "\\$&")}\\s*\\{[^}]*var\\(--card-tint\\)\\s+([\\d.]+)%`).exec(CARD);
  if (!rule?.[1]) throw new Error(`no wash found for ${selector} in kit/Card.css`);
  return Number(rule[1]) / 100;
}

const NAME = readFileSync(resolve(HERE, "../kit/Name.css"), "utf8");
const ROW = readFileSync(resolve(HERE, "../kit/Row.css"), "utf8");
const LIST = readFileSync(resolve(HERE, "../app/list/ListView.css"), "utf8");

/**
 * The token the first rule naming `selector` (alone or in a list) sets
 * `property` to in a sheet, as in `color: var(--text-offline)`, so a test
 * follows the stylesheet rather than a copy of it.
 */
function tokenIn(css: string, selector: string, property: string, sheet: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[[\]".:()]/g, "\\$&");
  const rule = new RegExp(`${escaped}[^{]*\\{[^}]*?(?<![\\w-])${property}\\s*:\\s*var\\((--[\\w-]+)\\)`).exec(clean);
  if (!rule?.[1]) throw new Error(`no ${property} found for ${selector} in ${sheet}`);
  return rule[1];
}

const VARS = rootVars(TOKENS);
const NAMES = rootVars(PALETTE);

function resolveVar(name: string, seen = new Set<string>()): string {
  const value = VARS.get(name) ?? NAMES.get(name);
  if (value === undefined) throw new Error(`${name} is not defined in tokens.css`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (!ref?.[1]) return value;
  if (seen.has(ref[1])) throw new Error(`${name} refers to itself`);
  seen.add(ref[1]);
  return resolveVar(ref[1], seen);
}

/** sRGB channel (0–1) to linear light. */
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (c: number) => Math.min(1, Math.max(0, c));

/** OKLCH (Björn Ottosson's OKLab) to gamma sRGB, 0–1. */
function oklch(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_;
  return [toGamma(clamp(r)), toGamma(clamp(g)), toGamma(clamp(bl))];
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgb) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (ok) {
    const [r, g, b] = oklch(Number(ok[1]), Number(ok[2]), Number(ok[3]));
    return [r, g, b, 1];
  }
  throw new Error(`cannot read the color "${value}"`);
}

const color = (name: string) => parseColor(resolveVar(name));

/** A translucent color laid over an opaque one. */
function over(top: Rgba, under: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Opaque surfaces that text, icons and names are drawn on. */
const SURFACES = [
  "--surface-sunken",
  "--surface-window",
  "--surface-popover",
  "--surface-raised",
  "--surface-hover",
  "--surface-titlebar",
  "--surface-titlebar-end",
];

const TEXT = ["--text-primary", "--text-secondary", "--text-muted", "--text-away", "--text-accent", "--text-danger", "--text-success", "--text-offline"];
const NON_TEXT = ["--icon-default", "--icon-muted", "--icon-faint", "--accent", "--focus", "--danger", "--success"];
const PALETTE_KEYS = [...NAMES.keys()].filter((key) => key.startsWith("--name-"));

function failures(foregrounds: string[], backgrounds: string[], floor: number): string[] {
  const out: string[] = [];
  for (const fg of foregrounds) {
    for (const bg of backgrounds) {
      const value = ratio(color(fg), color(bg));
      if (value < floor) out.push(`${fg} on ${bg}: ${value.toFixed(2)}:1, needs ${floor}:1`);
    }
  }
  return out;
}

describe("contrast of the new client's tokens", () => {
  it("reads the tokens and all 16 names", () => {
    expect(SURFACES.every((s) => VARS.has(s))).toBe(true);
    expect(PALETTE_KEYS).toHaveLength(16);
  });

  it("keeps every text role at 4.5:1 on every surface", () => {
    const bad = failures(TEXT, SURFACES, 4.5);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("keeps icons, the accent and the focus ring at 3:1 on every surface", () => {
    const bad = failures(NON_TEXT, SURFACES, 3);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("keeps all 16 name colors at 4.5:1 on every surface a name sits on", () => {
    const bad = failures(PALETTE_KEYS, SURFACES, 4.5);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  // A person's card is washed faintly in their color (kit/Card.css). The wash
  // is kept away from the name at the card's head (#272), but a name must stay
  // readable even where the wash is strongest, whoever's color it is.
  it("keeps all 16 name colors at 4.5:1 on a card washed in any of them, where the wash is strongest", () => {
    const washes: Array<[string, string, number]> = [
      ["a person's card (a Popover)", "--surface-popover", washOf('.k-popover[data-tinted="yes"]')],
      ["a Card", "--surface-raised", washOf('.k-card[data-tinted="yes"]')],
    ];
    const bad: string[] = [];
    for (const [where, surface, strength] of washes) {
      for (const tint of PALETTE_KEYS) {
        const [r, g, b] = color(tint);
        const behind = over([r, g, b, strength], color(surface));
        for (const name of PALETTE_KEYS) {
          const value = ratio(color(name), behind);
          if (value < 4.5) bad.push(`${name} on ${where} washed in ${tint}: ${value.toFixed(2)}:1, needs 4.5:1`);
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  // Somebody offline has their name drawn in a dim grey in the list, with
  // none of their own color (#274). Dim, but still text: it must read at
  // 4.5:1 on the list and on a row that's hovered or has its card open. The
  // colors are read from the stylesheets that paint them. Dark is the only
  // theme (docs/decisions.md, 2026-09-28).
  it("keeps an offline name at 4.5:1 on the list, and on a hovered or selected row", () => {
    const offline = tokenIn(NAME, ':root .name.k-name[data-offline="yes"]', "color", "kit/Name.css");
    const behind: Array<[string, string]> = [
      ["the list", tokenIn(LIST, ".nx-list", "background", "app/list/ListView.css")],
      ["a hovered or selected row", tokenIn(ROW, ".k-row-main:hover:not(:disabled)", "background", "kit/Row.css")],
    ];
    const bad = behind
      .map(([where, surface]) => [where, surface, ratio(color(offline), color(surface))] as const)
      .filter(([, , value]) => value < 4.5)
      .map(([where, surface, value]) => `${offline} on ${where} (${surface}): ${value.toFixed(2)}:1, needs 4.5:1`);
    expect(offline).toBe("--text-offline");
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("keeps text readable on the accent and on filled controls", () => {
    const window = color("--surface-window");
    const pairs: Array<[string, Rgba, Rgba, number]> = [
      ["--text-on-accent on --accent", color("--text-on-accent"), color("--accent"), 4.5],
      ["--text-on-danger on --danger-wash over a window", color("--text-on-danger"), over(color("--danger-wash"), window), 4.5],
      ["--text-primary on --accent-wash-strong over a window", color("--text-primary"), over(color("--accent-wash-strong"), window), 4.5],
      ["--text-accent on --accent-wash-stronger over a window", color("--text-accent"), over(color("--accent-wash-stronger"), window), 4.5],
      ["--icon-default on --surface-control", color("--icon-default"), color("--surface-control"), 3],
      ["a switch's thumb on its track, off", color("--text-secondary"), color("--surface-control"), 3],
      ["a switch's thumb on its track, on", color("--text-on-accent"), color("--accent"), 3],
      ["a switch's track, on, on a window", color("--accent"), window, 3],
    ];
    const bad = pairs.filter(([, fg, bg, floor]) => ratio(fg, bg) < floor).map(([what, fg, bg, floor]) => `${what}: ${ratio(fg, bg).toFixed(2)}:1, needs ${floor}:1`);
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
