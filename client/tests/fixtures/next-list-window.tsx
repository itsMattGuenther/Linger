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
 * spent, and `nowhere.example` doesn't answer. `?hold` keeps the health
 * check waiting until `window.core.release()`.
 * Tokens rotate as a server's do: each refresh spends the one presented and
 * hands out the next, and one presented twice is refused and written down
 * as `reuse`. `?down` has Ashen Lanterns unreachable (`?down=<hostname>`,
 * another) until `window.core.up()`; `?stall` has its first refresh wait until
 * `window.core.unstall()`.
 * `?noinfo` has Casa da Ribeira never say its name. `?update` has a new
 * version waiting (0.4.1); otherwise this is the newest.
 *
 * Conversations open beside the list (#337): The Good Company's rooms and
 * DMs answer with the evening's messages, and take new ones. The window's
 * own size is faked too (`?many=600` puts that many older messages before
 * the evening in #general): it starts 340 wide at x=100 on a 1920-wide screen
 * (`?maximized` has it maximized), and every resize and move is written down
 * as `size <w>x<h>` and `position <x>,<y>`.
 *
 * `window.core.frame(server, frame)` delivers a gateway frame;
 * `window.core.status(server, status)` its connection's state;
 * `window.core.ask(event, question)` asks the owner something as another
 * window would. What the window asked for is in `body[data-did]`, and every
 * sound it played as `sound:<cue>` (`next/audio.ts`).
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { apply, type GatewayState, type GatewayStatus, serverState } from "../../src/lib/gateway";
import { ListWindow } from "../../src/next/app/list/ListWindow";
import "../../src/next/styles/app.css";
import { hearSounds } from "./next/audio";
import type { Message } from "../../src/generated/Message";
import { json, PHOTO_PATH } from "./next/desktop";
import { SERVER, SERVER_NAME, evening, messages, people } from "./next/evening";
import { collections, fakeMedia, fakeSearch } from "./next/finds";
import type { MediaKind } from "../../src/generated/MediaKind";
import { GUILD, guild, LISBON, lisbon, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
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
/** The sign-ins saved on this computer: all three, or with `?one` The Good Company alone. */
const saved = query.has("one") ? [SERVER] : [SERVER, GUILD, LISBON];
const NO_KEYRING = "No usable keyring on this computer (no secret service).";
const names: Record<string, { name: string; accent: string | null }> = { [SERVER]: { name: SERVER_NAME, accent: "amber" }, ...serverInfo };

function ready(server: string): ServerFrame {
  const state = states[server];
  if (!state?.me) throw new Error(`no fixture for ${server}`);
  return {
    s: 1,
    op: "ready",
    d: {
      session_id: `s-${new URL(server).hostname}`,
      user: state.me,
      users: state.users,
      rooms: state.rooms,
      dms: state.dms,
      presence: state.presence,
      voice: Object.entries(state.voice).map(([room_id, peers]) => ({ room_id, peers })),
    },
  } as ServerFrame;
}

// --- the shell -------------------------------------------------------------

/** The list window's box on the screen, in the desktop's pixels. */
const box = { x: 100, y: 40, width: 340, height: 820 };
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

(window as unknown as { isTauri: boolean }).isTauri = true;
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
    case "update_check":
      note("update_check");
      return query.has("update") ? { kind: "ready", version: "0.4.1", notes: null } : { kind: "current" };
    case "gateway_disconnect":
      note(`disconnect ${String(a.baseUrl)}`);
      return null;
    case "gateway_send":
      note(`send ${String(a.baseUrl)}:${JSON.stringify(a.frame)}`);
      return true;
    case "plugin:window|minimize":
      note("minimize");
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
    case "plugin:window|current_monitor":
      return { name: "screen", scaleFactor: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } };
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
    // A desktop banner (lib/notify.ts), with where it leads.
    case "show_notification":
    case "voice_volume":
    // What the voice engine is told: controls are what the room hears about,
    // push-to-talk's gate isn't (#232).
    case "voice_controls":
    case "voice_push_to_talk":
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
      /** The desktop shell passes on a clicked banner's target. */
      banner: (target: unknown) => void;
      /** The desktop shell hid the list into the tray, its close button pressed (#400). */
      hidden: () => void;
      /** With `?hold`, the server answers its health check from now on. */
      release: () => void;
      /** With `?down`, the server that was down answers from now on. */
      up: () => void;
      /** With `?stall`, Ashen Lanterns' first refresh is answered now. */
      unstall: () => void;
      /** The voice engine hears somebody start or stop talking (`peer` null for you). */
      speaking: (server: string, peer: string | null, speaking: boolean) => void;
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
  banner: (target) => deliver("next:banner", target),
  hidden: () => deliver("next:hidden", null),
  release: () => release(),
  up: () => {
    down = null;
  },
  unstall: () => unstall(),
  speaking: (server, peer, speaking) => deliver("voice:speaking", { server, peer, speaking }),
};

// --- the servers -----------------------------------------------------------

let release: () => void = () => undefined;
/** `?down` is Ashen Lanterns; `?down=<hostname>` any other. */
let down: string | null = query.has("down") ? query.get("down") || new URL(GUILD).hostname : null;
let unstall: () => void = () => undefined;
const stalled = new Promise<void>((settle) => {
  unstall = settle;
});
let stalling = query.has("stall");
/** What each server will take next, and what the keyring holds: they part only when a token is lost on the way. */
const issued: Record<string, string> = Object.fromEntries(saved.map((server) => [server, `refresh-1-${server}`]));
const keyring: Record<string, string | undefined> = { ...issued };
let minted = 1;
const held = new Promise<void>((settle) => {
  release = settle;
});

/** The Good Company's history, room by room, as its server holds it. */
const history: Record<string, Message[]> = Object.fromEntries(
  Object.entries(structuredClone(messages)).map(([room, list]) => [
    room,
    list.map((message) => ({ ...message, attachments: message.attachments.map((file) => (file.url.startsWith("data:") ? { ...file, url: PHOTO_PATH } : file)) })),
  ]),
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
  const refuse = (status: number, code: string, message: string) => json({ error: { code, message, retry_after_ms: null } }, status);
  const signedIn = () => {
    minted += 1;
    issued[server] = `refresh-${minted}-${server}`;
    return json({ access_token: `token-${server}`, refresh_token: issued[server], expires_in: 600, user: state.me });
  };
  if (path === "/auth/refresh") {
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
    return new Response(null, { status: 204 });
  }
  const invite = /^\/auth\/invite\/(.+)$/.exec(path);
  if (invite) return json({ valid: invite[1] !== "DEAD", server_name: names[server]?.name ?? null, expires_at: null });
  const setup = /^\/setup\/(.+)$/.exec(path);
  if (setup && method === "GET") return json({ valid: setup[1] !== "used" });
  if ((path === "/auth/login" || path === "/auth/register" || path === "/setup") && method === "POST") {
    note(`signin ${JSON.stringify(body)}`);
    if (body.password === "wrong") return refuse(401, "UNAUTHENTICATED", "That username and password don't match.");
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
  if (path === "/me/notify-rules") return json([]);
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
    });
  }
  if (path === "/me" && method === "GET") return json(state.me);
  if (path === "/me" && method === "PATCH") return json({ ...state.me, status: body.status ?? state.me?.status ?? null });
  return json({ error: { code: "NOT_FOUND", message: "Not in this fixture.", retry_after_ms: null } }, 404);
};

// The phone marks its page the way main.tsx does, so its styles apply here too.
if (query.get("shell") === "phone") document.documentElement.dataset.shell = "phone";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ListWindow />
  </StrictMode>,
);
