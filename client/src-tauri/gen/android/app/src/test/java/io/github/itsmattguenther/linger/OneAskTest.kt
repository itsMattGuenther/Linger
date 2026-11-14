package io.github.itsmattguenther.linger

import java.util.concurrent.CyclicBarrier
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android 17's local network dialog, put up once however many requests ask
 * at the same moment (#842). The first version checked and marked it in two
 * steps, so two threads could both put one up, and Android would turn one
 * down unseen (#900 review).
 */
class OneAskTest {
  @Test
  fun oneAskUntilItsAnsweredOrAMinuteGoesBy() {
    val dialog = OneAsk()
    assertTrue(dialog.claim(1_000))
    assertFalse(dialog.claim(2_000))
    assertFalse(dialog.claim(60_999))
    assertTrue("no answer in a minute holds nothing up", dialog.claim(61_000))
    dialog.answered()
    assertTrue(dialog.claim(61_001))
  }

  @Test
  fun manyAtOnceAndOnlyOnePutsItUp() {
    val dialog = OneAsk()
    val threads = 16
    repeat(200) { round ->
      dialog.answered()
      val start = CyclicBarrier(threads)
      val claimed = AtomicInteger()
      (1..threads).map {
        thread {
          start.await()
          if (dialog.claim(round.toLong())) claimed.incrementAndGet()
        }
      }.forEach { it.join() }
      assertEquals("round $round", 1, claimed.get())
    }
  }
}
