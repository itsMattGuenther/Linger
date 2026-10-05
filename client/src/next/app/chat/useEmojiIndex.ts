import { useEffect, useSyncExternalStore } from "react";
import { type EmojiIndex, emojiIndex, loadEmoji, onEmojiLoaded } from "../../../lib/emoji";

/**
 * The emoji list (#359), loading it when `want` is true and it isn't in yet.
 * Everything that asked for it draws again once it arrives.
 */
export function useEmojiIndex(want: boolean): EmojiIndex | null {
  const index = useSyncExternalStore(onEmojiLoaded, emojiIndex, emojiIndex);
  useEffect(() => {
    if (want && index === null) void loadEmoji();
  }, [want, index]);
  return index;
}
