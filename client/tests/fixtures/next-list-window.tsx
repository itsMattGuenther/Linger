/**
 * The real list window (`src/next/app/list/ListWindow.tsx`), the owner, with
 * the desktop shell and the servers faked in the page, for
 * `tests/browser/next-list-window.spec.ts`: restoring the sign-ins from the
 * keyring, connecting to every server, the list with several servers, your
 * order and Quiet kept on this computer, knocks, and answering other windows.
 *
 * - The shell: Tauri's own mocks. `sessions_load` hands back a saved sign-in
 *   per server; `gateway_connect` answers with that server's `ready` frame,
 *   as the Rust core would; window commands are written down.
 * - The servers: `fetch` answers a token refresh, read positions, rules and
 *   each server's name.
 *
 * Open it at /tests/fixtures/next-list-window.html. `?one` signs in to The
 * Good Company only. Signing in: `?signedout` has nothing saved, so the
 * window opens on the sign-in screen; `?nokeyring` has no keyring to save
 * to; `?revoked` has The Good Company refuse its saved sign-in (with `?one`,
 * that leaves nothing signed in). The sign-in routes take any username;
 * the password `wrong` is refused, invite `DEAD` and setup token `used` are
 * spent, joining as "Matt" in any capitals is refused as a look-alike (#574),
 * and `nowhere.example` doesn't answer. The usernames `crowd`,
 * `guesser` and `busy` meet the server's limits (#538): a network out of
 * sign-ups for now, one out of sign-in tries, and a server busy checking
 * passwords. `?hold` keeps the health
 * check waiting until `window.core.release()`.
 * Tokens rotate as a server's do: each refresh spends the one presented and
 * hands out the next, and one presented twice is refused and written down
 * as `reuse`. `?down` has Ashen Lanterns unreachable (`?down=<hostname>`,
 * another) until `window.core.up()`; `?stall` has its first refresh wait until
 * `window.core.unstall()`. `window.core.refuseNext()` has the next refresh
 * of any server wait for `unstall()` too, and then be refused, as for an
 * account deleted meanwhile (#650).
 * `?noinfo` has Casa da Ribeira never say its name.
 *
 * Updates (#772): `?update` has 0.4.1 downloaded and ready, on a copy that
 * installs by itself; `?update=waiting` has it on its day's wait until
 * `window.core.downloaded()`; `?update=password` is a copy that needs a
 * password to install; `?update=arch` one pacman owns. Otherwise this is the
 * newest. Installing is written down as `update_now <how it comes back>` and
 * never answers, as a restart wouldn't (`?updatefail` has it refused).
 * `?pending` has 0.4.1 waiting for this start, whose install fails, as
 * offline, at `window.core.installFailed()`. `?updated` is the first start after an update, to the
 * version `release-line.json` names. `?behind` has The Good Company, which
 * you host, run 0.4.0 while 0.4.1 is out.
 *
 * Conversations open beside the list (#337): The Good Company's rooms and
 * DMs answer with the evening's messages, and take new ones. The window's
 * own size is faked too (`?many=600` puts that many older messages before
 * the evening in #general): it starts 340 wide at x=100 on a 1920-wide screen
 * (`?maximized` has it maximized), and every resize and move is written down
 * as `size <w>x<h>` and `position <x>,<y>`. Jules's photo in #general loads
 * only where something serves `PHOTO_PATH` on the server (`next/desktop.ts`):
 * a spec does with `page.route`, and so must anything taking pictures of it.
 *
 * Report and block (T-1605), on The Good Company: `?guest` has Eli host it
 * instead of you, so there's somebody to report to; `?cohost` has Eli host it
 * and you a co-host, and `?cohosts` has Dave a co-host (#424), whose switch
 * is written down as `cohost u-… on|off`; `?blocked` has you
 * blocking Jules already; `?reports` has one report open for you, the host,
 * from Eli about a message of Jules's in #general. Blocks, reports and
 * closing one are written down (`block u-…`, `report {…}`, `close r-…`) and
 * answered with the frames the server sends. Taking somebody out of voice
 * (#423) is written down as `takeout <room> <user>`, and refused unless
 * you're the host.
 *
 * Leaving a group DM (#565) is written down as `leave <id>` and answered with
 * the `dm.remove` the server sends; `?leavefails` has it refused.
 *
 * A file to download (#703): `?file` has Sam share a PDF in #general, after
 * the evening. The browser being handed an address is written down as
 * `open <url>`; the iPhone's shell fetching one for its share sheet
 * (`phone_save`) as `phone_save <url> <name>`, and answered at once, or with
 * `?savehold` only at `window.core.saved()`; `?savefail` has it refused.
 *
 * "Open in Linger" (#607): `?opened=<link>` is the link Linger was started
 * with, handed over the first time the window asks (`link_offered`), and
 * `window.core.link(link)` is one handed over while it runs. Each ask is
 * written down as `link_offered`.
 *
 * The message of the day (#464): `?motd` has Eli's set in #general, just
 * after the evening. Changing a room is written down as `room <id> <body>`,
 * refused unless you host or co-host, and answered with the frames the
 * server sends: the room, and for a new message of the day its line.
 *
 * `window.core.frame(server, frame)` delivers a gateway frame;
 * `window.core.restart(server, read)` starts its session over, with read
 * positions moved meanwhile;
 * `window.core.status(server, status)` its connection's state;
 * `window.core.ask(event, question)` asks the owner something as another
 * window would. What the window asked for is in `body[data-did]`, every
 * sound it played as `sound:<cue>` (`next/audio.ts`), and how many times
 * React has drawn it in `window.commits` (`next/commits.tsx`).
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { apply, type GatewayState, type GatewayStatus, serverState } from "../../src/lib/gateway";
import { ListWindow } from "../../src/next/app/list/ListWindow";
import { loadTextSize, onAppearance } from "../../src/next/core/appearance";
import { followTextSize } from "../../src/next/core/phone";
import "../../src/next/styles/app.css";
import { hearSounds } from "./next/audio";
import { Counted } from "./next/commits";
import type { Message } from "../../src/generated/Message";
import type { Report } from "../../src/generated/Report";
import type { User } from "../../src/generated/User";
import type { VoicePeer } from "../../src/generated/VoicePeer";
import { json, served } from "./next/desktop";
import { customEmoji, SERVER, SERVER_NAME, evening, messages, people } from "./next/evening";
import { collections, fakeMedia, fakeSearch } from "./next/finds";
import type { MediaKind } from "../../src/generated/MediaKind";
import { GUILD, guild, LISBON, lisbon, serverInfo } from "./next/servers";
import { voiceInThePage } from "../../src/lib/ipc";
import { browserWorld } from "../../src/lib/pageVoice";
import { FakeSfu, fakeMicrophone, realAudio, type Received } from "./next/sfu";
import releaseLine from "../../src/next/core/release-line.json";

const query = new URLSearchParams(location.search);
// The first start after an update (#772): an older version was seen here.
if (query.has("updated")) localStorage.setItem("linger.next.update.seen", "0.0.1");
/** Whether the update `?update=waiting` waits for is downloaded yet (`window.core.downloaded()`). */
let updateDownloaded = query.get("update") !== "waiting";
/** The start-up install `?pending` is waiting on, ended by `window.core.installFailed()`. */
let installing: (() => void) | null = null;
const did: string[] = [];
const note = (what: string) => {
  did.push(what);
  document.body.dataset.did = did.join("|");
};
hearSounds(note);

/** Each server as its store state, from the fixtures: every one answers, signed in or not. */
const states: Record<string, GatewayState> = {
  [SERVER]: evening(serverState(SERVER)),
  [GUILD]: guild(serverState(GUILD)),
  [LISBON]: lisbon(serverState(LISBON)),
};
// `?seven`: Dave, Callie, Sam and Jen are in #general's voice too, seven with
// you once you join, as on a game night (#747). With `?sfu` they're silent.
const GAME_NIGHT = ["u-dave", "u-callie", "u-sam", "u-jen"];
const good = states[SERVER];
if (query.has("seven") && good) {
  states[SERVER] = {
    ...good,
    voice: {
      ...good.voice,
      "r-general": [
        ...(good.voice["r-general"] ?? []),
        ...GAME_NIGHT.map((user): VoicePeer => ({ session_id: `s-${user.slice(2)}`, user_id: user, controls: { muted: false, deafened: false } })),
      ],
    },
  };
}
// `?guest`: Eli hosts The Good Company, and you don't (T-1605). `?cohost`:
// the same, with you a co-host (#424). `?cohosts`: Dave is a co-host.
if (query.has("guest") || query.has("cohost") || query.has("cohosts")) {
  const good = states[SERVER];
  const eliHosts = query.has("guest") || query.has("cohost");
  const host = (user: User): User => ({
    ...user,
    is_host: eliHosts ? user.id === people.eli.id : user.is_host,
    is_cohost: (query.has("cohost") && user.id === good?.me?.id) || (query.has("cohosts") && user.id === people.dave.id),
  });
  if (good?.me) states[SERVER] = { ...good, me: host(good.me), users: good.users.map(host) };
}
// `?motd`: #general's message of the day, set by Eli a minute after the
// evening's last word there (#464). The same moment on every load, as a
// server keeps it: a fold is kept by it.
if (query.has("motd")) {
  const good = states[SERVER];
  const set_at = (messages["r-general"]?.at(-1)?.created_at ?? 0) + 60_000;
  const motd = { text: "Raid night Friday at 8. Bring flasks, and @matt brings the snacks.", set_by: people.eli.id, set_at };
  if (good) states[SERVER] = { ...good, rooms: good.rooms.map((room) => (room.id === "r-general" ? { ...room, motd } : room)) };
}
/** Who you've blocked on The Good Company, as its server keeps them. */
const blocks = new Set<string>(query.has("blocked") ? [people.jules.id] : []);
/** The sign-ins saved on this computer: all three, or with `?one` The Good Company alone. */
const saved = query.has("one") ? [SERVER] : [SERVER, GUILD, LISBON];
/** What the shell says with no Secret Service running (`src-tauri/src/secrets.rs`): the system's own words. */
const NO_KEYRING =
  "Platform secure storage failure: zbus error: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files";
const names: Record<string, { name: string; accent: string | null }> = { [SERVER]: { name: SERVER_NAME, accent: "amber" }, ...serverInfo };
// `?servers=30`: that many servers signed in at once (#512), the three and
// more like Casa da Ribeira, each its own.
const extra = Math.max(0, Number(query.get("servers") ?? "0") - saved.length);
for (let at = 1; at <= extra; at += 1) {
  const server = `https://extra-${at}.example`;
  states[server] = lisbon(serverState(server));
  saved.push(server);
  names[server] = { name: `Extra ${at}`, accent: "teal" };
}

/** How many times a session has started over (`window.core.restart`). */
let restarts = 0;

function ready(server: string, again = ""): ServerFrame {
  const state = states[server];
  if (!state?.me) throw new Error(`no fixture for ${server}`);
  return {
    s: 1,
    op: "ready",
    d: {
      session_id: `s-${new URL(server).hostname}${again}`,
      user: state.me,
      users: state.users,
      rooms: state.rooms,
      dms: state.dms,
      presence: state.presence,
      voice: Object.entries(state.voice).map(([room_id, peers]) => ({ room_id, peers })),
      // The home server's own emoji (#359); `?noemoji` has none.
      emoji: server === SERVER && !query.has("noemoji") ? customEmoji : [],
      // Reactions (#485): the home server's; `?oldreactions` is one from before them.
      ...(server === SERVER && !query.has("oldreactions") ? { reactions: true } : {}),
    },
  } as ServerFrame;
}

// --- the shell -------------------------------------------------------------

/** The list window's box on the screen, in the desktop's pixels: `?x=` moves it along. */
const box = { x: Number(query.get("x") ?? 100), y: 40, width: 340, height: 820 };

// The page's own view of its screen (core/screen.ts, #628), as the engine
// gives it: a 1920 px screen with a 40 px panel, `?second` a second one to the
// right of it, and the window where the shell has it.
const screenLeft = query.has("second") ? 1920 : 0;
Object.defineProperty(window.screen, "availLeft", { configurable: true, get: () => screenLeft });
Object.defineProperty(window.screen, "availWidth", { configurable: true, get: () => 1920 });
Object.defineProperty(window.screen, "availHeight", { configurable: true, get: () => 1040 });
Object.defineProperty(window, "screenX", { configurable: true, get: () => box.x });
Object.defineProperty(window, "outerWidth", { configurable: true, get: () => box.width });
/** A size or position as the window API sends it: `{ Logical: {…} }`, or bare. */
function logical(value: unknown): { width: number; height: number; x: number; y: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const wrapped: unknown = Reflect.get(value, "size") ?? Reflect.get(value, "position") ?? value;
  if (typeof wrapped !== "object" || wrapped === null) return null;
  const inner: unknown = Reflect.get(wrapped, "Logical") ?? Reflect.get(wrapped, "Physical") ?? wrapped;
  if (typeof inner !== "object" || inner === null) return null;
  const read = (key: string) => {
    const found: unknown = Reflect.get(inner, key);
    return typeof found === "number" ? found : 0;
  };
  return { width: read("width"), height: read("height"), x: read("x"), y: read("y") };
}

const listeners = new Map<string, number[]>();
interface Internals {
  runCallback: (id: number, data: unknown) => void;
}
const deliver = (event: string, payload: unknown) => {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  for (const id of listeners.get(event) ?? []) internals.runCallback(id, { event, id, payload });
};
const seq: Record<string, number> = {};
/**
 * Android's Back, as the shell's app plugin hands it to the page
 * (`onBackButtonPress`): the channel listening, and how many it has been sent.
 */
let backListener: { id: number; sent: number } | null = null;

(window as unknown as { isTauri: boolean }).isTauri = true;
/** The `linger://` link the shell is holding for the window (#607), as it would hand it over. */
let opened: string | null = query.get("opened");
mockWindows("main");
mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "plugin:event|listen": {
      const event = String(a.event);
      listeners.set(event, [...(listeners.get(event) ?? []), Number(a.handler)]);
      return Number(a.handler);
    }
    case "plugin:event|unlisten":
      listeners.set(
        String(a.event),
        (listeners.get(String(a.event)) ?? []).filter((id) => id !== Number(a.eventId)),
      );
      return null;
    case "plugin:event|emit":
      if (["next:signedout", "next:signedin", "next:serverprefs"].includes(String(a.event))) note(`emit ${String(a.event)}:${JSON.stringify(a.payload)}`);
      deliver(String(a.event), a.payload);
      return null;
    case "plugin:event|emit_to": {
      const target = (a.target as { label?: string }).label;
      if (target === "main") deliver(String(a.event), a.payload);
      else note(`to ${target}:${String(a.event)}:${JSON.stringify(a.payload)}`);
      return null;
    }
    case "plugin:app|register_listener":
      if (a.event === "back-button") backListener = { id: Number((a.handler as { id?: unknown }).id), sent: 0 };
      return null;
    case "plugin:app|remove_listener":
      if (a.event === "back-button" && backListener?.id === Number(a.channelId)) backListener = null;
      return null;
    case "sessions_load":
      if (query.has("nokeyring")) return { kind: "unavailable", reason: NO_KEYRING };
      if (query.has("signedout")) return { kind: "empty" };
      return { kind: "found", sessions: saved.filter((base_url) => keyring[base_url] !== undefined).map((base_url) => ({ base_url, refresh_token: keyring[base_url] ?? "" })) };
    case "session_save": {
      const session = a.session as { base_url?: string; refresh_token?: string };
      note(`save ${String(session.base_url)}`);
      if (query.has("nokeyring")) return { kind: "unavailable", reason: NO_KEYRING };
      keyring[String(session.base_url)] = session.refresh_token;
      return { kind: "done" };
    }
    case "session_forget":
      note(`forget ${String(a.baseUrl)}`);
      keyring[String(a.baseUrl)] = undefined;
      return { kind: "done" };
    case "gateway_connect": {
      const server = String(a.baseUrl);
      note(`connect ${server}`);
      window.setTimeout(() => {
        seq[server] = 1;
        deliver("gateway:status", { server, status: { kind: "ready", latency_ms: 20 } });
        deliver("gateway:frame", { server, frame: ready(server) });
        // Written down, so a spec can wait for every connection's `ready`:
        // React's development mode connects twice, and a second `ready`
        // clears what the first one's rooms had loaded (#339, #355).
        note(`ready ${server}`);
      }, 20);
      return null;
    }
    case "voice_join":
      note(`voice_join:${JSON.stringify({ roomId: a.roomId })}`);
      // The engine opens the devices and starts sending, as the Rust core says.
      window.setTimeout(() => deliver("voice:audio", { server: String(a.baseUrl), state: "sending" }), 20);
      return null;
    case "link_offered": {
      note("link_offered");
      const link = opened;
      opened = null;
      return link;
    }
    case "app_version":
      return query.has("updated") ? releaseLine.version : "0.3.6";
    // A link or a download handed to the browser.
    case "plugin:opener|open_url":
      note(`open ${String(a.url)}`);
      return null;
    // A file fetched for an iPhone's share sheet (#703).
    case "phone_save":
      note(`phone_save ${String(a.url)} ${String(a.name)}`);
      return (query.has("savehold") ? saving : Promise.resolve()).then(() => {
        if (query.has("savefail")) throw "Couldn't get the file.";
        return null;
      });
    case "update_check": {
      note("update_check");
      const line = "Screen sharing, and fixes for voice.";
      const kind = query.get("update");
      if (kind === null) return { kind: "current", silent: true };
      if (kind === "arch") return { kind: "managed", by: "pacman", newer: { version: "0.4.1", line } };
      return { kind: "newer", version: "0.4.1", line, published: 0, downloaded: updateDownloaded, silent: kind !== "password" };
    }
    case "update_now":
      note(`update_now ${String(a.comeBack)}`);
      // A restart never answers; a refusal does.
      return query.has("updatefail") ? { kind: "failed", reason: "The network is down." } : new Promise(() => undefined);
    case "update_pending":
      return query.has("pending") ? "0.4.1" : null;
    case "update_install_pending":
      note("update_install_pending");
      return new Promise((done) => {
        installing = () => done({ kind: "failed", reason: "offline" });
      });
    case "newest_version":
      return query.has("behind") ? "0.4.1" : null;
    // Whether the list window is on screen (#772: how Linger comes back after an update).
    case "plugin:window|is_visible":
      return true;
    case "gateway_disconnect":
      note(`disconnect ${String(a.baseUrl)}`);
      return null;
    case "gateway_send":
      note(`send ${String(a.baseUrl)}:${JSON.stringify(a.frame)}`);
      voiceSignal(String(a.baseUrl), a.frame as { op: string; d?: { sdp?: string } });
      return true;
    case "plugin:window|minimize":
      note("minimize");
      return null;
    // The page showing its own window (#594 has the shell do it instead).
    case "plugin:window|show":
      note("show");
      return null;
    // The list window's own size and place (#337): unfolding grows it, folding shrinks it.
    case "plugin:window|is_maximized":
      return query.has("maximized");
    case "plugin:window|scale_factor":
      return 1;
    case "plugin:window|inner_size":
      return { width: box.width, height: box.height };
    case "plugin:window|outer_position":
      return { x: box.x, y: box.y };
    case "plugin:window|outer_size":
      return { width: box.width, height: box.height };
    // Never asked for (#628): on Linux it reads GTK off its thread.
    case "plugin:window|current_monitor":
      note("current_monitor");
      return null;
    case "plugin:window|set_size": {
      const size = logical(a.value);
      if (size) {
        box.width = size.width;
        box.height = size.height;
        note(`size ${size.width}x${size.height}`);
      }
      return null;
    }
    case "plugin:window|set_position": {
      const at = logical(a.value);
      if (at) {
        box.x = at.x;
        box.y = at.y;
        note(`position ${at.x},${at.y}`);
      }
      return null;
    }
    case "next_open_conversation":
    case "next_open_settings":
    case "next_open_tool":
    case "next_close_to_tray":
    case "next_tray_voice":
    // The list brought back from the tray by the shell, not by itself (#594).
    case "next_show_list":
    // A desktop banner (lib/notify.ts), with where it leads.
    case "show_notification":
    case "voice_volume":
    // What the voice engine is told: controls are what the room hears about,
    // push-to-talk's gate isn't (#232).
    case "voice_controls":
    case "voice_push_to_talk":
    // The shell watching for the talk key with any app in front, or stopping (#500).
    case "voice_talk_key":
    // The phone's call bar, shown, redrawn or taken away (#429).
    case "phone_call_bar":
      note(`${cmd}:${JSON.stringify(a)}`);
      return null;
    default:
      return null;
  }
});

declare global {
  interface Window {
    core?: {
      /** A gateway frame from a server, numbered after its last. */
      frame: (server: string, frame: Omit<ServerFrame, "s">) => void;
      /** A server's connection changes state, as the Rust core would say. */
      status: (server: string, status: GatewayStatus) => void;
      /** Another window asks the owner something (the bus's ask). */
      ask: (event: string, question: Record<string, unknown>) => void;
      /** The desktop shell passes on a tray menu choice ("mute" or "leave"). */
      tray: (action: string) => void;
      /** The update `?update=waiting` waits for finished downloading (#772). */
      downloaded: () => void;
      /** The start-up install `?pending` waits on fails, as offline (#772). */
      installFailed: () => void;
      /** The desktop shell heard the talk key go "down" or "up" with any app in front (#500). */
      talkKey: (edge: string) => void;
      /** The desktop shell passes on a clicked banner's target. */
      banner: (target: unknown) => void;
      /** Android's Back, pressed or swiped, as the shell hands it over; false when nothing is listening, and Android would leave the app. */
      back: () => boolean;
      /** The desktop shell hid the list into the tray, its close button pressed (#400). */
      hidden: () => void;
      /** The desktop shell was handed a `linger://` link, read as the link a person would paste (#607). */
      link: (link: string) => void;
      /** With `?hold`, the server answers its health check from now on. */
      release: () => void;
      /** With `?savehold`, the iPhone's shell has the file, and the share sheet shows. */
      saved: () => void;
      /** With `?down`, the server that was down answers from now on. */
      up: () => void;
      /** With `?stall`, Ashen Lanterns' first refresh is answered now. */
      unstall: () => void;
      /** The next refresh waits for `unstall()`, then is refused (#650). */
      refuseNext: () => void;
      /** The voice engine hears somebody start or stop talking (`peer` null for you). */
      speaking: (server: string, peer: string | null, speaking: boolean) => void;
      /** With `?sfu`, the server's voice forwarding as the phone's engine meets it (#429). */
      sfu?: { received: () => Promise<Received>; drop: () => void; state: () => string };
      /**
       * The session starts over (#453): the server's read positions move
       * first, as reading on another device would, then a fresh `ready`
       * with a new session id.
       */
      restart: (server: string, read: Record<string, string>) => void;
    };
  }
}
window.core = {
  frame: (server, frame) => {
    seq[server] = (seq[server] ?? 1) + 1;
    const numbered = { ...frame, s: seq[server] } as ServerFrame;
    // The server's own state moves on too, as a real server's would, so a
    // later `ready` carries it. In development React starts the list twice
    // (StrictMode), and the second connection's `ready` could land after a
    // test's first frame and undo it: a restyle that added a glow was lost
    // that way (#339).
    const state = states[server];
    if (state) states[server] = apply(state, numbered);
    deliver("gateway:frame", { server, frame: numbered });
  },
  status: (server, status) => deliver("gateway:status", { server, status }),
  ask: (event, question) => deliver(event, { v: 1, id: "q-1", from: "chat", ...question }),
  tray: (action) => deliver("next:tray", action),
  downloaded: () => {
    updateDownloaded = true;
    deliver("next:update", null);
  },
  installFailed: () => installing?.(),
  talkKey: (edge) => deliver("next:talkkey", edge),
  banner: (target) => deliver("next:banner", target),
  back: () => {
    if (backListener === null) return false;
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    internals.runCallback(backListener.id, { index: backListener.sent, message: null });
    backListener.sent += 1;
    return true;
  },
  hidden: () => deliver("next:hidden", null),
  link: (link) => {
    opened = link;
    deliver("next:link", null);
  },
  release: () => release(),
  saved: () => showSheet(),
  up: () => {
    down = null;
  },
  unstall: () => unstall(),
  refuseNext: () => {
    refusing = true;
  },
  speaking: (server, peer, speaking) => deliver("voice:speaking", { server, peer, speaking }),
  sfu: {
    received: async () => (await sfu?.received()) ?? { packets: 0, level: 0 },
    drop: () => sfu?.drop(),
    state: () => sfu?.state ?? "none",
  },
  restart: (server, read) => {
    const state = states[server];
    if (!state) return;
    states[server] = { ...state, read: { ...state.read, ...read } };
    restarts += 1;
    seq[server] = 1;
    deliver("gateway:frame", { server, frame: ready(server, `-${restarts}`) });
  },
};

// --- the servers -----------------------------------------------------------

let release: () => void = () => undefined;
/** With `?savehold`, the iPhone's share sheet waits for `window.core.saved()`. */
let showSheet: () => void = () => undefined;
const saving = new Promise<void>((settle) => {
  showSheet = settle;
});
/** `?down` is Ashen Lanterns; `?down=<hostname>` any other. */
let down: string | null = query.has("down") ? query.get("down") || new URL(GUILD).hostname : null;
let unstall: () => void = () => undefined;
const stalled = new Promise<void>((settle) => {
  unstall = settle;
});
let stalling = query.has("stall");
let refusing = false;
/** What each server will take next, and what the keyring holds: they part only when a token is lost on the way. */
const issued: Record<string, string> = Object.fromEntries(saved.map((server) => [server, `refresh-1-${server}`]));
const keyring: Record<string, string | undefined> = { ...issued };
let minted = 1;
const held = new Promise<void>((settle) => {
  release = settle;
});

/** The Good Company's history, room by room, as its server holds it. */
const history: Record<string, Message[]> = Object.fromEntries(
  Object.entries(structuredClone(messages)).map(([room, list]) => [room, list.map(served)]),
);
// `?many=600`: that many older messages before the evening in #general, an
// hour apart, for reading back and letting go.
const many = Number(query.get("many") ?? "0");
if (many > 0) {
  const held = history["r-general"] ?? [];
  const first = held[0]?.created_at ?? Date.now();
  history["r-general"] = [
    ...Array.from({ length: many }, (_, index): Message => ({
      id: `l${String(index + 1).padStart(7, "0")}`,
      room_id: "r-general",
      author_id: index % 2 === 0 ? people.eli.id : people.jules.id,
      body: `older message ${index + 1}`,
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: first - (many - index) * 60_000,
    })),
    ...held,
  ];
}
// `?file`: Sam shares a PDF in #general, a minute after the evening (#703).
if (query.has("file")) {
  const held = history["r-general"] ?? [];
  const last = held.at(-1);
  if (last) {
    const created_at = last.created_at + 60_000;
    history["r-general"] = [
      ...held,
      {
        ...last,
        id: "m000998",
        author_id: people.sam.id,
        body: "the map for saturday",
        reply_to: null,
        reactions: [],
        created_at,
        attachments: [
          {
            id: "a-map",
            filename: "river-loop-trail-map.pdf",
            mime: "application/pdf",
            size_bytes: 2_100_000,
            url: "/media/river-loop-trail-map.pdf",
            width: null,
            height: null,
            duration_ms: null,
            blurhash: null,
            poster_url: null,
            starred_at: null,
            uploader_id: people.sam.id,
            created_at,
          },
        ],
      },
    ];
  }
}
/** The Good Company's open reports, for its host: `?reports` has one of Jules's messages reported by Eli. */
let reports: Report[] = (() => {
  if (!query.has("reports")) return [];
  const said = (history["r-general"] ?? []).find((message) => message.author_id === people.jules.id);
  if (!said) return [];
  return [
    {
      id: "r-1",
      reporter_id: people.eli.id,
      user_id: people.jules.id,
      message: { id: said.id, room_id: "r-general", excerpt: said.body, created_at: said.created_at },
      note: "This felt a bit much tonight.",
      created_at: Date.now() - 20 * 60_000,
    },
  ];
})();
let serial = 900_000;
function page(room: string, params: URLSearchParams): Message[] {
  const all = history[room] ?? [];
  const limit = Number(params.get("limit") ?? "100");
  const around = params.get("around");
  const before = params.get("before");
  if (around !== null) {
    const older = all.filter((message) => message.id <= around).slice(-Math.ceil(limit / 2));
    const newer = all.filter((message) => message.id > around).slice(0, Math.floor(limit / 2));
    return [...older, ...newer];
  }
  const upTo = before === null ? all : all.filter((message) => message.id < before);
  return upTo.slice(-limit);
}

/** What a server says for each of its limits on the way in (#538). */
const SIGNUPS_PAUSED =
  "Lots of people have joined from your network in the last hour, so this server is pausing new sign-ups from it. Try again in about 10 minutes. If your group is joining together, the host can raise this limit.";
const SIGN_INS_PAUSED = "Too many sign-in tries from your network in the last minute. Try again in 12 seconds.";
const SERVER_BUSY = "The server is busy letting other people in. Try again in a moment.";

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const server = url.origin;
  if (url.hostname === "nowhere.example") throw new TypeError("Failed to fetch");
  if (url.hostname === down) {
    note(`unreachable ${server}${url.pathname.slice("/api/v1".length)}`);
    throw new TypeError("Failed to fetch");
  }
  const state = states[server];
  if (!state || !url.pathname.startsWith("/api/v1")) return realFetch(input, init);
  const path = url.pathname.slice("/api/v1".length);
  const method = init?.method ?? "GET";
  note(`${method} ${server}${path}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  await new Promise((settle) => window.setTimeout(settle, 10));
  const refuse = (status: number, code: string, message: string, retryAfterMs: number | null = null) =>
    json({ error: { code, message, retry_after_ms: retryAfterMs } }, status);
  const signedIn = () => {
    minted += 1;
    issued[server] = `refresh-${minted}-${server}`;
    return json({ access_token: `token-${server}`, refresh_token: issued[server], expires_in: 600, user: state.me });
  };
  if (path === "/auth/refresh") {
    if (refusing) {
      refusing = false;
      await stalled;
      return refuse(401, "UNAUTHENTICATED", "That sign-in has ended.");
    }
    if (stalling && server === GUILD) {
      stalling = false;
      await stalled;
    }
    if (query.has("revoked") && server === SERVER) return refuse(401, "UNAUTHENTICATED", "That sign-in has ended.");
    if (body.refresh_token !== issued[server]) {
      note(`reuse ${server}`);
      return refuse(401, "UNAUTHENTICATED", "That sign-in was used twice.");
    }
    return signedIn();
  }
  if (path === "/health") {
    // `?hold`: the server doesn't answer until the test lets it (`window.core.release()`).
    if (query.has("hold")) await held;
    // `?behind`: the release it runs, behind the newest (#772).
    if (query.has("behind")) return json({ ok: true, version: server === SERVER ? "0.4.0" : "0.4.1" });
    return new Response(null, { status: 204 });
  }
  const invite = /^\/auth\/invite\/(.+)$/.exec(path);
  if (invite) return json({ valid: invite[1] !== "DEAD", server_name: names[server]?.name ?? null, expires_at: null });
  const setup = /^\/setup\/(.+)$/.exec(path);
  if (setup && method === "GET") return json({ valid: setup[1] !== "used" });
  // A sign-in link the host made (#581): `used` is one that's been used.
  const signInLink = /^\/auth\/sign-in-link\/(.+)$/.exec(path);
  if (signInLink) {
    const valid = signInLink[1] !== "used";
    return json({ valid, server_name: valid ? (names[server]?.name ?? null) : null, username: valid ? "matt" : null, made_by: valid ? "Callie" : null, expires_at: valid ? Date.now() + 86_400_000 : null });
  }
  if ((path === "/auth/login" || path === "/auth/register" || path === "/setup" || path === "/auth/sign-in-link") && method === "POST") {
    note(`signin ${JSON.stringify(body)}`);
    if (body.password === "wrong") return refuse(401, "UNAUTHENTICATED", "That username and password don't match.");
    // The server's limits (#538), in the words it sends.
    if (body.username === "crowd") return refuse(429, "RATE_LIMITED", SIGNUPS_PAUSED, 599_990);
    if (body.username === "guesser") return refuse(429, "RATE_LIMITED", SIGN_INS_PAUSED, 11_250);
    if (body.username === "busy") return refuse(429, "RATE_LIMITED", SERVER_BUSY, 5_000);
    // Joining as somebody already here, in other capitals: the server's look-alike refusal (#574).
    if (path === "/auth/register" && typeof body.display_name === "string" && body.display_name.toLowerCase() === state.me?.display_name.toLowerCase()) {
      return refuse(409, "DISPLAY_NAME_TAKEN", "Someone here already goes by a name that looks like that. Try something a little different.");
    }
    return signedIn();
  }
  if (path === "/read") return json(state.read);
  // Conversations beside the list (#337).
  const messagesOf = /^\/rooms\/([^/]+)\/messages$/.exec(path);
  if (messagesOf && method === "GET") {
    note(`history ${decodeURIComponent(messagesOf[1] ?? "")}${url.search}`);
    return json(server === SERVER ? page(decodeURIComponent(messagesOf[1] ?? ""), url.searchParams) : []);
  }
  if (messagesOf && method === "POST") {
    serial += 1;
    const room = decodeURIComponent(messagesOf[1] ?? "");
    const message: Message = {
      id: `m${String(serial).padStart(6, "0")}`,
      room_id: room,
      author_id: people.matt.id,
      body: String(body.body ?? ""),
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: Date.now(),
    };
    history[room] = [...(history[room] ?? []), message];
    return json(message, 201);
  }
  if (/^\/rooms\/[^/]+\/read$/.test(path)) return new Response(null, { status: 204 });
  // Changing a room, as the host or a co-host does (#464): a new message of
  // the day comes back as the room and a line in it, as the server sends them.
  const roomOf = server === SERVER ? /^\/rooms\/([^/]+)$/.exec(path) : null;
  if (roomOf && method === "PATCH") {
    const id = decodeURIComponent(roomOf[1] ?? "");
    note(`room ${id} ${JSON.stringify(body)}`);
    if (!state.me?.is_host && !state.me?.is_cohost) return refuse(403, "FORBIDDEN", "Only the host or a co-host can do that.");
    const found = state.rooms.find((room) => room.id === id);
    if (!found) return refuse(404, "NOT_FOUND", "No such room on this server.");
    const text = typeof body.motd === "string" ? body.motd.trim() : null;
    if (text !== null && text.length > 300) return refuse(422, "VALIDATION_FAILED", "A message of the day is at most 300 characters.");
    const at = Date.now();
    const { motd: _old, ...rest } = found;
    const motdNow = text === null ? found : text === "" ? rest : { ...found, motd: { text, set_by: state.me.id, set_at: at } };
    // Reactions on or off (#485): "on" is the field left out.
    const { reactions_off: _was, ...reacting } = motdNow;
    const room = typeof body.reactions_off !== "boolean" ? motdNow : body.reactions_off ? { ...motdNow, reactions_off: true } : reacting;
    states[SERVER] = { ...state, rooms: state.rooms.map((one) => (one.id === id ? room : one)) };
    window.setTimeout(() => {
      window.core?.frame(SERVER, { op: "room.update", d: room } as Omit<ServerFrame, "s">);
      if (text === null || text === "") return;
      serial += 1;
      const line: Message = {
        id: `m${String(serial).padStart(6, "0")}`,
        room_id: id,
        author_id: state.me?.id ?? "",
        body: text,
        reply_to: null,
        attachments: [],
        reactions: [],
        pinned_at: null,
        edited_at: null,
        deleted_at: null,
        created_at: at,
        motd: true,
      };
      history[id] = [...(history[id] ?? []), line];
      window.core?.frame(SERVER, { op: "message.create", d: line } as Omit<ServerFrame, "s">);
    }, 10);
    return json(room);
  }
  // Leaving a group DM (#565): written down as `leave <id>`, refused for a
  // one-to-one DM as the server refuses it, and answered with the frame the
  // server sends every one of your sessions. `?leavefails` has the server
  // not answer.
  const leaveOf = server === SERVER ? /^\/dms\/([^/]+)\/leave$/.exec(path) : null;
  if (leaveOf && method === "POST") {
    const id = decodeURIComponent(leaveOf[1] ?? "");
    note(`leave ${id}`);
    if (query.has("leavefails")) return refuse(503, "INTERNAL", "The server couldn't do that just now. Try again in a moment.");
    const found = state.dms.find((dm) => dm.id === id);
    if (!found) return refuse(404, "NOT_FOUND", "No such room on this server.");
    if (found.someone_left !== true && (found.member_ids?.length ?? 0) <= 2) {
      return refuse(422, "VALIDATION_FAILED", "A DM with one person can't be left. It's their row in your list.");
    }
    window.setTimeout(() => window.core?.frame(SERVER, { op: "dm.remove", d: { room_id: id } } as Omit<ServerFrame, "s">), 10);
    return new Response(null, { status: 204 });
  }
  if (path === "/links/preview") return json([]);
  // Media and Search beside the list (#337), from the same finds as their own windows' page.
  if (path === "/search" && method === "GET") {
    const params = url.searchParams;
    return json(fakeSearch(server, { q: params.get("q") ?? "", room: params.get("room_id"), author: params.get("author_id"), before: params.get("before"), limit: Number(params.get("limit") ?? "30") }));
  }
  if (path === "/media" && method === "GET") {
    const params = url.searchParams;
    const kind = params.get("kind");
    const number = (value: string | null) => (value === null ? null : Number(value));
    return json(
      fakeMedia(collections[server] ?? [], {
        kind: kind === null ? null : (kind as MediaKind),
        author: params.get("author"),
        since: number(params.get("since")),
        until: number(params.get("until")),
        before: params.get("before"),
        limit: Number(params.get("limit") ?? "60"),
      }),
    );
  }
  // `?limit`: the fourth knock inside an hour, refused as the server does,
  // with 19 minutes 10 seconds to go.
  if (path === "/knock")
    return query.has("limit")
      ? json({ error: { code: "RATE_LIMITED", message: "Slow down a little.", retry_after_ms: 1_150_000 } }, 429)
      : new Response(null, { status: 204 });
  if (path === "/dms" && method === "POST") {
    // The DM you already have with exactly these people, or a new one.
    const me = state.me?.id ?? "";
    const wanted = [me, ...(Array.isArray(body.user_ids) ? body.user_ids.map(String) : [])].sort();
    const held = state.dms.find((dm) => [...(dm.member_ids ?? [])].sort().join() === wanted.join());
    return json(
      held ?? { id: `d-${wanted.filter((id) => id !== me).join("-")}`, slug: "", name: "", topic: null, kind: "dm", member_ids: wanted, position: 0, archived_at: null, last_message_id: null },
      held ? 200 : 201,
    );
  }
  // A reaction (#485): kept as the server keeps it, and told to everybody as
  // `reaction.update`, yours included.
  const reactOf = server === SERVER ? /^\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(path) : null;
  if (reactOf && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(reactOf[1] ?? "");
    const key = decodeURIComponent(reactOf[2] ?? "");
    const on = method === "PUT";
    note(`react ${id} ${key} ${on ? "on" : "off"}`);
    for (const list of Object.values(history)) {
      const at = list.findIndex((message) => message.id === id);
      const found = list[at];
      if (!found) continue;
      const held = found.reactions.find((group) => group.key === key);
      const others = (held?.user_ids ?? []).filter((one) => one !== state.me?.id);
      const user_ids = on && state.me ? [...others, state.me.id] : others;
      const rest = found.reactions.filter((group) => group.key !== key);
      list[at] = { ...found, reactions: user_ids.length === 0 ? rest : [...rest, { key, count: user_ids.length, user_ids }] };
      window.setTimeout(
        () => window.core?.frame(SERVER, { op: "reaction.update", d: { message_id: id, key, count: user_ids.length, user_ids } } as Omit<ServerFrame, "s">),
        10,
      );
      return new Response(null, { status: 204 });
    }
    return refuse(404, "NOT_FOUND", "That message is gone.");
  }
  if (path === "/me/notify-rules") return json([]);
  // Report and block (PROTOCOL §5): The Good Company's; the others predate them.
  if (server === SERVER && path === "/me/blocks" && method === "GET") return json([...blocks]);
  const blockOf = server === SERVER ? /^\/me\/blocks\/([^/]+)$/.exec(path) : null;
  if (blockOf && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(blockOf[1] ?? "");
    const on = method === "PUT";
    note(`${on ? "block" : "unblock"} ${id}`);
    if (on) blocks.add(id);
    else blocks.delete(id);
    window.setTimeout(() => window.core?.frame(SERVER, { op: "block.update", d: { user_id: id, blocked: on } } as Omit<ServerFrame, "s">), 10);
    return new Response(null, { status: 204 });
  }
  if (server === SERVER && path === "/reports" && method === "POST") {
    note(`report ${JSON.stringify(body)}`);
    const reported = typeof body.message_id === "string" ? (history["r-general"] ?? []).find((message) => message.id === body.message_id) : undefined;
    const report: Report = {
      id: `r-${reports.length + 2}`,
      reporter_id: state.me?.id ?? "",
      user_id: reported?.author_id ?? String(body.user_id ?? ""),
      message: reported ? { id: reported.id, room_id: reported.room_id, excerpt: reported.body, created_at: reported.created_at } : null,
      note: typeof body.note === "string" ? body.note : null,
      created_at: Date.now(),
    };
    return json(report, 201);
  }
  if (server === SERVER && path === "/reports" && method === "GET") {
    return state.me?.is_host || state.me?.is_cohost
      ? json(reports)
      : json({ error: { code: "FORBIDDEN", message: "Only the host or a co-host sees reports.", retry_after_ms: null } }, 403);
  }
  // The co-host switch (#424): the host's alone, answered with the person as
  // they are now and the `user.update` the server sends everybody.
  const cohostOf = server === SERVER ? /^\/users\/([^/]+)\/cohost$/.exec(path) : null;
  if (cohostOf && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(cohostOf[1] ?? "");
    const on = method === "PUT";
    note(`cohost ${id} ${on ? "on" : "off"}`);
    if (!state.me?.is_host) return json({ error: { code: "FORBIDDEN", message: "Only the host can do that.", retry_after_ms: null } }, 403);
    const found = state.users.find((user) => user.id === id);
    if (!found) return json({ error: { code: "NOT_FOUND", message: "No such person on this server.", retry_after_ms: null } }, 404);
    const user: User = { ...found, is_cohost: on };
    window.setTimeout(() => window.core?.frame(SERVER, { op: "user.update", d: user } as Omit<ServerFrame, "s">), 10);
    return json(user);
  }
  const reportOf = server === SERVER ? /^\/reports\/([^/]+)$/.exec(path) : null;
  if (reportOf && method === "DELETE") {
    const id = decodeURIComponent(reportOf[1] ?? "");
    note(`close ${id}`);
    reports = reports.filter((report) => report.id !== id);
    window.setTimeout(() => window.core?.frame(SERVER, { op: "reports.changed", d: {} } as Omit<ServerFrame, "s">), 10);
    return new Response(null, { status: 204 });
  }
  const takeOutOf = /^\/rooms\/([^/]+)\/voice\/([^/]+)$/.exec(path);
  if (takeOutOf && method === "DELETE") {
    // The host or a co-host (#424).
    if (!state.me?.is_host && !state.me?.is_cohost) return json({ error: { code: "FORBIDDEN", message: "Only the host or a co-host can do that.", retry_after_ms: null } }, 403);
    note(`takeout ${decodeURIComponent(takeOutOf[1] ?? "")} ${decodeURIComponent(takeOutOf[2] ?? "")}`);
    return new Response(null, { status: 204 });
  }
  if (path === "/server" && query.has("noinfo") && server === LISBON) return json({ error: { code: "UNAVAILABLE", message: "Busy.", retry_after_ms: null } }, 503);
  if (path === "/server") {
    return json({
      name: names[server]?.name ?? server,
      accent_key: names[server]?.accent ?? null,
      icon_key: null,
      member_count: state.users.length,
      created_at: 0,
      storage_used_bytes: 1_200_000_000,
      storage_limit_bytes: 50_000_000_000,
      file_expiry_days: 90,
      // `?screens`: the server passes shared screens on (#360, #746).
      ...(query.has("screens") ? { screens: true } : {}),
      // `?hostissues`: the server you host has a nearly full disk and no
      // backup for four days (#582). Said to the host alone, as a server does.
      ...(query.has("hostissues") && server === SERVER && state.me?.is_host
        ? { health: { backups: true, last_backup_at: Date.now() - 4 * 24 * 60 * 60 * 1000 - 60_000, backup_overdue: true, disk_nearly_full: true, file_space_nearly_full: false } }
        : {}),
      // `?behind`: a server you host, all well with its machine (#772).
      ...(query.has("behind") && server === SERVER && state.me?.is_host
        ? { health: { backups: true, last_backup_at: Date.now() - 6 * 60 * 60 * 1000, backup_overdue: false, disk_nearly_full: false, file_space_nearly_full: false } }
        : {}),
      // `?hostbucket`: last night's copy is fine, but none has reached the
      // host's bucket for four days (#614).
      ...(query.has("hostbucket") && server === SERVER && state.me?.is_host
        ? {
            health: {
              backups: true,
              last_backup_at: Date.now() - 6 * 60 * 60 * 1000,
              backup_overdue: false,
              disk_nearly_full: false,
              file_space_nearly_full: false,
              bucket: { name: "good-company-backups", last_sent_at: Date.now() - 4 * 24 * 60 * 60 * 1000 - 60_000, overdue: true },
            },
          }
        : {}),
    });
  }
  if (path === "/me" && method === "GET") return json(state.me);
  if (path === "/me" && method === "PATCH") return json({ ...state.me, status: body.status ?? state.me?.status ?? null });
  return json({ error: { code: "NOT_FOUND", message: "Not in this fixture.", retry_after_ms: null } }, 404);
};

// The phone marks its page the way main.tsx does, so its styles apply here
// too, and sizes its text the same way: the phone's text size (`?phonetext=`,
// the usual when not given) with the Text size chosen in Settings on top (#690).
if (query.get("shell") === "phone") {
  document.documentElement.dataset.shell = "phone";
  followTextSize(document, () => Promise.resolve(Number(query.get("phonetext") ?? "1")), loadTextSize, onAppearance);
}

// --- the phone's voice (#429) ----------------------------------------------
//
// On the phone, voice runs in the page (src/lib/pageVoice.ts), as main.tsx
// sets it up. Its microphone here is a tone made in the page (`?micquiet`:
// silence), so no browser needs a microphone of its own. With `?sfu` the
// server's voice forwarding is a real connection in the page
// (next/sfu.ts): Eli's tone is loud, Jules's silent, and the phone's
// answers, restarts and leave go to it.
const micAudio = query.get("shell") === "phone" ? realAudio() : null;
if (micAudio) {
  voiceInThePage({
    ...browserWorld(),
    getMicrophone: async () => {
      await micAudio.resume().catch(() => undefined);
      return fakeMicrophone(micAudio, query.has("micquiet") ? 0 : 0.5);
    },
  });
}
const sfu = query.has("sfu")
  ? new FakeSfu(
      (frame) => window.core?.frame(SERVER, frame as Omit<ServerFrame, "s">),
      [
        { session: "s-eli", loudness: 0.5 },
        { session: "s-jules", loudness: 0 },
        ...(query.has("seven") ? GAME_NIGHT.map((user) => ({ session: `s-${user.slice(2)}`, loudness: 0 })) : []),
      ],
      query.has("bitrate") ? Number(query.get("bitrate")) : null,
    )
  : null;
let sfuJoined = false;
/** The phone's voice frames, as the server's forwarding takes them. */
function voiceSignal(server: string, frame: { op: string; d?: { sdp?: string } }) {
  if (!sfu || server !== SERVER) return;
  if (frame.op === "voice.join" && !sfuJoined) {
    sfuJoined = true;
    void sfu.offer();
  } else if (frame.op === "voice.answer" && frame.d?.sdp) void sfu.answer(frame.d.sdp);
  else if (frame.op === "voice.restart" && sfuJoined) void sfu.offer();
  else if (frame.op === "voice.leave") {
    sfuJoined = false;
    sfu.close();
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Counted>
      <ListWindow />
    </Counted>
  </StrictMode>,
);
