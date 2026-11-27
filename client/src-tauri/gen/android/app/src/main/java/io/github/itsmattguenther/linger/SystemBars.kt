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
 * The bars stay see-through over the page's own ground, but for Android's
 * backing behind three-button navigation.
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

  /** Behind three-button navigation on a light page, as androidx's own default. */
  private val LIGHT_SCRIM = Color.argb(0xe6, 0xff, 0xff, 0xff)

  /** The app's screen, while it has one. */
  var activity: WeakReference<ComponentActivity>? = null

  /** Whether the last theme the page put on was light: a dark one until it says. */
  fun light(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(LIGHT, false)

  /**
   * The bars for a light theme's page, or a dark one's. On the screen's own
   * thread. The navigation bar keeps Android's own backing behind three
   * buttons (an "auto" style, which lets the system keep their contrast, as
   * the plain `enableEdgeToEdge()` did), told the theme rather than the
   * phone's dark mode; gesture navigation stays see-through.
   */
  fun draw(screen: ComponentActivity, light: Boolean) {
    val status = if (light) {
      SystemBarStyle.light(Color.TRANSPARENT, OLD_ANDROID_SCRIM)
    } else {
      SystemBarStyle.dark(Color.TRANSPARENT)
    }
    val navigation = SystemBarStyle.auto(LIGHT_SCRIM, OLD_ANDROID_SCRIM) { !light }
    screen.enableEdgeToEdge(status, navigation)
  }

  /** Rust's call: keep it for the next start, and redraw the bars now if there's a screen. */
  @JvmStatic
  fun follow(context: Context, light: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(LIGHT, light).apply()
    val screen = activity?.get() ?: return
    screen.runOnUiThread { draw(screen, light) }
  }
}
