package io.github.itsmattguenther.linger

import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DEFAULT as MANIFEST
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED as OFF
import android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED as ON
import io.github.itsmattguenther.linger.AppIcon.DOOR_AGAIN
import io.github.itsmattguenther.linger.AppIcon.ENTRIES
import io.github.itsmattguenther.linger.AppIcon.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The home screen icon's launcher entries (#961): which look is in use, and
 * what to change to put another up. An entry nobody changed has the
 * manifest's state, where only the door's first entry is on. Turning that
 * one off ends the app, so it may only ever be the last step.
 */
class AppIconTest {
  private val fresh = emptyMap<String, Int>()
  private val door = ENTRIES[0]
  private val dusk = ENTRIES[4]

  @Test
  fun aPhoneNobodyChangedIsOnTheDoor() {
    assertEquals(0, AppIcon.which(fresh))
  }

  @Test
  fun aLookTurnedOnIsTheOneInUse() {
    assertEquals(4, AppIcon.which(mapOf(door to OFF, dusk to ON)))
    // Back on the door, through its second entry.
    assertEquals(0, AppIcon.which(mapOf(door to OFF, DOOR_AGAIN to ON)))
    // Every entry off answers the door.
    assertEquals(0, AppIcon.which((ENTRIES + DOOR_AGAIN).associateWith { OFF }))
  }

  @Test
  fun theFirstChangeTurnsTheNewOneOnThenTheDoorOffLast() {
    assertEquals(listOf(Step(dusk, ON), Step(door, OFF)), AppIcon.steps(fresh, 4))
  }

  @Test
  fun laterChangesPutTheOldOneBackToTheManifestSoNothingEnds() {
    val onDusk = mapOf(door to OFF, dusk to ON)
    assertEquals(listOf(Step(ENTRIES[1], ON), Step(dusk, MANIFEST)), AppIcon.steps(onDusk, 1))
    // The door again, through its second entry: its first stays off.
    assertEquals(listOf(Step(DOOR_AGAIN, ON), Step(dusk, MANIFEST)), AppIcon.steps(onDusk, 0))
    // And from there to another look.
    val backOnDoor = mapOf(door to OFF, DOOR_AGAIN to ON)
    assertEquals(listOf(Step(ENTRIES[2], ON), Step(DOOR_AGAIN, MANIFEST)), AppIcon.steps(backOnDoor, 2))
  }

  @Test
  fun onlyEverTheDoorsFirstEntryIsTurnedOffAndOnlyLast() {
    val starts = listOf(fresh, mapOf(door to OFF, dusk to ON), mapOf(door to OFF, DOOR_AGAIN to ON), mapOf(dusk to ON))
    for (start in starts) {
      for (place in ENTRIES.indices) {
        val steps = AppIcon.steps(start, place)
        val ends = steps.filter { it.state == OFF }
        assertTrue("$start → $place: $steps", ends.all { it.entry == door })
        if (ends.isNotEmpty()) assertEquals(steps.last(), ends.single())
        // And whatever is turned off, the launcher is never left with no entry on.
        val after = start.toMutableMap().apply { for (step in steps) this[step.entry] = step.state }
        assertEquals("$start → $place", place, AppIcon.which(after))
      }
    }
  }

  @Test
  fun theLookAlreadyUpChangesNothing() {
    assertEquals(emptyList<Step>(), AppIcon.steps(fresh, 0))
    assertEquals(emptyList<Step>(), AppIcon.steps(mapOf(door to OFF, dusk to ON), 4))
  }
}
