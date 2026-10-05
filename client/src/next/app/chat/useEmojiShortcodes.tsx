import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useState } from "react";
import type { CustomEmoji } from "../../../generated/CustomEmoji";
import { searchEmoji, shortcodeOf, type UnicodeEmoji, withTone } from "../../../lib/emoji";
import { skinTone } from "../../../lib/emoji/recent";
import { sameShortcode, type ShortcodeTyping, shortcodeAt } from "../../../lib/emoji/shortcodes";
import { supportedVersion } from "../../../lib/emoji/support";
import { type MenuAnchor, type OptionItem, OptionList, optionId } from "../../kit";
import { useEmojiIndex } from "./useEmojiIndex";

/** How many the list offers: a server's own first, then Unicode's. */
const SHOWN = 8;

/** What choosing one puts in: a Unicode emoji, or a server's own as `:name:`. */
export type ShortcodePick = { glyph: string } | { custom: CustomEmoji };

/**
 * The emoji the message box offers after a `:` and two characters (#359),
 * the way `@` offers people (`useMentions`): the box stays a combobox, the
 * keyboard never leaves it, Up and Down move, Enter or Tab chooses, Escape
 * closes and keeps what was typed. A server's own emoji come first.
 */
export function useEmojiShortcodes({
  box,
  anchor: anchorOf,
  conversation,
  custom,
  put,
}: {
  box: RefObject<HTMLTextAreaElement | null>;
  anchor: RefObject<HTMLElement | null>;
  conversation: string;
  custom: readonly CustomEmoji[];
  put: (typing: ShortcodeTyping, pick: ShortcodePick) => void;
}): {
  open: boolean;
  /** The combobox's attributes, while this list is the one open. */
  aria: { "aria-expanded": boolean; "aria-controls": string | undefined; "aria-activedescendant": string | undefined };
  track: (node: HTMLTextAreaElement) => void;
  close: () => void;
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  list: ReactNode;
} {
  const listId = useId();
  const [typing, setTyping] = useState<ShortcodeTyping | null>(null);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState<{ query: string; id: string } | null>(null);
  const index = useEmojiIndex(typing !== null);

  const track = (node: HTMLTextAreaElement) => {
    const next = node.selectionStart === node.selectionEnd ? shortcodeAt(node.value, node.selectionStart) : null;
    setTyping((held) => (sameShortcode(held, next) ? held : next));
    setDismissed((held) => (next !== null && next.start === held ? held : null));
  };

  useEffect(() => {
    setTyping(null);
    setDismissed(null);
  }, [conversation]);

  const drawable = useMemo(() => {
    if (index === null) return [];
    const newest = supportedVersion();
    return index.all.filter((emoji) => emoji.version <= newest);
  }, [index]);

  const matches = useMemo((): { id: string; pick: ShortcodePick; item: Omit<OptionItem, "id"> }[] => {
    if (typing === null) return [];
    const q = typing.query;
    const own = custom
      .filter((one) => one.name.includes(q))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, SHOWN);
    const tone = skinTone();
    const theirs: UnicodeEmoji[] = searchEmoji(drawable, q, SHOWN - own.length);
    return [
      ...own.map((one) => ({
        id: `c:${one.id}`,
        pick: { custom: one } as ShortcodePick,
        item: { lead: { kind: "picture" as const, url: one.url }, title: `:${one.name}:`, note: "this server", label: `${one.name}, this server's emoji` },
      })),
      ...theirs.map((emoji) => {
        const glyph = withTone(emoji, tone);
        return {
          id: `u:${emoji.glyph}`,
          pick: { glyph } as ShortcodePick,
          // Just the emoji and its name, as Discord's list: Unicode's long
          // description stays for a screen reader.
          item: { lead: { kind: "emoji" as const, glyph }, title: `:${shortcodeOf(emoji)}:`, label: `${shortcodeOf(emoji)}, ${emoji.label}` },
        };
      }),
    ];
  }, [typing, custom, drawable]);

  const open = typing !== null && typing.start !== dismissed && matches.length > 0;
  const activeId = !open
    ? null
    : active !== null && active.query === typing.query && matches.some((one) => one.id === active.id)
      ? active.id
      : (matches[0]?.id ?? null);

  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  useLayoutEffect(() => {
    const node = anchorOf.current;
    if (!open || !node) return;
    const measure = () => {
      const { top, left, right, bottom } = node.getBoundingClientRect();
      setAnchor((held) => (held && held.top === top && held.left === left && held.right === right && held.bottom === bottom ? held : { top, left, right, bottom }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      setAnchor(null);
    };
  }, [open, anchorOf]);

  const pick = (id: string | null) => {
    const chosen = matches.find((one) => one.id === id);
    const node = box.current;
    if (!chosen || !node) return;
    const now = node.selectionStart === node.selectionEnd ? shortcodeAt(node.value, node.selectionStart) : null;
    if (now === null) return;
    setTyping(null);
    put(now, chosen.pick);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || typing === null) return false;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return true;
    const at = matches.findIndex((one) => one.id === activeId);
    const move = (to: number) => {
      const next = matches[(to + matches.length) % matches.length];
      if (next) setActive({ query: typing.query, id: next.id });
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(at + 1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        move(at - 1);
        return true;
      case "Enter":
        if (event.shiftKey) return false;
        event.preventDefault();
        pick(activeId);
        return true;
      case "Tab":
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
        event.preventDefault();
        pick(activeId);
        return true;
      case "Escape":
        event.preventDefault();
        setDismissed(typing.start);
        return true;
      default:
        return false;
    }
  };

  const items = useMemo<OptionItem[]>(() => matches.map((one) => ({ id: one.id, ...one.item })), [matches]);

  return {
    open,
    aria: {
      "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open && activeId !== null ? optionId(listId, activeId) : undefined,
    },
    track,
    close: () => setTyping(null),
    onKey,
    list:
      open && anchor !== null && typing !== null ? (
        <OptionList
          id={listId}
          label="Emoji"
          items={items}
          active={activeId}
          anchor={anchor}
          onActive={(id) => setActive({ query: typing.query, id })}
          onPick={pick}
        />
      ) : null,
  };
}
