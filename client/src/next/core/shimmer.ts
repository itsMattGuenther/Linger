/**
 * How a Shimmer name's band is drawn in this window (#532, `kit/Name.css`).
 *
 * The band crosses the name for as long as it's on screen, so its cost is
 * paid every frame, and each engine is cheapest a different way. Chromium
 * (WebView2 on Windows, Android's WebView) moves a window and a copy of the
 * letters by `transform` on its compositor, and the page does nothing per
 * frame: measured on one name, 6% of a core became 3% drawing without the
 * GPU and 15% became 5% with it. WebKitGTK, the Linux app's engine, went
 * the other way: with those layers moving, its window and the desktop's
 * compositor did more work every frame (1.5% of a core became 3.7%), and
 * without the GPU it drew more, not less. There the page keeps painting the
 * band as a background moved by `background-position`, as it always has.
 * Both look the same.
 */

/** The Linux app, where WebKitGTK paints the band cheapest itself. */
export function shimmerPaintedByPage(userAgent: string, desktop: boolean): boolean {
  return desktop && /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent);
}

/**
 * Marks the page for the painted band where that's the cheaper way
 * (`:root[data-shimmer="paint"]`, `kit/Name.css`).
 */
export function followShimmer(root: { dataset: DOMStringMap }, userAgent: string, desktop: boolean): void {
  if (shimmerPaintedByPage(userAgent, desktop)) root.dataset.shimmer = "paint";
}
