/**
 * The real chat window (`src/next/app/chat/ChatWindow.tsx`) on the same fake
 * desktop as `next-chat-window.tsx` (`next/desktop.ts`), with the server
 * doing more: files going up, older history to page through, and refusals.
 * For `tests/browser/next-chat-parity.spec.ts`, which proves the
 * conversation's items in `docs/design/parity.md`.
 *
 * Open it at /tests/fixtures/next-chat-parity.html?room=r-general. Options:
 * - `?many=1200`: #general has that many older messages before the evening,
 *   for paging back and letting go.
 * - `?ptt`: you're in voice in #general, with push-to-talk on.
 * - `?refuse`: every edit and delete is refused, in the server's words.
 * - `?hang`: a send is never answered; `?offline`: a send can't reach the server.
 * - `?uploadrefuse`: the server refuses every file before it goes up.
 * - `?holdparts`: a file's bytes wait at the file store until
 *   `window.parity.release()`, so it shows as going up.
 * - `?flakystore`: the file store refuses each part the first time it's sent.
 *
 * Files go up as the real server has them: a slot (`POST /uploads`), the
 * bytes to the store (`PUT /api/v1/store/…`), then `complete`. A send that
 * names finished files carries them on the message. `window.parity` lets a
 * test act as the owner and the server; what the window asked for is in
 * `body[data-did]`, `|`-separated (`sent:` is a send's JSON, `open:` a link
 * or file handed to the browser).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Attachment } from "../../src/generated/Attachment";
import type { Message } from "../../src/generated/Message";
import { serverState } from "../../src/lib/gateway";
import { ChatWindow } from "../../src/next/app/chat/ChatWindow";
import "../../src/next/styles/app.css";
import { fakeDesktop, json, refuse, type Unnumbered } from "./next/desktop";
import { people, SERVER, SERVER_NAME, evening } from "./next/evening";

const query = new URLSearchParams(location.search);
if (!query.has("server")) query.set("server", SERVER);
history.replaceState(null, "", `${location.pathname}?${query.toString()}`);

const night = evening(serverState(SERVER));

// Files that finished going up, by attachment id, for the message that carries them.
const finished = new Map<string, Attachment>();
const slots = new Map<string, { filename: string; mime: string; size: number }>();
let uploads = 0;
let release: () => void = () => undefined;
const parts = new Promise<void>((settle) => {
  release = settle;
});
/** A request nobody answers, which lets go when the caller gives up on it, as a real one does. */
function unanswered(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("The request was given up on.", "AbortError")), { once: true });
  });
}

const desktop = fakeDesktop({
  label: "chat",
  query,
  infos: { [SERVER]: { name: SERVER_NAME, accent: "amber" } },
  ownerState: {
    ...night,
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
  },
  commands: {
    "plugin:opener|open_url": (args) => desktop.note(`open:${String(args.url)}`),
  },
  routes: (method, path, _url, body) => {
    if (path === "/uploads" && method === "POST") {
      if (query.has("uploadrefuse")) return refuse(413, "PAYLOAD_TOO_LARGE", "That file is bigger than this server takes.");
      uploads += 1;
      // One identifier for both (PROTOCOL §6): an upload is an attachment that isn't finished.
      const id = `f-${uploads}`;
      slots.set(id, { filename: String(body.filename), mime: String(body.mime), size: Number(body.size_bytes) });
      return json({
        upload_id: id,
        attachment_id: id,
        method: "PUT",
        url: `/api/v1/store/${id}/1`,
        headers: {},
        part_size_bytes: 5 * 1024 * 1024,
        parts: null,
      });
    }
    const complete = /^\/uploads\/([^/]+)\/complete$/.exec(path);
    if (complete && method === "POST") {
      const id = decodeURIComponent(complete[1] ?? "");
      const slot = slots.get(id);
      if (!slot) return refuse(404, "NOT_FOUND", "That upload is gone.");
      const attachment: Attachment = {
        id,
        filename: slot.filename,
        mime: slot.mime,
        size_bytes: slot.size,
        url: `/media/${id}`,
        width: null,
        height: null,
        duration_ms: null,
        blurhash: null,
        poster_url: null,
        starred_at: null,
        uploader_id: people.matt.id,
        created_at: Date.now(),
      };
      finished.set(attachment.id, attachment);
      return json(attachment);
    }
    if (/^\/uploads\/[^/]+$/.test(path) && method === "DELETE") return new Response(null, { status: 204 });
    const messagesOf = /^\/rooms\/([^/]+)\/messages$/.exec(path);
    if (messagesOf && method === "POST") {
      desktop.note(`sent:${JSON.stringify(body)}`);
      const ids = Array.isArray(body.attachment_ids) ? body.attachment_ids.map(String) : [];
      if (ids.length === 0) return null;
      const files = ids.flatMap((id) => {
        const file = finished.get(id);
        return file ? [file] : [];
      });
      const message = desktop.newMessage(decodeURIComponent(messagesOf[1] ?? ""), people.matt.id, String(body.body ?? ""), { attachments: files });
      return json(message, 201);
    }
    const one = /^\/messages\/[^/]+$/.exec(path);
    if (one && (method === "PATCH" || method === "DELETE") && query.has("refuse")) {
      return refuse(403, "FORBIDDEN", "The host has locked this room's history.");
    }
    return null;
  },
});

// The store's bytes and a send that never comes back sit outside `routes`,
// which can't wait: they're answered here, before the fake server sees them.
const fakeFetch = window.fetch;
const refusedOnce = new Set<string>();
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  if (url.origin === SERVER && url.pathname.startsWith("/api/v1/store/") && method === "PUT") {
    desktop.note(`PUT ${url.pathname.slice("/api/v1".length)}`);
    if (query.has("holdparts")) await parts;
    if (query.has("flakystore") && !refusedOnce.has(url.pathname)) {
      refusedOnce.add(url.pathname);
      return new Response("the store hiccuped", { status: 500 });
    }
    return new Response(null, { status: 200, headers: { ETag: `"etag-${url.pathname.split("/").at(-2) ?? ""}"` } });
  }
  if (query.has("offline") && url.origin === SERVER && /\/rooms\/[^/]+\/messages$/.test(url.pathname) && method === "POST") {
    throw new TypeError("Failed to fetch");
  }
  if (query.has("hang") && url.origin === SERVER && /\/rooms\/[^/]+\/messages$/.test(url.pathname) && method === "POST") {
    desktop.note(`sent:${typeof init?.body === "string" ? init.body : ""}`);
    return unanswered(init?.signal);
  }
  return fakeFetch(input, init);
};

const many = Number(query.get("many") ?? "0");
if (many > 0) desktop.older("r-general", many);

declare global {
  interface Window {
    parity?: {
      /** A gateway frame reaches the window, as the core sends it. */
      frame: (frame: Unnumbered) => void;
      /** Somebody says something in a room, with anything else on the message, arriving as a frame. */
      post: (room: string, author: string, body: string, extra?: Partial<Message>) => string;
      /** With `?holdparts`: the file store takes the bytes. */
      release: () => void;
      /** The list window opens a conversation while this window is open. */
      open: (room: string) => void;
    };
  }
}

window.parity = {
  frame: desktop.frame,
  post: (room, author, body, extra) => {
    const message = desktop.newMessage(room, author, body, extra);
    desktop.frame({ op: "message.create", d: message });
    return message.id;
  },
  release: () => release(),
  open: (room) => desktop.deliver("next:open", { server: SERVER, room }),
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ChatWindow />
  </StrictMode>,
);
