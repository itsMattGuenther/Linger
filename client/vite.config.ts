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
  build: {
    // WebKitGTK is the floor (ARCHITECTURE §2): keep output conservative.
    target: ["es2022", "safari15"],
    // Two clients: today's (`index.html`) and the Buddy list client under
    // development (`next.html`, M15), which the shell opens only when
    // LINGER_NEXT=1 (`src-tauri/src/window.rs`). Both ship in every build so
    // the hidden switch works in an installed copy too.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        next: fileURLToPath(new URL("next.html", import.meta.url)),
      },
    },
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
