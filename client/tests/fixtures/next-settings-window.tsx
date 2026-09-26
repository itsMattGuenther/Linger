/**
 * The real Settings window (`src/next/app/settings/SettingsWindow.tsx`),
 * wired end to end with the desktop shell, the list window and the server
 * faked in the page (`next/desktop.ts`), for
 * `tests/browser/next-settings-window.spec.ts`: saving through the borrowed
 * sign-in, and asking the list window for what only it may do.
 *
 * Open it at /tests/fixtures/next-settings-window.html. Options:
 * `?section=invites` opens on a section; `?member` is you as a member, not
 * the host; `?refuse` has the list window refuse a rule or a password.
 * What the window asked for is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Invite } from "../../src/generated/Invite";
import type { NotifyRule } from "../../src/generated/NotifyRule";
import type { ServerInfo } from "../../src/generated/ServerInfo";
import { serverState } from "../../src/lib/gateway";
import { SettingsWindow } from "../../src/next/app/settings/SettingsWindow";
import "../../src/next/styles/app.css";
import { fakeDesktop, json } from "./next/desktop";
import { NOW, SERVER, SERVER_NAME, evening, people } from "./next/evening";

const query = new URLSearchParams(location.search);
const night = evening(serverState(SERVER));
const me = { ...people.matt, is_host: !query.has("member") };
let info: ServerInfo = { name: SERVER_NAME, accent_key: "amber", icon_key: null, member_count: 7, created_at: NOW - 90 * 86_400_000 } as ServerInfo;
const invites: Invite[] = [];
let rules: NotifyRule[] = [];

const desktop = fakeDesktop({
  label: "settings",
  query,
  ownerState: { ...night, me, users: night.users.map((user) => (user.id === me.id ? me : user)) },
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
    voice_devices: () => ({ inputs: ["Built-in microphone"], outputs: ["Headphones"], default_input: "Built-in microphone", default_output: "Headphones" }),
  },
  routes: (method, path, _url, body) => {
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
    return null;
  },
});

declare global {
  interface Window {
    shell?: {
      section: (key: string) => void;
      /** The list window says a server was signed out of. */
      signedOut: (server: string) => void;
    };
  }
}
window.shell = {
  section: (key) => desktop.deliver("next:section", key),
  signedOut: (server) => desktop.deliver("next:signedout", { v: 1, server }),
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <SettingsWindow />
  </StrictMode>,
);
