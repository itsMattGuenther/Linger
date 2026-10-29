// The environment the packaged-app check starts Linger with (#765).
//
// The check proves what the app's own startup does (`linux_startup.rs`): the
// decoder ranks, WebKit's media and drawing switches, HTTP/1.1. A setting
// with the same name in the shell of whoever runs the check can pass for the
// app's own, or change what WebKit, GStreamer, GTK or the graphics drivers
// do, and make the check pass or fail for the wrong reason: #757's review
// found #756's own workaround would have passed for the fix. So every setting
// in those families is left out, not only the ones known today, and the check
// sets back only what it means to.

/** Settings that change what the WebView, its media or its drawing do, by how their names start. */
export const SETTING_FAMILIES = [
  // WebKit and its JavaScript engine.
  "WEBKIT_",
  "JSC_",
  // GStreamer, and the sound server it plays through.
  "GST_",
  "PULSE_",
  // GTK and GDK (GTK3_MODULES, GTK_THEME, GDK_BACKEND, GDK_GL, GDK_SCALE...).
  "GTK",
  "GDK_",
  "GSK_",
  // libsoup, WebKit's network library.
  "SOUP_",
  // The graphics drivers: Mesa, the GL and EGL loaders, NVIDIA's driver,
  // GBM, VA-API, VDPAU, Vulkan, and which GPU draws.
  "MESA_",
  "LIBGL_",
  "__GL",
  "__EGL",
  "EGL_",
  "GBM_",
  "__NV",
  "NVD_",
  "LIBVA_",
  "VDPAU_",
  "VK_",
  "DRI_PRIME",
  // An AppImage's own, and Linger's own.
  "APPIMAGE",
  "APPDIR",
  "LINGER_",
];

/** The display and session: the check starts its own virtual display and D-Bus. */
const SESSION = ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "LD_LIBRARY_PATH"];

/**
 * `inherited` without any setting in those families, or the display and
 * session; and the names of the settings left out, for the check's log. The
 * session's aren't named: they're always there, and always replaced.
 */
export function cleanEnvironment(inherited) {
  const env = {};
  const dropped = [];
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined || SESSION.includes(key)) continue;
    if (SETTING_FAMILIES.some((prefix) => key.startsWith(prefix))) dropped.push(key);
    else env[key] = value;
  }
  return { env, dropped: dropped.sort() };
}
