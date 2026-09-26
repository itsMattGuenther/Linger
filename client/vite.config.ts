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
    entries: ["index.html", "next.html", "tests/fixtures/*.html"],
  },
  build: {
    // WebKitGTK is the floor (ARCHITECTURE §2): keep output conservative.
    target: ["es2022", "safari15"],
    // Two clients: the Buddy list (`next.html`), which the shell opens, and
    // today's (`index.html`), kept one release as a fallback behind
    // LINGER_CLASSIC=1 (`src-tauri/src/window.rs`). Both ship in every build
    // so the fallback works in an installed copy too.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        next: fileURLToPath(new URL("next.html", import.meta.url)),
      },
    },
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
