import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Port 1420 is Tauri's expected dev-server port (see src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Reuse the chosen icon without exposing unrelated repository files.
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(
          new URL("../assets/logo/Linger Pixel Porch Icon Set FINAL.png", import.meta.url),
        ),
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // Find every dependency at startup, the test pages' too. Otherwise one only
  // a test page uses (like Tauri's mocks) is found halfway through a
  // Playwright run, and the dev server reloads every open page under the
  // tests that were running.
  optimizeDeps: {
    entries: ["next.html", "tests/fixtures/*.html"],
  },
  build: {
    // WebKitGTK is the floor (ARCHITECTURE §2): keep output conservative.
    target: ["es2022", "safari15"],
    // Never embed an asset in the code as a `data:` URL, which Vite does to
    // any file under 4 KB. The shipped CSP allows only 'self' for fonts and
    // media, so an embedded one is refused: both Silkscreen faces were, in
    // every installed build, while dev mode served them as files and looked
    // fine (#318). `scripts/csp-assets.mjs` checks each build in CI.
    assetsInlineLimit: 0,
    // The app's one page, `next.html`, which every window opens
    // (`src-tauri/src/window.rs`).
    rollupOptions: {
      input: {
        next: fileURLToPath(new URL("next.html", import.meta.url)),
      },
    },
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
