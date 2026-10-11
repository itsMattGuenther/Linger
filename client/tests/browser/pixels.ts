import type { Page } from "@playwright/test";

/** A region of the page as RGBA pixels, four bytes a pixel, row by row. */
export interface Shot {
  w: number;
  h: number;
  data: Uint8Array;
}

/**
 * A region of the page as RGBA pixels, decoded by the page's own canvas.
 *
 * The pixels come back as one base64 string. As a list of numbers they were
 * most of a name test's time (about 1.6 s of a 5 s glow test, 30 times what
 * the string costs), and on a busy machine those tests ran out of theirs
 * (#528).
 */
export async function shoot(page: Page, clip: { x: number; y: number; width: number; height: number }, animations: "disabled" | "allow" = "disabled"): Promise<Shot> {
  const png = await page.screenshot({ clip, animations });
  const decoded = await page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.drawImage(bitmap, 0, 0);
    const bytes = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return { w: bitmap.width, h: bitmap.height, pixels: btoa(binary) };
  }, png.toString("base64"));
  return { w: decoded.w, h: decoded.h, data: new Uint8Array(Buffer.from(decoded.pixels, "base64")) };
}
