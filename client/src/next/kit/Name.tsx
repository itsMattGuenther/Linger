import { type AnimationEvent, type CSSProperties, type PointerEvent, useState, useSyncExternalStore } from "react";
import type { User } from "../../generated/User";
import { type Arrival, ARRIVAL_ROUNDS, arrivalOf, CROSSING_MS, endArrival, lightAt, subscribeArrivals } from "../../lib/arrivals";
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
 * again until something new happens (`useShine`). `list`, for the list: when
 * its person arrives (`lib/arrivals.ts`). `open`, for a person's card, a
 * knock or "came into #room" card and the style picker's preview: when it
 * opens. Everywhere else, a conversation
 * included, a shimmering name is still: its colors, no light.
 */
export function Name({
  person,
  size = "name",
  raw = false,
  dim = false,
  shine,
}: {
  person: User;
  size?: NameSize;
  raw?: boolean;
  dim?: boolean;
  shine?: Shine;
}) {
  const props = nameProps(person, raw ? "k-name name-raw" : "k-name");
  const shimmer = props["data-name-effect"] === "shimmer" && !dim;
  const light = useShine(shimmer, person.id, shine);
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
      {light.crossing ? <ShimmerBand key={`${person.display_name}\n${light.crossing.key}`} letters={person.display_name} crossing={light.crossing} onDone={light.rest} /> : null}
    </span>
  );
}

/** Where a Shimmer's light crosses a name: in the list, or on something that opens. */
export type Shine = "list" | "open";

/** A crossing to draw: the few for an arrival, or the one for a pointer. */
interface Crossing {
  sweep: "arrive" | "point";
  rounds: number;
  /** How far in it starts, in milliseconds: an arrival's other names are already that far. */
  into: number;
  /** Keys the band, so each crossing starts its window and its copy of the letters together. */
  key: string;
  /** The arrival it belongs to, to end it. */
  at: number;
}

const noSubscribe = () => () => {};

/**
 * When a Shimmer's light crosses a name, and none of it while the name can't
 * shine (dimmed, or no Shimmer).
 *
 * In the list it crosses when its person arrives (`lib/arrivals.ts`): that is
 * the person's, not this name's, so a name rebuilt because the layout around
 * it changed shape picks the crossing up where their other names are, or is
 * still once it's over. Nothing about it is kept here.
 *
 * Something that opens (a person's card, a knock or "came into #room" card,
 * the style picker's preview) crosses when it does, and again when its
 * Shimmer comes on. A card that goes before its crossings are done takes
 * them with it.
 *
 * And either crosses once when a mouse or a pen comes over it at rest. A
 * finger on a phone lands on names to scroll past them, and every one would
 * cross; there their card is what crosses a name again.
 *
 * It used to cross forever. Anything that moves makes the page draw a new
 * frame every refresh, and in the Linux app each frame is the whole window
 * copied into place on the app's main thread: an idle list with Shimmer names
 * in it kept a 165 Hz NVIDIA desktop at 58% of a core and 50 W, visible or on
 * another workspace. Between crossings the band isn't there at all, so a list
 * at rest draws nothing.
 *
 * A band that can't show (plain names, reduced motion, high contrast) never
 * runs, so it never ends and draws nothing; the next time the name is drawn
 * after its time, it's gone.
 */
function useShine(on: boolean, who: string, shine: Shine | undefined) {
  const listed = useSyncExternalStore(shine === "list" ? subscribeArrivals : noSubscribe, () => (shine === "list" ? arrivalOf(who) : undefined));
  // A mouse's one crossing: whose name, and when. It lasts one crossing from
  // then, like an arrival's three, so one cut short by an arrival never comes
  // back after it, and one for somebody else's name is never theirs.
  const [pointed, setPointed] = useState<{ who: string; at: number } | null>(null);
  // Something that opens: its own arrival, when it opens and when its Shimmer comes on.
  const [opened, setOpened] = useState<{ on: boolean; arrival: Arrival | undefined }>(() => ({ on, arrival: shine === "open" && on ? { at: performance.now(), ended: false } : undefined }));
  // Its Shimmer coming on or going: something that opens arrives again, and
  // a mouse's crossing cut short by it is over.
  if (opened.on !== on) {
    setOpened({ on, arrival: shine === "open" && on ? { at: performance.now(), ended: false } : opened.arrival });
    setPointed(null);
  }

  const now = performance.now();
  const arrival = shine === "list" ? listed : opened.arrival;
  const into = on && shine ? lightAt(arrival, now) : null;
  const pointInto = on && shine && pointed?.who === who ? now - pointed.at : null;
  const crossing: Crossing | null =
    arrival && into !== null
      ? { sweep: "arrive", rounds: ARRIVAL_ROUNDS, into, key: `a${arrival.at}`, at: arrival.at }
      : pointed && pointInto !== null && pointInto >= 0 && pointInto < CROSSING_MS
        ? { sweep: "point", rounds: 1, into: pointInto, key: `p${pointed.at}`, at: pointed.at }
        : null;
  return {
    crossing,
    point:
      on && shine && crossing === null
        ? (event: PointerEvent) => {
            if (event.pointerType === "touch") return;
            setPointed({ who, at: performance.now() });
          }
        : undefined,
    rest: (done: Crossing) => {
      if (done.sweep === "point") setPointed((was) => (was?.at === done.at ? null : was));
      else if (shine === "list") endArrival(who, done.at);
      else setOpened((now) => (now.arrival?.at === done.at ? { ...now, arrival: { at: done.at, ended: true } } : now));
    },
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
function ShimmerBand({ letters, crossing, onDone }: { letters: string; crossing: Crossing; onDone: (done: Crossing) => void }) {
  // The window's own end; its copy of the letters ends at the same moment.
  const ended = (event: AnimationEvent) => {
    if (event.animationName === "k-name-band" && event.target === event.currentTarget && !event.pseudoElement) onDone(crossing);
  };
  // How many crossings, and how far into them it starts; its copy of the
  // letters reads the same two, so the two stay in step. Fixed when the band
  // is drawn: drawn again mid-crossing, a new delay would jump it ahead.
  const [timing] = useState(
    () => ({ "--name-shimmer-length": `${CROSSING_MS}ms`, "--name-shimmer-rounds": crossing.rounds, "--name-shimmer-delay": `${-Math.round(crossing.into)}ms` }) as CSSProperties,
  );
  return (
    <span className="k-name-band-place" aria-hidden="true">
      <span className="k-name-band" data-letters={letters} data-sweep={crossing.sweep} style={timing} onAnimationEnd={ended} />
    </span>
  );
}
