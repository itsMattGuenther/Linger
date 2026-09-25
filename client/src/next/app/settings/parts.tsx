import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon, Spinner } from "../../kit";

/**
 * How a save went. Every save in Settings is a callback that resolves to the
 * problem in words, or null (the list's you-card works the same way).
 */
export type SavePhase = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "problem"; words: string };

/** A save's phase, and a way to run one. A save that throws is said as "couldn't reach the server". */
export function useSave(): {
  phase: SavePhase;
  run: (work: Promise<string | null>) => Promise<boolean>;
  reset: () => void;
  fail: (words: string) => void;
} {
  const [phase, setPhase] = useState<SavePhase>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(async (work: Promise<string | null>) => {
    setPhase({ kind: "saving" });
    let words: string | null;
    try {
      words = await work;
    } catch {
      words = "Couldn't reach the server.";
    }
    if (!alive.current) return words === null;
    setPhase(words === null ? { kind: "saved" } : { kind: "problem", words });
    return words === null;
  }, []);
  const reset = useCallback(() => setPhase({ kind: "idle" }), []);
  const fail = useCallback((words: string) => setPhase({ kind: "problem", words }), []);
  return { phase, run, reset, fail };
}

/**
 * One part of a section: its heading, the sentence under it, and its
 * controls. The heading is a real heading, for moving through the page.
 */
export function Block({ heading, lead, children }: { heading: string; lead?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="nx-set-block" aria-labelledby={id}>
      <h3 id={id} className="nx-set-heading">
        {heading}
      </h3>
      {lead ? <p className="nx-set-lead">{lead}</p> : null}
      {children}
    </section>
  );
}

/** A block without its own heading, for controls that bring their own (`ChoiceCards` has a legend). */
export function Plain({ children }: { children: ReactNode }) {
  return <section className="nx-set-block">{children}</section>;
}

/**
 * The end of a form: how the last save went, on the left, and the buttons on
 * the right. The words sit on the buttons' line, so saving never moves
 * anything below it.
 */
export function Actions({ phase, saved = "Saved", children, start = false }: { phase?: SavePhase; saved?: string; children: ReactNode; start?: boolean }) {
  return (
    <div className="nx-set-actions" data-start={start ? "yes" : undefined}>
      <SaveLine phase={phase ?? { kind: "idle" }} saved={saved} />
      <span className="nx-set-buttons">{children}</span>
    </div>
  );
}

/** "Saved", or what went wrong, in words. Always present, so screen readers hear it change. */
export function SaveLine({ phase, saved = "Saved" }: { phase: SavePhase; saved?: string }) {
  return (
    <p className="nx-set-said" role="status" data-kind={phase.kind}>
      {phase.kind === "saved" ? (
        <>
          <Icon name="check" size="sm" />
          <span>{saved}</span>
        </>
      ) : phase.kind === "problem" ? (
        <span>{phase.words}</span>
      ) : phase.kind === "saving" ? (
        <>
          <Spinner />
          <span>Saving…</span>
        </>
      ) : null}
    </p>
  );
}

/** A line of words under a block: a note, or how something stands right now. */
export function Note({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "status" | "problem" }) {
  return (
    <p className="nx-set-note" data-tone={tone} role={tone === "quiet" ? undefined : "status"}>
      {children}
    </p>
  );
}

/** Fields side by side while they fit, one under another when the window is narrow. */
export function Fields({ children, columns = 2 }: { children: ReactNode; columns?: 2 | 3 }) {
  return (
    <div className="nx-set-fields" data-columns={columns}>
      {children}
    </div>
  );
}

/**
 * A labelled row of small choices, one of which is picked: pressed buttons
 * in a named group. The label sits in a column of its own, so every row's
 * choices start on one edge.
 */
export function ChoiceRow({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="nx-set-choice-row">
      <span id={id} className="nx-set-choice-label">
        {label}
      </span>
      <div className="nx-set-choices" role="group" aria-labelledby={id}>
        {children}
      </div>
    </div>
  );
}
