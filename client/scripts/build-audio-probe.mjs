// Bundle the production sound player into a test-only script for packaged WebViews.
import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildAudioProbe(output) {
  const layout = await build({
    configFile: false,
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "isolate-fixture-ipc",
      transform(code, id) {
        if (!id.includes("@tauri-apps")) return;
        // The native bridge is read-only. Give this test-only component bundle
        // its own mock bridge; never replace the installed app's IPC functions.
        return code.replaceAll("__TAURI_INTERNALS__", "__LINGER_TEST_INTERNALS__")
          .replaceAll("__TAURI_EVENT_PLUGIN_INTERNALS__", "__LINGER_TEST_EVENT_INTERNALS__");
      },
    }],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL("./native-layout-probe.ts", import.meta.url)),
        formats: ["iife"],
        name: "LingerLayoutProbe",
        cssFileName: "native-layout-probe",
      },
    },
  });
  const layoutOutputs = Array.isArray(layout) ? layout : [layout];
  const layoutScript = layoutOutputs.flatMap((entry) => entry.output).find((entry) => entry.type === "chunk");
  if (!layoutScript) throw new Error("No native layout probe was built");
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
  // Discard the fixture's CSS: assertions must inspect the shipped stylesheet,
  // not a test-only copy. Nothing from this bundle is included in the product.
  await writeFile(output, `window.__runNativeLayout = async () => {
    history.replaceState(null, "", "?longnames");
    document.body.innerHTML = '<div id="root"></div>';
    ${layoutScript.code}
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = window.__lingerLayoutResult;
      if (result?.status === "failed") throw new Error(result.error);
      if (result?.status === "passed") return result;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("Native layout probe timed out");
  };\n${script.code}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Supply the probe output path");
  await buildAudioProbe(resolve(process.argv[2]));
}
