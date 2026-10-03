/**
 * The real Settings window (`src/next/app/settings/SettingsWindow.tsx`),
 * wired end to end with the desktop shell, the list window and the server
 * faked in the page (`next/desktop.ts`), for
 * `tests/browser/next-settings-window.spec.ts`: saving through the borrowed
 * sign-in, and asking the list window for what only it may do.
 *
 * Open it at /tests/fixtures/next-settings-window.html. Options:
 * `?section=invites` opens on a section; `?member` is you as a member, not
 * the host; `?refuse` has the list window refuse a rule or a password;
 * `?servers` signs in to the guild and Lisbon too, so Servers shows.
 * Starting at sign-in (#228) is off on this computer; `?autostart=on` has it
 * on already, `?autostart=refuse` has the computer refuse to change it,
 * `?autostart=ignores` has it take the change without keeping it,
 * `?autostart=none` is a computer where it isn't offered, and
 * `?autostart=hyprland` is a desktop that won't start it by itself.
 * The server runs 0.4.4 and so does the newest release; `?serverVersion=0.4.3`
 * has the server answer an older one (#314).
 * `window.shell.prefs(prefs)` is the list window saying your servers'
 * order or Quiet changed.
 * Report and block (T-1605): `?blocked` has you blocking Jules, for Account's
 * list; `?reports` has one report open for you, the host, from Eli about a
 * message of Jules's in #general, for People. Unblocking, deleting the message
 * and closing the report are written down, and the list window passes on
 * what changed, as the real one does.
 * What the window asked for is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Invite } from "../../src/generated/Invite";
import type { NotifyRule } from "../../src/generated/NotifyRule";
import type { Report } from "../../src/generated/Report";
import type { ServerInfo } from "../../src/generated/ServerInfo";
import { serverState } from "../../src/lib/gateway";
import { SettingsWindow } from "../../src/next/app/settings/SettingsWindow";
import "../../src/next/styles/app.css";
import { fakeDesktop, json } from "./next/desktop";
import { NOW, SERVER, SERVER_NAME, evening, messages, people } from "./next/evening";
import { GUILD, guild, LISBON, lisbon, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
const night = evening(serverState(SERVER));
const me = { ...people.matt, is_host: !query.has("member") };
let info: ServerInfo = { name: SERVER_NAME, accent_key: "amber", icon_key: null, member_count: 7, created_at: NOW - 90 * 86_400_000 } as ServerInfo;
const invites: Invite[] = [];
let blocked: string[] = query.has("blocked") ? [people.jules.id] : [];
const reported = (messages["r-general"] ?? []).find((message) => message.author_id === people.jules.id);
let reports: Report[] | null = !me.is_host
  ? null
  : query.has("reports") && reported
    ? [
        {
          id: "r-1",
          reporter_id: people.eli.id,
          user_id: people.jules.id,
          message: { id: reported.id, room_id: "r-general", excerpt: reported.body, created_at: reported.created_at },
          note: "This felt a bit much tonight.",
          created_at: NOW - 20 * 60_000,
        },
      ]
    : [];
/** The list window passes on what it holds that changed, as it does when a frame changes it. */
const shareSafety = () => window.setTimeout(() => desktop.deliver("next:shared", { v: 1, server: SERVER, shared: { myVoice: null, read: night.read, readLoaded: true, notifyRules: rules, blocked, reports } }), 10);
let rules: NotifyRule[] = [];
// What the computer has for starting at sign-in: the only record there is.
const startup = query.get("autostart");
let startsAtSignIn = startup === "on";

const desktop = fakeDesktop({
  label: "settings",
  query,
  others: query.has("servers") ? { [GUILD]: guild(serverState(GUILD)), [LISBON]: lisbon(serverState(LISBON)) } : {},
  infos: query.has("servers") ? serverInfo : {},
  ownerState: { ...night, me, users: night.users.map((user) => (user.id === me.id ? me : user)), blocked, reports },
  asks: {
    "next:notify": (asked) => {
      if (query.has("refuse")) return { problem: "The server is busy." };
      // Saved: the owner tells every window the new rules, as the real one does.
      const rule = asked.rule as NotifyRule;
      rules = asked.on ? [...rules, rule] : rules.filter((held) => held.target_user_id !== rule.target_user_id || held.room_id !== rule.room_id);
      window.setTimeout(() => desktop.deliver("next:shared", { v: 1, server: SERVER, shared: { myVoice: null, read: night.read, readLoaded: true, notifyRules: rules } }), 10);
      return { problem: null };
    },
    "next:password": (asked) => ({ problem: asked.current === "old-secret" ? null : "That isn't your current password." }),
  },
  commands: {
    "plugin:webview|set_webview_zoom": (args) => desktop.note(`zoom:${String(args.value)}`),
    "plugin:window|scale_factor": () => 1,
    "plugin:window|inner_size": () => ({ width: 720, height: 640 }),
    "plugin:window|set_size": (args) => desktop.note(`size:${JSON.stringify(args.value)}`),
    app_version: () => "0.3.6",
    update_check: () => ({ kind: "current" }),
    newest_version: () => "0.4.4",
    autostart_state: () => (startup === "none" ? null : { on: startsAtSignIn, ignored_by: startup === "hyprland" ? "Hyprland" : null }),
    autostart_set: (args) => {
      desktop.note(`autostart:${String(args.on)}`);
      // The shell answers with a sentence when the computer says no.
      if (startup === "refuse") throw "This computer didn't allow it.";
      if (startup !== "ignores") startsAtSignIn = args.on === true;
      return { on: startsAtSignIn, ignored_by: startup === "hyprland" ? "Hyprland" : null };
    },
    "plugin:opener|open_url": (args) => desktop.note(`open:${String(args.url)}`),
    voice_devices: () => ({ inputs: ["Built-in microphone"], outputs: ["Headphones"], default_input: "Built-in microphone", default_output: "Headphones" }),
  },
  routes: (method, path, url, body) => {
    // The other servers answer from the shared fake: their names, and nothing else.
    if (url.origin !== SERVER) return null;
    if (path === "/health" && method === "GET") return json({ ok: true, version: query.get("serverVersion") ?? "0.4.4" });
    if (path === "/server" && method === "GET") return json(info);
    if (path === "/server" && method === "PATCH") {
      info = { ...info, name: String(body.name ?? info.name), accent_key: (body.accent_key ?? null) as ServerInfo["accent_key"] };
      return json(info);
    }
    if (path === "/me" && method === "PATCH") {
      return json({ ...me, display_name: typeof body.display_name === "string" ? body.display_name : me.display_name });
    }
    if (path === "/invites" && method === "GET") return json(invites);
    if (path === "/users/removed") return json([]);
    const unblock = /^\/me\/blocks\/([^/]+)$/.exec(path);
    if (unblock && method === "DELETE") {
      desktop.note(`unblock ${decodeURIComponent(unblock[1] ?? "")}`);
      blocked = blocked.filter((id) => id !== decodeURIComponent(unblock[1] ?? ""));
      shareSafety();
      return new Response(null, { status: 204 });
    }
    const message = /^\/messages\/([^/]+)$/.exec(path);
    if (message && method === "DELETE") {
      desktop.note(`delete ${decodeURIComponent(message[1] ?? "")}`);
      return new Response(null, { status: 204 });
    }
    const report = /^\/reports\/([^/]+)$/.exec(path);
    if (report && method === "DELETE") {
      desktop.note(`close ${decodeURIComponent(report[1] ?? "")}`);
      reports = (reports ?? []).filter((held) => held.id !== decodeURIComponent(report[1] ?? ""));
      shareSafety();
      return new Response(null, { status: 204 });
    }
    return null;
  },
});

declare global {
  interface Window {
    shell?: {
      section: (key: string) => void;
      /** The list window says a server was signed out of. */
      signedOut: (server: string) => void;
      /** The list window says your servers' order or Quiet changed. */
      prefs: (prefs: { order: string[]; quiet: string[] }) => void;
    };
  }
}
window.shell = {
  section: (key) => desktop.deliver("next:section", key),
  signedOut: (server) => desktop.deliver("next:signedout", { v: 1, server }),
  prefs: (prefs) => desktop.deliver("next:serverprefs", { v: 1, prefs }),
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <SettingsWindow />
  </StrictMode>,
);
