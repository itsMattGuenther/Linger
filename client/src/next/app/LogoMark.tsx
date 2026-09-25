import "./LogoMark.css";

/**
 * The small mark before the server name in the list's title bar.
 *
 * A placeholder (docs/design/buddy-list.md, "Open questions"): Matt didn't
 * like the first small-logo attempts, and the mark will be redesigned. Until
 * then it is the pixel "L" on a dark tile with a cyan edge, from the logo's
 * wordmark panel, drawn in token colors and on whole pixels.
 */
export function LogoMark() {
  return (
    <svg className="nx-logomark" viewBox="0 0 10 10" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <rect className="nx-logomark-edge" x="0" y="0" width="10" height="10" />
      <rect className="nx-logomark-tile" x="1" y="1" width="8" height="8" />
      <rect className="nx-logomark-ink" x="3" y="2" width="2" height="6" />
      <rect className="nx-logomark-ink" x="5" y="6" width="2" height="2" />
      <rect className="nx-logomark-lamp" x="5" y="6" width="2" height="1" />
    </svg>
  );
}
