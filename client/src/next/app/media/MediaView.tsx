import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../../generated/Attachment";
import type { MediaItem } from "../../../generated/MediaItem";
import type { MediaKind } from "../../../generated/MediaKind";
import type { MessageId } from "../../../generated/MessageId";
import type { RoomId } from "../../../generated/RoomId";
import type { UserId } from "../../../generated/UserId";
import { renderAs } from "../../../lib/media";
import { TYPING_PAUSE_MS } from "../../../lib/search";
import { isFiltered, keepLine, KINDS, MEDIA_PAGE, mediaAsk, mediaEmpty, mediaOrder, NO_FILTERS, starLine, tileLine, type MediaFilters, type TileLine } from "../../core/media";
import { merge, type Stream } from "../../core/pages";
import { EVERY_SERVER, inScope, startScope, type ViewServer } from "../../core/scope";
import { directory, personChoices } from "../../core/search";
import { Button, Icon, IconButton, type IconName, Name, Select, TextField } from "../../kit";
import { ServerMark, ServerScope } from "../ServerScope";
import "./MediaView.css";

/** A server as the media view sees it. */
export interface MediaServer extends ViewServer {
  /** How many days it keeps a file, or null for good; left out while it hasn't said. */
  expiryDays?: number | null;
}

/** One page asked of one server. */
export interface MediaAsk {
  kind: MediaKind | null;
  author: UserId | null;
  /** The first and last moments of the range, in ms, inclusive; null for open-ended. */
  since: number | null;
  until: number | null;
  /** The last item's cursor, for the page after it; null for the first. */
  before: string | null;
  limit: number;
}

export interface MediaViewProps {
  /** The servers you're on, in the list's order. */
  servers: readonly MediaServer[];
  /** The server it was opened from, to start on. Left out: every server, or the only one. */
  startOn?: string;
  /** Ask one server for a page: starred first, then newest, or what went wrong in words. */
  media: (server: string, ask: MediaAsk) => Promise<readonly MediaItem[] | string>;
  /** Star a file or take its star off. Resolves once the server has answered: null when it took it, or what went wrong in words. */
  star: (server: string, attachmentId: string, starred: boolean) => Promise<string | null>;
  /** A path a server gave, as a full address on its media origin. */
  mediaUrl: (server: string, path: string) => string;
  /** Go to the message and moment an item came from (MEDIA-4, CONV-17). */
  onOpenItem: (server: string, roomId: RoomId, messageId: MessageId) => void;
  /** A link's own page, in the browser. */
  onOpenLink: (url: string) => void;
  /** Save a file through the system. */
  onDownload: (server: string, file: Attachment) => void;
}

const OFFLINE = "Couldn't reach the server.";
const NOBODY = directory({ me: null, users: [], rooms: [] });

/** An item's key, across servers. The links in one message share a cursor, so a link's address is part of it. */
function keyOf(server: string, item: MediaItem): string {
  return `${server}|${item.kind}|${item.cursor}|${item.link?.url ?? ""}`;
}

const GLYPH: Record<MediaKind, IconName> = { image: "media", video: "play", audio: "audio", file: "file", link: "link", pin: "message" };

/**
 * The media collection (SPEC §4.4, parity MEDIA-1…6), as a pane that fills
 * whatever holds it. The host draws its title bar; this owns the filters and
 * the grid.
 *
 * Everything shared, starred first and then newest, narrowed by kind, person
 * and dates. Every tile leads back to its message. A star lights only once
 * the server has taken it, and a starred tile stays where it is until the
 * next load: moving it from under the pointer would lose your place. With
 * several servers it looks through one or all of them, and each tile then
 * says which server it's from.
 *
 * Keyboard: the arrows, Home and End move through the tiles, and Enter opens
 * one. Only one tile, and its buttons, are in the tab order at a time.
 */
export function MediaView({ servers, startOn, media, star, mediaUrl, onOpenItem, onOpenLink, onDownload }: MediaViewProps) {
  const [scope, setScope] = useState(() => startScope(servers, startOn));
  const [filters, setFilters] = useState<MediaFilters>(NO_FILTERS);
  const [streams, setStreams] = useState<ReadonlyMap<string, Stream<MediaItem>> | null>(null);
  // Loading from the start: the first page is asked for as soon as it mounts.
  const [loading, setLoading] = useState(true);
  const [problems, setProblems] = useState<readonly { server: string | null; words: string }[]>([]);
  // What the last star said, until the next thing happens.
  const [said, setSaid] = useState<{ words: string; problem: boolean } | null>(null);
  // Stars the server has taken since this list loaded, drawn over the items
  // without moving them.
  const [stars, setStars] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [starring, setStarring] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(0);

  const grid = useRef<HTMLUListElement | null>(null);
  const asker = useRef(media);
  asker.current = media;
  const generation = useRef(0);
  const lastDates = useRef({ from: "", to: "" });

  const several = servers.length > 1;
  const covered = useMemo(() => inScope(scope, servers), [scope, servers]);
  const coveredKey = covered.map((one) => one.server).join("|");
  const one = scope === EVERY_SERVER ? null : (covered[0] ?? null);
  const mixed = several && scope === EVERY_SERVER;
  const names = useMemo(() => new Map(servers.map((place) => [place.server, directory(place)])), [servers]);
  const placeOf = useCallback((server: string) => servers.find((place) => place.server === server), [servers]);

  /** Ask these servers for a page: the first of a new list (`fresh`), or the next after what each has sent. */
  const load = useCallback(
    async (targets: readonly string[], fresh: boolean, held: ReadonlyMap<string, Stream<MediaItem>> | null) => {
      const asked = mediaAsk(filters);
      if (typeof asked === "string") {
        setProblems([{ server: null, words: asked }]);
        setLoading(false);
        return;
      }
      const mine = generation.current;
      setLoading(true);
      const answers = await Promise.all(
        targets.map(async (server) => {
          const before = fresh ? null : (held?.get(server)?.items.at(-1)?.cursor ?? null);
          try {
            return { server, got: await asker.current(server, { ...asked, before, limit: MEDIA_PAGE }) };
          } catch {
            return { server, got: OFFLINE };
          }
        }),
      );
      if (mine !== generation.current) return;
      setLoading(false);
      setProblems(answers.flatMap(({ server, got }) => (typeof got === "string" ? [{ server, words: got }] : [])));
      // A fresh list every server refused leaves what was showing.
      if (fresh && answers.every(({ got }) => typeof got === "string")) return;
      setStreams((before) => {
        const next = new Map(fresh ? [] : (before ?? []));
        for (const { server, got } of answers) {
          const had = fresh ? [] : (next.get(server)?.items ?? []);
          if (typeof got === "string") next.set(server, fresh ? { items: [], more: false } : { items: had, more: true });
          // A page is full, or a little over (the links in one message share
          // one), until the end: an empty page is the end (PROTOCOL §6), and
          // so is a short one, which saves asking for it.
          else next.set(server, { items: [...had, ...got], more: got.length >= MEDIA_PAGE });
        }
        return next;
      });
      if (fresh) {
        setStars(new Map());
        setActive(0);
      }
    },
    [filters],
  );

  // A changed filter or server is a different collection, not a longer one.
  // A date is typed a digit at a time, so a change there waits for a pause.
  useEffect(() => {
    generation.current += 1;
    setProblems([]);
    setSaid(null);
    setLoading(true);
    const dated = lastDates.current.from !== filters.from || lastDates.current.to !== filters.to;
    lastDates.current = { from: filters.from, to: filters.to };
    const targets = coveredKey.split("|");
    const timer = window.setTimeout(() => void load(targets, true, null), dated ? TYPING_PAUSE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [coveredKey, filters, load]);

  const merged = useMemo(
    () => (streams === null ? null : merge(covered.map((place) => [place.server, streams.get(place.server) ?? { items: [], more: false }] as const), mediaOrder)),
    [streams, covered],
  );
  const shown = useMemo(
    () =>
      (merged?.shown ?? []).map(({ server, item }) => {
        const key = keyOf(server, item);
        const starredNow = stars.get(key);
        const current = starredNow === undefined ? item : { ...item, starred_at: starredNow ? (item.starred_at ?? Date.now()) : null };
        return { server, key, item: current, line: tileLine(current, names.get(server) ?? NOBODY, mixed ? (placeOf(server)?.name ?? server) : null) };
      }),
    [merged, stars, names, mixed, placeOf],
  );

  const toggleStar = async (server: string, key: string, item: MediaItem, line: TileLine) => {
    const file = item.attachment;
    if (!file || starring.has(key)) return;
    const want = !line.starred;
    setStarring((held) => new Set(held).add(key));
    setSaid({ words: starLine(want, "asking"), problem: false });
    const mine = generation.current;
    let problem: string | null;
    try {
      problem = await star(server, file.id, want);
    } catch {
      problem = OFFLINE;
    }
    setStarring((held) => {
      const next = new Set(held);
      next.delete(key);
      return next;
    });
    if (mine !== generation.current) return;
    if (problem === null) {
      setStars((held) => new Map(held).set(key, want));
      setSaid({ words: starLine(want, "done"), problem: false });
    } else {
      setSaid({ words: problem, problem: true });
    }
  };

  const filtered = isFiltered(filters);
  const empty = mediaEmpty(filtered);
  const problemWords = problems.map(({ server, words }) => (server !== null && several ? `${placeOf(server)?.name ?? server}: ${words}` : words)).join(" ");
  const status = problemWords
    ? { words: problemWords, problem: true }
    : loading
      ? { words: "Loading media…", problem: false }
      : (said ?? { words: keepLine(one ? one.expiryDays : undefined), problem: false });

  const tiles = () => [...(grid.current?.querySelectorAll<HTMLButtonElement>(".nx-tile-open") ?? [])];
  const onGridKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const all = tiles();
    const at = all.findIndex((tile) => tile === document.activeElement);
    if (at < 0) return;
    // A row is every tile level with the first.
    const top = all[0]?.getBoundingClientRect().top ?? 0;
    const across = Math.max(1, all.filter((tile) => Math.abs(tile.getBoundingClientRect().top - top) < 1).length);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + across, ArrowUp: at - across, Home: 0, End: all.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    all[Math.max(0, Math.min(to, all.length - 1))]?.focus();
  };

  const setFilter = (change: Partial<MediaFilters>) => setFilters((held) => ({ ...held, ...change }));

  return (
    <div className="nx-media" data-screen="media">
      <div className="nx-media-top">
        <ServerScope
          servers={servers}
          value={scope}
          onChange={(next) => {
            // People are per server: a different one has different people.
            setScope(next);
            setFilter({ author: null });
          }}
        />
        <div className="nx-media-kinds" role="group" aria-label="Kind">
          {KINDS.map((kind) => (
            <Button key={kind.label} size="sm" variant="quiet" pressed={filters.kind === kind.key} onClick={() => setFilter({ kind: kind.key })}>
              {kind.label}
            </Button>
          ))}
        </div>
        <div className="nx-media-narrow">
          <div className="nx-media-who">
            {one ? (
              <Select label="Shared by" value={filters.author ?? ""} onChange={(value) => setFilter({ author: value === "" ? null : value })} options={personChoices(one)} />
            ) : (
              <p className="nx-media-who-off">Pick one server to choose a person.</p>
            )}
          </div>
          <TextField label="From" type="date" value={filters.from} max={filters.to || undefined} onChange={(from) => setFilter({ from })} />
          <TextField label="Until" type="date" value={filters.to} min={filters.from || undefined} onChange={(to) => setFilter({ to })} />
        </div>
      </div>
      <div className="nx-media-status">
        <p className="nx-media-line" role="status" data-problem={status.problem ? "" : undefined}>
          {status.words}
        </p>
        {filtered ? (
          <Button size="sm" variant="quiet" onClick={() => setFilters(NO_FILTERS)}>
            Clear filters
          </Button>
        ) : null}
      </div>
      <div className="nx-media-body">
        {shown.length === 0 ? (
          streams === null || loading || problems.length > 0 ? null : (
            <div className="nx-media-empty">
              <p className="nx-media-empty-title">{empty.title}</p>
              <p className="nx-media-empty-line">{empty.line}</p>
            </div>
          )
        ) : (
          <ul className="nx-media-grid" aria-label="Shared" ref={grid} onKeyDown={onGridKey} data-mixed={mixed ? "yes" : undefined}>
            {shown.map(({ server, key, item, line }, index) => {
              const { link, attachment, room_id: roomId, message_id: messageId } = item;
              return (
                <Tile
                  key={key}
                  line={line}
                  accent={mixed ? (placeOf(server)?.accent ?? null) : undefined}
                  url={(path) => mediaUrl(server, path)}
                  current={index === Math.min(active, shown.length - 1)}
                  starring={starring.has(key)}
                  onFocus={() => setActive(index)}
                  onOpen={() => {
                    if (line.opens && roomId !== null && messageId !== null) onOpenItem(server, roomId, messageId);
                  }}
                  onStar={() => void toggleStar(server, key, item, line)}
                  onLink={link ? () => onOpenLink(link.url) : null}
                  // A picture opens at its message; anything else can be saved from here.
                  onDownload={attachment && renderAs(attachment.mime) !== "image" ? () => onDownload(server, attachment) : null}
                />
              );
            })}
          </ul>
        )}
        {merged?.more && shown.length > 0 ? (
          <div className="nx-media-more">
            <Button size="md" busy={loading} onClick={() => void load(merged.next, false, streams)}>
              Show older
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One thing somebody shared. The whole tile is the way back to its message:
 * its face, its name, who shared it, where and when. Its buttons sit at the
 * end of its name: the star, and the link or the download.
 */
function Tile({
  line,
  accent,
  url,
  current,
  starring,
  onFocus,
  onOpen,
  onStar,
  onLink,
  onDownload,
}: {
  line: TileLine;
  /** The server's color, when tiles from several servers are mixed. */
  accent: string | null | undefined;
  url: (path: string) => string;
  current: boolean;
  starring: boolean;
  onFocus: () => void;
  onOpen: () => void;
  onStar: () => void;
  onLink: (() => void) | null;
  onDownload: (() => void) | null;
}) {
  const actions = [
    line.starrable ? (
      <IconButton
        key="star"
        icon="star"
        size="sm"
        label={line.starred ? `Take the star off ${line.title}` : `Star ${line.title}`}
        pressed={line.starred}
        disabled={starring}
        skipTab={!current}
        onClick={onStar}
      />
    ) : null,
    onLink ? <IconButton key="link" icon="popout" size="sm" label={`Open ${line.title} in your browser`} skipTab={!current} onClick={onLink} /> : null,
    onDownload ? <IconButton key="save" icon="download" size="sm" label={`Download ${line.title}`} skipTab={!current} onClick={onDownload} /> : null,
  ].filter((action) => action !== null);
  return (
    <li className="nx-tile" data-actions={actions.length || undefined} data-starred={line.starred ? "yes" : undefined}>
      <button type="button" className="nx-tile-open" aria-label={line.label} title={line.moment} tabIndex={current ? 0 : -1} disabled={!line.opens} onFocus={onFocus} onClick={onOpen}>
        <Face line={line} url={url} />
        <span className="nx-tile-title" aria-hidden="true">
          {line.title}
        </span>
        <span className="nx-tile-meta" aria-hidden="true">
          <span className="nx-tile-who">{line.who ? <Name person={line.who} size="meta" /> : line.whoName}</span>
          <span className="nx-tile-where">
            {line.dm ? (
              <span className="nx-tile-dm">
                <Icon name="message" size="sm" />
              </span>
            ) : null}
            {line.where ?? "archived room"}
          </span>
        </span>
        <span className="nx-tile-meta" aria-hidden="true">
          <span className="nx-tile-date">{line.date}</span>
          {line.size === null ? null : <span className="nx-tile-size">{line.size}</span>}
        </span>
        {accent === undefined ? null : (
          <span className="nx-tile-meta" aria-hidden="true">
            <ServerMark accent={accent} />
            <span className="nx-tile-server">{line.serverName}</span>
          </span>
        )}
      </button>
      {actions.length > 0 ? <span className="nx-tile-actions">{actions}</span> : null}
    </li>
  );
}

/**
 * The tile's face, the same size whatever it holds and before anything
 * loads: a picture whole inside it, a video's poster and length, a link's
 * site, or the kind's glyph.
 */
function Face({ line, url }: { line: TileLine; url: (path: string) => string }) {
  const face = line.face;
  switch (face.kind) {
    case "image":
      return (
        <span className="nx-tile-face" data-face="image" aria-hidden="true">
          <img src={url(face.path)} alt="" width={face.width ?? undefined} height={face.height ?? undefined} loading="lazy" decoding="async" />
        </span>
      );
    case "video":
      return (
        <span className="nx-tile-face" data-face="video" aria-hidden="true">
          {face.poster === null ? <Icon name="play" size="lg" /> : <img src={url(face.poster)} alt="" loading="lazy" decoding="async" />}
          {face.length === null ? null : <span className="nx-tile-length">{face.length}</span>}
        </span>
      );
    case "link":
      return (
        <span className="nx-tile-face" data-face="link" aria-hidden="true">
          {face.icon === null ? <Icon name="link" size="lg" /> : <img className="nx-tile-favicon" src={face.icon} alt="" />}
          <span className="nx-tile-domain">{face.domain}</span>
        </span>
      );
    case "glyph":
      return (
        <span className="nx-tile-face" data-face="glyph" aria-hidden="true">
          <Icon name={GLYPH[face.of]} size="lg" />
          <span className="nx-tile-word">{face.word}</span>
        </span>
      );
  }
}
