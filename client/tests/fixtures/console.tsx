/** Synthetic people and local responses; the production frame, stream and controls. */
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { Console } from "../../src/App";
import type { User } from "../../src/generated/User";
import type { Room } from "../../src/generated/Room";
import type { Message } from "../../src/generated/Message";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import { AuthedApi } from "../../src/lib/api";
import "../../src/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/generated/palette.generated.css";
import "../../src/styles/base.css";
import "../../src/styles/names.css";

const baseUrl = "https://console.example";
const query = new URLSearchParams(location.search);
const me: User = {
  id: "matt",
  username: "matt",
  display_name: "Matt",
  is_host: !query.has("member"),
  style: {
    font_key: "geist-sans",
    weight: 500,
    italic: false,
    fill: { kind: "solid", color: "azure" },
    effect: "none",
    msg_font_key: null,
  },
  entrance_sound: null,
  last_seen_at: null,
  status: null,
};
const users: User[] = [
  me,
  {
    ...me,
    id: "jules",
    username: "jules",
    display_name: "Jules",
    is_host: false,
    style: { ...me.style, fill: { kind: "solid", color: "mint" } },
    status: {
      line: "A little time away from the screen.",
      reading: "The Creative Act",
      listening: "Khruangbin",
      working_on: null,
      image_id: null,
      image_url: null,
      away_message: null,
      away_since: null,
    },
  },
  {
    ...me,
    id: "eli",
    username: "eli",
    display_name: "Eli",
    is_host: false,
    style: { ...me.style, fill: { kind: "solid", color: "amber" } },
  },
  {
    ...me,
    id: "sam",
    username: "sam",
    display_name: "Sam",
    is_host: false,
    style: { ...me.style, fill: { kind: "solid", color: "rose" } },
    last_seen_at: Date.now() - 3_600_000,
  },
];
const rooms: Room[] = ["general", "listening-room", "weekend-plans"].map(
  (slug, position) => ({
    id: slug,
    slug,
    name: slug,
    kind: "room",
    topic: position === 0 ? "Good company. No hurry." : null,
    position,
    archived_at: null,
    last_message_id: null,
    member_ids: null,
  }),
);
const bodies = [
  [
    "jules",
    "Anyone around for a little while? Finally got the speakers set up.",
  ],
  ["matt", "I'm here. Just making coffee — be with you in a minute."],
  ["eli", "Perfect timing. What are we listening to?"],
  [
    "jules",
    "A bit of Khruangbin. Feels like a good afternoon to leave the windows open.",
  ],
  [
    "matt",
    "This is exactly what I wanted this place to feel like. Somewhere to drop in, catch up, and stay a little longer.",
  ],
  ["eli", "No plans, no agenda. I can get behind that."],
  [
    "jules",
    "Also, Saturday walk? The trail by the river should be lovely this week.",
  ],
  [
    "matt",
    "Count me in. Let's put the details in **weekend-plans** when we know.",
  ],
];
const messages: Message[] = (
  query.has("history")
    ? Array.from({ length: 10_000 }, (_, index) => [
        "jules",
        `History sample ${index}. A conversation with enough words to wrap when the side panels get wider.`,
      ])
    : bodies
).map(([author, body], index, all) => ({
  id: `message-${String(index).padStart(5, "0")}`,
  room_id: "general",
  author_id: author ?? "matt",
  body: body ?? "",
  reply_to: null,
  attachments: [],
  reactions:
    index === 5
      ? [{ key: "heart", count: 2, user_ids: ["jules", "matt"] }]
      : [],
  pinned_at: null,
  edited_at: null,
  deleted_at: null,
  created_at: Date.now() - (all.length - index) * 180_000,
}));
const server = {
  name: "The Good Company",
  accent_key: null,
  icon_key: null,
  member_count: users.length,
  created_at: Date.now(),
  storage_used_bytes: 128_000_000,
  storage_limit_bytes: 10_000_000_000,
  file_expiry_days: 90,
};
const frame = (value: ServerFrame) =>
  emit("gateway:frame", { server: baseUrl, frame: value });
Object.defineProperty(globalThis, "isTauri", { value: true });
mockIPC(
  async (cmd) => {
    if (cmd === "voice_join") {
      window.setTimeout(() => {
        void emit("voice:audio", { server: baseUrl, state: "sending" });
        void frame({
          op: "voice.state",
          s: 4,
          d: {
            room_id: "general",
            peers: [
              {
                session_id: "mine",
                user_id: "matt",
                controls: { muted: false, deafened: false },
              },
              {
                session_id: "jules-voice",
                user_id: "jules",
                controls: { muted: false, deafened: false },
              },
              {
                session_id: "eli-voice",
                user_id: "eli",
                controls: { muted: true, deafened: false },
              },
            ],
          },
        });
      }, 20);
    }
    if (cmd === "gateway_connect") {
      window.setTimeout(
        () =>
          void (async () => {
            await emit("gateway:status", {
              server: baseUrl,
              status: { kind: "ready", latency_ms: 28 },
            });
            await frame({
              op: "ready",
              s: 1,
              d: {
                session_id: "mine",
                user: me,
                users,
                rooms,
                dms: [],
                presence: users.slice(0, 3).map((user) => ({
                  user_id: user.id,
                  state: "in_room",
                  room_id: "general",
                  away_message: null,
                })),
              },
            });
            await frame({
              op: "room.occupancy",
              s: 2,
              d: { room_id: "general", user_ids: ["matt", "jules", "eli"] },
            });
            await frame({
              op: "voice.state",
              s: 3,
              d: {
                room_id: "general",
                peers: [
                  {
                    session_id: "jules-voice",
                    user_id: "jules",
                    controls: { muted: false, deafened: false },
                  },
                  {
                    session_id: "eli-voice",
                    user_id: "eli",
                    controls: { muted: true, deafened: false },
                  },
                ],
              },
            });
          })(),
        30,
      );
    }
    if (cmd === "voice_devices")
      return {
        inputs: [],
        outputs: [],
        default_input: null,
        default_output: null,
      };
    if (cmd === "check_for_update") return { kind: "current" };
    return true;
  },
  { shouldMockEvents: true },
);
// Fetch remains the real API's boundary: no casts replacing its generic wire methods.
globalThis.fetch = async (input) => {
  // A network response arrives on a later task, not between scroll event
  // listeners. An already-resolved mock can re-render before the virtualizer
  // even observes the scroll that requested this page.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const url = new URL(String(input));
  let answer: unknown = [];
  if (url.pathname.endsWith("/server")) answer = server;
  else if (url.pathname.endsWith("/read")) answer = {};
  else if (url.pathname.includes("/messages")) {
    const before = url.searchParams.get("before");
    answer = url.pathname.includes("/general/")
      ? messages
          .filter((message) => before === null || message.id < before)
          .slice(-100)
          .reverse()
      : [];
  } else if (url.pathname.endsWith("/voice/ice"))
    answer = { servers: [], ttl_secs: 0 };
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const api = new AuthedApi(
  baseUrl,
  {
    accessToken: "fixture",
    refreshToken: "fixture",
    expiresAt: Date.now() + 3_600_000,
  },
  { onTokens: () => {}, onSignedOut: () => {} },
);
const root = document.getElementById("root");
if (!root) throw new Error("missing fixture root");
createRoot(root).render(
  <Console
    servers={[{ baseUrl, api, user: me }]}
    keyringNotice={null}
    onSignOut={async () => {}}
    onAddServer={async () => {}}
  />,
);
