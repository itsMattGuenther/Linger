/**
 * The real Search and Media windows (`src/next/app/tools/`), wired end to
 * end with the desktop shell, the list window and the server faked in the
 * page (`next/desktop.ts`), for `tests/browser/next-tool-window.spec.ts`:
 * catching up with the list window, asking the server through the borrowed
 * sign-in, and asking the list window to open what was found.
 *
 * Open it at /tests/fixtures/next-tool-window.html?which=search (or
 * `media`). `?servers` signs in to the guild too. What the window asked for
 * is written to `body[data-did]`, `|`-separated.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { MediaKind } from "../../src/generated/MediaKind";
import { serverState } from "../../src/lib/gateway";
import { MediaWindow } from "../../src/next/app/tools/MediaWindow";
import { SearchWindow } from "../../src/next/app/tools/SearchWindow";
import "../../src/next/styles/app.css";
import { fakeDesktop, json } from "./next/desktop";
import { SERVER, SERVER_NAME, evening } from "./next/evening";
import { collections, fakeMedia, fakeSearch } from "./next/finds";
import { GUILD, guild, serverInfo } from "./next/servers";

const query = new URLSearchParams(location.search);
const which = query.get("which") === "media" ? "media" : "search";
const number = (value: string | null) => (value === null ? null : Number(value));

fakeDesktop({
  label: which,
  query,
  ownerState: evening(serverState(SERVER)),
  others: query.has("servers") ? { [GUILD]: guild(serverState(GUILD)) } : {},
  infos: { [SERVER]: { name: SERVER_NAME, accent: "amber" }, [GUILD]: serverInfo[GUILD] },
  routes: (method, path, url) => {
    const server = url.origin;
    const params = url.searchParams;
    if (path === "/search" && method === "GET") {
      return json(
        fakeSearch(server, {
          q: params.get("q") ?? "",
          room: params.get("room_id"),
          author: params.get("author_id"),
          before: params.get("before"),
          limit: Number(params.get("limit") ?? "30"),
        }),
      );
    }
    if (path === "/media" && method === "GET") {
      const kind = params.get("kind");
      return json(
        fakeMedia(collections[server] ?? [], {
          kind: kind === null ? null : (kind as MediaKind),
          author: params.get("author"),
          since: number(params.get("since")),
          until: number(params.get("until")),
          before: params.get("before"),
          limit: Number(params.get("limit") ?? "60"),
        }),
      );
    }
    if (/^\/media\/[^/]+\/star$/.test(path)) return new Response(null, { status: 204 });
    return null;
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<StrictMode>{which === "media" ? <MediaWindow /> : <SearchWindow />}</StrictMode>);
