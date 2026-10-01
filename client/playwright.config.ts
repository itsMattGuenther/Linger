import { defineConfig } from "@playwright/test";

// The page server's port. LINGER_TEST_PORT moves it, so a second copy of the
// repository (a git worktree) can run its tests while this one runs its own:
// with one fixed port, the second run's server can't start.
const port = Number(process.env.LINGER_TEST_PORT ?? 1421);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Stop well inside the CI job's own limit, so a hung run fails here — naming
  // the test still running and uploading evidence — rather than being killed
  // with its log. CI runs each engine in a job of its own, limited to 20
  // minutes; WebKit, the slower one, took about 12 by 2026-09-28, so CI now
  // runs it as two halves at once (`--shard`, ci.yml), each about 6.
  globalTimeout: process.env.CI ? 16 * 60_000 : undefined,
  workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // Text in grey smoothing only. With colored (LCD) smoothing, which
        // CI's image turns on, Chromium paints red and blue fringes on grey
        // letters wherever text sits on an opaque layer, and not where it's
        // on a layer of its own, like a list long enough to scroll. The
        // tests that measure a name's color pixel by pixel then depend on
        // how long the list is: a list that stopped scrolling (#351) made an
        // offline name read as colored (next-offline-names.spec.ts).
        launchOptions: { executablePath: process.env.LINGER_CHROMIUM_PATH, args: ["--disable-lcd-text"] },
      },
    },
    {
      name: "webkit",
      // On CI, a freshly started WebKit once took 25.5 seconds to open its
      // first tab, before the test had done anything, and two knock tests ran
      // out of their 30 (#335). Every other tab there opens in well under a
      // second. Locally, scripts/webkit.sh runs every worker's WebKit in one
      // container, and a test that takes 9 seconds on CI took a median 25
      // there; two ran out of their 30 (#368). Sixty is room for both, and
      // costs nothing unless something hangs; slow tests are still held to
      // 15 seconds on CI by the testing strategy.
      timeout: 60_000,
      use: {
        browserName: "webkit",
        // scripts/webkit.sh runs WebKit in Playwright's Ubuntu image, for the
        // systems its WebKit won't start on, and connects here. The container
        // shares this machine's network, so the pages load directly.
        connectOptions: process.env.LINGER_WEBKIT_WS ? { wsEndpoint: process.env.LINGER_WEBKIT_WS } : undefined,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/tests/fixtures/kit.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
