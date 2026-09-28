import type { User } from "../../generated/User";
import { nameProps } from "../../lib/names";
import "./Name.css";

/**
 * The fixed sizes draw the name in its own line box. `inline` is for a name
 * inside a sentence ("Eli and Jules are talking", a reply's quote): it takes
 * the sentence's size and flows with its words, so a long sentence can still
 * end in an ellipsis.
 */
export type NameSize = "meta" | "control" | "body" | "name" | "display" | "inline";

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
 *
 * `dim` draws the name in a dim neutral grey instead of their color,
 * gradient, glow or shimmer, for somebody whose lights are off: idle, away or
 * offline, in the list's People rows (#274, #301). Their face, weight and
 * slant stay, so it still looks like their name; the color comes back the
 * moment they do, because the caller passes their presence as it is now.
 */
export function Name({ person, size = "name", raw = false, dim = false }: { person: User; size?: NameSize; raw?: boolean; dim?: boolean }) {
  const props = nameProps(person, raw ? "k-name name-raw" : "k-name");
  return (
    <span {...props} data-kit="Name" data-size={size} data-dim={dim ? "yes" : undefined}>
      {person.display_name}
    </span>
  );
}
