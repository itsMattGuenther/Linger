import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import type { Message } from "../../../generated/Message";
import type { ReactionGroup } from "../../../generated/ReactionGroup";
import type { User } from "../../../generated/User";
import { recentEmoji } from "../../../lib/emoji/recent";
import { customIdOf, customKey, reactedWords } from "../../../lib/reactions";
import { onPhone } from "../../core/phone";
import { Icon, type MenuAnchor } from "../../kit";
import { useTooltip } from "../../kit/Tooltip";
import { EmojiPicker } from "./EmojiPicker";
import "./Reactions.css";

/**
 * What a conversation's rows need for reactions (#485), handed down whole.
 * Left out where reactions are off: a room the host turned them off in, or
 * everywhere for somebody who hid them (Settings → Appearance).
 */
export interface ReactionKit {
  /** Leave yours (`on`) or take it back. A refusal rejects with a sentence. */
  toggle: (message: Message, key: string, on: boolean) => Promise<void>;
  /** The server's own emoji, for the picker. */
  custom: readonly CustomEmoji[];
  /** The same, by id: a reaction names one by its id. */
  byId: ReadonlyMap<string, CustomEmoji>;
  /** What the picker calls the server's own emoji. */
  serverName: string;
}

/** One reaction's emoji: the glyph, or a server's own picture. */
function Glyph({ reactionKey, byId }: { reactionKey: string; byId: ReadonlyMap<string, CustomEmoji> }) {
  const id = customIdOf(reactionKey);
  const custom = id === null ? undefined : byId.get(id);
  if (custom) return <img className="nx-react-custom" src={custom.url} alt="" draggable={false} />;
  return <span className="nx-react-glyph">{reactionKey}</span>;
}

/** What a reaction is called, out loud: the emoji, or a server's own by name. */
function nameOf(key: string, byId: ReadonlyMap<string, CustomEmoji>): string {
  const id = customIdOf(key);
  if (id === null) return key;
  const custom = byId.get(id);
  return custom ? `:${custom.name}:` : "an emoji";
}

/**
 * A message's reactions (SPEC §4.8, #485): a pill per emoji with how many
 * people left it, yours blue, who on hover; then a smiley-plus while there's
 * room for another, shown on hover on a computer and always on a phone.
 */
export function ReactionPills({
  groups,
  meId,
  people,
  kit,
  onToggle,
  onAdd,
}: {
  groups: readonly ReactionGroup[];
  meId: string | null;
  people: ReadonlyMap<string, User>;
  kit: ReactionKit;
  onToggle: (key: string, on: boolean) => void;
  /** Open the picker beside this box; left out at six. */
  onAdd?: (anchor: MenuAnchor) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="nx-reactions" role="group" aria-label="Reactions">
      {groups.map((group) => (
        <Pill key={group.key} group={group} meId={meId} people={people} kit={kit} onToggle={onToggle} />
      ))}
      {onAdd ? (
        <button
          type="button"
          className="nx-react-pill nx-react-add"
          aria-label="Add a reaction"
          title="Add a reaction"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onAdd({ top: box.top, bottom: box.bottom, left: box.left, right: box.right });
          }}
        >
          <Icon name="react" size="sm" />
        </button>
      ) : null}
    </div>
  );
}

function Pill({
  group,
  meId,
  people,
  kit,
  onToggle,
}: {
  group: ReactionGroup;
  meId: string | null;
  people: ReadonlyMap<string, User>;
  kit: ReactionKit;
  onToggle: (key: string, on: boolean) => void;
}) {
  const mine = meId !== null && group.user_ids.includes(meId);
  const names = group.user_ids.map((id) => (id === meId ? "You" : (people.get(id)?.display_name ?? "Somebody")));
  const id = customIdOf(group.key);
  const words = reactedWords(names, id === null ? null : (kit.byId.get(id)?.name ?? null));
  const tip = useTooltip(words);
  return (
    <>
      <button
        type="button"
        className="nx-react-pill"
        data-mine={mine ? "yes" : undefined}
        aria-pressed={mine}
        aria-label={`${nameOf(group.key, kit.byId)} ${group.count}. ${words}.`}
        onClick={() => onToggle(group.key, !mine)}
        {...tip.anchorProps}
      >
        <Glyph reactionKey={group.key} byId={kit.byId} />
        <span className="nx-react-count">{group.count}</span>
      </button>
      {tip.bubble}
    </>
  );
}

/** The gap between a picker and what opened it, and the closest it comes to an edge. */
const GAP = 6;
const EDGE = 8;

/**
 * The picker a reaction is chosen from (#485), floating over the
 * conversation by whatever opened it: above it when there's room, else below,
 * its right edge on the opener's. On a phone it fills the bottom of the
 * screen. With six different reactions on the message already, it offers
 * only those six and says why. A click outside or Escape closes it.
 */
export function ReactionPicker({
  anchor,
  who,
  kit,
  full,
  meId,
  onPick,
  onClose,
}: {
  anchor: MenuAnchor;
  /** Whose message, for its label. */
  who: string;
  kit: ReactionKit;
  /** The message's six, when it has six; null when there's room for more. */
  full: readonly ReactionGroup[] | null;
  meId: string | null;
  onPick: (key: string) => void;
  /** Escape gives the opener the keyboard back; a click elsewhere doesn't. */
  onClose: (refocus: boolean) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const phone = onPhone();
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node || phone) return;
    const size = node.getBoundingClientRect();
    const right = anchor.right;
    const above = anchor.top - GAP - size.height >= EDGE;
    const top = above ? anchor.top - GAP - size.height : Math.min(anchor.bottom + GAP, window.innerHeight - EDGE - size.height);
    const left = Math.min(Math.max(right - size.width, EDGE), window.innerWidth - EDGE - size.width);
    setPlace({ top: Math.max(EDGE, top), left });
  }, [anchor, phone]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      onClose(false);
    };
    // On the next tick, so the click that opened it doesn't close it.
    const timer = window.setTimeout(() => document.addEventListener("pointerdown", outside), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", outside);
    };
  }, [onClose]);

  const label = `React to ${who}'s message`;
  return createPortal(
    <div
      ref={box}
      className="nx-react-picker"
      data-phone={phone ? "yes" : undefined}
      data-placed={phone || place ? "yes" : "no"}
      style={place && !phone ? { top: place.top, left: place.left } : undefined}
    >
      {full ? (
        <FullPicker groups={full} kit={kit} meId={meId} label={label} onPick={onPick} onClose={() => onClose(true)} />
      ) : (
        <EmojiPicker
          custom={kit.custom}
          serverName={kit.serverName}
          label={label}
          hint={`Pick one to react to ${who}'s message`}
          floating
          onPick={(picked) => onPick("glyph" in picked ? picked.glyph : customKey(picked.custom))}
          onClose={() => onClose(true)}
        />
      )}
    </div>,
    document.body,
  );
}

/** At six: only the six already on the message, and why. */
function FullPicker({
  groups,
  kit,
  meId,
  label,
  onPick,
  onClose,
}: {
  groups: readonly ReactionGroup[];
  kit: ReactionKit;
  meId: string | null;
  label: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div
      className="nx-react-full"
      role="dialog"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="nx-react-full-row">
        {groups.map((group, at) => {
          const mine = meId !== null && group.user_ids.includes(meId);
          return (
            <button
              key={group.key}
              ref={at === 0 ? first : undefined}
              type="button"
              className="nx-react-cell"
              data-mine={mine ? "yes" : undefined}
              aria-pressed={mine}
              aria-label={nameOf(group.key, kit.byId)}
              onClick={() => onPick(group.key)}
            >
              <Glyph reactionKey={group.key} byId={kit.byId} />
            </button>
          );
        })}
      </div>
      <p className="nx-react-full-note">This message has six different reactions, the most it can hold. Add yours to one of these.</p>
    </div>
  );
}

/** What the phone's row starts with until you've used six of your own. */
const QUICK_DEFAULTS = ["❤️", "😂", "👍", "🔥", "😮", "😢"];

/** The emoji you've used lately (#359), as reaction keys: six, topped up with the usual ones. */
export function quickKeys(kit: ReactionKit): string[] {
  const byName = new Map(kit.custom.map((one) => [one.name, one]));
  const used = recentEmoji().flatMap((one) => {
    if (one.name !== undefined) {
      const custom = byName.get(one.name);
      return custom ? [customKey(custom)] : [];
    }
    return one.glyph === undefined ? [] : [one.glyph];
  });
  return [...new Set([...used, ...QUICK_DEFAULTS])].slice(0, 6);
}

/**
 * On a phone, the top of a message's sheet (#485): the six emoji you use
 * most, and a smiley-plus for every emoji. Each is a menu item, so the sheet's
 * keyboard moves through them with the rest. At six different reactions on
 * the message, only those six.
 */
export function QuickReactions({
  kit,
  keys,
  mine,
  onPick,
  onMore,
}: {
  kit: ReactionKit;
  keys: readonly string[];
  /** The ones you've left on this message. */
  mine: ReadonlySet<string>;
  onPick: (key: string) => void;
  /** Every emoji; left out at six. */
  onMore?: () => void;
}) {
  return (
    <div className="nx-react-quick" role="group" aria-label="React">
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="nx-react-cell"
          data-mine={mine.has(key) ? "yes" : undefined}
          aria-label={nameOf(key, kit.byId)}
          onClick={() => onPick(key)}
        >
          <Glyph reactionKey={key} byId={kit.byId} />
        </button>
      ))}
      {onMore ? (
        <button type="button" role="menuitem" tabIndex={-1} className="nx-react-cell nx-react-more" aria-label="Every emoji" onClick={onMore}>
          <Icon name="react" size="md" />
        </button>
      ) : null}
    </div>
  );
}
