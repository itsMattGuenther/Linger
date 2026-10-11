import { useEffect, useState } from "react";
import { loadHideReactions, onAppearance } from "../core/appearance";

/**
 * Whether reactions are hidden on this computer (#485), as saved, and again
 * whenever Settings changes it: through the app's own announcement, and
 * through storage for a page with no app around it.
 */
export function useHideReactions(): boolean {
  const [hidden, setHidden] = useState(loadHideReactions);
  useEffect(() => {
    const again = () => setHidden(loadHideReactions());
    const stop = onAppearance(again);
    window.addEventListener("storage", again);
    return () => {
      stop();
      window.removeEventListener("storage", again);
    };
  }, []);
  return hidden;
}
