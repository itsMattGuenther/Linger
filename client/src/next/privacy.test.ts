/**
 * The privacy lines the new client holds, read from the source on every test
 * run (docs/design/parity.md, PRIV-2, PRIV-3, PRIV-7; AGENTS.md hard rules 2
 * and 4). Each check reads what ships: the new client (src/next), the core it
 * shares with today's client (src/lib), the wire types (src/generated) and
 * the desktop shell (src-tauri). Comments are left out, so a line saying what
 * the code never does doesn't count as doing it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NEXT = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(NEXT, "..");
const CLIENT = resolve(SRC, "..");
const SHELL = join(CLIENT, "src-tauri");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Code that ships: TypeScript under src/next and src/lib, tests left out. */
const SHIPPED = [...walk(NEXT), ...walk(join(SRC, "lib"))].filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file));
const RUST = walk(join(SHELL, "src")).filter((file) => file.endsWith(".rs"));
const WIRE = walk(join(SRC, "generated")).filter((file) => file.endsWith(".ts"));

/** The text without its comments: block, line (not inside a URL), and Rust's. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const rel = (file: string) => relative(CLIENT, file);

/** Every file and line where a pattern appears in code. */
function uses(files: readonly string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    code(file)
      .split("\n")
      .flatMap((line, index) => (pattern.test(line) ? [`${rel(file)}:${index + 1}: ${line.trim()}`] : [])),
  );
}

describe("privacy, from the source", () => {
  it("reads enough to mean something", () => {
    expect(SHIPPED.length).toBeGreaterThan(100);
    expect(RUST.length).toBeGreaterThan(5);
    expect(WIRE.length).toBeGreaterThan(50);
  });

  it("never turns a message, or anything else, into markup (PRIV-7)", () => {
    expect(uses(SHIPPED, /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment|\bsrcdoc\b/)).toEqual([]);
  });

  it("talks to nothing but the servers you're signed in to: no telemetry, analytics or crash reporting (PRIV-3)", () => {
    // Only the two places that talk to a server call fetch, and both address it.
    const fetches = uses(SHIPPED, /\bfetch\(/);
    expect(fetches.map((line) => line.split(":")[0]).sort()).toEqual(["src/lib/api.ts", "src/lib/upload.ts"]);
    for (const line of fetches) expect(line).toMatch(/fetch\((`\$\{baseUrl\}|absoluteUrl\(baseUrl,)/);
    // No other way out of the page.
    expect(uses(SHIPPED, /XMLHttpRequest|sendBeacon|new WebSocket|new EventSource|new Image\(|navigator\.(sendBeacon|connection)/)).toEqual([]);

    const REPORTERS = /sentry|bugsnag|posthog|mixpanel|segment|amplitude|datadog|rollbar|newrelic|logrocket|fullstory|hotjar|analytics|gtag|plausible|umami|matomo|honeybadger|raygun|appsignal|opentelemetry|telemetry|firebase|crashpad|breakpad/i;
    const pkg = JSON.parse(readFileSync(join(CLIENT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const packages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
    expect(packages.filter((name) => REPORTERS.test(name))).toEqual([]);
    const crates = readFileSync(join(SHELL, "Cargo.toml"), "utf8")
      .split("\n")
      .filter((line) => /^[a-z0-9_-]+\s*=/.test(line))
      .map((line) => line.split("=")[0]?.trim() ?? "");
    expect(crates.length).toBeGreaterThan(5);
    expect(crates.filter((name) => REPORTERS.test(name))).toEqual([]);
  });

  it("has no way to learn or carry what apps or windows anybody has open (PRIV-2)", () => {
    // Nothing on the wire could carry it.
    const FOREIGN = /^(.*_)?(window|windows|app|apps|application|applications|activity|activities|foreground|process|processes|program|programs|executable)(_.*)?$/;
    const fields = WIRE.flatMap((file) => [...code(file).matchAll(/\b([a-z_]+)\??:/g)].map((found) => `${rel(file)} ${found[1] ?? ""}`));
    expect(fields.length).toBeGreaterThan(100);
    expect(fields.filter((field) => FOREIGN.test(field.split(" ")[1] ?? ""))).toEqual([]);
    // And the shell never asks the system what else is open.
    const ASKING = /GetForegroundWindow|GetWindowText|EnumWindows|_NET_ACTIVE_WINDOW|_NET_WM_NAME|WM_NAME|NSWorkspace|frontmostApplication|active_win|get_active_window|x11rb|xcb::|wmctrl|xdotool|hyprctl|swaymsg|sysinfo|\/proc\//;
    expect(uses(RUST, ASKING)).toEqual([]);
    const crates = readFileSync(join(SHELL, "Cargo.toml"), "utf8");
    expect(crates).not.toMatch(/^(active-win|active-win-pos-rs|x-win|x11rb|xcb|sysinfo|windows|windows-sys|objc2-app-kit)\s*=/m);
  });
});
