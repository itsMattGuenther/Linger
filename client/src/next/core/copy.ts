/**
 * Put words on the clipboard: true when they went, false when the clipboard
 * refused, so the caller can say so honestly rather than claim "Copied".
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
