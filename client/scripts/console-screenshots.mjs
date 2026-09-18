/** Capture the production Console with synthetic people, never a saved account. */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await page
          .getByRole("button", { name: "Join voice", exact: true })
          .click();
        await page.waitForTimeout(100);
        await page.mouse.move(700, 750);
        await page.screenshot({ path: resolve(output, `${theme}-voice.png`) });
        await page
          .getByRole("button", { name: "Jules, voice options", exact: true })
          .click();
        await page.screenshot({
          path: resolve(output, `${theme}-voice-options.png`),
        });
        await page.keyboard.press("Escape");
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
        await page.getByRole("button", { name: "Close", exact: true }).click();
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
  // Simulate the normal desktop state; do not present the browser's missing
  // keyring warning as the desktop welcome experience.
  await welcome.goto(`${origin}/tests/fixtures/welcome.html`);
  await welcome.getByRole("textbox", { name: "server or link" }).waitFor();
  await welcome.evaluate(() => document.fonts.ready);
  await welcome.locator(".auth-logo").evaluate((img) => img.decode());
  await welcome.screenshot({ path: resolve(output, "welcome.png") });
  const guide = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
  });
  await guide.goto(`${origin}/tests/fixtures/styleguide.html`);
  await guide
    .getByRole("heading", { name: "Clear controls. A little character." })
    .waitFor();
  await guide.evaluate(() => document.fonts.ready);
  await guide.screenshot({ path: resolve(output, "styleguide.png") });
  const review = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await review.goto(`${origin}/tests/fixtures/console.html`);
  await review.locator(".msg-body").first().waitFor();
  await review.evaluate(() => document.fonts.ready);
  await review
    .locator(".composer-input")
    .fill("I can stay for one more. Who's in?");
  await review.screenshot({ path: resolve(output, "chat.png") });
  await review
    .locator(".roster")
    .getByRole("button", { name: /Jules/ })
    .click();
  await review.mouse.move(700, 950);
  await review.screenshot({ path: resolve(output, "member.png") });
  await review.keyboard.press("Escape");
  await review
    .getByRole("button", { name: "Server options", exact: true })
    .click();
  await review.mouse.move(700, 950);
  await review.screenshot({ path: resolve(output, "server-options.png") });
  await review.keyboard.press("Escape");
  await review.getByRole("button", { name: "Settings", exact: true }).click();
  await review.getByRole("button", { name: "Appearance", exact: true }).click();
  await review.screenshot({ path: resolve(output, "appearance.png") });
  await review.getByRole("button", { name: "Profile", exact: true }).click();
  const styling = review
    .locator(".settings-section")
    .filter({
      has: review.getByRole("heading", { name: "Make yourself at home" }),
    });
  await styling
    .getByRole("button", { name: "two, blended", exact: true })
    .click();
  await styling
    .getByRole("group", { name: "from color", exact: true })
    .getByRole("button", { name: "rose", exact: true })
    .click();
  await styling
    .getByRole("group", { name: "to color", exact: true })
    .getByRole("button", { name: "amber", exact: true })
    .click();
  await styling.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await review.screenshot({ path: resolve(output, "your-style.png") });
  await review
    .getByRole("button", { name: "Edit status", exact: true })
    .click();
  const editor = review.locator(".status-editor");
  await editor
    .getByRole("textbox", { name: /^status / })
    .fill("Coffee on. Come hang out for a while.");
  await editor
    .getByRole("textbox", { name: "reading", exact: true })
    .fill("The Creative Act");
  await editor
    .getByRole("textbox", { name: "listening to", exact: true })
    .fill("Khruangbin · A LA SALA");
  await editor.locator("summary").click();
  await editor.locator(".status-draft-preview").scrollIntoViewIfNeeded();
  await review.screenshot({ path: resolve(output, "your-status.png") });
  await review
    .getByRole("button", { name: "Sound & voice", exact: true })
    .click();
  await review.screenshot({ path: resolve(output, "sound-settings.png") });

  for (const theme of ["dark", "light"]) {
    const memories = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await memories.goto(`${origin}/tests/fixtures/console.html?delight`);
    await memories.getByRole("button", { name: "Media", exact: true }).click();
    await memories.locator(".media-tile").first().waitFor();
    await memories.evaluate(() => document.fonts.ready);
    await memories
      .locator(".media-face img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode())),
      );
    await memories.locator(".media-star").first().click();
    await memories
      .getByText("Kept. Starred files don’t expire.", { exact: true })
      .waitFor();
    await memories.mouse.move(1200, 950);
    await memories.screenshot({
      path: resolve(output, `${theme}-memories.png`),
    });
    await memories.getByRole("button", { name: "Close media" }).click();
    await memories
      .getByRole("button", { name: "River at golden hour.svg", exact: true })
      .click();
    await memories
      .getByRole("dialog")
      .locator("img")
      .evaluate((image) => image.decode());
    await memories.screenshot({ path: resolve(output, `${theme}-photo.png`) });
    await memories.close();
  }

  // These offline renders exercise the same score as the app. They do not
  // open an audio device, play through mute, or contact a server.
  const samples = await review.evaluate(async () => {
    const { renderChimeSamples } = await import(
      "/tests/fixtures/chime-review.ts"
    );
    return renderChimeSamples();
  });
  const sounds = resolve(output, "sounds");
  await mkdir(sounds, { recursive: true });
  for (const { cue, rate, samples: pcm } of samples) {
    const wav = Buffer.alloc(44 + pcm.length * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24);
    wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(pcm.length * 2, 40);
    pcm.forEach((sample, index) =>
      wav.writeInt16LE(
        Math.round(Math.max(-1, Math.min(1, sample)) * 32767),
        44 + index * 2,
      ),
    );
    await writeFile(resolve(sounds, `${cue}.wav`), wav);
  }
  await writeFile(
    resolve(sounds, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Linger · Sound review</title><style>body{color-scheme:dark;background:#17191d;color:#ecebea;font:16px/1.6 system-ui;max-width:800px;margin:3rem auto;padding:0 1rem}h1{font-size:1.75rem}p{color:#b5bbc5}.sounds{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}section{border:1px solid #656d7c;padding:1rem}h2{font-size:1rem;font-weight:500;margin:0 0 1rem}audio{width:100%}</style><h1>A familiar little sound.</h1><p>Local review samples, rendered from the app’s synthesizer. Nothing autoplays. Start at a low speaker volume. These standalone samples do not read your in-app mute or quiet-hour preferences.</p><div class="sounds">${samples.map(({ cue }) => `<section><h2>${cue.replaceAll("-", " ")}</h2><audio controls preload="none" src="${cue}.wav"></audio></section>`).join("")}</div></html>`,
  );
  console.log(`Console screenshots: ${output}`);
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
}
