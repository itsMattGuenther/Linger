/**
 * "Open in Linger" (#607): an invite page's button is a `linger://` link, and
 * the computer hands it to Linger. The shell reads it strictly and turns it
 * into the link a person would have pasted (src-tauri/src/deep_link.rs); the
 * list window puts that in the "Server or link" box and nothing more. The
 * person sees the address and presses Continue, exactly as if they'd pasted
 * it, so a page can't make Linger contact anything by itself.
 */
import { parsePastedLink } from "../../lib/link";
import type { Bus } from "./bus";

/** The shell's word that a link is waiting (`deep_link::OFFERED`). It carries nothing. */
export const OFFERED_LINK = "next:link";

/** A link for the paste box, numbered so the same link opened twice is two offers. */
export interface Offered {
  link: string;
  n: number;
}

/**
 * Only an invite or a setup link: that's all an invite page sends. Read the
 * way the paste box reads it (`lib/link.ts`), as a second check on what the
 * shell already checked.
 */
export function offerable(link: string | null | undefined): string | null {
  if (typeof link !== "string" || link === "") return null;
  const read = parsePastedLink(link);
  return read !== null && (read.kind === "invite" || read.kind === "setup") ? link : null;
}

/**
 * Numbers each link as it comes. Made here rather than in a component, so
 * the list window keeps nothing of its own drawing with it (#534).
 */
export function numbering(offer: (offered: Offered) => void): (link: string) => void {
  let n = 0;
  return (link) => {
    n += 1;
    offer({ link, n });
  };
}

/**
 * Hear about links for as long as the list window is open. `take` asks the
 * shell for the waiting one, which also clears it: asked once at the start,
 * for the link that opened Linger, and again each time the shell says
 * another is waiting.
 */
export function watchOfferedLinks(bus: Pick<Bus, "listen">, take: () => Promise<string | null>, onLink: (link: string) => void): () => void {
  let gone = false;
  let stop: (() => void) | null = null;
  const ask = () => {
    void take().then(
      (link) => {
        const fit = offerable(link);
        if (!gone && fit !== null) onLink(fit);
      },
      () => undefined,
    );
  };
  void bus
    .listen<unknown>(OFFERED_LINK, ask)
    .then(
      (unlisten) => {
        if (gone) unlisten();
        else stop = unlisten;
      },
      () => undefined,
    )
    // Asking takes the link, so a window already gone doesn't ask: React's
    // development mode starts the list twice, and the first start would
    // take the link and drop it.
    .then(() => {
      if (!gone) ask();
    });
  return () => {
    gone = true;
    stop?.();
  };
}
