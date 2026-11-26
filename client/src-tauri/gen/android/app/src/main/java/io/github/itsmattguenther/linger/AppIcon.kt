package io.github.itsmattguenther.linger

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED
import android.content.pm.PackageManager.DONT_KILL_APP

/**
 * The home screen icon a person picks (#961, SPEC §4.15), in Settings ›
 * Appearance. Each look is a launcher entry of its own in the manifest (an
 * `activity-alias` of MainActivity, with that look's icon), and one is on:
 * the usual way to change an app's icon on Android. Rust
 * (src-tauri/src/phone_icon.rs) asks for a look by its place in [ENTRIES],
 * the same order as scripts/app-icon-looks.mjs, whose test checks they agree.
 *
 * Android ends an app when an entry the manifest has on is turned off, so
 * only the door's first entry is on there, and it's turned off once: the
 * first change away from the door closes Linger, which the page says
 * beforehand. Every other entry is off in the manifest, so putting one back
 * to the manifest's state turns it off without ending anything, and the door
 * comes back through a second entry of its own ([DOOR_AGAIN]). Notifications,
 * shares and linger:// links open MainActivity itself, not an entry, so they
 * work whichever is on.
 */
object AppIcon {
  /** The launcher entries, one per look: only the door's is on in the manifest. */
  val ENTRIES = listOf("IconDoor", "IconAfterDark", "IconPorchLight", "IconDaylight", "IconDusk", "IconOriginal")

  /** The door's second entry, off in the manifest, for going back to the door once its first is off. */
  const val DOOR_AGAIN = "IconDoorAgain"

  /** An entry's state to put it in: on, or turned off. */
  data class Step(val entry: String, val state: Int)

  private fun onInManifest(entry: String) = entry == ENTRIES[0]

  /** Whether an entry is on: changed to on, or never changed and on in the manifest. */
  fun on(states: Map<String, Int>, entry: String): Boolean {
    val state = states[entry] ?: COMPONENT_ENABLED_STATE_DEFAULT
    return state == COMPONENT_ENABLED_STATE_ENABLED || (state == COMPONENT_ENABLED_STATE_DEFAULT && onInManifest(entry))
  }

  /** The look in use: the door if either of its entries is on, otherwise the first that is. */
  fun which(states: Map<String, Int>): Int {
    if (on(states, ENTRIES[0]) || on(states, DOOR_AGAIN)) return 0
    return (1 until ENTRIES.size).firstOrNull { on(states, ENTRIES[it]) } ?: 0
  }

  /**
   * What to change, in order, to put the look at `place` up: its entry on
   * first, so the launcher never has none; the others off; and last the
   * door's first entry, whose turning off ends the app.
   */
  fun steps(states: Map<String, Int>, place: Int): List<Step> {
    val firstDoorOn = on(states, ENTRIES[0])
    val wanted = if (place == 0) (if (firstDoorOn) ENTRIES[0] else DOOR_AGAIN) else ENTRIES[place]
    val steps = mutableListOf<Step>()
    if (!on(states, wanted)) steps += Step(wanted, COMPONENT_ENABLED_STATE_ENABLED)
    for (other in ENTRIES.drop(1) + DOOR_AGAIN) {
      if (other != wanted && on(states, other)) steps += Step(other, COMPONENT_ENABLED_STATE_DEFAULT)
    }
    if (wanted != ENTRIES[0] && firstDoorOn) steps += Step(ENTRIES[0], COMPONENT_ENABLED_STATE_DISABLED)
    return steps
  }

  /**
   * Where the manifest's `.IconDoor` and the rest live: the code's own
   * package, which a build with an app id of its own (a `.debug` suffix)
   * doesn't change.
   */
  private val CODE = AppIcon::class.java.name.substringBeforeLast('.')

  private fun entry(context: Context, name: String) = ComponentName(context.packageName, "$CODE.$name")

  private fun states(context: Context): Map<String, Int> {
    val packages = context.packageManager
    return (ENTRIES + DOOR_AGAIN).associateWith { packages.getComponentEnabledSetting(entry(context, it)) }
  }

  // One change at a time, and no reading in the middle of one: two quick
  // picks would each start from what was there before the other, and leave
  // both their entries on.
  @JvmStatic
  @Synchronized
  fun current(context: Context): Int = which(states(context))

  /**
   * Puts the look at `place` on the home screen: 1 once it's there, 0 for a
   * place there's no look at. The first change away from the door ends the
   * app at its last step, so that answer never arrives.
   */
  @JvmStatic
  @Synchronized
  fun set(context: Context, place: Int): Int {
    if (place !in ENTRIES.indices) return 0
    val packages = context.packageManager
    for (step in steps(states(context), place)) packages.setComponentEnabledSetting(entry(context, step.entry), step.state, DONT_KILL_APP)
    return 1
  }
}
