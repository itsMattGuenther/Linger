import { IconButton } from "../../kit";

/** You're back at the computer and still away (#392). */
export interface AwayNudge {
  /** Leave it: you're staying away for now. */
  onDismiss: () => void;
}

/**
 * The line the top card shows when you come back to Linger and you're still
 * away (#392): easy to miss otherwise, and friends see you as away the whole
 * time. It only says so; I'm back is right above it, and nothing sets you
 * back by itself, because away is something you choose (SPEC §4.6).
 */
export function AwayNudgeLine({ nudge }: { nudge: AwayNudge }) {
  return (
    <p className="nx-you-nudge" role="status">
      <span className="nx-you-nudge-text">Welcome back. You're still away.</span>
      <IconButton icon="close" label="Stay away for now" size="sm" onClick={nudge.onDismiss} />
    </p>
  );
}
