package io.github.itsmattguenther.linger

import android.content.Context
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import java.lang.ref.WeakReference

/**
 * The status bar's and navigation bar's icons (#965, SPEC §5.3): dark on
 * Daylight's paper, light on every dark theme. Linger's page is drawn under
 * both bars (edge to edge), so their icons have to read on its ground, which
 * the phone's own dark mode knows nothing about: a phone in light mode drew
 * dark icons on The door's night.
 *
 * Rust (src-tauri/src/theme.rs) calls [follow] each time the page puts a
 * theme on. The answer is kept, so the next start draws its first frame
 * with the right icons (MainActivity) before the page has said anything.
 * The bars themselves stay see-through: the page's own ground is under them.
 */
object SystemBars {
  private const val PREFS = "linger.systemBars"
  private const val LIGHT = "light"

  /**
   * Behind the navigation bar's light buttons where Android can't draw
   * dark ones (before Android 8, which Linger still runs on): see-through
   * dark, as androidx's own default, so they still read on paper.
   */
  private val OLD_ANDROID_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)

  /** The app's screen, while it has one. */
  var activity: WeakReference<ComponentActivity>? = null

  /** Whether the last theme the page put on was light: a dark one until it says. */
  fun light(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(LIGHT, false)

  /** The bars for a light theme's page, or a dark one's. On the screen's own thread. */
  fun draw(screen: ComponentActivity, light: Boolean) {
    val style = if (light) {
      SystemBarStyle.light(Color.TRANSPARENT, OLD_ANDROID_SCRIM)
    } else {
      SystemBarStyle.dark(Color.TRANSPARENT)
    }
    screen.enableEdgeToEdge(style, style)
  }

  /** Rust's call: keep it for the next start, and redraw the bars now if there's a screen. */
  @JvmStatic
  fun follow(context: Context, light: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(LIGHT, light).apply()
    val screen = activity?.get() ?: return
    screen.runOnUiThread { draw(screen, light) }
  }
}
