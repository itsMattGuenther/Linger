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
  const shimmer = props["data-name-effect"] === "shimmer" && !dim;
  return (
    <span {...props} data-kit="Name" data-size={size} data-dim={dim ? "yes" : undefined}>
      {/* A shimmering name's letters keep their direction to themselves, so a
          character in it that turns text around can't move the band's place
          after them (#488, #532). */}
      {shimmer ? <span className="k-name-letters">{person.display_name}</span> : person.display_name}
      {shimmer ? <ShimmerBand key={person.display_name} letters={person.display_name} /> : null}
    </span>
  );
}

/**
 * The shimmer's moving band (#532, `Name.css`): where it lives, the window
 * that slides across the name, and in it a copy of the letters drawn from
 * `data-letters`, so the copy is never selected, copied or read out. Its
 * caller keys it by the letters, so a new name starts the window and its copy
 * again together: they move in step only because they started together.
 */
function ShimmerBand({ letters }: { letters: string }) {
  return (
    <span className="k-name-band-place" aria-hidden="true">
      <span className="k-name-band" data-letters={letters} />
    </span>
  );
}
