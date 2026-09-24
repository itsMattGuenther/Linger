import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Stop well inside the CI job's own limit, so a hung run fails here — naming
  // the test still running and uploading evidence — rather than being killed
  // with its log. A normal CI run takes about five minutes.
  globalTimeout: process.env.CI ? 12 * 60_000 : undefined,
  workers: process.env.CI ? 2 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:1421",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: { executablePath: process.env.LINGER_CHROMIUM_PATH },
      },
    },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 1421",
    url: "http://127.0.0.1:1421/tests/fixtures/attachments.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
