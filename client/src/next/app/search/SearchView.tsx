import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { SearchHit } from "../../../generated/SearchHit";
import type { UserId } from "../../../generated/UserId";
import { emptyLine, isSearchable, MAX_QUERY_CHARS, PAGE, TYPING_PAUSE_MS } from "../../../lib/search";
import { merge, type Stream } from "../../core/pages";
import { EVERY_SERVER, inScope, startScope, type ViewServer } from "../../core/scope";
import { directory, hitLine, hitOrder, personChoices, roomChoices, searchStatus, type HitLine } from "../../core/search";
import { Button, Icon, Name, Select, TextField } from "../../kit";
import { ServerMark, ServerScope } from "../ServerScope";
import "./SearchView.css";

/** One page asked of one server. */
export interface SearchAsk {
  /** What's in the box, as typed: the server takes the words out of it. */
  q: string;
  room: RoomId | null;
  author: UserId | null;
  /** The last hit's cursor, for the page after it; null for the first. */
  before: string | null;
  limit: number;
}

export interface SearchViewProps {
  /** The servers you're on, in the list's order. */
  servers: readonly ViewServer[];
  /** The server it was opened from, to start on. Left out: every server, or the only one. */
  startOn?: string;
  /** Ask one server for a page: its hits, newest first, or what went wrong in words. */
  search: (server: string, ask: SearchAsk) => Promise<readonly SearchHit[] | string>;
  /** Go to the moment a hit came from (CONV-17). */
  onOpenHit: (server: string, roomId: RoomId, messageId: MessageId) => void;
  /** Changes when the host wants the cursor in the box: it opened, or Ctrl+K was pressed again. */
  focusRequest?: number;
}

const OFFLINE = "Couldn't reach the server.";
/** Names for a server the view doesn't know, which can't happen but mustn't crash. */
const NOBODY = directory({ me: null, users: [], rooms: [] });

/**
 * Search (SPEC §4.12, parity SRCH-1…5), as a pane that fills whatever holds
 * it: a tab, a window of its own or a panel. The host draws its title bar and
 * owns Ctrl+K; this owns the box, the filters and the results.
 *
 * It asks after a pause in typing, or at once on Enter, and never for a box
 * with no word in it. A newer search drops an older one's late answer. With
 * several servers it looks through one or all of them; every server's pages
 * are merged newest first, and each hit then says which server it's from.
 *
 * Keyboard: Down from the box goes to the first hit; the arrows, Home and End
 * move through the hits, and Up from the first goes back to the box. Enter
 * opens a hit. Only one hit is in the tab order at a time.
 */
export function SearchView({ servers, startOn, search, onOpenHit, focusRequest }: SearchViewProps) {
  const [scope, setScope] = useState(() => startScope(servers, startOn));
  const [typed, setTyped] = useState("");
  const [room, setRoom] = useState("");
  const [author, setAuthor] = useState("");
  // Each server's pages, for the search on screen; null before the first
  // answer, or when the box holds nothing to search for.
  const [streams, setStreams] = useState<ReadonlyMap<string, Stream<SearchHit>> | null>(null);
  const [searching, setSearching] = useState(false);
  const [problems, setProblems] = useState<readonly { server: string; words: string }[]>([]);
  const [active, setActive] = useState(0);

  const root = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  // The host's function may be new on every render; the search shouldn't restart for it.
  const asker = useRef(search);
  asker.current = search;
  // Which search is current: a late answer to an older one is dropped.
  const generation = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const several = servers.length > 1;
  const covered = useMemo(() => inScope(scope, servers), [scope, servers]);
  const coveredKey = covered.map((one) => one.server).join("|");
  const one = scope === EVERY_SERVER ? null : (covered[0] ?? null);
  const names = useMemo(() => new Map(servers.map((place) => [place.server, directory(place)])), [servers]);
  const nameOf = useCallback((server: string) => servers.find((place) => place.server === server)?.name ?? server, [servers]);

  const focusBox = useCallback(() => {
    const input = root.current?.querySelector<HTMLInputElement>(".nx-find-box input");
    input?.focus();
    input?.select();
  }, []);

  useEffect(() => {
    focusBox();
  }, [focusRequest, focusBox]);

  /**
   * Ask these servers for a page: the first of a new search (`fresh`), or
   * the next after what each has sent. Every answer lands together, so the
   * merged list moves once.
   */
  const ask = useCallback(
    async (targets: readonly string[], fresh: boolean, held: ReadonlyMap<string, Stream<SearchHit>> | null) => {
      const mine = generation.current;
      setSearching(true);
      const answers = await Promise.all(
        targets.map(async (server) => {
          const before = fresh ? null : (held?.get(server)?.items.at(-1)?.cursor ?? null);
          try {
            const got = await asker.current(server, { q: typed, room: room || null, author: author || null, before, limit: PAGE });
            return { server, got };
          } catch {
            return { server, got: OFFLINE };
          }
        }),
      );
      if (mine !== generation.current) return;
      setSearching(false);
      setProblems(answers.flatMap(({ server, got }) => (typeof got === "string" ? [{ server, words: got }] : [])));
      // A fresh search that every server refused leaves what was showing:
      // a refusal is a line above the results, not an empty page.
      if (fresh && answers.every(({ got }) => typeof got === "string")) return;
      setStreams((before) => {
        const next = new Map(fresh ? [] : (before ?? []));
        for (const { server, got } of answers) {
          const had = fresh ? [] : (next.get(server)?.items ?? []);
          if (typeof got === "string") {
            // A first page that failed has nothing to hold the others back
            // with; a later one keeps its place so Show older can try again.
            next.set(server, fresh ? { items: [], more: false } : { items: had, more: true });
          } else {
            next.set(server, { items: [...had, ...got], more: got.length >= PAGE });
          }
        }
        return next;
      });
      if (fresh) setActive(0);
    },
    [typed, room, author],
  );

  // Search as you type, after a pause. A changed filter or server is a new
  // search, not a longer one. An empty box asks nothing: the server refuses a
  // query with no words in it, and that would spend a rate-limit token.
  useEffect(() => {
    generation.current += 1;
    window.clearTimeout(timer.current);
    setProblems([]);
    if (!isSearchable(typed)) {
      setStreams(null);
      setSearching(false);
      return undefined;
    }
    // Searching from the first keystroke, so the line says so through the pause.
    setSearching(true);
    const targets = coveredKey.split("|");
    timer.current = window.setTimeout(() => void ask(targets, true, null), TYPING_PAUSE_MS);
    return () => window.clearTimeout(timer.current);
  }, [typed, coveredKey, ask]);

  const searchNow = () => {
    if (!isSearchable(typed)) return;
    generation.current += 1;
    window.clearTimeout(timer.current);
    void ask(coveredKey.split("|"), true, null);
  };

  const merged = useMemo(
    () => (streams === null ? null : merge(covered.map((place) => [place.server, streams.get(place.server) ?? { items: [], more: false }] as const), hitOrder)),
    [streams, covered],
  );
  const shown = merged?.shown ?? [];
  const mixed = several && scope === EVERY_SERVER;
  const lines = useMemo(() => {
    const now = Date.now();
    return shown.map(({ server, item }) => ({
      server,
      hit: item,
      line: hitLine(item, names.get(server) ?? NOBODY, mixed ? nameOf(server) : null, now),
    }));
  }, [shown, names, mixed, nameOf]);

  const status = searchStatus({ searching, problems: problems.map(({ server, words }) => ({ name: several ? nameOf(server) : null, words })) });
  const filtered = room !== "" || author !== "";
  // Nothing typed yet, nothing searchable typed, or searched and not found.
  // Until the first answer, and after a refusal, the area stays blank and
  // the line above says what's happening.
  const emptyWords = !isSearchable(typed) || (streams !== null && problems.length === 0) ? emptyLine(typed, filtered) : null;

  const hitButtons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>(".nx-hit-main") ?? [])];
  const moveTo = (index: number) => {
    const buttons = hitButtons();
    const target = buttons[Math.max(0, Math.min(index, buttons.length - 1))];
    target?.focus();
  };
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const buttons = hitButtons();
    const at = buttons.findIndex((button) => button === document.activeElement);
    if (at < 0) return;
    const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    if (to < 0) focusBox();
    else moveTo(to);
  };

  return (
    <div className="nx-find" data-screen="search" ref={root}>
      <div className="nx-find-top">
        <ServerScope
          servers={servers}
          value={scope}
          onChange={(next) => {
            // A different server has different rooms and people.
            setScope(next);
            setRoom("");
            setAuthor("");
          }}
        />
        <div
          className="nx-find-box"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && shown.length > 0) {
              event.preventDefault();
              moveTo(active);
            }
          }}
        >
          <TextField
            label="Search"
            hideLabel
            value={typed}
            onChange={setTyped}
            placeholder="Words, or a file's name"
            icon="search"
            size="lg"
            maxLength={MAX_QUERY_CHARS}
            onEnter={searchNow}
          />
        </div>
        {one ? (
          <div className="nx-find-filters">
            <Select label="Where" hideLabel value={room} onChange={setRoom} options={roomChoices(one)} />
            <Select label="Who" hideLabel value={author} onChange={setAuthor} options={personChoices(one)} />
          </div>
        ) : (
          <p className="nx-find-filters-off">Pick one server to look in a room, or for a person.</p>
        )}
      </div>
      <p className="nx-find-status" role="status" data-problem={problems.length > 0 ? "" : undefined}>
        {status}
      </p>
      <div className="nx-find-results">
        {shown.length === 0 ? (
          emptyWords === null ? null : (
            <p className="nx-find-empty">{emptyWords}</p>
          )
        ) : (
          <ul className="nx-hits" aria-label="Results" ref={list} onKeyDown={onListKey} data-mixed={mixed ? "yes" : undefined}>
            {lines.map(({ server, hit, line }, index) => (
              <Hit
                key={`${server}|${hit.cursor}`}
                line={line}
                accent={mixed ? (servers.find((place) => place.server === server)?.accent ?? null) : undefined}
                current={index === Math.min(active, lines.length - 1)}
                onFocus={() => setActive(index)}
                onOpen={() => onOpenHit(server, hit.room_id, hit.message_id)}
              />
            ))}
          </ul>
        )}
        {merged?.more && shown.length > 0 ? (
          <div className="nx-find-more">
            <Button size="md" busy={searching} onClick={() => void ask(merged.next, false, streams)}>
              Show older
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One hit: who, where and when on its first line, and the words with the
 * matched ones marked on its second, or the file it was found by. A screen
 * reader hears it as one sentence. A hit from an archived room shows but
 * can't open.
 */
function Hit({
  line,
  accent,
  current,
  onFocus,
  onOpen,
}: {
  line: HitLine;
  /** The server's color, when hits from several servers are mixed. */
  accent: string | null | undefined;
  current: boolean;
  onFocus: () => void;
  onOpen: () => void;
}) {
  const gone = line.where === undefined;
  return (
    <li className="nx-hit">
      <button type="button" className="nx-hit-main" aria-label={line.label} tabIndex={current ? 0 : -1} disabled={gone} onFocus={onFocus} onClick={onOpen}>
        {accent === undefined ? null : (
          <span className="nx-hit-lead" aria-hidden="true">
            <ServerMark accent={accent} />
          </span>
        )}
        <span className="nx-hit-text" aria-hidden="true">
          <span className="nx-hit-top">
            <span className="nx-hit-who">{line.who ? <Name person={line.who} size="control" /> : line.whoName}</span>
            <span className="nx-hit-where">
              {line.dm ? (
                <span className="nx-hit-dm">
                  <Icon name="message" size="sm" />
                </span>
              ) : null}
              {line.where ?? "archived room"}
            </span>
            {line.serverName === null ? null : <span className="nx-hit-server">{line.serverName}</span>}
            <span className="nx-hit-when">{line.when}</span>
          </span>
          <span className="nx-hit-words">
            {line.words
              ? // Keyed by position: a run has no id, and the snippet is rebuilt whole or not at all.
                line.words.map((part, at) => (part.matched ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>))
              : [
                  <span key="icon" className="nx-hit-file">
                    <Icon name="file" size="sm" />
                  </span>,
                  <mark key="file">{line.file}</mark>,
                  line.also ? (
                    <span key="also" className="nx-hit-also">
                      {line.also}
                    </span>
                  ) : null,
                ]}
          </span>
        </span>
      </button>
    </li>
  );
}
