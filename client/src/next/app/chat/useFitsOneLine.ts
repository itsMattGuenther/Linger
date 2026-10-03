import { type RefObject, useLayoutEffect, useState } from "react";

/**
 * Whether `words` fit on one line of a text box, in its own font, inside its
 * padding. For a hint that would otherwise wrap: a text box shows a hint's
 * second line out of sight, and Android's engine doesn't cut a text box's
 * hint with a "…" whatever the stylesheet says. Measured again when the box
 * changes size and when the fonts arrive.
 */
export function useFitsOneLine(box: RefObject<HTMLTextAreaElement | null>, words: string): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const pen = document.createElement("canvas").getContext("2d");
    if (!pen) return;
    let gone = false;
    const measure = () => {
      if (gone) return;
      const style = getComputedStyle(node);
      pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setFits(room <= 0 || pen.measureText(words).width <= room);
    };
    measure();
    void document.fonts.ready.then(measure);
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => {
      gone = true;
      watch.disconnect();
    };
  }, [box, words]);
  return fits;
}
