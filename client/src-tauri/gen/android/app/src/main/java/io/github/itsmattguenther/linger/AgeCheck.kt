package io.github.itsmattguenther.linger

import android.app.Activity
import android.content.Context
import android.util.Log
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.android.play.agesignals.AgeSignalsAccessRequest
import com.google.android.play.agesignals.AgeSignalsException
import com.google.android.play.agesignals.AgeSignalsManager
import com.google.android.play.agesignals.AgeSignalsManagerFactory
import com.google.android.play.agesignals.AgeSignalsRequest
import com.google.android.play.agesignals.ApplicableAgeFeaturesRequest
import com.google.android.play.agesignals.model.AgeSignalsStatus
import com.google.android.play.agesignals.model.ApplicableAgeFeature
import java.lang.ref.WeakReference
import java.util.concurrent.TimeUnit

/**
 * The age Google Play holds for the person, where a law makes Play share it
 * with apps (#953, SPEC §4.15). Linger is for people 13 and older, so the one
 * question is whether the person is under 13. Play says where the check
 * applies (`MANDATORY_SHARING`): Linger asks only there, so nobody anywhere
 * else sees Play's question about sharing their age.
 *
 * Rust (src-tauri/src/phone_age.rs) calls [ask], off the main thread, and
 * gets 1 for a person under 13, 0 for anybody else, and -1 when it couldn't
 * tell: a copy not installed from Play (Play answers `APP_NOT_OWNED`), no
 * Play at all, a person who hasn't verified their age with Play yet, any
 * error. Rust and the page treat -1 as 0: a check that failed never locks
 * anybody out. Nothing here keeps the age or logs it: the log says only
 * which way the check went.
 */
object AgeCheck {
  /** Linger's one age gate. */
  const val GATE = 13

  /** The app's screen, while it has one: Play asks the person from it, where it asks at all. */
  var activity: WeakReference<Activity>? = null

  /** How long one of Play's own answers may take before the check gives up. */
  private const val WAIT_SECONDS = 20L

  /**
   * How long the access request may take. Where sharing is mandatory, Play
   * says it shows the person nothing and answers at once; if it ever shows
   * them something, giving up while they read it would let them in, and the
   * list doesn't wait for this anyway (core/ageCheck.ts), so it waits long.
   */
  private const val PERSON_SECONDS = 15L * 60

  /** An answer, and which way the check went to it, for the log. */
  data class Answer(val verdict: Int, val why: String)

  /** Waits for one of Play's answers: `person` when somebody might be answering it. */
  interface Waiter {
    fun <T> wait(task: Task<T>, person: Boolean): T
  }

  /** Each answer, waited for on this thread, for a while. */
  private val blocking =
    object : Waiter {
      override fun <T> wait(task: Task<T>, person: Boolean): T =
        Tasks.await(task, if (person) PERSON_SECONDS else WAIT_SECONDS, TimeUnit.SECONDS)
    }

  /** 1, 0 or -1, as above. Blocks while Play answers: never on the main thread. */
  @JvmStatic
  fun ask(context: Context): Int {
    val answer =
      try {
        decide(AgeSignalsManagerFactory.create(context), activity?.get(), blocking)
      } catch (error: Exception) {
        Answer(-1, "failed, ${failure(error)}")
      }
    Log.i("Linger", "age check: ${answer.why}")
    return answer.verdict
  }

  /** The check itself, with Play's manager and the waiting handed in, so a test can give Play's fake. */
  fun decide(manager: AgeSignalsManager, screen: Activity?, waiter: Waiter): Answer {
    val features = waiter.wait(manager.getApplicableAgeFeatures(ApplicableAgeFeaturesRequest.builder().build()), person = false).features()
    if (!features.contains(ApplicableAgeFeature.MANDATORY_SHARING)) return Answer(0, "not required here")
    val from = screen ?: return Answer(-1, "no screen to ask from")
    val access = waiter.wait(manager.requestAgeSignalsAccess(AgeSignalsAccessRequest.builder().setActivity(from).build()), person = true)
    when (access.ageSignalsStatus()) {
      AgeSignalsStatus.SHARED -> {}
      AgeSignalsStatus.VERIFICATION_REQUIRED -> return Answer(-1, "the person hasn't verified their age with Play yet")
      AgeSignalsStatus.NOT_SHARED -> return Answer(-1, "not shared")
      else -> return Answer(-1, "an access status this build doesn't know")
    }
    val signals = waiter.wait(manager.checkAgeSignals(AgeSignalsRequest.builder().build()), person = false)
    return Answer(verdict(signals.ageUpper()), "shared")
  }

  /**
   * A person under 13 from the range Play shared: the top of the range is
   * below the gate. No top means 18 or older, or nothing shared.
   */
  @JvmStatic
  fun verdict(ageUpper: Int?): Int = if (ageUpper != null && ageUpper < GATE) 1 else 0

  /** Which failure, by Play's error code where it gave one: never anything about the person. */
  private fun failure(error: Exception): String {
    val play = error as? AgeSignalsException ?: error.cause as? AgeSignalsException
    return if (play != null) "Play's error ${play.errorCode}" else error.javaClass.simpleName
  }
}
