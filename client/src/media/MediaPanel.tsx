/**
 * The media collection (SPEC §4.4).
 *
 * "Everything shared on a server accumulates into a browsable collection:
 * images, video, audio, links, files, and pinned messages." This is that
 * collection, and it is a first-class destination in the rail rather than
 * something you find by searching — the spec is explicit about it, because the
 * whole point is that the collection *is* the relationship. You shared
 * something great eight months ago; it is still here.
 *
 * Four things it has to do, and all four are the spec's words: a grid,
 * filterable by person, type and date range; every item links back to the
 * message and moment it was posted in; anyone can star an item; starred items
 * sort first and never expire.
 *
 * The panel takes over the stream column the way the host panel does. There is
 * no modal stack in this product, and the roster stays where it is.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { MediaItem } from "../generated/MediaItem";
import type { MediaKind } from "../generated/MediaKind";
import type { MessageId } from "../generated/MessageId";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";
import type { User } from "../generated/User";
import type { UserId } from "../generated/UserId";
import { ApiError, type AuthedApi } from "../lib/api";
import { openExternal } from "../lib/external";
import { absoluteUrl } from "../lib/url";
import { conversationLabel } from "../dm/dm";
import { personStyle } from "../lib/names";
import EmptyState from "../lib/EmptyState";
import DestinationHeader from "../lib/DestinationHeader";
import Button from "../lib/Button";
import { fullTime } from "../stream/time";
import {
  dayEnd,
  dayStart,
  durationText,
  expiryText,
  fileSize,
  itemDescription,
  itemLabel,
  KIND_FILTERS,
} from "./media";
import "./media.css";
import DownloadFile from "./DownloadFile";

/** A page. Big enough that scrolling is rare, small enough to arrive fast. */
const PAGE = 60;
const sharedDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

interface Filters {
  kind: MediaKind | null;
  author: UserId | null;
  /** `YYYY-MM-DD` as the date inputs give it, empty when unset. */
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { kind: null, author: null, from: "", to: "" };

export default function MediaPanel({
  api,
  users,
  me,
  rooms,
  onOpen,
  onClose,
  expiryDays,
}: {
  api: AuthedApi;
  /** Everyone the gateway has told us about, for the person filter and names. */
  users: User[];
  /** Who is looking, for naming a DM — it has no name of its own. */
  me: UserId | null;
  rooms: Room[];
  /** Go to the moment an item came from. */
  onOpen: (roomId: RoomId, messageId: MessageId) => void;
  onClose: () => void;
  /**
   * How long this server keeps a file, or `null` when it keeps them for good.
   * Undefined until `GET /server` has answered.
   */
  expiryDays?: number | null;
}) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Which page request is the current one. A filter changed while a page is in
  // flight would otherwise fold the old answer into the new list.
  const generation = useRef(0);

  const load = useCallback(
    async (before: string | null): Promise<void> => {
      const mine = generation.current;
      setLoading(true);
      try {
        const page = await api.media({
          kind: filters.kind,
          author: filters.author,
          since: dayStart(filters.from),
          until: dayEnd(filters.to),
          before,
          limit: PAGE,
        });
        if (mine !== generation.current) return;
        setProblem(null);
        setAtEnd(page.length === 0);
        setItems((held) =>
          before === null ? page : [...(held ?? []), ...page],
        );
      } catch (error) {
        if (mine !== generation.current) return;
        setProblem(
          error instanceof ApiError
            ? error.message
            : "Couldn't reach the server.",
        );
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [api, filters],
  );

  // A changed filter is a different collection, not a longer one.
  useEffect(() => {
    generation.current += 1;
    setItems(null);
    setAtEnd(false);
    void load(null);
  }, [load]);

  const people = new Map(users.map((person) => [person.id, person]));
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const shown = items ?? [];
  const last = shown.at(-1);
  const unfiltered =
    filters.kind === null &&
    filters.author === null &&
    filters.from === "" &&
    filters.to === "";

  const setStar = async (item: MediaItem, starred: boolean): Promise<void> => {
    const file = item.attachment;
    if (!file) return;
    const mine = generation.current;
    setProblem(null);
    // Moved locally first: a star is a toggle, and waiting a round trip to
    // redraw one makes it feel broken. A refusal puts it back.
    const at = starred ? Date.now() : null;
    const apply = (value: number | null): void => {
      if (mine !== generation.current) return;
      setItems((held) =>
        (held ?? []).map((candidate) =>
          candidate.cursor === item.cursor
            ? {
                ...candidate,
                starred_at: value,
                attachment: candidate.attachment
                  ? { ...candidate.attachment, starred_at: value }
                  : null,
              }
            : candidate,
        ),
      );
    };
    apply(at);
    try {
      await (starred ? api.starMedia(file.id) : api.unstarMedia(file.id));
    } catch (error) {
      apply(item.starred_at);
      if (mine === generation.current)
        setProblem(
          error instanceof ApiError
            ? error.message
            : "Couldn't reach the server.",
        );
      throw error;
    }
  };

  return (
    <main className="stream media">
      <DestinationHeader
        title="Media"
        closeLabel="Close media"
        onClose={onClose}
        description={
          <>
            The things you shared. The moments they came from.
            {/* Explain stars beside the collection they keep. */}
            {expiryDays === undefined || expiryDays === null
              ? null
              : ` · files go after ${expiryText(expiryDays)}; starred ones stay`}
          </>
        }
      />

      <div className="media-filters">
        <div className="media-kinds">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              className="host-tab meta"
              aria-pressed={filters.kind === filter.key}
              onClick={() =>
                setFilters((held) => ({ ...held, kind: filter.key }))
              }
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="media-narrow">
          <label className="media-field meta">
            <span>from</span>
            <select
              value={filters.author ?? ""}
              onChange={(event) =>
                setFilters((held) => ({
                  ...held,
                  author: event.target.value === "" ? null : event.target.value,
                }))
              }
            >
              <option value="">anyone</option>
              {users.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="media-field meta">
            <span>between</span>
            <input
              type="date"
              value={filters.from}
              max={filters.to === "" ? undefined : filters.to}
              onChange={(event) =>
                setFilters((held) => ({ ...held, from: event.target.value }))
              }
            />
          </label>
          <label className="media-field meta">
            <span>and</span>
            <input
              type="date"
              value={filters.to}
              min={filters.from === "" ? undefined : filters.from}
              onChange={(event) =>
                setFilters((held) => ({ ...held, to: event.target.value }))
              }
            />
          </label>
          {filters.kind === null &&
          filters.author === null &&
          filters.from === "" &&
          filters.to === "" ? null : (
            <Button onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          )}
        </div>
      </div>

      <div className="media-body">
        {problem ? (
          <p className="media-problem" role="alert">
            {problem}
          </p>
        ) : null}
        {items === null ? (
          <p className="placeholder">Loading media…</p>
        ) : shown.length === 0 ? (
          unfiltered ? (
            <EmptyState title="Good things collect here.">
              Photos, files and links from your conversations will appear here.
              Share something to get started.
            </EmptyState>
          ) : (
            <p className="placeholder">Nothing here matches those filters.</p>
          )
        ) : (
          <ul className="media-grid">
            {shown.map((item) => (
              <li key={item.cursor}>
                <Tile
                  baseUrl={api.baseUrl}
                  item={item}
                  who={people.get(item.author_id)}
                  room={
                    item.room_id === null
                      ? undefined
                      : conversationLabel(byId.get(item.room_id), users, me)
                  }
                  onOpen={() => {
                    if (item.room_id !== null && item.message_id !== null) {
                      onOpen(item.room_id, item.message_id);
                    }
                  }}
                  onStar={(starred) => setStar(item, starred)}
                />
              </li>
            ))}
          </ul>
        )}
        {shown.length > 0 && !atEnd ? (
          <p className="media-more">
            <Button
              disabled={loading}
              onClick={() => void load(last?.cursor ?? null)}
            >
              {loading ? "Loading…" : "Show older"}
            </Button>
          </p>
        ) : null}
      </div>
    </main>
  );
}

/**
 * One thing somebody shared.
 *
 * The whole tile is the way back to the message — that is the spec's "each item
 * links back to the message and moment it was posted in", and it is why the
 * footer says which room and when rather than only what the file is called.
 */
function Tile({
  baseUrl,
  item,
  who,
  room,
  onOpen,
  onStar,
}: {
  baseUrl: string;
  item: MediaItem;
  who: User | undefined;
  room: string | undefined;
  onOpen: () => void;
  onStar: (starred: boolean) => Promise<void>;
}) {
  const starred = item.starred_at !== null;
  const file = item.attachment;
  const name = who?.display_name ?? "someone";
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const star = async (): Promise<void> => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setNotice("");
    try {
      await onStar(!starred);
      setNotice(
        starred ? "Star removed." : "Kept. Starred files don’t expire.",
      );
    } catch {
      // The collection shows the server's refusal; never claim a failed save.
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="media-tile" data-starred={starred ? "true" : undefined}>
      <button
        type="button"
        className="media-open"
        onClick={onOpen}
        aria-label={itemDescription(item, name)}
      >
        <span className="media-face">
          {item.kind === "image" && file ? (
            <img
              src={absoluteUrl(baseUrl, file.url)}
              alt=""
              loading="lazy"
              decoding="async"
            />
          ) : item.kind === "video" && file ? (
            <>
              {file.poster_url === null ? (
                <span className="media-glyph" aria-hidden="true">
                  video
                </span>
              ) : (
                <img
                  src={absoluteUrl(baseUrl, file.poster_url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              )}
              {file.duration_ms === null ? null : (
                <span className="media-duration meta">
                  {durationText(Number(file.duration_ms))}
                </span>
              )}
            </>
          ) : item.kind === "link" && item.link ? (
            <span className="media-linkface">
              {item.link.icon === null ? null : (
                <img
                  className="card-icon"
                  src={item.link.icon}
                  alt=""
                  width={14}
                  height={14}
                />
              )}
              <span className="media-linktitle">
                {item.link.title ?? item.link.domain}
              </span>
              <span className="meta">{item.link.domain}</span>
            </span>
          ) : (
            <span className="media-glyph" aria-hidden="true">
              {item.kind === "pin" ? "pinned" : item.kind}
            </span>
          )}
        </span>
        <span className="media-name">{itemLabel(item)}</span>
        <span className="media-foot meta">
          <span className="media-who name-color" style={personStyle(who)}>
            {name}
          </span>
          {room === undefined ? null : <span>{room}</span>}
          <time
            dateTime={new Date(item.created_at).toISOString()}
            title={fullTime(item.created_at)}
          >
            {sharedDate.format(item.created_at)}
          </time>
          {file === null || file === undefined ? null : (
            <span>{fileSize(Number(file.size_bytes))}</span>
          )}
        </span>
      </button>

      <div className="media-actions">
        {/* Only a file can be starred: a star is what keeps it from being swept
            at a year old (SPEC §4.4), and a link or a pin has no object to
            keep. */}
        {file ? (
          <button
            type="button"
            className="media-star"
            aria-pressed={starred}
            aria-label={`${starred ? "Unstar" : "Star"} ${itemLabel(item)}`}
            disabled={busy}
            aria-busy={busy}
            title="Starred files don’t expire"
            onClick={() => void star()}
          >
            <span aria-hidden="true">{starred ? "★" : "☆"}</span>
            {busy ? "Saving…" : starred ? "Starred" : "Star"}
          </button>
        ) : null}
        {item.link ? (
          <button
            type="button"
            className="att-get"
            onClick={() => item.link && openExternal(item.link.url)}
          >
            open
          </button>
        ) : null}
        {file && item.kind !== "image" ? (
          <DownloadFile key={file.url} url={absoluteUrl(baseUrl, file.url)} />
        ) : null}
      </div>
      <p className="media-confirmation" role="status">
        {notice}
      </p>
    </div>
  );
}
