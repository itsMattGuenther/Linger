/**
 * The real chat window (`src/next/app/chat/ChatWindow.tsx`): a conversation
 * in a window of its own, popped out of the tabs beside the list (#337),
 * wired end to end with the desktop shell, the list window and the server
 * all faked in the page (`next/desktop.ts`), so
 * `tests/browser/next-chat-window.spec.ts` can drive the wiring: catching up
 * with the owner, borrowing its sign-in, loading history, sending, reading,
 * presence and voice intents. The tabs beside the list are the list
 * window's (`next-list-window.tsx`, `next-side.spec.ts`).
 *
 * Open it at /tests/fixtures/next-chat-window.html?room=r-general. Options:
 * `?fail` refuses every send; `?noowner` has the owner never answer;
 * `?expired` has the server refuse the first lent token, as if it ran out;
 * `?ptt` puts you in voice in #general with push-to-talk on; `?limit`
 * refuses knocks, as the fourth in an hour; `?servers` signs in to the
 * guild too; `?as=eli` is Eli's window, not yours, to see how the room shows
 * you; `?many=600` puts that many older
 * messages before the evening in #general; `&message=` opens at one. The photo
 * loads only where something serves
 * `PHOTO_PATH` (the spec does). Mute, Deafen and Leave are made by the list
 * window, which answers with their sound (#241): `?hold` keeps each change
 * waiting until `window.owner.finish()`, and `?refuse` has it fail.
 *
 * `window.owner` lets a test act as the owner or the shell; what the window
 * asked for is written to `body[data-did]`, `|`-separated, every sound it
 * played as `sound:<cue>` (`next/audio.ts`), and how many times React has
 * drawn it in `window.commits` (`next/commits.tsx`).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "../../src/generated/Message";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { type MyVoice, serverState } from "../../src/lib/gateway";
import { controlCue } from "../../src/lib/sound-events";
import { ChatWindow } from "../../src/next/app/chat/ChatWindow";
import "../../src/next/styles/app.css";
import { hearSounds } from "./next/audio";
import { Counted } from "./next/commits";
import { fakeDesktop, type Unnumbered } from "./next/desktop";
import { SERVER, SERVER_NAME, evening, people } from "./next/evening";
import { GUILD, guild, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
if (!query.has("server")) query.set("server", SERVER);
history.replaceState(null, "", `${location.pathname}?${query.toString()}`);

const night = evening(serverState(SERVER));
// Your voice seat, as the list window shares it (`?ptt`, `?talking`).
const seat =
  query.has("ptt") || query.has("talking")
    ? {
        roomId: "r-general",
        muted: false,
        deafened: false,
        mutedBeforeDeafen: false,
        pushToTalk: query.has("ptt"),
        talkHeld: false,
        moved: false,
        audio: "sending" as const,
        refused: null,
        peers: {},
        speaking: {},
        talking: query.has("talking"),
        volumes: {},
      }
    : null;
const desktop = fakeDesktop({
  label: "chat-5f1e",
  query,
  asks: {
    "next:voicecontrol": (question) => voiceControl(question),
  },
  others: query.has("servers") ? { [GUILD]: guild(serverState(GUILD)) } : {},
  // `?novoice`: the main server says it carries no voice (#306).
  infos: { [SERVER]: { name: SERVER_NAME, accent: "amber", ...(query.has("novoice") ? { voice: false } : {}) }, [GUILD]: serverInfo[GUILD] },
  ownerState: {
    ...night,
    ...(query.get("as") === "eli" ? { me: people.eli } : {}),
    // In voice, the server lists your own seat too.
    // `?ptt`: in voice in #general with push-to-talk, the key up: the
    // microphone closed, but not muted, so the server lists you as on (#232).
    // `?talking`: in voice there with an open microphone, and talking.
    voice:
      query.has("ptt") || query.has("talking")
        ? {
            ...night.voice,
            "r-general": [...(night.voice["r-general"] ?? []), { session_id: "s-matt", user_id: people.matt.id, controls: { muted: false, deafened: false } }],
          }
        : night.voice,
    myVoice: seat,
  },
});

hearSounds(desktop.note);

// The list window's half of Mute, Deafen and Leave (VOICE_CONTROL in
// core/share.ts): it makes the change, tells every window the new seat, and
// only then answers with the sound that confirms it. `?hold` keeps the
// change waiting until the test finishes it; `?refuse` has it fail, as a
// change the voice engine refused.
let finishing: (() => void)[] = [];
async function voiceControl(question: Record<string, unknown>): Promise<{ cue: string | null }> {
  if (query.has("hold")) await new Promise<void>((finish) => finishing.push(finish));
  if (query.has("refuse")) throw new Error("Couldn't change voice controls. Voice was disconnected; join again to retry.");
  const state = serverState(SERVER);
  const mine = state.myVoice;
  if (mine === null) return { cue: null };
  const on = question.on === true;
  let next: MyVoice | null = mine;
  if (question.control === "leave") next = null;
  else if (question.control === "mute" && !mine.deafened) next = { ...mine, muted: on };
  else if (question.control === "deafen" && mine.deafened !== on)
    next = { ...mine, deafened: on, muted: on || mine.mutedBeforeDeafen, mutedBeforeDeafen: on ? mine.muted : mine.mutedBeforeDeafen, talkHeld: false };
  const { read, readLoaded, notifyRules } = state;
  desktop.deliver("next:shared", { v: 1, server: SERVER, shared: { myVoice: next, read, readLoaded, notifyRules } });
  return { cue: next === null ? "voice-leave" : controlCue(mine, next) };
}

declare global {
  interface Window {
    owner?: {
      /** A gateway frame reaches every window, as the core sends it. */
      frame: (frame: Unnumbered) => void;
      /** The list window brings this window forward on its conversation, on a server (the main one if left out), at a message if one is named. */
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
      /** Settings turned push-to-talk on or off mid-call, as the list window tells every window (#231). */
      pushToTalk: (on: boolean) => void;
      /** With `?hold`: the list window finishes the Mute, Deafen or Leave it's making. */
      finish: () => void;
      /** Starting voice in a room failed in the list window, which shares why and the devices it asked for (#261, #273). */
      voiceFailed: (roomId: string, problem: string, devices: { input: string | null; output: string | null }) => void;
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
  pushToTalk: (on) =>
    desktop.deliver("next:shared", { v: 1, server: SERVER, shared: { myVoice: seat && { ...seat, pushToTalk: on }, read: night.read, readLoaded: true, notifyRules: [] } }),
  finish: () => {
    const waiting = finishing;
    finishing = [];
    for (const finish of waiting) finish();
  },
  voiceFailed: (roomId, problem, devices) => {
    const { myVoice, read, readLoaded, notifyRules } = serverState(SERVER);
    desktop.deliver("next:shared", { v: 1, server: SERVER, shared: { myVoice, voiceFailed: { roomId, problem, devices }, read, readLoaded, notifyRules } });
  },
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
    <Counted>
      <ChatWindow />
    </Counted>
  </StrictMode>,
);
