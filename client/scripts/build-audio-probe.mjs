// Bundle the production sound player into a test-only script for packaged WebViews.
import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildAudioProbe(output) {
  const result = await build({
    configFile: false,
    logLevel: "error",
    plugins: [{
      name: "isolate-audio-ipc",
      transform(code, id) {
        if (!id.includes("@tauri-apps")) return;
        // The player hands its sounds to the shell in the app (#250). This
        // probe measures the webview's own audio, so the bundle's copy of the
        // Tauri API talks to the probe's stand-in bridge, which says the shell
        // couldn't play. The app's own bridge is read-only and left alone.
        return code.replaceAll("__TAURI_INTERNALS__", "__LINGER_AUDIO_INTERNALS__");
      },
    }],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("../../scripts/audio-runtime-probe.js", import.meta.url)),
        formats: ["iife"],
        name: "LingerAudioProbe",
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  const script = outputs.flatMap((entry) => entry.output).find((entry) => entry.type === "chunk");
  if (!script) throw new Error("No audio probe was built");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, script.code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply the probe output path");
  await buildAudioProbe(resolve(process.argv[2]));
}
