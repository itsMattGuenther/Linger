// Screenshot helper for the prototypes. Needs the dev server:
//   pnpm exec vite --port 1421
// then, from client/:
//   node prototypes/shoot.mjs /prototypes/buddy-list/ out.png [--w 1440] [--h 900]
//     [--light] [--wait 600] [--eval "js to run before the shot"]
// `?still&shots` is added to the URL so the moment is frozen and
// prototype-only controls are hidden.
import { chromium } from "@playwright/test";

const [, , path, out, ...rest] = process.argv;
const opt = { w: 1440, h: 900, wait: 700, eval: [], light: false, base: "http://localhost:1421" };
for (let i = 0; i < rest.length; i++) {
  const k = rest[i].replace(/^--/, "");
  if (k === "light") opt.light = true;
  else if (k === "eval") opt.eval.push(rest[++i]);
  else opt[k] = /^\d+$/.test(rest[i + 1]) ? Number(rest[++i]) : rest[++i];
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: opt.w, height: opt.h }, deviceScaleFactor: 1 });
await page.emulateMedia({ colorScheme: opt.light ? "light" : "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const sep = path.includes("?") ? "&" : "?";
await page.goto(`${opt.base}${path}${sep}still&shots`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
for (const js of opt.eval) {
  await page.evaluate(js);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(opt.wait);
await page.screenshot({ path: out });
await browser.close();
if (errors.length) console.error("page errors:\n" + errors.join("\n"));
console.log(out);
