import "./LogoMark.css";

/**
 * Linger's small mark, before the name in a title bar: the porch door with
 * the light on (assets/logo/linger-door.svg, which the tray icon is drawn
 * from too). The porch picture itself can't be read at 20px; its door, lit
 * window and lamp-lit step can. Drawn in token colors.
 */
export function LogoMark() {
  return (
    <svg className="nx-logomark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="nx-logomark-door" d="M5.2 21.2 V8.6 A6.8 6.8 0 0 1 18.8 8.6 V21.2 Z" />
      <path className="nx-logomark-window" d="M8.4 13 V9.4 A3.6 3.6 0 0 1 15.6 9.4 V13 Z" />
      <circle className="nx-logomark-lamp" cx="15.4" cy="16.6" r="1.15" />
      <rect className="nx-logomark-lamp" x="2.6" y="21" width="18.8" height="1.9" rx="0.95" />
    </svg>
  );
}
