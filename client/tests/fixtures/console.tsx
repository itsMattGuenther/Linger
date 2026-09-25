/** Synthetic people and local responses; the production frame, stream and controls. */
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { Console } from "../../src/App";
import type { User } from "../../src/generated/User";
import type { Room } from "../../src/generated/Room";
import type { CreateMessageRequest } from "../../src/generated/CreateMessageRequest";
import type { Message } from "../../src/generated/Message";
import type { SearchHit } from "../../src/generated/SearchHit";
import type { ServerFrame } from "../../src/generated/ServerFrame";
import type { UpdateMeRequest } from "../../src/generated/UpdateMeRequest";
import type { LinkPreview } from "../../src/generated/LinkPreview";
import type { LinkPreviewRequest } from "../../src/generated/LinkPreviewRequest";
import { sharedFiles, sharedMedia } from "./delight-data";
import { AuthedApi } from "../../src/lib/api";
import "../../src/fonts/fonts.css";
import "../../src/styles/tokens.css";
import "../../src/generated/palette.generated.css";
import "../../src/styles/base.css";
import "../../src/styles/names.css";

const baseUrl = "https://console.example";
const query = new URLSearchParams(location.search);
// A single unbroken word with no spaces to break on, for the rail-overflow
// regressions (#83, #100): real room, server and display names can be this
// long, and the layout has to wrap them without help from whitespace.
const longWord =
  "reallyreallyreallyreallyreallyreallyreallyreallylongunbrokenname";
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
if (query.has("longnames"))
  users.push({
    ...me,
    id: "long-name",
    username: "long_name",
    display_name: longWord,
    is_host: false,
  });
if (query.has("qa")) {
  me.display_name = "Matt with a longer display name";
  me.style = { ...me.style, font_key: "geist-mono", msg_font_key: "jetbrains-mono" };
  for (const user of users) {
    if (user.id === "jules") user.style = { ...user.style, msg_font_key: "newsreader" };
    if (user.id === "eli") user.style = { ...user.style, msg_font_key: "ibm-plex-sans" };
  }
}
const rooms: Room[] = query.has("emptyrail")
  ? []
  : ["general", "listening-room", "weekend-plans"].map(
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
if (query.has("longnames"))
  rooms.push({
    id: "longroom",
    slug: longWord,
    name: longWord,
    kind: "room",
    topic: null,
    position: rooms.length,
    archived_at: null,
    last_message_id: null,
    member_ids: null,
  });
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
if (query.has("qa")) bodies.push([
  "matt",
  "A grouped continuation with enough text to wrap. Inline `code` keeps its own font.",
]);
if (query.has("spacing")) bodies.splice(0, bodies.length,
  ["jules", "First line\nSecond line\nThird line\n\nA separate paragraph."],
  ["jules", "Another message from the same person."],
  ["matt", "A different sender.\nStill easy to read."],
  ["matt", "> A quoted line\n> Another quoted line\n\n- First item\n- Second item\n\n```\nfirst code line\nsecond code line\n```"],
  ["matt", "Short follow-up."],
  ["matt", "Another short line."],
);
// A link and its card, for the #139 hover checks.
if (query.has("hovering")) bodies.push([
  "jules",
  "The trail map is up at https://trails.example/river if anybody wants it.",
]);
const spacingDm: Room = {
  id: "spacing-dm", slug: "spacing-dm", name: "spacing-dm", topic: null,
  kind: "dm", member_ids: ["matt", "jules"], position: 0,
  archived_at: null, last_message_id: null,
};
const longNameDm: Room = {
  id: "long-name-dm", slug: "long-name-dm", name: "long-name-dm", topic: null,
  kind: "dm", member_ids: ["matt", "long-name"], position: 0,
  archived_at: null, last_message_id: null,
};
const messages: Message[] = (
  (query.has("history") || query.has("catchup"))
    ? Array.from({ length: query.has("catchup") ? 300 : 10_000 }, (_, index) => [
        "jules",
        `History sample ${index}. A conversation with enough words to wrap when the side panels get wider.`,
      ])
    : bodies
).map(([author, body], index, all) => ({
  id: `message-${String(index).padStart(5, "0")}`,
  room_id: "general",
  author_id: author ?? "matt",
  body: body ?? "",
  reply_to: query.has("qa") && index === all.length - 1 ? "message-00007" : null,
  attachments:
    query.has("delight") && index === 4 ? sharedFiles.slice(0, 1) : [],
  // The server still stores and sends reactions; the app draws none of them
  // during the trial (#168). This one is here so a test can prove that.
  reactions:
    index === 5 && !query.has("spacing")
      ? [{ key: "heart", count: 2, user_ids: ["jules", "matt"] }]
      : [],
  pinned_at: null,
  edited_at: null,
  deleted_at: null,
  created_at: Date.now() - (all.length - index) * 180_000,
}));
if (query.has("hovering")) {
  messages[3]!.edited_at = messages[3]!.created_at + 60_000;
  messages[6]!.attachments = [{
    ...sharedFiles[0]!, id: "trail-notes", filename: "trail-notes.pdf",
    mime: "application/pdf", width: null, height: null,
  }];
}
if (query.has("catchup")) {
  rooms[0]!.last_message_id = messages.at(-1)!.id;
  spacingDm.last_message_id = messages.at(-1)!.id;
}
if (query.has("replies")) {
  messages[2]!.reply_to = messages[0]!.id;
  messages[3]!.author_id = messages[2]!.author_id;
  messages[3]!.reply_to = messages[0]!.id;
  messages[4]!.reply_to = messages[2]!.id;
}
const server = {
  name: query.has("longnames") ? longWord : "The Good Company",
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
// A counter, not `Date.now()`: two sends held and released close together in
// a test can land in the same millisecond, and real ids (UUIDv7) never tie.
let sentSeq = 0;
// Which sends are currently held, one entry per send so two of the same text
// held at once are still two entries. Mirrored onto `data-sends-held` so a
// test can wait for a send to actually be held before releasing it — see the
// POST handler below.
const heldSends: string[] = [];
// Settles once the server's answer to a join has gone out. Your own seat is
// drawn the moment you click Join (#141), so a test cannot see this from the
// page; `fixture-voice-alone` waits on it instead, or the join's full list of
// peers can land after it and put everybody back.
let joinFrameSent: Promise<void> = Promise.resolve();
const publishHeldSends = (): void => {
  document.documentElement.dataset.sendsHeld = JSON.stringify(heldSends);
};
Object.defineProperty(globalThis, "isTauri", { value: true });
mockIPC(
  async (cmd, args) => {
    if (cmd === "voice_controls") {
      if (document.documentElement.dataset.refuse === "yes")
        throw new Error("fixture refusal");
      if (!args || !("controls" in args))
        throw new Error("missing fixture controls");
      document.documentElement.dataset.controls = JSON.stringify(args.controls);
    }
    if (cmd === "voice_leave") document.documentElement.dataset.left = "yes";
    // Leaving the slow way too: the server stops listing you 250 ms later.
    if (cmd === "voice_leave" && query.has("slowjoin"))
      window.setTimeout(() => void frame({ op: "voice.state", d: { room_id: "general", peers: [] } }), 250);
    // `?slowjoin` joins the way a real client does (#141, #142): nobody is in
    // voice beforehand, the server lists you at 250 ms, the microphone
    // finishes opening at 500 ms, and each lands as its own update.
    if (cmd === "voice_join" && query.has("slowjoin")) {
      window.setTimeout(() => void frame({
        op: "voice.state",
        d: {
          room_id: "general",
          peers: [{ session_id: "mine", user_id: "matt", controls: { muted: false, deafened: false } }],
        },
      }), 250);
      window.setTimeout(() => void emit("voice:audio", { server: baseUrl, state: "sending" }), 500);
      await new Promise((done) => window.setTimeout(done, 400));
      return true;
    }
    if (cmd === "voice_join") {
      let sent = (): void => {};
      joinFrameSent = new Promise((resolve) => { sent = resolve; });
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
        }).then(sent);
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
                dms: (query.has("spacing") || query.has("catchup") || query.has("sending"))
                  ? [spacingDm]
                  : query.has("longnames")
                    ? [longNameDm]
                    : [],
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
                peers: query.has("slowjoin") ? [] : [
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
            // `?dmhere`: somebody is in the DM too, so its rail row draws
            // the occupancy dots a room row does (#164).
            if (query.has("dmhere")) {
              await frame({
                op: "room.occupancy",
                s: 10,
                d: { room_id: spacingDm.id, user_ids: ["jules"] },
              });
            }
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
    // `?update` has a newer version waiting, with the long release body the
    // updater really hands over, so a test can see it is not reprinted (#174).
    if (cmd === "update_check")
      return query.has("update")
        ? { kind: "ready", version: "0.3.5", notes: "# Linger 0.3.5\n\n## Messaging\n\n- A very long list of changes" }
        : { kind: "current" };
    if (cmd === "app_version") return "0.3.4";
    if (cmd === "plugin:opener|open_url" && args && "url" in args && typeof args.url === "string")
      document.documentElement.dataset.openedUrl = args.url;
    return true;
  },
  { shouldMockEvents: true },
);
// Fetch remains the real API's boundary: no casts replacing its generic wire methods.
globalThis.fetch = async (input, init) => {
  // A network response arrives on a later task, not between scroll event
  // listeners. An already-resolved mock can re-render before the virtualizer
  // even observes the scroll that requested this page.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const url = new URL(String(input));
  let answer: unknown = [];
  if (
    init?.method &&
    ["PUT", "DELETE", "PATCH"].includes(init.method) &&
    !url.pathname.endsWith("/read")
  ) {
    document.documentElement.dataset.writeRequests = String(
      Number(document.documentElement.dataset.writeRequests ?? "0") + 1,
    );
    if (document.documentElement.dataset.holdWrites === "yes") {
      await new Promise<void>((resolve) => {
        document.addEventListener("finish-write", () => resolve(), {
          once: true,
        });
        document.documentElement.dataset.writePending = "yes";
      });
      delete document.documentElement.dataset.writePending;
    }
    if (document.documentElement.dataset.refuseWrites === "yes") {
      return new Response(
        JSON.stringify({
          error: { code: "FORBIDDEN", message: "This change was refused." },
        }),
        { status: 403 },
      );
    }
    if (url.pathname.endsWith("/me")) {
      const patch: UpdateMeRequest = JSON.parse(String(init.body));
      const next: User = {
        ...me,
        style: patch.style ?? me.style,
        status: patch.status ?? me.status,
        display_name: patch.display_name ?? me.display_name,
      };
      Object.assign(me, next);
      return new Response(JSON.stringify(next));
    }
    return new Response(null, { status: 204 });
  }
  if (url.pathname.endsWith("/server")) answer = server;
  else if (url.pathname.endsWith("/search") && query.has("catchup")) {
    const target = messages[180]!;
    const hits: SearchHit[] = [{ message_id: target.id, room_id: "general", author_id: target.author_id,
      created_at: target.created_at, cursor: target.id, snippet: [{ text: "History sample 180", matched: true }], matched_filenames: [] }];
    answer = hits;
  }
  else if (url.pathname.endsWith("/media"))
    answer =
      query.has("delight") && !url.searchParams.has("before")
        ? sharedMedia.filter(
            (item) =>
              !url.searchParams.has("kind") ||
              item.kind === url.searchParams.get("kind"),
          )
        : [];
  else if (url.pathname.endsWith("/links/preview")) {
    const asked: LinkPreviewRequest = JSON.parse(String(init?.body));
    const previews: LinkPreview[] = asked.urls.map((link) => ({
      url: link, domain: new URL(link).hostname, title: "River trail map", icon: null,
    }));
    answer = previews;
  }
  else if (url.pathname.endsWith("/read")) {
    if (init?.method === "PUT") {
      document.documentElement.dataset.readMarker = String(init.body);
      return new Response(null, { status: 204 });
    }
    if (query.has("catchup")) await new Promise((resolve) => setTimeout(resolve, 150));
    answer = query.has("catchup") ? { general: "message-00040", "spacing-dm": "message-00080" } : {};
  }
  else if (url.pathname.includes("/messages")) {
    const roomId = url.pathname.includes("/spacing-dm/") ? spacingDm.id : "general";
    if (init?.method === "POST") {
      const posted: CreateMessageRequest = JSON.parse(String(init.body));
      document.documentElement.dataset.lastSent = JSON.stringify(posted);
      if (document.documentElement.dataset.holdSend === "yes") {
        // Several sends can be held at once now that sending is optimistic
        // (#128). Recorded here — not just awaited — so a test can wait for a
        // send to actually be held before releasing it: firing "finish-send"
        // before this send has reached its own listener would be released
        // into nothing, since a `{once: true}` listener that misses its event
        // never gets another chance at it.
        heldSends.push(posted.body);
        publishHeldSends();
        // A bare "finish-send" releases every held send at once, which is all
        // the single-send tests need. A test can also release one send by
        // name — "finish-send:<body>" — without touching the others.
        await new Promise<void>((resolve, reject) => {
          const release = (): void => resolve();
          document.addEventListener("finish-send", release, { once: true });
          document.addEventListener(`finish-send:${posted.body}`, release, { once: true });
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
        heldSends.splice(heldSends.indexOf(posted.body), 1);
        publishHeldSends();
      }
      if (document.documentElement.dataset.refuseSend === "yes") return Response.json({ error: { code: "FORBIDDEN", message: "This message was refused.", retry_after_ms: null } }, { status: 403 });
      const message: Message = { ...messages[0]!, id: `sent-${String(++sentSeq).padStart(5, "0")}`, room_id: roomId, author_id: me.id, body: posted.body, reply_to: posted.reply_to ?? null, created_at: Date.now(), reactions: [] };
      await frame({ op: "message.create", d: message });
      return Response.json(message);
    }
    const before = url.searchParams.get("before");
    const around = url.searchParams.get("around");
    answer = url.pathname.includes("/general/") || roomId === spacingDm.id
      ? (around === null
          ? messages.filter((message) => before === null || message.id < before).slice(-100)
          : [...messages.filter((message) => message.id <= around).slice(-50), ...messages.filter((message) => message.id > around).slice(0, 50)])
          .slice().reverse().map((message) => ({ ...message, room_id: roomId }))
      : [];
  } else if (url.pathname.endsWith("/knock")) {
    if (document.documentElement.dataset.holdKnock === "yes") await new Promise<void>((resolve, reject) => {
      document.addEventListener("finish-knock", () => resolve(), { once: true });
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    return new Response(null, { status: 204 });
  } else if (url.pathname.endsWith("/voice/ice"))
    answer = { servers: [], ttl_secs: 0 };
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
document.addEventListener(
  "fixture-reaction",
  () =>
    void frame({
      op: "reaction.update",
      s: 50,
      d: {
        message_id: "message-00005",
        key: "heart",
        count: 3,
        user_ids: ["jules", "matt", "eli"],
      },
    }),
);
document.addEventListener("fixture-message", () => {
  const message: Message = { ...messages.at(-1)!, id: `message-${String(messages.length).padStart(5, "0")}`, body: "A new arrival", created_at: Date.now() };
  messages.push(message);
  void frame({ op: "message.create", d: message });
});
// Voice seats for the #137 layout checks: `fixture-voice-alone` leaves only
// you in voice, and `fixture-talking` (detail: [session id or null for you,
// talking]) starts or stops somebody talking.
document.addEventListener("fixture-voice-alone", () => {
  void joinFrameSent.then(() => frame({
    op: "voice.state",
    d: {
      room_id: "general",
      peers: [
        {
          session_id: "mine",
          user_id: "matt",
          controls: { muted: false, deafened: false },
        },
      ],
    },
  }));
});
document.addEventListener("fixture-talking", (event) => {
  const [peer, speaking] = (event as CustomEvent<[string | null, boolean]>)
    .detail;
  void emit("voice:speaking", { server: baseUrl, peer, speaking });
});
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
