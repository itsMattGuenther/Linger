// The packaged-app checks start Linger without any setting from the caller's
// shell that changes what WebKit, GStreamer, GTK or the graphics drivers do
// (#765). #757's review found #756's own workaround would have passed for
// the fix; this is every such setting, not a list of the known ones.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

test("the packaged-app check starts the app from it, not from the shell", () => {
  const check = read("scripts/linux-next-check.mjs");
  assert.match(check, /const \{ env, dropped \} = cleanEnvironment\(process\.env\);/);
  assert.doesNotMatch(check, /\.\.\.process\.env/);
});

test("the audio check leaves out the same families", () => {
  const audio = read("scripts/linux-audio-check.py");
  const [, tuple] = /^SETTING_FAMILIES = \(([^)]*)\)/m.exec(audio) ?? [];
  assert.ok(tuple, "no SETTING_FAMILIES in linux-audio-check.py");
  assert.deepEqual([...tuple.matchAll(/"([^"]+)"/g)].map((match) => match[1]), SETTING_FAMILIES);
  assert.match(audio, /if key\.startswith\(SETTING_FAMILIES\):\n\s+env\.pop\(key\)/);
});
