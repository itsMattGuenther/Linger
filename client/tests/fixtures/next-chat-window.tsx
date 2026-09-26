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
 * before this window was listening. The photo
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
import { fakeDesktop } from "./next/desktop";
import { SERVER, SERVER_NAME, evening } from "./next/evening";
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
      frame: (frame: Omit<ServerFrame, "s"> & { s?: number }) => void;
      /** The list window opens a conversation while this window is open, on a server (the main one if left out). */
      open: (room: string, server?: string) => void;
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
    };
  }
}

window.owner = {
  frame: desktop.frame,
  open: (room, server = SERVER) => desktop.deliver("next:open", { server, room }),
  say: (room, author, body) => {
    const message = desktop.newMessage(room, author, body);
    desktop.frame({ op: "message.create", d: message } as ServerFrame);
    return message.id;
  },
  held: desktop.held,
  mode: (mode) => desktop.deliver("next:mode", { v: 1, mode }),
  wake: desktop.wake,
  signedOut: (server) => desktop.deliver("next:signedout", { v: 1, server }),
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <ChatWindow />
  </StrictMode>,
);
