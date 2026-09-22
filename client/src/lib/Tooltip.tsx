import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const GAP_PX = 4;
const EDGE_PX = 8;

/** Draw short help text outside clipped or transformed app surfaces. */
export default function Tooltip({
  anchor,
  id,
  children,
}: {
  anchor: HTMLElement;
  id: string;
  children: ReactNode;
}) {
  const tooltip = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<CSSProperties>({
    visibility: "hidden",
    top: 0,
    left: 0,
  });

  useLayoutEffect(() => {
    const node = tooltip.current;
    if (!node) return;

    const place = (): void => {
      const source = anchor.getBoundingClientRect();
      const size = node.getBoundingClientRect();
      const roomAbove = source.top;
      const roomBelow = window.innerHeight - source.bottom;
      const fitsAbove = roomAbove >= size.height + GAP_PX + EDGE_PX;
      const fitsBelow = roomBelow >= size.height + GAP_PX + EDGE_PX;
      const above = fitsAbove || (!fitsBelow && roomAbove > roomBelow);
      const desiredTop = above
        ? source.top - size.height - GAP_PX
        : source.bottom + GAP_PX;
      const desiredLeft = source.left + (source.width - size.width) / 2;

      setPlacement({
        visibility: "visible",
        top: Math.max(
          EDGE_PX,
          Math.min(desiredTop, window.innerHeight - size.height - EDGE_PX),
        ),
        left: Math.max(
          EDGE_PX,
          Math.min(desiredLeft, window.innerWidth - size.width - EDGE_PX),
        ),
      });
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, children]);

  return createPortal(
    <div
      ref={tooltip}
      id={id}
      className="ui-tooltip"
      role="tooltip"
      style={placement}
    >
      {children}
    </div>,
    document.body,
  );
}
