/**
 * The real chat window (`src/next/app/chat/ChatWindow.tsx`), wired end to end
 * with the desktop shell, the list window and the server all faked in the
 * page (`next/desktop.ts`), so `tests/browser/next-chat-window.spec.ts` can
 * drive the wiring: catching up with the owner, borrowing its sign-in,
 * loading history, sending, reading, tabs, presence and voice intents.
 *
 * Open it at /tests/fixtures/next-chat-window.html?room=r-general. Options:
 * `?fail` refuses every send; `?noowner` has the owner never answer;
 * `?expired` has the server refuse the first lent token, as if it ran out;
 * `?ptt` puts you in voice in #general with push-to-talk on; `?limit`
 * refuses knocks, as the fourth in an hour; `&single=1` is the conversation
 * in a window of its own; `?servers` signs in to the guild too;
 * `?missed=r-listening,…` has the list window hand over rooms it sent
 * before this window was listening; `?many=600` puts that many older
 * messages before the evening in #general; `&message=` opens at one. The photo
 * loads only where something serves
 * `PHOTO_PATH` (the spec does).
 *
 * `window.owner` lets a test act as the owner or the shell; what the window
 * asked for is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "../../src/generated/Message";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { serverState } from "../../src/lib/gateway";
import { ChatWindow } from "../../src/next/app/chat/ChatWindow";
import "../../src/next/styles/app.css";
import { fakeDesktop, type Unnumbered } from "./next/desktop";
import { SERVER, SERVER_NAME, evening, people } from "./next/evening";
import { GUILD, guild, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
if (!query.has("server")) query.set("server", SERVER);
history.replaceState(null, "", `${location.pathname}?${query.toString()}`);

const night = evening(serverState(SERVER));
// Rooms the list window sent before this window was listening (`?missed=`),
// handed over when it asks, once.
let missed = (query.get("missed") ?? "").split(",").filter((room) => room !== "");
const desktop = fakeDesktop({
  label: query.get("single") === "1" ? "chat-5f1e" : "chat",
  query,
  asks: {
    "next:opens": () => {
      const opens = missed.map((roomId) => ({ server: SERVER, roomId }));
      missed = [];
      return { opens };
    },
  },
  others: query.has("servers") ? { [GUILD]: guild(serverState(GUILD)) } : {},
  infos: { [SERVER]: { name: SERVER_NAME, accent: "amber" }, [GUILD]: serverInfo[GUILD] },
  ownerState: {
    ...night,
    // In voice, the server lists your own seat too.
    voice: query.has("ptt")
      ? { ...night.voice, "r-general": [...(night.voice["r-general"] ?? []), { session_id: "s-matt", user_id: people.matt.id, controls: { muted: true, deafened: false } }] }
      : night.voice,
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
});

declare global {
  interface Window {
    owner?: {
      /** A gateway frame reaches every window, as the core sends it. */
      frame: (frame: Unnumbered) => void;
      /** The list window opens a conversation while this window is open, on a server (the main one if left out), at a message if one is named. */
      open: (room: string, server?: string, message?: string) => void;
      /** Somebody says something in a room, arriving as a frame. */
      say: (room: string, author: string, body: string) => string;
      /** What the page's server holds for a room, newest last. */
      held: (room: string) => Message[];
      /** Settings changed how conversations open, as the owner tells every window. */
      mode: (mode: "tabs" | "windows") => void;
      /** With `?noowner`: the list window starts answering. */
      wake: () => void;
      /** The list window says a server was signed out of. */
      signedOut: (server: string) => void;
      /** Somebody picks a message face in their Profile, arriving as a frame. */
      messageFont: (userId: string, key: string | null) => void;
      /** The list window signs in to the guild while this window is open. */
      signInGuild: () => void;
    };
  }
}

window.owner = {
  frame: desktop.frame,
  open: (room, server = SERVER, message) => desktop.deliver("next:open", { server, room, message: message ?? null }),
  say: (room, author, body) => {
    const message = desktop.newMessage(room, author, body);
    desktop.frame({ op: "message.create", d: message } as ServerFrame);
    return message.id;
  },
  held: desktop.held,
  mode: (mode) => desktop.deliver("next:mode", { v: 1, mode }),
  wake: desktop.wake,
  signedOut: (server) => desktop.deliver("next:signedout", { v: 1, server }),
  signInGuild: () => desktop.signIn(GUILD, guild(serverState(GUILD))),
  messageFont: (userId, key) => {
    const user = night.users.find((one) => one.id === userId);
    if (user) desktop.frame({ op: "user.update", d: { ...user, style: { ...user.style, msg_font_key: key } } });
  },
};

// `?many=600`: #general has that many older messages before the evening.
const many = Number(query.get("many") ?? "0");
if (many > 0) desktop.older("r-general", many);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ChatWindow />
  </StrictMode>,
);
