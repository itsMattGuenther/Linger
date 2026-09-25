/**
 * A fake desktop for the new client's real viewer windows (the chat window,
 * Settings): the desktop shell, the list window (the owner) and the server,
 * all in the page, so a Playwright spec can drive the real wiring.
 *
 * - The shell: Tauri's own mocks (`@tauri-apps/api/mocks`), with events
 *   routed here. Events sent to `main` reach the fake owner.
 * - The owner: answers the snapshot and token questions from `ownerState`,
 *   and anything in `asks`; writes down every intent.
 * - The server: `fetch` answers from the evening's messages, plus `routes`.
 *
 * Everything a window asked for is written to `body[data-did]`,
 * `|`-separated, for the spec to read back.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { LinkPreview } from "../../../src/generated/LinkPreview";
import type { Message } from "../../../src/generated/Message";
import type { ServerFrame } from "../../../src/generated/ServerFrame";
import type { GatewayState } from "../../../src/lib/gateway";
import { SERVER, messages, people, previews } from "./evening";

export interface DesktopOptions {
  /** This window's label, as the shell would give it. */
  label: string;
  /** What the owner shares in its snapshot. */
  ownerState: GatewayState;
  query: URLSearchParams;
  /** Questions the owner answers beyond the snapshot and tokens, by event. */
  asks?: Record<string, (question: Record<string, unknown>) => unknown>;
  /** Server routes tried before the shared ones; null to fall through. */
  routes?: (method: string, path: string, url: URL, body: Record<string, unknown>) => Response | null;
  /** Shell commands beyond events, gateway sends and window closing. */
  commands?: Record<string, (args: Record<string, unknown>) => unknown>;
}

export interface Desktop {
  note: (what: string) => void;
  /** Run this page's listeners for an event, as the shell would deliver it. */
  deliver: (event: string, payload: unknown) => void;
  /** A gateway frame, numbered after the owner's snapshot. */
  frame: (frame: Omit<ServerFrame, "s"> & { s?: number }) => void;
  /** A new message on the server, not yet announced. */
  newMessage: (room: string, author: string, body: string) => Message;
  /** What the server holds for a room, newest last. */
  held: (room: string) => Message[];
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function refuse(status: number, code: string, message: string): Response {
  return json({ error: { code, message, retry_after_ms: null } }, status);
}

/**
 * The evening keeps its photo inline, as a `data:` address, and a window
 * rightly treats only web addresses as whole (lib/url.ts). So this server
 * hands out an address on itself, which a spec serves (`page.route`).
 */
export const PHOTO_PATH = "/media/speakers.svg";

export function fakeDesktop({ label, ownerState, query, asks = {}, routes, commands = {} }: DesktopOptions): Desktop {
  const did: string[] = [];
  const note = (what: string) => {
    did.push(what);
    document.body.dataset.did = did.join("|");
  };

  // --- the shell ---------------------------------------------------------
  const listeners = new Map<string, number[]>();
  interface Internals {
    runCallback: (id: number, data: unknown) => void;
  }
  const deliver = (event: string, payload: unknown) => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    for (const id of listeners.get(event) ?? []) internals.runCallback(id, { event, id, payload });
  };

  (window as unknown as { isTauri: boolean }).isTauri = true;
  mockWindows(label, "main");
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
      default: {
        const command = commands[cmd];
        return command ? command(a) : null;
      }
    }
  });

  // --- the owner ---------------------------------------------------------
  const EPOCH = "s-evening";
  let seq = 100;
  const shared = { ...ownerState, sessionId: EPOCH };
  let tokens = 1;

  function ownerHears(event: string, payload: unknown): void {
    const question = payload as { v: number; id: string; from: string } & Record<string, unknown>;
    const reply = (answer: unknown) =>
      window.setTimeout(() => deliver(`${event}:answer`, { v: 1, id: question.id, from: "main", answer }), 5);
    switch (event) {
      case "next:snapshot":
        if (query.has("noowner")) return;
        reply({
          servers: [{ server: SERVER, state: shared, position: { epoch: EPOCH, seq }, lent: { token: `token-${tokens}`, expiresAt: Date.now() + 3_600_000 } }],
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
      default: {
        const answer = asks[event];
        if (!answer) return;
        const { v: _v, id: _id, from: _from, ...asked } = question;
        note(`ask:${event}:${JSON.stringify(asked)}`);
        reply(answer(asked));
      }
    }
  }

  // --- the server --------------------------------------------------------
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
  const newMessage = (room: string, author: string, body: string): Message => {
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
  };

  const page = (room: string, params: URLSearchParams): Message[] => {
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
  };

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

    const own = routes?.(method, path, url, body);
    if (own) return own;

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

  return {
    note,
    deliver,
    frame: (frame) => {
      seq += 1;
      deliver("gateway:frame", { server: SERVER, frame: { ...frame, s: seq } });
    },
    newMessage,
    held: (room) => store[room] ?? [],
  };
}
