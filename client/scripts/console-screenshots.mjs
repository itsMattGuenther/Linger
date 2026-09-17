/** Capture the production Console with synthetic people, never a saved account. */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const client = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(process.argv[2] ?? "../screenshots");
const port = 1422;
const origin = `http://127.0.0.1:${port}`;
await mkdir(output, { recursive: true });
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: client, stdio: "pipe" },
);
let logs = "";
vite.stdout.on("data", (chunk) => {
  logs += chunk;
});
vite.stderr.on("data", (chunk) => {
  logs += chunk;
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (vite.exitCode !== null) throw new Error(logs);
    try {
      ready =
        logs.includes(origin) &&
        (await fetch(`${origin}/tests/fixtures/console.html`)).ok;
    } catch {
      /* Starting. */
    }
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error(`Preview did not start. ${logs}`);
  browser = await chromium.launch({
    executablePath: process.env.LINGER_CHROMIUM_PATH,
  });
  for (const theme of ["dark", "light"]) {
    for (const [width, height] of [
      [1920, 1080],
      [1280, 820],
      [1100, 720],
      [760, 480],
    ]) {
      const page = await browser.newPage({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await page.goto(`${origin}/tests/fixtures/console.html`);
      await page.getByText("The Good Company", { exact: true }).waitFor();
      await page.locator(".msg-body").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      if (width === 1280) {
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
        await page.screenshot({
          path: resolve(output, `${theme}-appearance.png`),
        });
        await page.getByRole("button", { name: "close", exact: true }).click();
        await page
          .getByRole("button", { name: "join voice", exact: true })
          .click();
        await page.waitForTimeout(100);
        await page.screenshot({ path: resolve(output, `${theme}-voice.png`) });
        await page
          .getByRole("button", { name: "Jules, voice options", exact: true })
          .click();
        await page.screenshot({
          path: resolve(output, `${theme}-voice-options.png`),
        });
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
        await page.screenshot({
          path: resolve(output, `${theme}-voice-settings.png`),
        });
      }
      if (width === 760) {
        await page.getByRole("button", { name: "People", exact: true }).click();
        await page.screenshot({ path: resolve(output, `${theme}-people.png`) });
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Appearance", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Scale", exact: true })
          .selectOption("200");
        await page.getByRole("button", { name: "close", exact: true }).click();
        await page.waitForTimeout(350);
        await page.screenshot({
          path: resolve(output, `${theme}-760-200.png`),
        });
      }
      await page.close();
    }
  }
  for (const desktop of [100, 125]) {
    for (const scale of [100, 150, 200]) {
      const page = await browser.newPage({
        viewport: {
          width: 3840 / (desktop / 100),
          height: 2160 / (desktop / 100),
        },
        deviceScaleFactor: desktop / 100,
        colorScheme: "dark",
        reducedMotion: "reduce",
      });
      await page.addInitScript(
        (value) =>
          localStorage.setItem("linger.interface.scale", String(value)),
        scale,
      );
      await page.goto(`${origin}/tests/fixtures/console.html`);
      await page.locator(".msg-body").first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      await page.screenshot({
        path: resolve(
          output,
          desktop === 100
            ? `dark-4k-${scale}.png`
            : `dark-4k-desktop125-app${scale}.png`,
        ),
      });
      await page.close();
    }
  }
  const welcome = await browser.newPage({
    viewport: { width: 1100, height: 720 },
    colorScheme: "dark",
  });
  await welcome.goto(origin);
  await welcome.getByRole("textbox", { name: "server or link" }).waitFor();
  await welcome.evaluate(() => document.fonts.ready);
  await welcome.screenshot({ path: resolve(output, "welcome.png") });
  console.log(`Console screenshots: ${output}`);
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
