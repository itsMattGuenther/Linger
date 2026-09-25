/**
 * The search surface (SPEC §4.12, T-1203).
 *
 * A destination in the rail, next to `media`, opening in place of the message
 * stream — the same pattern the media collection uses, and for the same reason:
 * a place that is not a room is still a place, and nothing in this product
 * floats over the conversation. `Ctrl`/`Cmd`+`K` is a shortcut *into* here with
 * the box focused, never a second surface with its own behavior.
 *
 * What the spec refuses is most of what a search box usually does. No relevance
 * ranking — results are newest first and there is no control to change that.
 * No history, no saved searches, no suggestions: nothing about a search is
 * written down on either side, which is why there is no state in this file that
 * outlives the panel. And no query language, so what is typed goes to the
 * server as typed and the server looks for the words in it.
 *
 * A hit is a line: who, which room, when, and a few words either side of the
 * match with the matched words marked. Clicking one opens that room and goes to
 * that message, which is where the real message gets fetched — a hit is
 * deliberately not a `Message` (PROTOCOL §6).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { MessageId } from "../generated/MessageId";
import type { Room } from "../generated/Room";
import type { RoomId } from "../generated/RoomId";
import type { SearchHit } from "../generated/SearchHit";
import type { User } from "../generated/User";
import type { UserId } from "../generated/UserId";
import { ApiError, type AuthedApi } from "../lib/api";
import { conversationLabel } from "../lib/dm";
import { personStyle } from "../lib/names";
import DestinationHeader from "../lib/DestinationHeader";
import { hitTime } from "../stream/time";
import {
  emptyLine,
  fileLine,
  hitLabel,
  isSearchable,
  MAX_QUERY_CHARS,
  PAGE,
  snippetText,
  TYPING_PAUSE_MS,
} from "./search";
import "./search.css";

export default function SearchPanel({
  api,
  users,
  me,
  rooms,
  focusNonce,
  onOpen,
  onClose,
}: {
  api: AuthedApi;
  /** Everyone the gateway has told us about, for the person filter and names. */
  users: User[];
  /** Who is looking, for naming a DM — it has no name of its own. */
  me: UserId | null;
  rooms: Room[];
  /**
   * Bumped every time `Ctrl`/`Cmd`+`K` is pressed. The panel is already open on
   * the second press, so a mount-time autofocus would do nothing — this is what
   * makes the shortcut put the cursor in the box every time.
   */
  focusNonce: number;
  /** Go to the message a hit came from. */
  onOpen: (roomId: RoomId, messageId: MessageId) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [room, setRoom] = useState<RoomId | null>(null);
  const [author, setAuthor] = useState<UserId | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLInputElement | null>(null);
  // Which request is the current one. A word typed while a page is in flight
  // would otherwise fold the old answer into the new list.
  const generation = useRef(0);

  useEffect(() => {
    box.current?.focus();
    box.current?.select();
  }, [focusNonce]);

  const load = useCallback(
    async (before: string | null): Promise<void> => {
      const mine = generation.current;
      setLoading(true);
      try {
        const page = await api.search({
          q: typed,
          room,
          author,
          before,
          limit: PAGE,
        });
        if (mine !== generation.current) return;
        setProblem(null);
        setAtEnd(page.length < PAGE);
        setHits((held) => (before === null ? page : [...(held ?? []), ...page]));
      } catch (error) {
        if (mine !== generation.current) return;
        // Whatever was on screen stays on screen. A refused search is a line
        // above the results, not an empty page — and blanking the list on a
        // dropped connection would make every keystroke feel like a loss.
        setProblem(error instanceof ApiError ? error.message : "Couldn't reach the server.");
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [api, typed, room, author],
  );

  // Search as you type, after a pause. A changed filter is a different search,
  // not a longer one, so it starts a fresh first page like a changed word does.
  //
  // The empty box asks for nothing rather than for everything: `GET /search`
  // refuses a query with no words in it, and spending a rate-limit token to be
  // told that is a waste of a token and a sentence nobody needs to read.
  useEffect(() => {
    generation.current += 1;
    setAtEnd(false);
    setProblem(null);
    if (!isSearchable(typed)) {
      setHits(null);
      setLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(() => void load(null), TYPING_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, load]);

  const people = new Map(users.map((person) => [person.id, person]));
  // Rooms *and* the DMs you are in: since T-1303 a member's own DMs are in
  // their search results, and a hit the client cannot name reads as one from a
  // room that is gone.
  const byId = new Map(rooms.map((one) => [one.id, one]));
  const shown = hits ?? [];
  const last = shown.at(-1);
  const filtered = room !== null || author !== null;

  return (
    <main className="stream search">
      <DestinationHeader
        title="Search"
        description="What people said, and what their files were called"
        closeLabel="Close search"
        onClose={onClose}
      />

      {/* A form, so Enter searches now rather than waiting out the pause. */}
      <form
        className="search-controls"
        onSubmit={(event) => {
          event.preventDefault();
          generation.current += 1;
          if (isSearchable(typed)) void load(null);
        }}
      >
        <input
          ref={box}
          type="search"
          className="search-box"
          value={typed}
          maxLength={MAX_QUERY_CHARS}
          spellCheck={false}
          autoComplete="off"
          aria-label="search"
          placeholder="a word somebody said"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
        />
        <div className="search-filters">
          <label className="search-field meta">
            <span>in</span>
            <select
              value={room ?? ""}
              onChange={(event) => setRoom(event.target.value === "" ? null : event.target.value)}
            >
              <option value="">any room</option>
              {rooms.map((one) => (
                <option key={one.id} value={one.id}>
                  {/* A DM has no slug worth drawing (SPEC §4.13); this is the
                      same name the rail and the hit list already use. */}
                  {conversationLabel(one, users, me) ?? `#${one.slug}`}
                </option>
              ))}
            </select>
          </label>
          <label className="search-field meta">
            <span>from</span>
            <select
              value={author ?? ""}
              onChange={(event) => setAuthor(event.target.value === "" ? null : event.target.value)}
            >
              <option value="">anyone</option>
              {users.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.display_name}
                </option>
              ))}
            </select>
          </label>
          {filtered ? (
            <button
              type="button"
              className="host-close meta"
              onClick={() => {
                setRoom(null);
                setAuthor(null);
              }}
            >
              clear
            </button>
          ) : null}
        </div>
      </form>

      <div className="search-body">
        {problem ? <p className="search-problem meta">{problem}</p> : null}
        {shown.length === 0 ? (
          <p className="placeholder">{loading ? "…" : emptyLine(typed, filtered)}</p>
        ) : (
          <ul className="search-hits">
            {shown.map((hit) => (
              <li key={hit.cursor}>
                <Hit
                  hit={hit}
                  who={people.get(hit.author_id)}
                  room={conversationLabel(byId.get(hit.room_id), users, me)}
                  onOpen={() => onOpen(hit.room_id, hit.message_id)}
                />
              </li>
            ))}
          </ul>
        )}
        {shown.length > 0 && !atEnd ? (
          <p className="search-more">
            <button
              type="button"
              className="host-close meta"
              disabled={loading}
              onClick={() => void load(last?.cursor ?? null)}
            >
              {loading ? "…" : "older"}
            </button>
          </p>
        ) : null}
      </div>

    </main>
  );
}

/**
 * One hit: who, where, when, and a few words with the match marked.
 *
 * The whole line is the way to the message, the way a media tile is the way to
 * the moment it was posted in. The snippet's runs are drawn in order and the
 * matched ones get `<mark>` — there is nothing to parse and nothing to escape,
 * which is exactly why the server sends runs instead of a marked-up string
 * (PROTOCOL §6).
 *
 * The filename line only appears when the message text did not carry the match,
 * because that is the case where a hit otherwise looks like a mistake: the
 * words are not in the words, they are in what the file was called.
 *
 * A hit from an archived room is drawn and cannot be opened. The index covers
 * every message that has not been deleted, archived room or not — which is
 * right, because archiving a room is not deleting what was said in it — but
 * the client has nowhere to take you: an archived room is not in the rail and
 * has no stream to scroll. Saying so is better than a click that silently
 * lands somewhere else.
 */
function Hit({
  hit,
  who,
  room,
  onOpen,
}: {
  hit: SearchHit;
  who: User | undefined;
  room: string | undefined;
  onOpen: () => void;
}) {
  const name = who?.display_name ?? "someone";
  const when = hitTime(hit.created_at);
  const matchedWords = hit.snippet.some((part) => part.matched);
  const file = matchedWords ? null : fileLine(hit.matched_filenames);
  const words = snippetText(hit.snippet).trim();
  const gone = room === undefined;

  return (
    <button
      type="button"
      className="search-hit"
      disabled={gone}
      onClick={onOpen}
      aria-label={
        gone ? `${hitLabel(hit, name, room, when)} (archived room)` : hitLabel(hit, name, room, when)
      }
    >
      <span className="search-hit-head meta" aria-hidden="true">
        <span className="search-who name-color" style={personStyle(who)}>
          {name}
        </span>
        <span className="search-where">{gone ? "archived room" : room}</span>
        <time dateTime={new Date(hit.created_at).toISOString()}>{when}</time>
      </span>
      <span className="search-hit-body" aria-hidden="true">
        {words === "" && file === null ? (
          <span className="search-nothing">no words</span>
        ) : (
          // Keyed by position: a run has no id, and its position in the
          // snippet is its identity — the list is rebuilt whole or not at all.
          hit.snippet.map((part, at) =>
            part.matched ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>,
          )
        )}
      </span>
      {file === null ? null : (
        <span className="search-file meta" aria-hidden="true">
          {file}
        </span>
      )}
    </button>
  );
}
