import {
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "../../../generated/User";
import { type MentionPerson, type MentionTyping, mentionAt, mentionMatches, sameTyping } from "../../core/chat/mentions";
import { type MenuAnchor, Name, type OptionItem, OptionList, optionId } from "../../kit";
import { markerFor } from "../markers";

/** The message box's side of the list: the combobox's attributes and the events that follow the caret. */
export interface MentionField {
  role: "combobox";
  "aria-autocomplete": "list";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
  onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onFocus: (event: FocusEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
}

/**
 * The people the message box offers after an `@` (#267, SPEC §4.2). The box
 * is a combobox and the list its listbox: the keyboard never leaves the box,
 * and the highlighted person is its `aria-activedescendant`, so a screen
 * reader says who it is.
 *
 * - Up and Down move; Enter or Tab puts in `@username` and a space; Escape
 *   closes the list and keeps what was typed. Enter with the list open never
 *   sends.
 * - While an input method is composing, nothing here moves: the list neither
 *   opens nor follows the keys until the composition ends.
 * - It closes when the box loses focus, and opens again on the same `@`
 *   when it comes back (unless Escape closed it there).
 *
 * `put` is the box's: it writes the chosen person in and puts the caret
 * after them.
 */
export function useMentions({
  box,
  anchor: anchorOf,
  conversation,
  people,
  put,
}: {
  box: RefObject<HTMLTextAreaElement | null>;
  /** What the list floats beside: the box's row. */
  anchor: RefObject<HTMLElement | null>;
  conversation: string;
  /** Who may be offered here, in order (`mentionable`). */
  people: readonly MentionPerson[];
  put: (typing: MentionTyping, user: User) => void;
}): {
  field: MentionField;
  /** Follow the caret after the box's text changed. */
  track: (node: HTMLTextAreaElement) => void;
  /** Called first on every key in the box: true when the list took it. */
  onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  list: ReactNode;
} {
  const listId = useId();
  const [typing, setTyping] = useState<MentionTyping | null>(null);
  // Where Escape closed the list: it stays closed on that `@`.
  const [dismissed, setDismissed] = useState<number | null>(null);
  // The highlighted person, for the query they were highlighted under;
  // typing more starts again at the top.
  const [active, setActive] = useState<{ query: string; id: string } | null>(null);
  const composing = useRef(false);

  const track = (node: HTMLTextAreaElement) => {
    if (composing.current) return;
    const next = node.selectionStart === node.selectionEnd ? mentionAt(node.value, node.selectionStart) : null;
    setTyping((held) => (sameTyping(held, next) ? held : next));
    setDismissed((held) => (next !== null && next.start === held ? held : null));
  };

  useEffect(() => {
    setTyping(null);
    setDismissed(null);
  }, [conversation]);

  const matches = useMemo(() => (typing === null ? [] : mentionMatches(people, typing.query)), [people, typing]);
  const open = typing !== null && typing.start !== dismissed && matches.length > 0;
  const first = matches[0]?.user.id ?? null;
  const activeId = !open
    ? null
    : active !== null && active.query === typing.query && matches.some((person) => person.user.id === active.id)
      ? active.id
      : first;

  // The box's place, while the list is open: read when it opens and again
  // only when the box or the window changes size, never per keystroke.
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  useLayoutEffect(() => {
    const node = anchorOf.current;
    if (!open || !node) return;
    const measure = () => {
      const { top, left, right, bottom } = node.getBoundingClientRect();
      setAnchor((held) =>
        held && held.top === top && held.left === left && held.right === right && held.bottom === bottom ? held : { top, left, right, bottom },
      );
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
    const person = matches.find((one) => one.user.id === id);
    const node = box.current;
    if (!person || !node) return;
    // Read the box again: the words the list was drawn for are the words there.
    const now = node.selectionStart === node.selectionEnd ? mentionAt(node.value, node.selectionStart) : null;
    if (now === null) return;
    setTyping(null);
    put(now, person.user);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || typing === null) return false;
    // While an input method composes, its keys are its own (Safari says so
    // with 229): the list stays where it is, and nothing here or in the box
    // acts on them. Nothing is prevented, so the input method still gets them.
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return true;
    const at = matches.findIndex((person) => person.user.id === activeId);
    const move = (to: number) => {
      const next = matches[(to + matches.length) % matches.length];
      if (next) setActive({ query: typing.query, id: next.user.id });
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
        // Shift+Enter is a new line, as ever; any other Enter chooses and never sends.
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

  const items = useMemo<OptionItem[]>(
    () =>
      matches.map(({ user, state }) => ({
        id: user.id,
        lead: { kind: "person", person: markerFor(user, state) },
        title: <Name person={user} />,
        note: `@${user.username}`,
        label: `${user.display_name}, @${user.username}`,
      })),
    [matches],
  );

  const field: MentionField = {
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": open,
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open && activeId !== null ? optionId(listId, activeId) : undefined,
    onSelect: (event) => track(event.currentTarget),
    onFocus: (event) => track(event.currentTarget),
    onBlur: () => setTyping(null),
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (event) => {
      composing.current = false;
      track(event.currentTarget);
    },
  };

  const list =
    open && anchor !== null && typing !== null ? (
      <OptionList
        id={listId}
        label="People to mention"
        items={items}
        active={activeId}
        anchor={anchor}
        onActive={(id) => setActive({ query: typing.query, id })}
        onPick={pick}
      />
    ) : null;

  return { field, track, onKey, list };
}
