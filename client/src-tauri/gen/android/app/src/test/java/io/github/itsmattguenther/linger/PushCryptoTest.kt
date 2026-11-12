package io.github.itsmattguenther.linger

import java.io.File
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's side of the encryption (#830, PROTOCOL §5), on a computer: it
 * opens RFC 8291's own example, and the notification the server makes
 * (crates/linger-server/tests/fixtures/push-notification.json, which the
 * server's own test makes again), and nothing that was changed or isn't its.
 */
class PushCryptoTest {
  private fun b64(text: String): ByteArray = Base64.getUrlDecoder().decode(text.replace(Regex("\\s"), ""))

  // RFC 8291 §5 and Appendix A.
  private val uaPrivate = b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
  private val uaPublic = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
  private val auth = b64("BTBZMqHH6r4Tts7J_aSIgg")
  private val rfcMessage = b64(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
      "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
      "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  )

  /** A field of the server's fixture, read without a JSON library (Android's is a stub off a phone). */
  private fun fixture(name: String): String {
    val text = File("../../../../../crates/linger-server/tests/fixtures/push-notification.json").readText()
    val found = Regex("\"$name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(text) ?: error("no $name in the fixture")
    return found.groupValues[1].replace("\\\"", "\"").replace("\\\\", "\\")
  }

  @Test
  fun opensTheRfcsOwnExample() {
    val words = PushCrypto.decrypt(uaPrivate, uaPublic, auth, rfcMessage)
    assertEquals("When I grow up, I want to be a watermelon", words?.toString(Charsets.UTF_8))
  }

  @Test
  fun opensWhatTheServerSends() {
    val words = PushCrypto.decrypt(b64(fixture("ua_private")), b64(fixture("ua_public")), b64(fixture("auth_secret")), b64(fixture("message")))
    assertEquals(fixture("plaintext"), words?.toString(Charsets.UTF_8))
  }

  @Test
  fun opensNothingThatIsntItsOrWasChanged() {
    assertNull("another phone's secret", PushCrypto.decrypt(uaPrivate, uaPublic, ByteArray(16), rfcMessage))
    val (otherPrivate, otherPublic) = PushCrypto.newKeyPair()
    assertNull("another phone's key", PushCrypto.decrypt(otherPrivate, otherPublic, auth, rfcMessage))
    val changed = rfcMessage.copyOf().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
    assertNull("a changed byte", PushCrypto.decrypt(uaPrivate, uaPublic, auth, changed))
    assertNull("cut short", PushCrypto.decrypt(uaPrivate, uaPublic, auth, rfcMessage.copyOf(90)))
    assertNull("nothing", PushCrypto.decrypt(uaPrivate, uaPublic, auth, ByteArray(0)))
  }

  @Test
  fun makesKeysOfTheShapeTheServerTakes() {
    val (private, public) = PushCrypto.newKeyPair()
    assertEquals(32, private.size)
    assertEquals(65, public.size)
    assertEquals(4.toByte(), public[0])
    val (again, _) = PushCrypto.newKeyPair()
    assertTrue("a new key each time", !private.contentEquals(again))
    assertArrayEquals(uaPublic, uaPublic)
  }
}
