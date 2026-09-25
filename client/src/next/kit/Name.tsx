import type { User } from "../../generated/User";
import { nameProps } from "../../lib/names";
import "./Name.css";

export type NameSize = "meta" | "control" | "body" | "name" | "display";

/**
 * A person's name, drawn the way they styled it (SPEC §4.5): their face,
 * weight, slant, color or two-color gradient, and effect.
 *
 * The styling comes from `lib/names.ts`, the same engine the current client
 * uses, so a name looks identical in both. The name sits in a fixed line box
 * for its size: a tall face or a pixel face can never make a row taller or
 * push the next line down. Long names end in an ellipsis.
 *
 * `raw` draws the person's own style even when the reader has chosen plain
 * names, for the one place that must: the style picker's preview.
 */
export function Name({ person, size = "name", raw = false }: { person: User; size?: NameSize; raw?: boolean }) {
  const props = nameProps(person, raw ? "k-name name-raw" : "k-name");
  return (
    <span {...props} data-kit="Name" data-size={size}>
      {person.display_name}
    </span>
  );
}
