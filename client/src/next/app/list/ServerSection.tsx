import { type CSSProperties, useRef, useState } from "react";
import type { User } from "../../../generated/User";
import type { ListModel } from "../../core/list";
import { type FoldedLine, foldedText, type OpenLine, openText, type ServerHeader } from "../../core/servers";
import { lineProblem } from "../../core/you";
import { Icon, IconButton, MarkerCluster, Menu, type MenuAnchor, type MenuItem, Name, TextField, VoiceGlyph } from "../../kit";
import { markerFor } from "../markers";
import { ServerBody, type ServerBodyActions } from "./ServerBody";
import "./ServerSection.css";

/** One server, as the list with several servers shows it. */
export interface ServerListing extends ServerBodyActions {
  /** The server's address: the key everything is filed under. */
  id: string;
  name: string;
  /** The server's color: the host's accent palette key (a key, never a value), or none. */
  accent: string | null;
  model: ListModel;
  /** What its header and the line under it say (core/servers.ts). */
  header: ServerHeader;
  /** No chimes, no bold, no arrival cards for this server. Knocks still get through. */
  quiet: boolean;
  /** Who is talking right now, for the voice glyphs. */
  speaking?: ReadonlySet<string>;
  /** Change your status line on this server; answers with a problem in words, or null. */
  saveLine?: (line: string) => Promise<string | null>;
}

/** A palette key becomes a color only through the generated palette. */
export function serverColor(accent: string | null): CSSProperties {
  const key = accent && /^[a-z]{2,16}$/.test(accent) ? accent : "slate";
  return { "--server": `var(--name-${key})` } as CSSProperties;
}

/**
 * A server's section of the list (docs/design/buddy-list.md, "Several
 * servers"), like an AIM buddy group. Its header folds it, and stays pinned
 * while you scroll through a long one. Folded, it still shows its lights: the
 * name, bold when something inside is new, the dots of who's on, and one
 * plain line. Open, the line is who you are there, and the section holds the
 * server's rooms, DMs and people. The menu holds Quiet and the order.
 */
export function ServerSection({
  listing,
  index,
  folded,
  first,
  last,
  onToggle,
  onQuiet,
  onMove,
}: {
  listing: ServerListing;
  /** Its place in your order, for ids. */
  index: number;
  folded: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
  onQuiet?: (quiet: boolean) => void;
  onMove?: (by: -1 | 1) => void;
}) {
  const { name, header, quiet } = listing;
  const bodyId = `nx-srv-${index}-body`;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // The menu's button, for focus to come back to when the menu closes.
  const menuSlot = useRef<HTMLSpanElement | null>(null);
  const backToMenuButton = () => menuSlot.current?.querySelector("button")?.focus();

  const items: MenuItem[] = [];
  if (onQuiet) items.push({ id: "quiet", label: "Quiet", icon: "quiet", checked: quiet, onSelect: () => onQuiet(!quiet) });
  if (onMove && !first) items.push({ id: "up", label: "Move up", icon: "up", onSelect: () => onMove(-1) });
  if (onMove && !last) items.push({ id: "down", label: "Move down", icon: "down", onSelect: () => onMove(1) });

  const toggleLabel = [name, header.fresh ? "something new" : null, quiet ? "quiet" : null].filter(Boolean).join(", ");

  return (
    <section
      className="nx-srv"
      aria-label={name}
      data-folded={folded ? "yes" : undefined}
      data-quiet={quiet ? "yes" : undefined}
      style={serverColor(listing.accent)}
    >
      <div className="nx-srv-top">
      <div className="nx-srv-head">
        <button type="button" className="nx-srv-toggle" aria-expanded={!folded} aria-controls={bodyId} aria-label={toggleLabel} onClick={onToggle}>
          <span className="nx-srv-caret" aria-hidden="true">
            <Icon name="caret" size="sm" />
          </span>
          <span className="nx-srv-slot" aria-hidden="true">
            <span className="nx-srv-mark" />
          </span>
          <span className="nx-srv-title">
            <span className="nx-srv-name" data-fresh={header.fresh ? "yes" : undefined}>
              {name}
            </span>
            {quiet ? (
              <span className="nx-srv-quiet" title="Quiet: no chimes, no bold, no arrival cards">
                <Icon name="quiet" size="sm" />
              </span>
            ) : null}
            <span className="nx-srv-dots">
              <MarkerCluster people={header.dots.map(({ user, state }) => markerFor(user, state))} max={16} />
            </span>
          </span>
        </button>
        {items.length > 0 ? (
          <span ref={menuSlot} className="nx-srv-menu" data-open={menu ? "yes" : undefined}>
            <IconButton
              icon="more"
              label={`${name} options`}
              size="sm"
              expanded={menu !== null}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ top: box.top, left: box.left, right: box.right, bottom: box.bottom });
              }}
            />
          </span>
        ) : null}
      </div>

      {folded ? (
        <p className="nx-srv-line" data-kind={header.folded.kind}>
          <span className="nx-srv-line-icon" aria-hidden="true">
            {header.folded.kind === "voice" ? (
              <VoiceGlyph speaking={isTalking(header.folded, listing.speaking)} />
            ) : null}
          </span>
          <span className="nx-srv-line-text" data-text={foldedText(header.folded)}>
            <Folded line={header.folded} />
          </span>
        </p>
      ) : header.open ? (
        <YouHere line={header.open} saveLine={listing.saveLine} />
      ) : null}
      </div>

      {folded ? null : (
        <div id={bodyId} className="nx-srv-body">
          <ServerBody
            model={listing.model}
            speaking={listing.speaking}
            idPrefix={`s${index}-`}
            serverName={name}
            onOpenRoom={listing.onOpenRoom}
            onOpenDm={listing.onOpenDm}
            onMessage={listing.onMessage}
            onKnock={listing.onKnock}
            onStartDm={listing.onStartDm}
          />
        </div>
      )}

      {menu ? (
        <Menu
          label={`${name} options`}
          items={items.map((item) => ({
            ...item,
            onSelect: () => {
              item.onSelect();
              setMenu(null);
              backToMenuButton();
            },
          }))}
          anchor={menu}
          onClose={(reason) => {
            setMenu(null);
            if (reason !== "outside") backToMenuButton();
          }}
        />
      ) : null}
    </section>
  );
}

function isTalking(line: FoldedLine, speaking: ReadonlySet<string> | undefined): boolean {
  return line.kind === "voice" && speaking !== undefined && line.people.some((user) => speaking.has(user.id));
}

/** Names in a sentence, each in its own face: "Eli", "Eli and Jules", "Eli, Jules and others". */
function Names({ people, more }: { people: readonly User[]; more: boolean }) {
  const [first, second] = people;
  if (!first) return null;
  const name = (user: User) => <Name person={user} size="inline" />;
  if (!second) return more ? <>{name(first)} and others</> : name(first);
  return more ? (
    <>
      {name(first)}, {name(second)} and others
    </>
  ) : (
    <>
      {name(first)} and {name(second)}
    </>
  );
}

/** Between two parts of a line: real spaces, so it reads as a pause and copies as words. */
const Sep = () => <span className="nx-srv-sep">{" · "}</span>;

/** A folded server's one line (core/servers.ts `foldedText` says the same in plain words). */
function Folded({ line }: { line: FoldedLine }) {
  switch (line.kind) {
    case "voice":
      return (
        <>
          {line.people.length > 0 ? (
            <>
              <Names people={line.people} more={false} /> in <b className="nx-srv-room">#{line.room}</b>
            </>
          ) : (
            <>
              <b className="nx-srv-room">#{line.room}</b> in voice
            </>
          )}
          {line.seats ? (
            <>
              <Sep />
              {line.seats}
            </>
          ) : null}
        </>
      );
    case "room":
      return (
        <>
          <Names people={line.people} more={line.more} /> in <b className="nx-srv-room">#{line.room}</b>
        </>
      );
    case "quiet":
      return line.up.length === 0 ? (
        <>quiet</>
      ) : (
        <>
          quiet
          <Sep />
          <Names people={line.up} more={line.more} />
          {line.up.length === 1 && !line.more ? "'s up" : " are up"}
        </>
      );
  }
}

/**
 * An open server's line: who you are there and your status there, which you
 * can change from here (with several servers the top card only holds what's
 * true everywhere).
 */
function YouHere({ line, saveLine }: { line: OpenLine; saveLine?: (line: string) => Promise<string | null> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);

  const stop = () => {
    setEditing(false);
    setProblem(null);
    requestAnimationFrame(() => button.current?.focus());
  };
  const save = async () => {
    if (!saveLine || busy) return;
    const tooLong = lineProblem(draft);
    if (tooLong) {
      setProblem(tooLong);
      return;
    }
    setBusy(true);
    const refused = await saveLine(draft);
    setBusy(false);
    if (refused) setProblem(refused);
    else stop();
  };

  if (editing) {
    return (
      <div
        className="nx-srv-edit"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            stop();
          }
        }}
      >
        <TextField
          label={`Your status as ${line.me.display_name}`}
          hideLabel
          value={draft}
          onChange={setDraft}
          placeholder="What's up?"
          size="sm"
          italic
          autoFocus
          error={problem ?? undefined}
          onEnter={() => void save()}
        />
      </div>
    );
  }

  const away = line.away !== null;
  const words = (
    <>
      <span className="nx-srv-you-is">
        you're <Name person={line.me} size="inline" /> here
      </span>
      {away || line.status ? (
        <>
          <Sep />
          <span className="nx-srv-you-status" data-away={away ? "yes" : undefined}>
            {away ? `“${line.away}”` : line.status}
          </span>
        </>
      ) : null}
    </>
  );

  return (
    <p className="nx-srv-line" data-kind="you">
      <span className="nx-srv-line-icon" aria-hidden="true" />
      {saveLine && !away ? (
        <button
          ref={button}
          type="button"
          className="nx-srv-line-text nx-srv-you"
          aria-label={`${openText(line)}. Change your status here`}
          onClick={() => {
            setDraft(line.status ?? "");
            setProblem(null);
            setEditing(true);
          }}
        >
          {words}
        </button>
      ) : (
        <span className="nx-srv-line-text">{words}</span>
      )}
    </p>
  );
}
