/**
 * The real chat window (`src/next/app/chat/ChatWindow.tsx`), wired end to end
 * with the desktop shell, the list window and the server all faked in the
 * page, so `tests/browser/next-chat-window.spec.ts` can drive the wiring:
 * catching up with the owner, borrowing its sign-in, loading history,
 * sending, reading, tabs, presence and voice intents.
 *
 * - The shell: Tauri's own mocks (`@tauri-apps/api/mocks`), with events
 *   routed here. Events sent to `main` reach the fake owner below.
 * - The owner: answers the snapshot and token questions with the
 *   prototype's evening, and writes down every intent.
 * - The server: `fetch` answers from the evening's messages.
 *
 * Open it at /tests/fixtures/next-chat-window.html?room=r-general. Options:
 * `?fail` refuses every send; `?noowner` has the owner never answer;
 * `?expired` has the server refuse the first lent token, as if it ran out;
 * `?ptt` puts you in voice in #general with push-to-talk on; `?limit`
 * refuses knocks, as the fourth in an hour; `&single=1` is the conversation
 * in a window of its own. The
 * photo loads only where something serves `PHOTO_PATH` (the spec does).
 * `window.owner` lets a test act as the owner or the shell; what the window
 * asked for is written to `body[data-did]`, `|`-separated.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { LinkPreview } from "../../src/generated/LinkPreview";
import type { Message } from "../../src/generated/Message";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { serverState } from "../../src/lib/gateway";
import { ChatWindow } from "../../src/next/app/chat/ChatWindow";
import "../../src/next/styles/app.css";
import { SERVER, evening, messages, people, previews } from "./next/evening";

const query = new URLSearchParams(location.search);
if (!query.has("server")) query.set("server", SERVER);
history.replaceState(null, "", `${location.pathname}?${query.toString()}`);

const did: string[] = [];
const note = (what: string) => {
  did.push(what);
  document.body.dataset.did = did.join("|");
};

// ---------------------------------------------------------------------------
// The shell: events between windows, and the commands the page calls.

type Payload = unknown;
const listeners = new Map<string, number[]>();
/** Where `mockIPC` keeps the page's callbacks: a listener is one of them. */
interface Internals {
  runCallback: (id: number, data: unknown) => void;
}
/** Run this page's listeners for an event, as the shell would deliver it. */
function deliver(event: string, payload: Payload): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  for (const id of listeners.get(event) ?? []) internals.runCallback(id, { event, id, payload });
}

(window as unknown as { isTauri: boolean }).isTauri = true;
mockWindows("chat", "main");
mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "plugin:event|listen": {
      const event = String(a.event);
      const handler = Number(a.handler);
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return handler;
    }
    case "plugin:event|unlisten": {
      const event = String(a.event);
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((id) => id !== Number(a.eventId)),
      );
      return null;
    }
    case "plugin:event|emit":
      deliver(String(a.event), a.payload);
      ownerHears(String(a.event), a.payload);
      return null;
    case "plugin:event|emit_to": {
      const target = a.target as { label?: string };
      if (target.label === "main") ownerHears(String(a.event), a.payload);
      else deliver(String(a.event), a.payload);
      return null;
    }
    case "gateway_send":
      note(`gateway:${JSON.stringify(a.frame)}`);
      return true;
    case "plugin:window|close":
      note("window:close");
      return null;
    default:
      return null;
  }
});

// ---------------------------------------------------------------------------
// The owner: the list window, holding the connection.

const EPOCH = "s-evening";
let seq = 100;
const night = evening(serverState(SERVER));
const ownerState = {
  ...night,
  sessionId: EPOCH,
  myVoice: query.has("ptt")
    ? {
        roomId: "r-general",
        muted: true,
        deafened: false,
        mutedBeforeDeafen: false,
        pushToTalk: true,
        moved: false,
        audio: "sending" as const,
        peers: {},
        speaking: {},
        talking: false,
        volumes: {},
      }
    : null,
};
let tokens = 1;

interface Question {
  v: number;
  id: string;
  from: string;
}

function ownerHears(event: string, payload: Payload): void {
  const question = payload as Question & Record<string, unknown>;
  const reply = (answer: unknown) =>
    window.setTimeout(() => deliver(`${event}:answer`, { v: 1, id: question.id, from: "main", answer }), 5);
  switch (event) {
    case "next:snapshot":
      if (query.has("noowner")) return;
      reply({
        servers: [{ server: SERVER, state: ownerState, position: { epoch: EPOCH, seq }, lent: { token: `token-${tokens}`, expiresAt: Date.now() + 3_600_000 } }],
      });
      return;
    case "next:token":
      tokens += 1;
      note(`token:${String(question.stale)}`);
      reply({ token: `token-${tokens}`, expiresAt: Date.now() + 3_600_000 });
      return;
    case "next:intent": {
      const { v: _v, id: _id, from: _from, ...intent } = question;
      note(`intent:${JSON.stringify(intent)}`);
      return;
    }
  }
}

declare global {
  interface Window {
    owner?: {
      /** A gateway frame reaches every window, as the core sends it. */
      frame: (frame: Omit<ServerFrame, "s"> & { s?: number }) => void;
      /** The list window opens a conversation while this window is open. */
      open: (room: string) => void;
      /** Somebody says something in a room, arriving as a frame. */
      say: (room: string, author: string, body: string) => string;
      /** What the page's server holds for a room, newest last. */
      held: (room: string) => Message[];
      /** Settings changed how conversations open, as the owner tells every window. */
      mode: (mode: "tabs" | "windows") => void;
    };
  }
}

window.owner = {
  frame: (frame) => {
    seq += 1;
    deliver("gateway:frame", { server: SERVER, frame: { ...frame, s: seq } });
  },
  open: (room) => deliver("next:open", { server: SERVER, room }),
  say: (room, author, body) => {
    const message = newMessage(room, author, body);
    window.owner?.frame({ op: "message.create", d: message } as ServerFrame);
    return message.id;
  },
  held: (room) => store[room] ?? [],
  mode: (mode) => deliver("next:mode", { v: 1, mode }),
};

// ---------------------------------------------------------------------------
// The server: the evening's messages, paged the way the real one pages.

/**
 * The evening keeps its photo inline, as a `data:` address, and the window
 * rightly treats only web addresses as whole (lib/url.ts). So this server
 * hands out an address on itself, which the spec serves (`page.route`).
 */
const PHOTO_PATH = "/media/speakers.svg";
const store: Record<string, Message[]> = Object.fromEntries(
  Object.entries(structuredClone(messages)).map(([room, list]) => [
    room,
    list.map((message) => ({
      ...message,
      attachments: message.attachments.map((file) => (file.url.startsWith("data:") ? { ...file, url: PHOTO_PATH } : file)),
    })),
  ]),
);
let serial = 900_000;
function newMessage(room: string, author: string, body: string): Message {
  serial += 1;
  const message: Message = {
    id: `m${String(serial).padStart(6, "0")}`,
    room_id: room,
    author_id: author,
    body,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned_at: null,
    edited_at: null,
    deleted_at: null,
    created_at: Date.now(),
  };
  store[room] = [...(store[room] ?? []), message];
  return message;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function refuse(status: number, code: string, message: string): Response {
  return json({ error: { code, message, retry_after_ms: null } }, status);
}

function page(room: string, params: URLSearchParams): Message[] {
  const all = store[room] ?? [];
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

const PREFIX = `${SERVER}/api/v1`;
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!url.href.startsWith(PREFIX)) return realFetch(input, init);
  const path = url.href.slice(PREFIX.length).split("?")[0] ?? "";
  const method = init?.method ?? "GET";
  const auth = new Headers(init?.headers).get("Authorization") ?? "";
  note(`${method} ${path}${url.search}${auth ? ` as ${auth.replace("Bearer ", "")}` : ""}`);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  await new Promise((settle) => window.setTimeout(settle, 20));
  if (query.has("expired") && auth === "Bearer token-1") return refuse(401, "UNAUTHENTICATED", "Your sign-in ran out.");

  const messagesOf = /^\/rooms\/([^/]+)\/messages$/.exec(path);
  if (messagesOf && method === "GET") return json(page(decodeURIComponent(messagesOf[1] ?? ""), url.searchParams));
  if (messagesOf && method === "POST") {
    if (query.has("fail")) return refuse(503, "UNAVAILABLE", "The server is busy. Try again in a moment.");
    const message = newMessage(decodeURIComponent(messagesOf[1] ?? ""), people.matt.id, String(body.body ?? ""));
    return json(message, 201);
  }
  const one = /^\/messages\/([^/]+)$/.exec(path);
  if (one && method === "PATCH") {
    const id = decodeURIComponent(one[1] ?? "");
    for (const list of Object.values(store)) {
      const at = list.findIndex((message) => message.id === id);
      const found = list[at];
      if (found) {
        const edited = { ...found, body: String(body.body ?? ""), edited_at: Date.now() };
        list[at] = edited;
        return json(edited);
      }
    }
    return refuse(404, "NOT_FOUND", "That message is gone.");
  }
  if (one && method === "DELETE") return new Response(null, { status: 204 });
  if (path === "/knock") {
    return query.has("limit") ? refuse(429, "RATE_LIMITED", "That's three this hour.") : new Response(null, { status: 204 });
  }
  if (path === "/links/preview") {
    const urls = Array.isArray(body.urls) ? body.urls.map(String) : [];
    return json(urls.flatMap((wanted): LinkPreview[] => (previews[wanted] ? [previews[wanted]] : [])));
  }
  return refuse(404, "NOT_FOUND", "Not in this fixture.");
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ChatWindow />
  </StrictMode>,
);
