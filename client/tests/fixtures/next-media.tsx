/**
 * The media collection (`src/next/app/media/MediaView.tsx`) on the
 * prototype's Friday evening, with a fake server answering in the page
 * (`next/finds.ts`). The rules behind it are unit-tested in
 * `src/next/core/media.test.ts`; this page is for looking at it and for
 * `tests/browser/next-media.spec.ts` to measure and drive.
 *
 * Open it with `pnpm exec vite` at /tests/fixtures/next-media.html.
 *
 * - `?w=340` (any width): the pane's box is that wide, and the window tall;
 *   without it the pane fills the window.
 * - `?servers`: you're on three servers; `&start=guild` (or `lisbon`, `home`)
 *   opens it from that server.
 * - `?empty`: nothing has been shared yet.
 * - `?loading`: nothing ever answers.
 * - `?fail`: every page is refused, in the server's words; `?failsecond`
 *   answers the first and refuses the rest.
 * - `?starfail`: every star is refused; `?slowstar`: a star takes a second.
 * - `?many`: a hundred and fifty more things, for paging.
 * - `?lazy`: pictures come from `/__media/…`, which only answers when a spec
 *   serves it, to see the tiles keep their size before anything loads.
 * - `?long`: a name and a file name far too long for their places.
 *
 * What the pane asked for is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../../src/generated/MediaItem";
import type { User } from "../../src/generated/User";
import { serverState } from "../../src/lib/gateway";
import { MediaView, type MediaServer } from "../../src/next/app/media/MediaView";
import "../../src/next/styles/app.css";
import { evening, SERVER, SERVER_NAME } from "./next/evening";
import { collections, fakeMedia, manyItems, PICTURES } from "./next/finds";
import { GUILD, guild, LISBON, lisbon, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
const LONG = query.has("long");

const did: string[] = [];
const note = (what: string) => {
  did.push(what);
  document.body.dataset.did = did.join("|");
};

function place(server: string, name: string, accent: string, state: ReturnType<typeof evening>, expiryDays: number | null): MediaServer {
  const users: User[] = LONG && server === SERVER ? state.users.map((user) => (user.id === "u-jules" ? { ...user, display_name: "Jules Montgomery-Fairweather of the Long Name" } : user)) : state.users;
  return { server, name, accent, me: state.me?.id ?? null, users, rooms: [...state.rooms, ...state.dms], expiryDays };
}

const home = place(SERVER, SERVER_NAME, "amber", evening(serverState(SERVER)), 365);
const servers: MediaServer[] = query.has("servers")
  ? [home, place(GUILD, serverInfo[GUILD].name, serverInfo[GUILD].accent, guild(serverState(GUILD)), null), place(LISBON, serverInfo[LISBON].name, serverInfo[LISBON].accent, lisbon(serverState(LISBON)), 90)]
  : [home];
const START: Record<string, string> = { home: SERVER, guild: GUILD, lisbon: LISBON };
const startOn = START[query.get("start") ?? ""];

/** Each server's collection, which starring changes. */
const held: Record<string, MediaItem[]> = Object.fromEntries(
  Object.entries(collections).map(([server, items]) => {
    if (query.has("empty")) return [server, []];
    const long = LONG && server === SERVER ? items.map((one) => (one.attachment?.id === "a-map" && one.attachment ? { ...one, attachment: { ...one.attachment, filename: "river-loop-trail-map-with-every-bench-and-the-duck-pond-marked.pdf" } } : one)) : items;
    return [server, server === SERVER && query.has("many") ? [...long, ...manyItems()] : long];
  }),
);

let asked = 0;

function Fixture() {
  // Starring redraws the page, which hands the pane new functions: it must
  // not start over for that.
  const [, redraw] = useState(0);
  const width = query.get("w");
  return (
    <div style={{ width: width ? `${width}px` : "100vw", height: "100vh" }}>
      <MediaView
        servers={servers}
        startOn={startOn}
        media={async (server, ask) => {
          note(`media ${server === SERVER ? "" : `${server} `}kind=${ask.kind ?? ""} author=${ask.author ?? ""} since=${ask.since ?? ""} until=${ask.until ?? ""} before=${ask.before ?? ""}`);
          if (query.has("loading")) return new Promise(() => undefined);
          await new Promise((settle) => window.setTimeout(settle, 30));
          asked += 1;
          if (query.has("fail") || (query.has("failsecond") && asked > 1)) return "The server is busy. Try again in a moment.";
          return fakeMedia(held[server] ?? [], ask);
        }}
        star={async (server, id, starred) => {
          note(`star ${server === SERVER ? "" : `${server} `}${id} ${starred ? "on" : "off"}`);
          await new Promise((settle) => window.setTimeout(settle, query.has("slowstar") ? 1000 : 60));
          if (query.has("starfail")) return "Only files can be starred, and this one has gone.";
          held[server] = (held[server] ?? []).map((one) =>
            one.attachment?.id === id ? { ...one, starred_at: starred ? Date.now() : null, attachment: { ...one.attachment, starred_at: starred ? Date.now() : null } } : one,
          );
          redraw((n) => n + 1);
          return null;
        }}
        mediaUrl={(_server, path) => (query.has("lazy") ? `/__media${path}` : (PICTURES[path] ?? path))}
        onOpenItem={(server, room, message) => note(`open ${server === SERVER ? "" : `${server} `}${room} ${message}`)}
        onOpenLink={(url) => note(`link ${url}`)}
        onDownload={(server, file) => note(`download ${server === SERVER ? "" : `${server} `}${file.filename}`)}
      />
    </div>
  );
}

document.body.dataset.ready = "yes";
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
