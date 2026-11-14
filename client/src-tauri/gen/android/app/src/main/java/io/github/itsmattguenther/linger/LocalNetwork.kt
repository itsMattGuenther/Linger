package io.github.itsmattguenther.linger

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * A Linger server on the phone's own network, such as one run at home (#842,
 * SPEC §4.15). From Android 17, an app that targets it can't reach an
 * address on the Wi-Fi or Ethernet the phone is on until the person allows
 * it (the "Nearby devices" permissions), and a connection there doesn't
 * fail: it waits until it gives up. Rust (src-tauri/src/phone_network.rs)
 * calls [state] for a server whose address is on that network, and only
 * then; the answer to an ask reaches the page as `linger:local-network`
 * (MainActivity).
 */
object LocalNetwork {
  /** Linger's request for it, told apart from the notification asks (429, 830). */
  const val ASK = 842

  /** The app's screen, while it has one: asking needs it. */
  var activity: WeakReference<Activity>? = null

  private val dialog = OneAsk()

  /**
   * `granted` when Linger may reach the phone's network: always before
   * Android 17, which doesn't ask. Otherwise, with [ask], asks now and
   * answers `asking`; without, or with no screen to ask from, `denied`.
   */
  @JvmStatic
  fun state(context: Context, ask: Boolean): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.CINNAMON_BUN ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED
    ) {
      return "granted"
    }
    if (!ask) return "denied"
    val screen = activity?.get() ?: return "denied"
    if (!dialog.claim(SystemClock.elapsedRealtime())) return "asking"
    screen.runOnUiThread { screen.requestPermissions(arrayOf(Manifest.permission.ACCESS_LOCAL_NETWORK), ASK) }
    return "asking"
  }

  /** The dialog has gone: the next ask may put up another. */
  fun answered() {
    dialog.answered()
  }
}

/**
 * One dialog at a time. A page that asks again while it's showing waits for
 * the same answer instead of putting up a second one, which Android would
 * turn down unseen. Rust asks from more than one thread at once, so whether
 * one is up and marking it up are one step (#900 review). A minute on, an
 * answer that never came (the screen went away under it) no longer holds
 * anything up.
 */
class OneAsk(private val wait: Long = 60_000) {
  private var askedAt: Long? = null

  /** Whether the caller, at [now], may put the dialog up: once, until [answered] or [wait]. */
  @Synchronized
  fun claim(now: Long): Boolean {
    val asked = askedAt
    if (asked != null && now - asked < wait) return false
    askedAt = now
    return true
  }

  @Synchronized
  fun answered() {
    askedAt = null
  }
}
