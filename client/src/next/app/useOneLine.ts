import { useEffect, useState } from "react";
import { loadOneLine, onAppearance } from "../core/appearance";

/**
 * One line per person in the list (#197), as saved on this computer, and
 * again whenever Settings changes it: through the app's own announcement,
 * and through storage for a page with no app around it.
 */
export function useOneLine(): boolean {
  const [on, setOn] = useState(loadOneLine);
  useEffect(() => {
    const again = () => setOn(loadOneLine());
    const stop = onAppearance(again);
    window.addEventListener("storage", again);
    return () => {
      stop();
      window.removeEventListener("storage", again);
    };
  }, []);
  return on;
}
