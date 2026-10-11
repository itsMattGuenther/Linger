import { describe, expect, it } from "vitest";
import { followShimmer, shimmerPaintedByPage } from "./shimmer";

const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko)";

describe("which engine paints a Shimmer name's band itself (#532)", () => {
  it("is the Linux app's WebKitGTK only", () => {
    expect(shimmerPaintedByPage(WEBKITGTK, true)).toBe(true);
    // The compositor moves it: WebView2, Android's WebView, macOS's WebKit.
    expect(shimmerPaintedByPage(WEBVIEW2, true)).toBe(false);
    expect(shimmerPaintedByPage(ANDROID, true)).toBe(false);
    expect(shimmerPaintedByPage(MAC, true)).toBe(false);
    // A browser page (the tests' fixtures) isn't the app.
    expect(shimmerPaintedByPage(WEBKITGTK, false)).toBe(false);
  });

  it("marks the page for it, and leaves every other page alone", () => {
    const linux: { dataset: DOMStringMap } = { dataset: {} };
    followShimmer(linux, WEBKITGTK, true);
    expect(linux.dataset.shimmer).toBe("paint");
    const windows: { dataset: DOMStringMap } = { dataset: {} };
    followShimmer(windows, WEBVIEW2, true);
    expect(windows.dataset.shimmer).toBeUndefined();
  });
});
