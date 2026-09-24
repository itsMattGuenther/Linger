import { useLayoutEffect, useRef, type RefObject } from "react";

/** The computed properties that decide where a textarea's lines wrap. */
const COPIED = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "fontStretch",
  "fontVariant",
  "fontFeatureSettings",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
] as const;

/**
 * Grow a textarea to fit what is in it, up to the height CSS allows (#127).
 *
 * The measuring happens on a hidden copy, never on the box being typed in.
 * The usual trick — set the real box to `height: auto`, read `scrollHeight`,
 * set it back — collapses a `rows={1}` box to one line on every keystroke.
 * The stream above it grows into the gap and shrinks back, so each letter
 * costs extra layouts of the whole window, and WebKit, which does not anchor
 * scroll position, clamps the stream off its live edge in between. On a slow
 * WebKitGTK frame that is enough for typing to outrun the letters.
 *
 * The copy has a fixed width and zero height with its overflow clipped, which
 * makes it its own layout boundary: measuring it does not ask the rest of the
 * page to move. The real box is written to only when its height changes, so a
 * keystroke that does not start or remove a line touches nothing but the text.
 */
export function useAutoGrow(box: RefObject<HTMLTextAreaElement | null>, value: string): void {
  const mirror = useRef<HTMLTextAreaElement | null>(null);
  const width = useRef(0);
  const applied = useRef("");
  const latest = useRef(value);
  latest.current = value;

  const fit = (element: HTMLTextAreaElement, copy: HTMLTextAreaElement, text: string): void => {
    const style = getComputedStyle(element);
    for (const key of COPIED) if (copy.style[key] !== style[key]) copy.style[key] = style[key];
    // Same outer width, padding and border as the real box, so the copy wraps
    // its lines in the same places.
    copy.style.width = `${width.current}px`;
    copy.value = text;
    const extra =
      style.boxSizing === "border-box"
        ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
        : -(parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));
    const height = `${copy.scrollHeight + extra}px`;
    // min-height and max-height on the real box still clamp this, so the CSS
    // stays the one place that says how small and how tall the box can be.
    if (height === applied.current && element.style.height === height) return;
    applied.current = height;
    element.style.height = height;
  };

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const copy = document.createElement("textarea");
    copy.setAttribute("aria-hidden", "true");
    copy.tabIndex = -1;
    copy.rows = 1;
    copy.readOnly = true;
    Object.assign(copy.style, {
      position: "absolute",
      top: "0",
      left: "-10000px",
      height: "0",
      minHeight: "0",
      maxHeight: "none",
      overflow: "hidden",
      visibility: "hidden",
      pointerEvents: "none",
      resize: "none",
    });
    document.body.appendChild(copy);
    mirror.current = copy;
    // Reading the width is a layout of the page, so it is read when the box
    // changes size rather than on every keystroke.
    width.current = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;
      if (next === width.current) return;
      width.current = next;
      fit(element, copy, latest.current);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      copy.remove();
      mirror.current = null;
    };
    // `fit` only reads refs, so this runs once per box, not per keystroke.
  }, [box]);

  useLayoutEffect(() => {
    const element = box.current;
    const copy = mirror.current;
    if (!element || !copy) return;
    fit(element, copy, value);
  }, [box, value]);
}
