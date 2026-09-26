/**
 * Search (`src/next/app/search/SearchView.tsx`) on the prototype's Friday
 * evening, with a fake server answering in the page (`next/finds.ts`). The
 * rules behind it are unit-tested in `src/next/core/search.test.ts`; this
 * page is for looking at it and for `tests/browser/next-search.spec.ts` to
 * measure and drive.
 *
 * Open it with `pnpm exec vite` at /tests/fixtures/next-search.html. The page
 * is the host: it gives the pane its box and owns Ctrl+K, which puts the
 * cursor back in the box.
 *
 * - `?w=340` (any width): the pane's box is that wide, and the window tall;
 *   without it the pane fills the window.
 * - `?servers`: you're on three servers; `&start=guild` (or `lisbon`, `home`)
 *   opens it from that server.
 * - `?slow`: every answer takes a second, so "Searching…" shows.
 * - `?loading`: nothing ever answers.
 * - `?fail`: every search is refused, in the server's words; with
 *   `?servers`, `?failguild` has only the guild refuse; `?failsecond`
 *   answers the first search and refuses the rest.
 * - `?many`: sixty more messages about the porch, for paging.
 * - `?long`: a name and a room far too long for their places.
 * - `?archived`: #weekend-plans has been archived, so its hits ("trailhead")
 *   show but can't open.
 *
 * What the pane asked for is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "../../src/generated/Message";
import type { Room } from "../../src/generated/Room";
import type { User } from "../../src/generated/User";
import { serverState } from "../../src/lib/gateway";
import type { ViewServer } from "../../src/next/core/scope";
import { SearchView } from "../../src/next/app/search/SearchView";
import "../../src/next/styles/app.css";
import { evening, NOW, people, SERVER, SERVER_NAME } from "./next/evening";
import { fakeSearch } from "./next/finds";
import { GUILD, guild, LISBON, lisbon, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
const LONG = query.has("long");

const did: string[] = [];
const note = (what: string) => {
  did.push(what);
  document.body.dataset.did = did.join("|");
};

function place(server: string, name: string, accent: string, state: ReturnType<typeof evening>): ViewServer {
  const users: User[] = LONG && server === SERVER ? state.users.map((user) => (user.id === "u-eli" ? { ...user, display_name: "Eli Bartholomew-Maximilian the Considerably Long" } : user)) : state.users;
  const rooms: Room[] = state.rooms.map((room) => {
    if (LONG && room.id === "r-general") return { ...room, slug: "general-chatter-for-everything-that-doesnt-fit-anywhere-else" };
    if (query.has("archived") && room.id === "r-plans") return { ...room, archived_at: NOW };
    return room;
  });
  return { server, name, accent, me: state.me?.id ?? null, users, rooms: [...rooms, ...state.dms] };
}

const home = place(SERVER, SERVER_NAME, "amber", evening(serverState(SERVER)));
const servers: ViewServer[] = query.has("servers")
  ? [home, place(GUILD, serverInfo[GUILD].name, serverInfo[GUILD].accent, guild(serverState(GUILD))), place(LISBON, serverInfo[LISBON].name, serverInfo[LISBON].accent, lisbon(serverState(LISBON)))]
  : [home];
const START: Record<string, string> = { home: SERVER, guild: GUILD, lisbon: LISBON };
const startOn = START[query.get("start") ?? ""];

/** Sixty more messages about the porch in #general, oldest first, for paging. */
const many: Message[] = query.has("many")
  ? Array.from({ length: 60 }, (_, index) => ({
      id: `m7${String(index).padStart(5, "0")}`,
      room_id: "r-general",
      author_id: index % 2 === 0 ? people.dave.id : people.callie.id,
      body: `porch note number ${index + 1}: the light is still on`,
      reply_to: null,
      attachments: [],
      reactions: [],
      pinned_at: null,
      edited_at: null,
      deleted_at: null,
      created_at: NOW - (60 - index) * 3_600_000 * 30,
    }))
  : [];

let asked = 0;

function Fixture() {
  const [focusRequest, setFocusRequest] = useState(0);
  // The host owns Ctrl+K: pressed again, it puts the cursor back in the box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        note("ctrl+k");
        setFocusRequest((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.dataset.ready = "yes";
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const width = query.get("w");
  return (
    <div style={{ width: width ? `${width}px` : "100vw", height: "100vh" }}>
      <SearchView
        servers={servers}
        startOn={startOn}
        focusRequest={focusRequest}
        search={async (server, ask) => {
          note(`search ${server === SERVER ? "" : `${server} `}q=${ask.q} room=${ask.room ?? ""} author=${ask.author ?? ""} before=${ask.before ?? ""}`);
          if (query.has("loading")) return new Promise(() => undefined);
          await new Promise((settle) => window.setTimeout(settle, query.has("slow") ? 1000 : 30));
          asked += 1;
          if (query.has("fail") || (query.has("failguild") && server === GUILD) || (query.has("failsecond") && asked > 1)) return "Slow down: that's thirty searches this minute.";
          return fakeSearch(server, ask, server === SERVER ? many : []);
        }}
        onOpenHit={(server, room, message) => note(`open ${server === SERVER ? "" : `${server} `}${room} ${message}`)}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
