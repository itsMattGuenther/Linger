/**
 * The buddy list window, drawn from the prototype's Friday evening
 * (`next/evening.ts`) with no server and no desktop shell. What the list
 * shows is the list model's job and is unit-tested; this page is for
 * looking at it and for `tests/browser/next-list.spec.ts` to measure.
 *
 * Open it with `pnpm exec vite` at /tests/fixtures/next-list.html. The
 * window is the list's real size: 340 wide by 820 tall.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { serverState } from "../../src/lib/gateway";
import { listModel } from "../../src/next/core/list";
import { voiceModel } from "../../src/next/core/voice";
import { awayChoices } from "../../src/next/core/you";
import { ListView } from "../../src/next/app/list/ListView";
import "../../src/next/styles/app.css";
import { NOW, SERVER, SERVER_NAME, evening, people } from "./next/evening";

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
createRoot(root).render(
  <StrictMode>
    <ListView
      serverName={SERVER_NAME}
      model={listModel(shown, NOW)}
      speaking={speaking}
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
      onOpenRoom={(id) => note(`room:${id}`)}
      onOpenDm={(id) => note(`dm:${id}`)}
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
      onMessage={(user) => note(`message:${user.id}`)}
      onStartDm={async (people) => {
        note(`newdm:${people.map((person) => person.id).join(",")}`);
        // `?dmfail`: the server refuses, and the picker says so and stays open.
        return query.has("dmfail") ? "The server didn't answer." : null;
      }}
      onKnock={async (user) => {
        note(`knock:${user.id}`);
        // `?limit`: the fourth knock inside an hour (SPEC §4.9).
        return query.has("limit") ? { ok: false, problem: "That's three this hour. Give them a bit." } : { ok: true };
      }}
    />
  </StrictMode>,
);
