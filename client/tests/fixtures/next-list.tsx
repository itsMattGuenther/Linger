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
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { serverState } from "../../src/lib/gateway";
import type { GatewayState } from "../../src/lib/gateway";
import { withAway, withLine } from "../../src/next/core/you";
import { listModel } from "../../src/next/core/list";
import { moveServer, seatsWords, serverHeader } from "../../src/next/core/servers";
import type { ServerListing } from "../../src/next/app/list/ListView";
import { voiceModel } from "../../src/next/core/voice";
import { awayChoices } from "../../src/next/core/you";
import { ListView } from "../../src/next/app/list/ListView";
import "../../src/next/styles/app.css";
import { NOW, SERVER, SERVER_NAME, evening, people } from "./next/evening";
import { GUILD, LISBON, guild, lisbon, serverInfo } from "./next/servers";

// `?voice`: you're in voice in #general, Eli talking. `&ptt`: with push-to-talk.
const query = new URLSearchParams(location.search);
// `?away`: you're away already, so the top card offers "I'm back".
const night = evening(serverState(SERVER));
const base = query.has("away")
  ? (() => {
      const me = night.me && { ...night.me, status: night.me.status && { ...night.me.status, away_message: "walking the dog 🐕" } };
      return { ...night, me, users: night.users.map((user) => (me && user.id === me.id ? me : user)) };
    })()
  : night;
const state = query.has("voice")
  ? {
      ...base,
      voice: { "r-general": [...(base.voice["r-general"] ?? []), { session_id: "s-matt", user_id: people.matt.id }] },
      myVoice: {
        roomId: "r-general",
        muted: query.has("ptt"),
        deafened: false,
        mutedBeforeDeafen: false,
        pushToTalk: query.has("ptt"),
        moved: false,
        audio: "sending",
        peers: {},
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
const shown = query.has("nodms") ? { ...crowded, dms: [] } : crowded;
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

/** One server, as the list has always been. */
function OneServer() {
  const listing: ServerListing = {
    id: SERVER,
    name: SERVER_NAME,
    accent: "amber",
    model: listModel(shown, NOW),
    header: serverHeader(shown, listModel(shown, NOW), false),
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
    onKnock: async (user) => {
      note(`knock:${user.id}`);
      // `?limit`: the fourth knock inside an hour (SPEC §4.9).
      return query.has("limit") ? { ok: false, problem: "That's three this hour. Give them a bit." } : { ok: true };
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
