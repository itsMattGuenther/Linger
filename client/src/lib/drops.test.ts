import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { refuseStrayDrops } from "./drops";

/** A drag event as the page would get it: cancelable, with a drop effect to set. */
function drag(type: string): Event & { dataTransfer: { dropEffect: string } } {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: { dropEffect: "copy" } });
}

describe("files dropped where nothing takes them (COMP-11)", () => {
  it("are refused, rather than opened in place of the app", () => {
    const page = new EventTarget();
    const stop = refuseStrayDrops(page as unknown as Window);
    const over = drag("dragover");
    page.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe("none");
    const drop = drag("drop");
    page.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    stop();
    const after = drag("drop");
    page.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("leave a drop zone that took the file alone", () => {
    const page = new EventTarget();
    // The message box accepts first, as its handler runs before the window's.
    page.addEventListener("dragover", (event) => event.preventDefault());
    refuseStrayDrops(page as unknown as Window);
    const over = drag("dragover");
    page.dispatchEvent(over);
    expect(over.dataTransfer.dropEffect).toBe("copy");
  });

  it("is on in both clients", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const entry of ["main.tsx", "next/main.tsx"]) {
      expect(readFileSync(join(src, entry), "utf8"), entry).toContain("refuseStrayDrops(window);");
    }
  });
});
