package io.github.itsmattguenther.linger

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * This phone's notification keys, one set per server (#830, PROTOCOL §5): a
 * P-256 key pair and a 16-byte secret, made here. The server gets the public
 * key and the secret; the private key never leaves the phone.
 *
 * Kept where the messaging service can read them with Linger closed: in the
 * app's own preferences, each set sealed with an AES key that lives in the
 * Android Keystore and never leaves it. The app keeps out of backups
 * (`allowBackup="false"`), so none of this reaches Google's cloud either.
 */
object PushKeys {
  private const val FILE = "linger-push"
  private const val ALIAS = "linger-push"

  /** One server's keys. */
  class Keys(val server: String, val private: ByteArray, val public: ByteArray, val auth: ByteArray)

  private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  private fun sealer(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build(),
      )
      generateKey()
    }
  }

  private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  private fun unb64(text: String) = Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  private fun seal(words: ByteArray): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, sealer()) }
    return b64(cipher.iv) + "." + b64(cipher.doFinal(words))
  }

  private fun open(sealed: String): ByteArray? = try {
    val (iv, body) = sealed.split(".").let { it[0] to it[1] }
    Cipher.getInstance("AES/GCM/NoPadding").run {
      init(Cipher.DECRYPT_MODE, sealer(), GCMParameterSpec(128, unb64(iv)))
      doFinal(unb64(body))
    }
  } catch (e: Exception) {
    null
  }

  /** `server`'s keys, made and kept the first time they're asked for. */
  @Synchronized
  fun forServer(context: Context, server: String): Keys {
    read(context, server)?.let { return it }
    val (private, public) = PushCrypto.newKeyPair()
    val auth = ByteArray(16).also { SecureRandom().nextBytes(it) }
    val words = JSONObject().put("private", b64(private)).put("public", b64(public)).put("auth", b64(auth))
    prefs(context).edit().putString(server, seal(words.toString().toByteArray())).commit()
    return Keys(server, private, public, auth)
  }

  private fun read(context: Context, server: String): Keys? {
    val sealed = prefs(context).getString(server, null) ?: return null
    val words = open(sealed)?.let { JSONObject(String(it)) } ?: return null
    return Keys(server, unb64(words.getString("private")), unb64(words.getString("public")), unb64(words.getString("auth")))
  }

  /** Every server's keys this phone keeps, for a notification to be tried against. */
  @Synchronized
  fun all(context: Context): List<Keys> = prefs(context).all.keys.mapNotNull { read(context, it) }

  /**
   * Forget `server`'s keys. Answers whether that took this phone's last: it
   * had keys for `server` and none for any other server are left. A server
   * it never had keys for (a sign-out with notifications never on) answers
   * false, so nothing starts Firebase just to delete an address it never had.
   */
  @Synchronized
  fun forget(context: Context, server: String): Boolean {
    val had = prefs(context).contains(server)
    prefs(context).edit().remove(server).commit()
    return had && prefs(context).all.isEmpty()
  }

  fun encode(bytes: ByteArray): String = b64(bytes)
}
