/**
 * Everybody behind a run of dots, by name: the people who joined voice in
 * one line (#473), a poll's voters (#474), and who left a reaction, held on a
 * touch screen (#573). A small card over what opened it, as a big voice
 * room's everyone card is, closed with Escape, its own close, Back on a
 * phone, a press anywhere else, or what opened it.
 *
 * It takes the keyboard as it opens, so a screen reader is in it, and gives
 * it back to what opened it on Escape, its close or Back; a press elsewhere
 * leaves the focus to wherever it lands.
 *
 * Drawn on the page's body, not where it was opened: a conversation's rows
 * are placed by a transform, and anything fixed inside one is fixed to the
 * row instead of the window.
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { User } from "../../../generated/User";
import { Name, Popover, Row, RowList } from "../../kit";
import { useAbove } from "../list/useAbove";
import { markerFor } from "../markers";
import { useBackButton } from "../useBackButton";
import "./PeopleCard.css";

export function PeopleCard({
  heading,
  label,
  people,
  anchor,
  onClose,
}: {
  /** The card's small label: "Joined voice", or "Reacted with" and the emoji. */
  heading: ReactNode;
  /** Its name, for a screen reader: "Everyone who joined voice". */
  label: string;
  /** In the order they're to be read. */
  people: readonly User[];
  /** What opened it: the card sits over it. */
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement | null>(null);
  const at = useAbove(anchor, body);
  const closeBack = useCallback(() => {
    anchor.current?.focus({ preventScroll: true });
    onClose();
  }, [anchor, onClose]);
  useBackButton(true, closeBack);
  // Into the card as it opens: its close is the first thing in it.
  useEffect(() => {
    body.current?.parentElement?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      // What opened it closes it itself, as a toggle.
      if (body.current?.parentElement?.contains(event.target) || anchor.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anchor, onClose]);
  return createPortal(
    <Popover label={label} at={at} onClose={closeBack}>
      <div className="nx-people-card" ref={body}>
        <p className="nx-people-card-head">{heading}</p>
        <div className="nx-people-card-list">
          <RowList label={label}>
            {people.map((user) => (
              <Row key={user.id} lead={{ kind: "person", person: markerFor(user, "in_room") }} lines="one" title={<Name person={user} />} />
            ))}
          </RowList>
        </div>
      </div>
    </Popover>,
    document.body,
  );
}
