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
import { ListView } from "../../src/next/app/list/ListView";
import "../../src/next/styles/app.css";
import { NOW, SERVER, SERVER_NAME, evening, people } from "./next/evening";

const state = evening(serverState(SERVER));
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
      speaking={new Set([people.eli.id])}
      onOpenRoom={(id) => note(`room:${id}`)}
      onOpenDm={(id) => note(`dm:${id}`)}
      onOpenPerson={(user) => note(`person:${user.id}`)}
    />
  </StrictMode>,
);
