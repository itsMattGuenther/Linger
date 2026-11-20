import { type AnimationEvent, type PointerEvent, useState } from "react";
import type { User } from "../../generated/User";
import { nameProps, nameRuns } from "../../lib/names";
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
 *
 * `shine` lets a Shimmer's light cross the name, a few times and then never
 * again until something new happens (`useShine`): only the list and a
 * person's card pass it, and the style picker's preview. Everywhere else, a
 * conversation included, a shimmering name is still: its colors, no light.
 */
export function Name({
  person,
  size = "name",
  raw = false,
  dim = false,
  shine = false,
}: {
  person: User;
  size?: NameSize;
  raw?: boolean;
  dim?: boolean;
  shine?: boolean;
}) {
  const props = nameProps(person, raw ? "k-name name-raw" : "k-name");
  const shimmer = props["data-name-effect"] === "shimmer" && !dim;
  const light = useShine(shimmer && shine, person.id);
  // Emoji drawn apart from the letters, so a gradient or a shimmer doesn't paint them flat (#512).
  const runs = nameRuns(person.display_name);
  const letters =
    runs.length === 1 && !runs[0]?.emoji
      ? person.display_name
      : runs.map((run, index) =>
          run.emoji ? (
            <span key={index} className="k-name-emoji">
              {run.text}
            </span>
          ) : (
            run.text
          ),
        );
  return (
    <span {...props} data-kit="Name" data-size={size} data-dim={dim ? "yes" : undefined} onPointerEnter={light.point}>
      {/* A shimmering name's letters keep their direction to themselves, so a
          character in it that turns text around can't move the band's place
          after them (#488, #532). */}
      {shimmer ? <span className="k-name-letters">{letters}</span> : letters}
      {light.sweep ? <ShimmerBand key={`${person.display_name}\n${light.run}`} letters={person.display_name} sweep={light.sweep} onDone={light.rest} /> : null}
    </span>
  );
}

/** Which crossing a name's light is on: the few on arrival, or the one for a pointer. */
type Sweep = "arrive" | "point";

/**
 * When a Shimmer's light crosses a name: a few times when it shows up or its
 * lights come on (somebody back from idle, away or offline, or a new
 * Shimmer), once more when a pointer comes over it at rest, and otherwise
 * never. How many times each is `Name.css`'s to say.
 *
 * It used to cross forever. Anything that moves makes the page draw a new
 * frame every refresh, and in the Linux app each frame is the whole window
 * copied into place on the app's main thread: an idle list with Shimmer names
 * in it kept a 165 Hz NVIDIA desktop at 58% of a core and 50 W, visible or on
 * another workspace. Between crossings the band isn't there at all, so a list
 * at rest draws nothing.
 *
 * The band says when it's done (`rest`); a pointer over a name already
 * crossing changes nothing. A run counter keys the band, so every crossing
 * starts its window and its copy of the letters together. Somebody else in
 * the same place (a line of names that reuses this one for whoever is in it
 * now) has just shown up, so theirs arrives too.
 *
 * Pointing is a mouse or a pen. A finger on a phone lands on names to
 * scroll the list past them, and every one would cross; there their card is
 * what crosses a name again.
 *
 * A band that can't show (plain names, reduced motion, high contrast) never
 * runs, so it never ends: it waits, drawing nothing, and crosses once it
 * can, the names showing up in their own style again.
 */
function useShine(on: boolean, who: string) {
  const [light, setLight] = useState<{ on: boolean; who: string; sweep: Sweep | null; run: number }>({ on, who, sweep: on ? "arrive" : null, run: 0 });
  // Lights on, a new Shimmer or somebody new here: it arrives again. Lights
  // off: no band. Who is only asked while it can shine, so a name that never
  // does draws once when somebody else takes its place.
  const moved = on && light.who !== who;
  if (light.on !== on || moved) setLight({ on, who, sweep: on ? "arrive" : null, run: light.run + 1 });
  const current = light.on === on && !moved;
  const resting = on && current && light.sweep === null;
  return {
    sweep: on && current ? light.sweep : null,
    run: light.run,
    point: resting
      ? (event: PointerEvent) => {
          if (event.pointerType === "touch") return;
          setLight((now) => (now.on && now.sweep === null ? { ...now, sweep: "point", run: now.run + 1 } : now));
        }
      : undefined,
    rest: () => setLight((now) => ({ ...now, sweep: null })),
  };
}

/**
 * The shimmer's moving band (#532, `Name.css`): where it lives, the window
 * that slides across the name, and in it a copy of the letters drawn from
 * `data-letters`, so the copy is never selected, copied or read out. Its
 * caller keys it by the letters and the crossing, so a new name or a new
 * crossing starts the window and its copy again together: they move in step
 * only because they started together. It's there only while it crosses.
 */
function ShimmerBand({ letters, sweep, onDone }: { letters: string; sweep: Sweep; onDone: () => void }) {
  // The window's own end; its copy of the letters ends at the same moment.
  const ended = (event: AnimationEvent) => {
    if (event.animationName === "k-name-band" && event.target === event.currentTarget && !event.pseudoElement) onDone();
  };
  return (
    <span className="k-name-band-place" aria-hidden="true">
      <span className="k-name-band" data-letters={letters} data-sweep={sweep} onAnimationEnd={ended} />
    </span>
  );
}
