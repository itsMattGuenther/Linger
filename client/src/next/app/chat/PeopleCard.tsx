/**
 * Everybody behind a run of dots, by name: the people who joined voice in
 * one line (#473), and a poll's voters to come. A small card over what
 * opened it, as a big voice room's everyone card is, closed with Escape, its
 * own close, or what opened it.
 *
 * Drawn on the page's body, not where it was opened: a conversation's rows
 * are placed by a transform, and anything fixed inside one is fixed to the
 * row instead of the window.
 */
import { type RefObject, useRef } from "react";
import { createPortal } from "react-dom";
import type { User } from "../../../generated/User";
import { Name, Popover, Row, RowList } from "../../kit";
import { useAbove } from "../list/useAbove";
import { markerFor } from "../markers";
import "./PeopleCard.css";

export function PeopleCard({
  heading,
  label,
  people,
  anchor,
  onClose,
}: {
  /** The card's small label: "Joined voice". */
  heading: string;
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
  return createPortal(
    <Popover label={label} at={at} onClose={onClose}>
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
