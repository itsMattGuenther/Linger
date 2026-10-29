// The packaged-app checks start Linger without any setting from the caller's
// shell that changes what WebKit, GStreamer, GTK or the graphics drivers do
// (#765). #757's review found #756's own workaround would have passed for
// the fix; this is every such setting, not a list of the known ones.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cleanEnvironment, SETTING_FAMILIES } from "./linux-next-env.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a setting in any of the families is left out, and named; the rest of the shell isn't", () => {
  const settings = {
    // #756's workaround, which #757's review found could pass for the fix.
    WEBKIT_GST_DISABLE_GL_SINK: "1",
    WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    JSC_useJIT: "false",
    GST_PLUGIN_FEATURE_RANK: "nvh264dec:MAX",
    PULSE_SERVER: "unix:/elsewhere",
    GTK_THEME: "Adwaita:dark",
    GTK3_MODULES: "/somewhere/else.so",
    GDK_BACKEND: "wayland",
    GDK_GL: "disable",
    GSK_RENDERER: "cairo",
    SOUP_FORCE_HTTP1: "0",
    MESA_LOADER_DRIVER_OVERRIDE: "zink",
    LIBGL_ALWAYS_SOFTWARE: "1",
    __GLX_VENDOR_LIBRARY_NAME: "nvidia",
    __EGL_VENDOR_LIBRARY_FILENAMES: "/usr/share/glvnd/egl_vendor.d/10_nvidia.json",
    EGL_PLATFORM: "wayland",
    GBM_BACKEND: "nvidia-drm",
    __NV_PRIME_RENDER_OFFLOAD: "1",
    NVD_BACKEND: "direct",
    LIBVA_DRIVER_NAME: "nvidia",
    VDPAU_DRIVER: "nvidia",
    VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/nvidia_icd.json",
    DRI_PRIME: "1",
    APPIMAGE: "/home/someone/Linger.AppImage",
    APPDIR: "/tmp/.mount_Linger",
    LINGER_LINUX_BACKEND: "wayland",
  };
  const kept = { PATH: "/usr/bin", HOME: "/home/someone", LANG: "en_CA.UTF-8", XDG_SESSION_TYPE: "wayland" };
  const session = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", LD_LIBRARY_PATH: "/opt/lib" };
  const { env, dropped } = cleanEnvironment({ ...settings, ...kept, ...session });
  assert.deepEqual(env, kept);
  assert.deepEqual(dropped, Object.keys(settings).sort());
});

test("a shell with none of them has nothing to name", () => {
  assert.deepEqual(cleanEnvironment({ PATH: "/usr/bin", HOME: "/home/someone" }).dropped, []);
});

// The check run for real, with stand-ins for what it starts the app with:
// `xvfb-run` writes down the environment it was given and exits, so the check
// stops there. That environment is what the app would have had (#768's
// review: a test of the source alone passed a launch that ignored it).
test("the packaged-app check starts the app with that environment, and nothing from the shell", () => {
  const work = mkdtempSync(join(tmpdir(), "linger-next-env-"));
  try {
    const bin = join(work, "bin");
    mkdirSync(bin);
    const stand = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    stand("pkg-config", "echo -I/nowhere");
    stand("cc", 'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then : > "$2"; fi; shift; done');
    stand("xvfb-run", 'env > "$CAPTURE_ENVIRONMENT_TO"; exit 0');
    const capture = join(work, "env.txt");
    const shell = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: work,
      CAPTURE_ENVIRONMENT_TO: capture,
      WEBKIT_GST_DISABLE_GL_SINK: "0",
      __EGL_VENDOR_LIBRARY_FILENAMES: "/usr/share/glvnd/egl_vendor.d/50_mesa.json",
      LIBGL_ALWAYS_SOFTWARE: "1",
      GDK_SCALE: "2",
      GST_PLUGIN_FEATURE_RANK: "nvh264dec:MAX",
    };
    const run = spawnSync(process.execPath, [fileURLToPath(new URL("linux-next-check.mjs", import.meta.url)), "/bin/true", "--output", join(work, "out")], {
      env: shell,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(run.stdout, /left out of the app's environment, from this shell: GDK_SCALE, GST_PLUGIN_FEATURE_RANK, LIBGL_ALWAYS_SOFTWARE, WEBKIT_GST_DISABLE_GL_SINK, __EGL_VENDOR_LIBRARY_FILENAMES/);
    const given = Object.fromEntries(
      readFileSync(capture, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    for (const key of ["WEBKIT_GST_DISABLE_GL_SINK", "__EGL_VENDOR_LIBRARY_FILENAMES", "LIBGL_ALWAYS_SOFTWARE", "GDK_SCALE", "GST_PLUGIN_FEATURE_RANK"])
      assert.equal(given[key], undefined, `${key} reached the app`);
    // What the check means to set, it set.
    assert.equal(given.GDK_BACKEND, "x11");
    assert.equal(given.GTK3_MODULES, join(work, "out", "probe.so"));
    assert.equal(given.WEBKIT_DISABLE_DMABUF_RENDERER, "1");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("the audio check leaves out the same families", () => {
  const audio = read("scripts/linux-audio-check.py");
  const [, tuple] = /^SETTING_FAMILIES = \(([^)]*)\)/m.exec(audio) ?? [];
  assert.ok(tuple, "no SETTING_FAMILIES in linux-audio-check.py");
  assert.deepEqual([...tuple.matchAll(/"([^"]+)"/g)].map((match) => match[1]), SETTING_FAMILIES);
  assert.match(audio, /if key\.startswith\(SETTING_FAMILIES\):\n\s+env\.pop\(key\)/);
});
