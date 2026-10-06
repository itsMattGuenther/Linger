import type { MouseEvent } from "react";
import { Icon } from "./Icon";
import { Marker, type MarkerPerson } from "./Marker";
import "./MarkerCrowd.css";

/**
 * Everyone in a big voice room, one small marker each in their own color,
 * wrapping onto as many lines as it takes (#197). A marker is ringed in the
 * lamp while its person talks, so a busy room is seen as lights, never as a
 * number. The whole of it is one button, which opens everyone by name.
 */
export function MarkerCrowd({
  people,
  label,
  expanded = false,
  onActivate,
}: {
  /** In the room's order; `lit` while they're talking. */
  people: Array<MarkerPerson & { lit?: boolean }>;
  /** The button's name: what pressing it opens, like "Everyone in voice". */
  label: string;
  /** Whether what it opens is open now. */
  expanded?: boolean;
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button type="button" className="k-crowd" data-kit="MarkerCrowd" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={expanded} onClick={onActivate}>
      <span className="k-crowd-dots" aria-hidden="true">
        {people.map((person, index) => (
          <Marker key={index} color={person.color} state={person.state} size="sm" lit={person.lit ?? false} />
        ))}
      </span>
      <span className="k-crowd-go" aria-hidden="true">
        <Icon name="people" />
      </span>
    </button>
  );
}
