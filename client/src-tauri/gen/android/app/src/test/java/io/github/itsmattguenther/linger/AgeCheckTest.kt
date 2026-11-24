package io.github.itsmattguenther.linger

import com.google.android.gms.tasks.Task
import com.google.android.play.agesignals.AgeSignalsAccessResult
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsResult
import com.google.android.play.agesignals.ApplicableAgeFeaturesResult
import com.google.android.play.agesignals.model.AgeSignalsErrorCode
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import com.google.android.play.agesignals.testing.FakeAgeSignalsManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The Android age check (#953), against Google Play's own fake: it asks only
 * where Play says sharing is mandatory, and only a range whose top is under
 * 13 is a child. Play's default ranges are 0-12, 13-15, 16-17 and 18+.
 */
class AgeCheckTest {
  /** The fake's tasks are done when they're handed over: no thread to wait on. */
  private val now =
    object : AgeCheck.Waiter {
      override fun <T> wait(task: Task<T>): T {
        task.exception?.let { throw it }
        return task.result
      }
    }

  private fun play(mandatory: Boolean, status: Int? = AgeSignalsStatus.SHARED, upper: Int? = null, lower: Int? = null) =
    FakeAgeSignalsManager().apply {
      setNextApplicableAgeFeaturesResult(
        ApplicableAgeFeaturesResult.builder().setFeatures(if (mandatory) setOf(ApplicableAgeFeature.MANDATORY_SHARING) else emptySet()).build(),
      )
      setNextAgeSignalsAccessResult(AgeSignalsAccessResult.builder().setAgeSignalsStatus(status).build())
      setNextAgeSignalsResult(AgeSignalsResult.builder().setAgeLower(lower).setAgeUpper(upper).build())
    }

  @Test
  fun onlyATopUnder13IsAChild() {
    assertEquals(1, AgeCheck.verdict(12))
    assertEquals(1, AgeCheck.verdict(0))
    assertEquals(0, AgeCheck.verdict(15))
    assertEquals(0, AgeCheck.verdict(17))
    assertEquals(0, AgeCheck.verdict(null))
  }

  @Test
  fun asksNothingWhereNoLawApplies() {
    assertEquals(AgeCheck.Answer(0, "not required here"), AgeCheck.decide(play(mandatory = false, upper = 12), null, now))
  }

  @Test
  fun whereItMustAChildUnder13IsOne() {
    val screen = android.app.Activity()
    assertEquals(AgeCheck.Answer(1, "shared"), AgeCheck.decide(play(mandatory = true, upper = 12, lower = 0), screen, now))
    assertEquals(AgeCheck.Answer(0, "shared"), AgeCheck.decide(play(mandatory = true, upper = 15, lower = 13), screen, now))
    assertEquals(AgeCheck.Answer(0, "shared"), AgeCheck.decide(play(mandatory = true, upper = 17, lower = 16), screen, now))
    assertEquals(AgeCheck.Answer(0, "shared"), AgeCheck.decide(play(mandatory = true, upper = null, lower = 18), screen, now))
  }

  @Test
  fun anythingButSharedCouldNotTell() {
    val screen = android.app.Activity()
    for (status in listOf(AgeSignalsStatus.NOT_SHARED, AgeSignalsStatus.VERIFICATION_REQUIRED, AgeSignalsStatus.UNSPECIFIED, null)) {
      assertEquals(-1, AgeCheck.decide(play(mandatory = true, status = status, upper = 12), screen, now).verdict)
    }
  }

  @Test
  fun withNoScreenToAskFromItCouldNotTell() {
    assertEquals(AgeCheck.Answer(-1, "no screen to ask from"), AgeCheck.decide(play(mandatory = true, upper = 12), null, now))
  }

  @Test
  fun playsRefusalReachesTheCaller() {
    // A copy not installed from Play: `ask` turns this into -1.
    val manager = FakeAgeSignalsManager().apply { setNextApplicableAgeFeaturesException(AgeSignalsException(AgeSignalsErrorCode.APP_NOT_OWNED)) }
    assertThrows(AgeSignalsException::class.java) { AgeCheck.decide(manager, null, now) }
  }
}
