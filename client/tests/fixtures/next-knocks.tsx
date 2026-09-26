/**
 * Knocks landing on the buddy list (`src/next/app/list/KnockCards.tsx`), over
 * the real list on the prototype's evening, for
 * `tests/browser/next-knocks.spec.ts`. `window.knocks.arrive(from, server?)`
 * lands one now; a card calling itself gone is written to `body[data-gone]`.
 * `?voice` puts you in voice, so the voice bar is at the bottom. The list
 * window is 340 by 820.
 */
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { serverState } from "../../src/lib/gateway";
import { type KnockCard, KnockCards } from "../../src/next/app/list/KnockCards";
import { ListView } from "../../src/next/app/list/ListView";
import { listModel } from "../../src/next/core/list";
import { voiceModel } from "../../src/next/core/voice";
import "../../src/next/styles/app.css";
import { NOW, SERVER, SERVER_NAME, evening, people } from "./next/evening";

declare global {
  interface Window {
    /** `ago`: the knock arrived this long before its card is drawn. */
    knocks?: { arrive: (from: string | null, serverName?: string, ago?: number) => void };
  }
}

const night = evening(serverState(SERVER));
const state = new URLSearchParams(location.search).has("voice")
  ? {
      ...night,
      voice: { "r-general": [...(night.voice["r-general"] ?? []), { session_id: "s-matt", user_id: people.matt.id }] },
      myVoice: {
        roomId: "r-general",
        muted: false,
        deafened: false,
        mutedBeforeDeafen: false,
        pushToTalk: false,
        moved: false,
        audio: "sending" as const,
        peers: {},
        speaking: {},
        talking: false,
        volumes: {},
      },
    }
  : night;
const voice = voiceModel(state, new Set());
const gone: string[] = [];
let serial = 0;

function Page() {
  const [cards, setCards] = useState<KnockCard[]>([]);
  window.knocks = {
    arrive: (from, serverName, ago = 0) => {
      serial += 1;
      const user = Object.values(people).find((person) => person.id === from) ?? null;
      setCards((held) => [...held, { server: SERVER, id: `knock-${serial}`, at: Date.now() - ago, from: user, serverName: serverName ?? null }]);
    },
  };
  const onGone = useCallback((server: string, id: string) => {
    gone.push(id);
    document.body.dataset.gone = gone.join(",");
    setCards((held) => held.filter((card) => !(card.server === server && card.id === id)));
  }, []);
  return (
    <ListView
      serverName={SERVER_NAME}
      model={listModel(state, NOW)}
      onOpenRoom={(id) => (document.body.dataset.opened = id)}
      voice={voice ? { ...voice, onGoToRoom: () => undefined, onMute: () => undefined, onDeafen: () => undefined, onLeave: () => undefined } : undefined}
      notices={<KnockCards cards={cards} onGone={onGone} />}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
