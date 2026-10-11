import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import { GROUPS, searchEmoji, shortcodeOf, type SkinTone, type UnicodeEmoji, withTone } from "../../../lib/emoji";
import { type RecentEmoji, recentEmoji, rememberEmoji, setSkinTone, skinTone } from "../../../lib/emoji/recent";
import { supportedVersion } from "../../../lib/emoji/support";
import { onPhone } from "../../core/phone";
import "./EmojiPicker.css";
import { useEmojiIndex } from "./useEmojiIndex";

/** What the picker hands the box: a Unicode emoji, or a server's own as `:name:`. */
export type PickedEmoji = { glyph: string } | { custom: CustomEmoji };

/** One cell of the grid. */
type Cell = { key: string; glyph: string; emoji: UnicodeEmoji } | { key: string; custom: CustomEmoji };

interface Section {
  id: string;
  label: string;
  /** What its tab shows: a glyph, or a server's emoji picture. */
  tab: { glyph: string } | { url: string };
  cells: Cell[];
}

/** The tones' own hands, for the tone button and its choices. */
const TONE_HANDS = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"] as const;
const TONE_NAMES = ["No skin tone", "Light skin tone", "Medium-light skin tone", "Medium skin tone", "Medium-dark skin tone", "Dark skin tone"] as const;
/**
 * A grid row, which the keyboard's Up and Down move by: nine on a computer,
 * as many as fit on a phone (EmojiPicker.css), so it's read from the grid.
 */
function across(cells: Element | null | undefined): number {
  const columns = cells ? getComputedStyle(cells).gridTemplateColumns.split(" ").length : 0;
  return columns > 0 ? columns : 9;
}

/**
 * Every emoji (#359), as Discord's picker has them: search at the top, tabs
 * for the groups (recently used and the server's own first), one scrolling
 * grid, and the name of whatever's under the pointer or the keyboard at the
 * bottom, so the shortcodes get learned. A skin tone chosen once applies to
 * every emoji that has one. Arrows move through the grid; Enter picks.
 */
export function EmojiPicker({
  custom,
  serverName,
  onPick,
  onClose,
  label = "Emoji",
  hint = "Type :name: in a message to skip the picker",
  floating = false,
}: {
  /** The conversation's server's own emoji. */
  custom: readonly CustomEmoji[];
  /** What the server's own section is called: its name. */
  serverName: string;
  onPick: (picked: PickedEmoji) => void;
  onClose: () => void;
  /** What it's for, to a screen reader: the message box's emoji, or a reaction (#485). */
  label?: string;
  /** The footer's line while nothing is pointed at. */
  hint?: string;
  /** Placed by whoever opened it (a reaction's, #485), not above the message box's button. */
  floating?: boolean;
}) {
  const index = useEmojiIndex(true);
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState<SkinTone>(skinTone);
  const [choosingTone, setChoosingTone] = useState(false);
  const [recent, setRecent] = useState<RecentEmoji[]>(recentEmoji);
  const [hovered, setHovered] = useState<Cell | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const grid = useRef<HTMLDivElement | null>(null);

  // Typing finds an emoji at once on a computer. On a phone the keyboard
  // would come up and cover half the picker, so it waits for a tap on the
  // search field.
  const phone = onPhone();
  useEffect(() => {
    if (!phone) search.current?.focus();
  }, [phone]);

  const drawable = useMemo(() => {
    if (index === null) return [];
    const newest = supportedVersion();
    return index.all.filter((emoji) => emoji.version <= newest);
  }, [index]);

  const unicodeCell = (emoji: UnicodeEmoji): Cell => ({ key: `u:${emoji.glyph}`, glyph: withTone(emoji, tone), emoji });
  const customCell = (one: CustomEmoji): Cell => ({ key: `c:${one.id}`, custom: one });

  const sections = useMemo((): Section[] => {
    if (index === null) return [];
    const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
    if (q !== "") {
      const own = custom.filter((one) => one.name.includes(q));
      const found = searchEmoji(drawable, q, 150);
      return [{ id: "results", label: own.length + found.length === 0 ? "Nothing by that name" : "Found", tab: { glyph: "🔍" }, cells: [...own.map(customCell), ...found.map(unicodeCell)] }];
    }
    const byName = new Map(custom.map((one) => [one.name, one]));
    const recentCells = recent.flatMap((one): Cell[] => {
      if (one.name !== undefined) {
        const own = byName.get(one.name);
        return own ? [customCell(own)] : [];
      }
      const emoji = one.glyph === undefined ? undefined : index.byGlyph.get(one.glyph);
      return emoji && emoji.version <= supportedVersion() ? [unicodeCell(emoji)] : [];
    });
    const out: Section[] = [];
    if (recentCells.length > 0) out.push({ id: "recent", label: "Recently used", tab: { glyph: "🕘" }, cells: recentCells });
    if (custom.length > 0) {
      const first = custom[0];
      out.push({ id: "custom", label: serverName, tab: first ? { url: first.url } : { glyph: "⭐" }, cells: custom.map(customCell) });
    }
    for (const group of GROUPS) {
      out.push({ id: `g${group.id}`, label: group.label, tab: { glyph: group.glyph }, cells: drawable.filter((emoji) => emoji.group === group.id).map(unicodeCell) });
    }
    return out;
    // `unicodeCell` and `customCell` only read `tone`, which is listed.
  }, [index, query, custom, drawable, recent, tone, serverName]);

  const pick = (cell: Cell) => {
    if ("custom" in cell) {
      setRecent(rememberEmoji({ name: cell.custom.name }));
      onPick({ custom: cell.custom });
    } else {
      setRecent(rememberEmoji({ glyph: cell.emoji.glyph }));
      onPick({ glyph: cell.glyph });
    }
  };

  const chooseTone = (next: SkinTone) => {
    setTone(next);
    setSkinTone(next);
    setChoosingTone(false);
    if (!phone) search.current?.focus();
  };

  // Arrows through the grid's buttons, a row at a time.
  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = across(grid.current?.querySelector(".nx-emoji-cells"));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -row, ArrowDown: row }[event.key];
    if (step === undefined) return;
    const cells = [...(grid.current?.querySelectorAll<HTMLButtonElement>(".nx-emoji-cell") ?? [])];
    const at = cells.findIndex((cell) => cell === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    const next = cells[Math.min(cells.length - 1, Math.max(0, at + step))];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
  };

  const named = hovered ?? null;
  const footName = named === null ? null : "custom" in named ? `:${named.custom.name}:` : `:${shortcodeOf(named.emoji)}:`;
  const footNote = named === null ? null : "custom" in named ? serverName : named.emoji.label;

  return (
    <div
      className="nx-emoji-picker"
      role="dialog"
      aria-label={label}
      data-floating={floating ? "yes" : undefined}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        if (choosingTone) setChoosingTone(false);
        else onClose();
      }}
    >
      <div className="nx-emoji-top">
        <input
          ref={search}
          className="nx-emoji-search"
          type="search"
          placeholder="Find an emoji"
          aria-label="Find an emoji"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const first = sections[0]?.cells[0];
              if (first) pick(first);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              grid.current?.querySelector<HTMLButtonElement>(".nx-emoji-cell")?.focus();
            }
          }}
        />
        <span className="nx-emoji-tone-anchor">
          <button type="button" className="nx-emoji-tone" aria-label={`Skin tone: ${TONE_NAMES[tone]}`} aria-expanded={choosingTone} onClick={() => setChoosingTone((open) => !open)}>
            {TONE_HANDS[tone]}
          </button>
          {choosingTone ? (
            <span className="nx-emoji-tones" role="group" aria-label="Skin tone">
              {TONE_HANDS.map((hand, at) => (
                <button key={hand} type="button" className="nx-emoji-tone" aria-label={TONE_NAMES[at]} aria-pressed={tone === at} onClick={() => chooseTone(at as SkinTone)}>
                  {hand}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      </div>

      {query.trim() === "" && sections.length > 0 ? (
        <nav className="nx-emoji-tabs" aria-label="Emoji groups">
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              className="nx-emoji-tab"
              aria-label={section.label}
              title={section.label}
              onClick={() => grid.current?.querySelector(`[data-section="${section.id}"]`)?.scrollIntoView({ block: "start" })}
            >
              {"url" in section.tab ? <img src={section.tab.url} alt="" draggable={false} /> : section.tab.glyph}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="nx-emoji-grid" ref={grid} onKeyDown={onGridKey}>
        {index === null ? <p className="nx-emoji-note">Getting the emoji…</p> : null}
        {sections.map((section) => (
          <section key={section.id} className="nx-emoji-section" data-section={section.id} aria-label={section.label}>
            <h3 className="nx-emoji-heading">{section.label}</h3>
            <div className="nx-emoji-cells">
              {section.cells.map((cell) =>
                "custom" in cell ? (
                  <button
                    key={cell.key}
                    type="button"
                    className="nx-emoji-cell"
                    aria-label={`:${cell.custom.name}:`}
                    onClick={() => pick(cell)}
                    onPointerEnter={() => setHovered(cell)}
                    onFocus={() => setHovered(cell)}
                  >
                    <img src={cell.custom.url} alt="" draggable={false} loading="lazy" />
                  </button>
                ) : (
                  <button
                    key={cell.key}
                    type="button"
                    className="nx-emoji-cell"
                    aria-label={cell.emoji.label}
                    onClick={() => pick(cell)}
                    onPointerEnter={() => setHovered(cell)}
                    onFocus={() => setHovered(cell)}
                  >
                    {cell.glyph}
                  </button>
                ),
              )}
            </div>
          </section>
        ))}
      </div>

      <footer className="nx-emoji-foot" aria-live="polite">
        {named === null ? (
          <span className="nx-emoji-foot-note">{hint}</span>
        ) : (
          <>
            <span className="nx-emoji-foot-glyph" aria-hidden="true">
              {"custom" in named ? <img src={named.custom.url} alt="" draggable={false} /> : named.glyph}
            </span>
            <span className="nx-emoji-foot-name">{footName}</span>
            <span className="nx-emoji-foot-note">{footNote}</span>
          </>
        )}
      </footer>
    </div>
  );
}
