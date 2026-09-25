/**
 * The rules that keep the new client consistent, checked on every test run
 * (docs/design/system.md, "What the tests enforce").
 *
 * These are structural: they read the source, not the screen. A color or a
 * size typed straight into a component is how the old client ended up with
 * buttons of a dozen heights, so here it cannot pass the build. Each failure
 * says what to do instead.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NEXT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(NEXT, "..");
const TOKENS = join(NEXT, "styles", "tokens.css");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const FILES = walk(NEXT);
const CSS = FILES.filter((file) => file.endsWith(".css"));
const CODE = FILES.filter((file) => /\.(ts|tsx)$/.test(file));
const KIT_COMPONENTS = FILES.filter((file) => file.includes(`${sep}kit${sep}`) && file.endsWith(".tsx"));

const rel = (file: string) => relative(SRC, file);

/** Blank out comments but keep line numbers, so reports point at real lines. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function findAll(text: string, pattern: RegExp): Array<{ line: number; match: string }> {
  const hits: Array<{ line: number; match: string }> = [];
  for (const found of text.matchAll(pattern)) {
    const before = text.slice(0, found.index ?? 0);
    hits.push({ line: before.split("\n").length, match: found[0] });
  }
  return hits;
}

describe("CSS under src/next uses tokens", () => {
  it("has files to check", () => {
    expect(CSS.length).toBeGreaterThan(10);
    expect(CSS).toContain(TOKENS);
  });

  it("writes no color outside styles/tokens.css", () => {
    const problems: string[] = [];
    for (const file of CSS.filter((css) => css !== TOKENS)) {
      const text = stripComments(readFileSync(file, "utf8"));
      const colors = [
        ...findAll(text, /#[0-9a-fA-F]{3,8}\b/g),
        ...findAll(text, /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g),
        ...findAll(text, /:\s*(?:white|black|red|green|blue|gray|grey|orange|yellow|purple|pink)\b/g),
      ];
      for (const hit of colors) {
        problems.push(
          `${rel(file)}:${hit.line}: "${hit.match}" is a color literal. Use a semantic token from styles/tokens.css (a --surface-*, --text-*, --icon-*, --accent-* role); if none fits, add one there.`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("writes no pixel value but 0 and 1px outside styles/tokens.css", () => {
    const problems: string[] = [];
    for (const file of CSS.filter((css) => css !== TOKENS)) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const hit of findAll(text, /(?<![\w.-])(\d*\.?\d+)px\b/g)) {
        const value = Number.parseFloat(hit.match);
        if (value === 0 || value === 1) continue;
        problems.push(
          `${rel(file)}:${hit.line}: "${hit.match}" is a raw size. Use a scale token (--space-*, --control-*, --icon-*, --radius-*, --row-*, --line-*); 1px is allowed only for hairlines.`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("never uses !important", () => {
    const problems: string[] = [];
    for (const file of CSS) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const hit of findAll(text, /!\s*important/g)) {
        problems.push(
          `${rel(file)}:${hit.line}: !important. Raise the rule's specificity with a data attribute on the component, or fix the rule it fights.`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

/** Where an import points, as a path inside `client/src`, or null for a package. */
function importTarget(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  return resolve(dirname(file), specifier);
}

/** The old client's screens and styles. The new client builds its own. */
const OLD_UI = [
  "App.tsx",
  "app.css",
  "main.tsx",
  "styles",
  "stream",
  "settings",
  "roster",
  "host",
  "media",
  "search",
  "status",
  "voice",
  "auth",
  "notify",
  "knock",
  "dm",
];

function importProblem(file: string, specifier: string): string | null {
  const target = importTarget(file, specifier);
  if (target === null) return null;
  if (target === NEXT || target.startsWith(NEXT + sep)) return null;
  const inside = relative(SRC, target);
  if (inside.startsWith("..")) {
    return `imports "${specifier}", which is outside client/src. The new client's code lives in src/next; tests and fixtures import it, not the other way round.`;
  }
  const top = inside.split(sep)[0] ?? "";
  if (OLD_UI.includes(top)) {
    return `imports "${specifier}" from the old client's UI (src/${top}). Build it from the kit in src/next/kit instead; only src/lib, src/generated and src/fonts are shared.`;
  }
  if (top === "generated" || top === "fonts") return null;
  if (top === "lib") {
    const isUi =
      inside.endsWith(".tsx") ||
      inside.endsWith(".css") ||
      existsSync(`${target}.tsx`) ||
      (!existsSync(`${target}.ts`) && existsSync(join(target, "index.tsx")));
    return isUi
      ? `imports "${specifier}", a UI component of the old client in src/lib. Only src/lib's logic (.ts files) is shared; draw it with the kit in src/next/kit.`
      : null;
  }
  return `imports "${specifier}" (src/${top}). The new client may share only src/lib (logic), src/generated and src/fonts.`;
}

describe("src/next shares only the core with the old client", () => {
  it("imports nothing from the old client's UI", () => {
    const problems: string[] = [];
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']|@import\s+["']([^"']+)["']/gm;
    for (const file of [...CODE, ...CSS]) {
      const text = readFileSync(file, "utf8");
      for (const found of text.matchAll(pattern)) {
        const specifier = found[1] ?? found[2];
        if (!specifier) continue;
        const problem = importProblem(file, specifier);
        if (problem) problems.push(`${rel(file)}: ${problem}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("kit components cannot be resized by their callers", () => {
  it("takes no className or style prop", () => {
    const problems: string[] = [];
    for (const file of KIT_COMPONENTS) {
      const text = readFileSync(file, "utf8");
      // Props interfaces and inline prop types: `className?:` or `style:` as a member.
      const declared = findAll(text, /(?:^|[{;,])\s*(?:readonly\s+)?(className|style)\??\s*:\s*(?!\{)/gm);
      // Destructured props of an exported component.
      const destructured = [...text.matchAll(/export function \w+(?:<[^>]*>)?\(\s*\{([^}]*)\}/g)]
        .map((found) => found[1] ?? "")
        .filter((params) => /\b(className|style)\b/.test(params));
      for (const hit of declared) {
        problems.push(
          `${rel(file)}:${hit.line}: declares a "${hit.match.replace(/[{;,?:\s]/g, "").replace("readonly", "")}" prop. Kit components size themselves; add a typed prop for the state or size you need instead.`,
        );
      }
      for (const params of destructured) {
        problems.push(`${rel(file)}: an exported component destructures className/style (${params.trim()}). Remove it; see docs/design/system.md.`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("the shared core stands on its own", () => {
  // src/lib's logic is what both clients share, and what remains when the
  // old client is deleted at the switch (docs/design/architecture.md). If it
  // leaned on the old client's screens, deleting them would break it.
  it("imports nothing from the old client's UI in src/lib's logic", () => {
    const LIB = join(SRC, "lib");
    const logic = walk(LIB).filter((file) => file.endsWith(".ts"));
    expect(logic.length).toBeGreaterThan(10);
    const problems: string[] = [];
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|vi\.mock\(\s*)["']([^"']+)["']/gm;
    for (const file of logic) {
      const text = readFileSync(file, "utf8");
      for (const found of text.matchAll(pattern)) {
        const specifier = found[1];
        if (!specifier) continue;
        const target = importTarget(file, specifier);
        if (target === null) continue;
        const top = relative(SRC, target).split(sep)[0] ?? "";
        if (OLD_UI.includes(top)) {
          problems.push(
            `${rel(file)}: imports "${specifier}" (src/${top}). src/lib is the core both clients share and the part that outlives the old client; move the logic it needs into src/lib instead.`,
          );
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
