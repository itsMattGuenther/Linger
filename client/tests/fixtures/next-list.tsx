/**
 * The buddy list window, drawn from the prototype's Friday evening
 * (`next/evening.ts`) with no server and no desktop shell. What the list
 * shows is the list model's job and is unit-tested; this page is for
 * looking at it and for `tests/browser/next-list.spec.ts` to measure.
 *
 * Open it with `pnpm exec vite` at /tests/fixtures/next-list.html. The
 * window is the list's real size: 340 wide by 820 tall.
 *
 * `?servers`: the prototype's three servers (next/servers.ts), the first
 * open and the others folded; `&folded` starts them all folded, `&open` all
 * open, `&quiet` makes Ashen Lanterns quiet, `&awayfail` has Casa da
 * Ribeira refuse to save an away message.
 *
 * `?fields`: Jules and you have fields with labels of your own and web
 * addresses in them (#270); `&long` makes them as long as the server takes.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "../../src/lib/api";
import { apply, serverState } from "../../src/lib/gateway";
import type { GatewayState } from "../../src/lib/gateway";
import { knockOn } from "../../src/next/core/knock";
import { withAway, withLine } from "../../src/next/core/you";
import { listModel } from "../../src/next/core/list";
import { moveServer, seatsWords, serverHeader } from "../../src/next/core/servers";
import type { ServerListing } from "../../src/next/app/list/ListView";
import { voiceModel } from "../../src/next/core/voice";
import { awayChoices } from "../../src/next/core/you";
import { ListView } from "../../src/next/app/list/ListView";
import "../../src/next/styles/app.css";
import type { User } from "../../src/generated/User";
import { NOW, SERVER, SERVER_NAME, evening, ownFields, people, withFields } from "./next/evening";
import { GUILD, LISBON, guild, lisbon, serverInfo } from "./next/servers";

// `?voice`: you're in voice in #general, Eli talking. `&ptt`: with push-to-talk,
// the key up. `&mics`: Jules deafened and out of reach, Eli on a client that
// doesn't share its microphone (VOICE-6, VOICE-7). `&muted`, `&deafened`: your
// own controls pressed (deafening mutes too, as `setVoiceDeafened` does).
const query = new URLSearchParams(location.search);
// `?away`: you're away already, so the top card offers "I'm back", and the
// server says so to everyone, as it does once an away message is saved.
const night = evening(serverState(SERVER));
const base = query.has("away")
  ? (() => {
      const away = "walking the dog 🐕";
      const me = night.me && { ...night.me, status: night.me.status && { ...night.me.status, away_message: away } };
      return {
        ...night,
        me,
        users: night.users.map((user) => (me && user.id === me.id ? me : user)),
        presence: night.presence.map((entry) => (me && entry.user_id === me.id ? { ...entry, state: "away" as const, room_id: null, away_message: away } : entry)),
      };
    })()
  : night;
const state = query.has("voice")
  ? {
      ...base,
      voice: {
        "r-general": [
          ...(base.voice["r-general"] ?? []).map((peer) =>
            query.has("mics") ? { session_id: peer.session_id, user_id: peer.user_id, controls: peer.user_id === people.jules.id ? { muted: true, deafened: true } : undefined } : peer,
          ),
          { session_id: "s-matt", user_id: people.matt.id },
        ],
      },
      myVoice: {
        roomId: "r-general",
        muted: query.has("muted") || query.has("deafened"),
        deafened: query.has("deafened"),
        mutedBeforeDeafen: false,
        pushToTalk: query.has("ptt"),
        talkHeld: false,
        moved: false,
        audio: "sending",
        peers: query.has("mics") ? { "s-jules": "failed" } : {},
        speaking: { "s-eli": true },
        talking: false,
        volumes: {},
      },
    }
  : base;
// `?crowd`: four more people, so the new-message picker can reach its limit of seven.
const crowd = ["Ada", "Bo", "Kit", "Noor"].map((name) => ({
  ...people.callie,
  id: `u-${name.toLowerCase()}`,
  username: name.toLowerCase(),
  display_name: name,
  status: null,
}));
const crowded = query.has("crowd") ? { ...state, users: [...state.users, ...crowd] } : state;
// `?nodms`: nobody has started a DM yet.
const noDms = query.has("nodms") ? { ...crowded, dms: [] } : crowded;
// `?bare`: a brand-new server: no rooms, no DMs, nobody else, and you're the
// host (`&member` for somebody who isn't). `?many`: fifteen rooms, three of
// them busy (decision 22).
const hostMe = (me: typeof noDms.me) => (me ? { ...me, is_host: !query.has("member") } : me);
const bare = query.has("bare")
  ? { ...noDms, rooms: [], dms: [], me: hostMe(noDms.me), users: noDms.users.filter((user) => user.id === noDms.me?.id).map((user) => ({ ...user, is_host: !query.has("member") })), presence: noDms.presence.filter((entry) => entry.user_id === noDms.me?.id) }
  : noDms;
const many = query.has("many")
  ? {
      ...bare,
      rooms: [
        ...bare.rooms,
        ...Array.from({ length: 15 - bare.rooms.length }, (_, n) => ({ ...(bare.rooms[0] ?? ({} as never)), id: `r-extra-${n}`, slug: `extra-${n}`, name: `quiet-room-${n + 1}`, position: 10 + n, last_message_id: null })),
      ],
    }
  : bare;
// `?idle`: Callie hasn't touched anything for ten minutes (#259).
const shown = query.has("idle")
  ? { ...many, presence: many.presence.map((entry) => (entry.user_id === people.callie.id ? { ...entry, state: "idle" as const } : entry)) }
  : many;
// `?fields`: Jules and you have fields with labels of your own, web
// addresses among them (#270); `&long`, as long as the server takes.
const fielded = query.has("fields")
  ? (() => {
      const fields = ownFields(query.has("long"));
      const wearing = (user: User): User => (user.id === people.jules.id || user.id === people.matt.id ? withFields(user, fields) : user);
      return { ...shown, me: shown.me && wearing(shown.me), users: shown.users.map(wearing) };
    })()
  : shown;
const speaking = new Set([people.eli.id]);
const voice = voiceModel(state, speaking);
const opened: string[] = [];
// The page records what was opened, for the spec to read back.
const note = (what: string) => {
  opened.push(what);
  document.body.dataset.opened = opened.join(",");
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

/**
 * `?live`: the spec says things in conversations through `window.linger`, and
 * the real store folds them in. `said` is a message arriving (anyone's, yours
 * included); `read` is its window reading up to the newest, as the chat window
 * does for a message you just sent.
 */
interface Live {
  said: (roomId: string, authorId: string) => void;
  read: (roomId: string) => void;
}

/** One server, as the list has always been. */
function OneServer() {
  const [held, setHeld] = useState<GatewayState>(fielded);
  useEffect(() => {
    if (!query.has("live")) return;
    let next = 100;
    const live: Live = {
      said: (roomId, authorId) => {
        const id = `m${String((next += 1)).padStart(6, "0")}`;
        setHeld((now) =>
          apply(now, {
            s: 0,
            op: "message.create",
            d: { id, room_id: roomId, author_id: authorId, body: "hi", reply_to: null, attachments: [], reactions: [], pinned_at: null, edited_at: null, deleted_at: null, created_at: NOW },
          }),
        );
      },
      read: (roomId) => setHeld((now) => ({ ...now, read: { ...now.read, [roomId]: now.newest[roomId] ?? "" } })),
    };
    (window as unknown as { linger: Live }).linger = live;
    document.body.dataset.live = "ready";
  }, []);
  const listing: ServerListing = {
    id: SERVER,
    name: SERVER_NAME,
    accent: "amber",
    model: listModel(held, NOW),
    header: serverHeader(held, listModel(held, NOW), false),
    quiet: false,
    speaking,
    onOpenRoom: (id) => note(`room:${id}`),
    onOpenDm: (id) => note(`dm:${id}`),
    onMessage: (user) => note(`message:${user.id}`),
    onStartDm: async (people) => {
      note(`newdm:${people.map((person) => person.id).join(",")}`);
      // `?dmfail`: the server refuses, and the picker says so and stays open.
      return query.has("dmfail") ? "The server didn't answer." : null;
    },
    onHost: (section) => note(`host:${section}`),
    onKnock: async (user) => {
      note(`knock:${user.id}`);
      // `?limit`: the fourth knock inside an hour (SPEC §4.9), refused the
      // way the server refuses it, with 19 minutes 10 seconds to go.
      return knockOn({
        knock: async () => {
          if (query.has("limit")) throw new ApiError(429, { code: "RATE_LIMITED", message: "Slow down a little.", retry_after_ms: 1_150_000 });
        },
      }, user.id);
    },
  };
  return (
    <ListView
      servers={[listing]}
      voice={
        voice
          ? {
              ...voice,
              onGoToRoom: () => note(`go:${voice.roomId}`),
              onMute: (muted) => note(`mute:${muted}`),
              onDeafen: (deafened) => note(`deafen:${deafened}`),
              onLeave: () => note("leave"),
            }
          : undefined
      }
      onEditProfile={() => note("settings:profile")}
      you={{
        awayChoices: awayChoices([]),
        saveLine: async (line) => {
          note(`line:${line}`);
          return null;
        },
        goAway: async (message) => {
          note(`away:${message}`);
          return null;
        },
        comeBack: async () => {
          note("back");
          return null;
        },
      }}
    />
  );
}

/** Your status on one server changed, as the store folds in the saved you. */
function withStatus(held: GatewayState, status: NonNullable<GatewayState["me"]>["status"]): GatewayState {
  const me = held.me && { ...held.me, status };
  return { ...held, me, users: held.users.map((user) => (me && user.id === me.id ? me : user)) };
}

const NAMES: Record<string, { name: string; accent: string }> = {
  [SERVER]: { name: SERVER_NAME, accent: "amber" },
  ...serverInfo,
};

/** The prototype's three servers, each with its own you, in an order you can change. */
function Servers() {
  const [states, setStates] = useState<Record<string, GatewayState>>(() => ({
    [SERVER]: state,
    [GUILD]: guild(serverState(GUILD)),
    [LISBON]: lisbon(serverState(LISBON)),
  }));
  const [order, setOrder] = useState<string[]>([SERVER, GUILD, LISBON]);
  const [quiet, setQuiet] = useState<ReadonlySet<string>>(() => new Set(query.has("quiet") ? [GUILD] : []));
  const restatus = (id: string, change: (held: GatewayState) => NonNullable<GatewayState["me"]>["status"]) =>
    setStates((all) => {
      const held = all[id];
      return held ? { ...all, [id]: withStatus(held, change(held)) } : all;
    });

  const listings = order.flatMap((id): ServerListing[] => {
    const held = states[id];
    const info = NAMES[id];
    if (!held || !info) return [];
    const model = listModel(held, NOW);
    return [
      {
        id,
        name: info.name,
        accent: info.accent,
        model,
        header: serverHeader(held, model, quiet.has(id)),
        quiet: quiet.has(id),
        speaking: id === SERVER ? speaking : undefined,
        onOpenRoom: (room) => note(`room:${id}:${room}`),
        onOpenDm: (dm) => note(`dm:${id}:${dm}`),
        onMessage: (user) => note(`message:${id}:${user.id}`),
        onKnock: async (user) => {
          note(`knock:${id}:${user.id}`);
          return { ok: true };
        },
        onStartDm: async (chosen) => {
          note(`newdm:${id}:${chosen.map((person) => person.id).join(",")}`);
          return null;
        },
        saveLine: async (line) => {
          note(`line:${id}:${line}`);
          restatus(id, (held) => withLine(held.me?.status, line));
          return null;
        },
      },
    ];
  });

  const inVoice = voice && states[SERVER]?.myVoice;
  const voiceCount = voice ? voice.people.length : 0;
  return (
    <ListView
      servers={listings}
      folded={query.has("folded") ? order : query.has("open") ? [] : undefined}
      onQuiet={(id, on) => {
        note(`quiet:${id}:${on}`);
        setQuiet((held) => {
          const next = new Set(held);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        });
      }}
      onMove={(id, by) => {
        note(`move:${id}:${by}`);
        setOrder((held) => moveServer(held, id, by));
      }}
      everywhere={{
        awayChoices: awayChoices([]),
        goAway: async (message, chosen) => {
          note(`away:${chosen.join("+")}:${message}`);
          const answers: Record<string, string | null> = {};
          for (const id of chosen) {
            if (query.has("awayfail") && id === LISBON) {
              answers[id] = "Casa da Ribeira didn't answer. Try again in a moment.";
              continue;
            }
            answers[id] = null;
            restatus(id, (held) => withAway(held.me?.status, message));
          }
          return answers;
        },
        comeBack: async (chosen) => {
          note(`back:${chosen.join("+")}`);
          for (const id of chosen) restatus(id, (held) => withAway(held.me?.status, null));
          return Object.fromEntries(chosen.map((id) => [id, null]));
        },
      }}
      voice={
        voice && inVoice
          ? {
              ...voice,
              server: { name: SERVER_NAME, accent: "amber", seats: seatsWords(voiceCount) },
              onGoToRoom: () => note(`go:${voice.roomId}`),
              onMute: (muted) => note(`mute:${muted}`),
              onDeafen: (deafened) => note(`deafen:${deafened}`),
              onLeave: () => note("leave"),
            }
          : undefined
      }
    />
  );
}

createRoot(root).render(<StrictMode>{query.has("servers") ? <Servers /> : <OneServer />}</StrictMode>);
