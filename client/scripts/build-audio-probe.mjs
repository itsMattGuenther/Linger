// Bundle the production sound player into a test-only script for packaged WebViews.
import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildAudioProbe(output) {
  const result = await build({
    configFile: false,
    logLevel: "error",
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
