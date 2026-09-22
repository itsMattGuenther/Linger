// Test-only entry. Use real components and the package's existing stylesheet.
import "../tests/fixtures/console";
import { SCALE_OPTIONS, setInterfaceScale } from "../src/lib/interface";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resultTarget = window as Window & { __lingerLayoutResult?: unknown };
resultTarget.__lingerLayoutResult = { status: "pending" };

async function run() {
  const checks: unknown[] = [];
  for (let attempt = 0; !document.querySelector(".rail-dms .room-slug"); attempt++) {
    if (attempt > 100) throw new Error("Synthetic room and DM did not load");
    await wait(50);
  }
  for (const theme of ["dark", "light"]) {
    document.documentElement.dataset.theme = theme;
    for (const scale of SCALE_OPTIONS) {
      setInterfaceScale(scale);
      await wait(60);
      const navigation = document.querySelector<HTMLButtonElement>(".navigation-access");
      if (navigation) navigation.click();
      await wait(60);
      const rail = document.querySelector<HTMLElement>(".rail-content");
      if (!rail || !rail.getBoundingClientRect().width) throw new Error(`Missing visible rail at ${scale}%`);
      // Exercise the reserved scrollbar gutter even on an overlay-scrollbar host.
      rail.style.overflowY = "scroll";
      rail.style.scrollbarGutter = "stable";
      for (const height of [240, 400]) {
        rail.style.height = `${height}px`;
        rail.style.maxHeight = `${height}px`;
        await wait(40);
        const overflow = rail.scrollWidth - rail.clientWidth;
        const left = rail.getBoundingClientRect().left + rail.clientLeft;
        const right = left + rail.clientWidth;
        if (overflow > 1) throw new Error(`${theme} ${scale}% ${height}px: sideways rail overflow ${overflow}px`);
        for (const node of rail.querySelectorAll<HTMLElement>(".server-name, .room-slug, .rail-places")) {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (box.left < left - 1 || box.right > right + 1 || node.scrollWidth > node.clientWidth + 1)
            throw new Error(`${theme} ${scale}%: ${node.className} escapes the scroll box`);
          if (style.textOverflow === "ellipsis" || !["none", ""].includes(style.webkitLineClamp))
            throw new Error(`${node.className} truncates navigation text`);
        }
        checks.push({ theme, scale, height, overflow, gutter: rail.offsetWidth - rail.clientWidth });
      }
      document.querySelector<HTMLButtonElement>('button[aria-label="Close navigation"]')?.click();
    }
  }
  resultTarget.__lingerLayoutResult = { status: "passed", checks };
}
void run().catch((error: unknown) => {
  resultTarget.__lingerLayoutResult = { status: "failed", error: String(error) };
});
