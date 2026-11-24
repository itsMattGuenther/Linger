/**
 * The age the phone's app store holds for the person, where a law makes the
 * store share it (#953, SPEC §4.15). Linger is for people 13 and older on
 * both stores. Where Apple or Google says the app must check, the shell
 * asks the store (`src-tauri/src/phone_age.rs`) and answers `child` for a
 * person under 13, and `ok` for everybody else: anywhere no law applies, a
 * copy that can't ask, and every error. The page never waits for it: the
 * list opens at once, and an answer of `child` takes its place.
 *
 * The answer stays here, in memory, for as long as the page is open: it
 * isn't stored, sent anywhere or logged, and the next start asks again.
 */

/** What the shell's check said: `child` closes the app, and everything else is `ok`. */
export type AgeVerdict = "child" | "ok";

/** Only the shell's exact `child` is one: anything else it could say, or not say, lets the person in. */
export function verdictOf(answer: unknown): AgeVerdict {
  return answer === "child" ? "child" : "ok";
}

/** One check, asked once however often the page asks it, with whoever is listening told of a change. */
export interface AgeCheck {
  /** Asks the shell, the first time only; a failed or odd answer leaves it `ok`. */
  ask(question: () => Promise<unknown>): Promise<void>;
  verdict(): AgeVerdict;
  subscribe(listener: () => void): () => void;
}

export function ageCheck(): AgeCheck {
  let verdict: AgeVerdict = "ok";
  let asked: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  return {
    ask(question) {
      asked ??= Promise.resolve()
        .then(question)
        .then(
          (answer) => {
            if (verdictOf(answer) !== "child") return;
            verdict = "child";
            for (const listener of [...listeners]) listener();
          },
          () => undefined,
        );
      return asked;
    },
    verdict: () => verdict,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The page's one check. */
export const phoneAge = ageCheck();
