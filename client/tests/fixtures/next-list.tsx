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
import { ListView } from "../../src/next/app/list/ListView";
import "../../src/next/styles/app.css";
import { NOW, SERVER, SERVER_NAME, evening, people } from "./next/evening";

// `?voice`: you're in voice in #general, Eli talking. `&ptt`: with push-to-talk.
const query = new URLSearchParams(location.search);
const base = evening(serverState(SERVER));
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
      model={listModel(state, NOW)}
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
      onMessage={(user) => note(`message:${user.id}`)}
      onKnock={async (user) => {
        note(`knock:${user.id}`);
        // `?limit`: the fourth knock inside an hour (SPEC §4.9).
        return query.has("limit") ? { ok: false, problem: "That's three this hour. Give them a bit." } : { ok: true };
      }}
    />
  </StrictMode>,
);
