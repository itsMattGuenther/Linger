/**
 * The privacy lines the new client holds, read from the source on every test
 * run (docs/design/parity.md, PRIV-2, PRIV-3, PRIV-7; AGENTS.md hard rules 2
 * and 4). Each check reads what ships: the app (src/next), the core it
 * shares between windows (src/lib), the wire types (src/generated) and
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
    // One WebSocket, the screen socket (#360), and it addresses the server too.
    const sockets = uses(SHIPPED, /new WebSocket\(/);
    expect(sockets.map((line) => line.split(":")[0])).toEqual(["src/lib/screen/socket.ts"]);
    for (const line of sockets) expect(line).toMatch(/new WebSocket\(`\$\{baseUrl\.replace\(/);
    // No other way out of the page.
    expect(uses(SHIPPED, /XMLHttpRequest|sendBeacon|new EventSource|new Image\(|navigator\.(sendBeacon|connection)/)).toEqual([]);

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
    expect(crates).not.toMatch(/^(active-win|active-win-pos-rs|x-win|x11rb|xcb|x11|x11-dl|sysinfo|windows|objc2-app-kit)\s*=/m);
    // `windows-sys` only to ask whether the one talk key is down (#500):
    // none of Windows' windows, processes or hooks.
    expect(featuresOf(crates, "windows-sys")).toEqual(["Win32_UI_Input_KeyboardAndMouse"]);
  });

  it("never asks a shared screen what it is: no window's or app's name, no picker of its own (PRIV-2, #360)", () => {
    // The system's picker chooses; the app gets pictures. A track's label is
    // a window's title on some engines, and its settings name what kind of
    // thing was picked: none of it is read, anywhere in what ships.
    const SCREEN = SHIPPED.filter((file) => /src\/lib\/screen\/|[Ss]creen/.test(rel(file)));
    expect(SCREEN.length).toBeGreaterThan(4);
    expect(uses(SCREEN, /\.label\b|getSettings\(|getCapabilities\(|getConstraints\(|displaySurface|\.deviceId\b|CaptureController|getDisplayMediaSet|desktopCapturer/)).toEqual([]);
    // The one call that asks for a screen is the system's own picker.
    expect(uses(SHIPPED, /getDisplayMedia\(/).map((line) => line.split(":")[0])).toEqual(["src/lib/screen/share.ts"]);
  });

  it("never sees the whole keyboard: only the one talk key, only in voice (PRIV-2, #500)", () => {
    // Nothing that hooks, grabs, records or reads every key: no keyboard or
    // mouse hook, no raw input, no snapshot of every key's state, no X11
    // keymap or grab, no input device read directly, no event tap.
    const WHOLE_KEYBOARD =
      /SetWindowsHookEx|WH_KEYBOARD|WH_MOUSE|GetKeyboardState|RegisterRawInputDevices|GetRawInputData|GetRawInputBuffer|RAWINPUT|XQueryKeymap|XGrabKey|XGrabKeyboard|XISelectEvents|XIRawEvent|XRecord|\/dev\/input|evdev|libinput|uinput|CGEventTapCreate|CGEventSourceFlagsState|CGEventSourceCounterForEventType|addGlobalMonitorForEvents|IOHIDManager|NSEvent/;
    expect(uses(RUST, WHOLE_KEYBOARD)).toEqual([]);
    // Windows is asked about one key in one place: the talk key's code.
    expect(uses(RUST, /GetAsyncKeyState\(/)).toEqual([expect.stringMatching(/^src-tauri\/src\/talk_key\/mod\.rs:\d+: .*GetAsyncKeyState\(i32::from\(vk\)\)/)]);
    // And macOS the same way (#587): one key or one button, named once each
    // where it's declared and once where it's asked, nowhere else.
    expect(uses(RUST, /CGEventSource\w*\(/)).toEqual([
      expect.stringMatching(/^src-tauri\/src\/talk_key\/mod\.rs:\d+: +fn CGEventSourceKeyState\(state_id: i32, key: u16\) -> bool;$/),
      expect.stringMatching(/^src-tauri\/src\/talk_key\/mod\.rs:\d+: +fn CGEventSourceButtonState\(state_id: i32, button: u32\) -> bool;$/),
      expect.stringMatching(/^src-tauri\/src\/talk_key\/mod\.rs:\d+: .*CGEventSourceKeyState\(COMBINED_SESSION_STATE, code\)/),
      expect.stringMatching(/^src-tauri\/src\/talk_key\/mod\.rs:\d+: .*CGEventSourceButtonState\(COMBINED_SESSION_STATE, button\)/),
    ]);
    const crates = readFileSync(join(SHELL, "Cargo.toml"), "utf8");
    expect(crates).not.toMatch(/^(rdev|device_query|device-query|inputbot|global-hotkey|tauri-plugin-global-shortcut|livesplit-hotkey|willhook|multiinput|evdev|evdev-rs|input|uinput|keyboard-query|mki)\s*=/m);
    // The desktop's portal for global shortcuts and nothing else of it: not
    // input capture, remote desktop or screen casting.
    expect(featuresOf(crates, "ashpd")).toEqual(["async-io", "global_shortcuts"]);
    // Every dependency is a one-line table, so the checks above read all of it.
    expect(crates).not.toMatch(/\.(windows-sys|ashpd)\]/);
  });
});

/** The features a dependency names in Cargo.toml (`name = { …, features = [...] }`), every place it's named, in order. */
function featuresOf(toml: string, name: string): string[] {
  const lines = toml.split("\n").filter((line) => line.startsWith(`${name} =`) || line.startsWith(`${name}=`));
  expect(lines.length, `${name} in Cargo.toml`).toBeGreaterThan(0);
  return lines.flatMap((line) => {
    const listed = /features\s*=\s*\[([^\]]*)\]/.exec(line)?.[1] ?? "";
    expect(line, `${name} turns off default features, so none come in unnamed`).toMatch(/default-features\s*=\s*false|^windows-sys/);
    return [...listed.matchAll(/"([^"]+)"/g)].map((found) => found[1] ?? "");
  });
}
