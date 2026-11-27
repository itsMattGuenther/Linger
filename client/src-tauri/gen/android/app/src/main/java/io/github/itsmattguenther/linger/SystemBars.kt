package io.github.itsmattguenther.linger

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
 * theme on. Nothing is kept for the next start: Linger always opens on The
 * door's navy (themes.xml), so MainActivity starts with light icons, and
 * the page says its theme as it loads.
 * The bars stay see-through over the page's own ground, but for Android's
 * backing behind three-button navigation.
 */
object SystemBars {
  /**
   * See-through dark, androidx's own default: behind the navigation bar's
   * light buttons before Android 8, which can't draw dark ones, so they
   * read on paper; and on Android 8 and 9, the navigation bar's backing on
   * a dark theme. (The status bar's, before Android 6, never runs: Linger
   * needs Android 7.)
   */
  private val DARK_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)

  /**
   * See-through white, androidx's own default: the navigation bar's backing
   * on Daylight on Android 8 and 9. From Android 10 the system draws its
   * own backing behind three buttons, and none behind gestures.
   */
  private val LIGHT_SCRIM = Color.argb(0xe6, 0xff, 0xff, 0xff)

  /** The app's screen, while it has one. */
  var activity: WeakReference<ComponentActivity>? = null

  /**
   * The bars for a light theme's page, or a dark one's. On the screen's own
   * thread. The navigation bar keeps the backing the plain
   * `enableEdgeToEdge()` gave it (an "auto" style: from Android 10 the
   * system's own behind three buttons and none behind gestures; on 8 and 9
   * a see-through band either way), told the theme rather than the phone's
   * dark mode.
   */
  fun draw(screen: ComponentActivity, light: Boolean) {
    val status = if (light) {
      SystemBarStyle.light(Color.TRANSPARENT, DARK_SCRIM)
    } else {
      SystemBarStyle.dark(Color.TRANSPARENT)
    }
    val navigation = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { !light }
    screen.enableEdgeToEdge(status, navigation)
  }

  /** Rust's call: redraw the bars now, if there's a screen. */
  @JvmStatic
  fun follow(light: Boolean) {
    val screen = activity?.get() ?: return
    screen.runOnUiThread { draw(screen, light) }
  }
}
