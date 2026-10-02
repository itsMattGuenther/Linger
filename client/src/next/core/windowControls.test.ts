import { describe, expect, it } from "vitest";
import { drawsMinimize } from "./windowControls";

const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("which windows Linger gives a minimize button (#386)", () => {
  it("the Windows app's, whose windows all have one", () => {
    expect(drawsMinimize(WEBVIEW2, true)).toBe(true);
  });

  it("not the Linux app's: a tiling desktop has no minimizing", () => {
    expect(drawsMinimize(WEBKITGTK, true)).toBe(false);
  });

  it("not a Mac's, and not a page in a browser on Windows", () => {
    expect(drawsMinimize(SAFARI, true)).toBe(false);
    expect(drawsMinimize(WEBVIEW2, false)).toBe(false);
  });
});
