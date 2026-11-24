/**
 * The age the phone's app store holds for the person, where a law makes the
 * store share it (#953, SPEC §4.15). Linger is for people 13 and older on
 * both stores. Where Apple or Google says the app must check, the shell
 * asks the store (`src-tauri/src/phone_age.rs`) and answers `child` for a
 * person under 13, and `ok` for everybody else: anywhere no law applies, a
 * copy that can't ask, and every error.
 *
 * The list waits for the answer before it opens, for `ASK_WITHIN_MS` at most
 * (`app/list/AgeGate.tsx`): a store that's slow to answer must never keep
 * anybody out, so after that the list opens anyway, and an answer of `child`
 * that comes later still closes it. For a child, the list never opens, or
 * goes at once, with everything it had open; and every saved sign-in is
 * signed out of, from the saved sign-ins themselves, whether its server
 * answers or not (`signOutEverywhere`).
 *
 * The answer stays here, in memory, for as long as the page is open: it
 * isn't stored, sent anywhere or logged, and the next start asks again.
 */

/** What the shell's check said: `child` for a person under 13, and everything else is `ok`. */
export type AgeVerdict = "child" | "ok";

/** Where the page is: `unknown` until the check answers or is given up on. */
export type AgeState = AgeVerdict | "unknown";

/** The longest the list waits for the store before it opens anyway. */
export const ASK_WITHIN_MS = 3_000;

/** Only the shell's exact `child` is one: anything else it could say, or not say, lets the person in. */
export function verdictOf(answer: unknown): AgeVerdict {
  return answer === "child" ? "child" : "ok";
}

/** One check, asked once however often the page asks it, with whoever is listening told of a change. */
export interface AgeCheck {
  /** Asks the shell, the first time only; a failed or odd answer is `ok`. */
  ask(question: () => Promise<unknown>): Promise<void>;
  /** The wait is over without an answer: `ok` for now. A `child` answer that comes later still counts. */
  giveUp(): void;
  state(): AgeState;
  /** Signs a child out of everything, the first time it's asked to only. */
  leave(signOut: () => Promise<void>): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function ageCheck(): AgeCheck {
  let state: AgeState = "unknown";
  let asked: Promise<void> | null = null;
  let left: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const become = (next: AgeState) => {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    ask(question) {
      asked ??= Promise.resolve()
        .then(question)
        .then(
          (answer) => become(verdictOf(answer) === "child" ? "child" : state === "unknown" ? "ok" : state),
          () => become(state === "unknown" ? "ok" : state),
        );
      return asked;
    },
    giveUp() {
      if (state === "unknown") become("ok");
    },
    state: () => state,
    leave(signOut) {
      left ??= Promise.resolve()
        .then(signOut)
        .catch(() => undefined);
      return left;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The page's one check. */
export const phoneAge = ageCheck();

/** What signing out of everything takes from the shell and the servers. */
export interface LeaveShell {
  /** Every saved sign-in, the servers that didn't answer this time included. */
  saved(): Promise<readonly { baseUrl: string; refreshToken: string }[]>;
  /** The server forgets that sign-in, and with it this phone's notifications (PROTOCOL §5). */
  logout(baseUrl: string, refreshToken: string): Promise<void>;
  /** The phone forgets the saved sign-in, and the keys that server's notifications open with. */
  forget(baseUrl: string): Promise<void>;
  /** The servers the iPhone's share window keeps a sign-in of its own for; none elsewhere. */
  shareKept(): Promise<readonly string[] | null>;
  /** Stops keeping the share window's sign-in, answering with it, to sign out. */
  shareForget(baseUrl: string): Promise<string | null>;
}

/**
 * Signs out of every saved server, as Sign out does, from the saved sign-ins
 * themselves: the list may never have opened, and a server it couldn't reach
 * still has its sign-in kept here. Each server is told first, while the
 * sign-in is still known, then the phone forgets it; one that doesn't answer
 * is forgotten all the same. Then the share window's own sign-ins, the same
 * way. Nothing here stops for a failure.
 */
export async function signOutEverywhere(shell: LeaveShell): Promise<void> {
  const saved = await shell.saved().catch(() => []);
  await Promise.allSettled(
    saved.map(async ({ baseUrl, refreshToken }) => {
      await shell.logout(baseUrl, refreshToken).catch(() => undefined);
      await shell.forget(baseUrl);
    }),
  );
  const kept = (await shell.shareKept().catch(() => null)) ?? [];
  await Promise.allSettled(
    kept.map(async (baseUrl) => {
      const token = await shell.shareForget(baseUrl);
      if (token !== null) await shell.logout(baseUrl, token);
    }),
  );
}
