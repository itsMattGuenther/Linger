package io.github.itsmattguenther.linger

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * A phone notification opened (#830, PROTOCOL §5): RFC 8291, the standard
 * web push encryption, with RFC 8188's `aes128gcm` coding in one record.
 *
 * The server encrypts each notification to this phone's key with a key pair
 * made for that one notification, and only this phone's private key opens it,
 * so the relay, Google and Apple carry it without reading it. Plain Java
 * crypto, so it runs the same in the app and in a test on a computer
 * (`src/test/.../PushCryptoTest.kt`, against the RFC's own example and one
 * the server made).
 */
object PushCrypto {
  private val curve: ECParameterSpec by lazy {
    AlgorithmParameters.getInstance("EC").run {
      init(ECGenParameterSpec("secp256r1"))
      getParameterSpec(ECParameterSpec::class.java)
    }
  }

  /** A fresh P-256 key pair: the private scalar (32 bytes) and the public point (65). */
  fun newKeyPair(): Pair<ByteArray, ByteArray> {
    val pair = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1"))
      generateKeyPair()
    }
    val private = (pair.private as ECPrivateKey).s
    return fixed(private, 32) to uncompressed((pair.public as ECPublicKey).w)
  }

  /** The words inside `message`, or null when it isn't for this key or was changed. */
  fun decrypt(privateScalar: ByteArray, publicPoint: ByteArray, auth: ByteArray, message: ByteArray): ByteArray? {
    // The header (RFC 8188 §2.1): salt, record size, and the sender's key.
    if (message.size < 16 + 4 + 1 + 65 + 17) return null
    val salt = message.copyOfRange(0, 16)
    val idLength = message[20].toInt() and 0xff
    if (idLength != 65) return null
    val senderPoint = message.copyOfRange(21, 21 + idLength)
    val body = message.copyOfRange(21 + idLength, message.size)
    return try {
      val shared = KeyAgreement.getInstance("ECDH").run {
        init(privateKey(privateScalar))
        doPhase(publicKey(senderPoint), true)
        generateSecret()
      }
      // RFC 8291 §3.3, then RFC 8188 §2.2 and §2.3.
      val ikm = expand(extract(auth, shared), "WebPush: info".toByteArray() + byteArrayOf(0) + publicPoint + senderPoint, 32)
      val prk = extract(salt, ikm)
      val cek = expand(prk, "Content-Encoding: aes128gcm".toByteArray() + byteArrayOf(0), 16)
      val nonce = expand(prk, "Content-Encoding: nonce".toByteArray() + byteArrayOf(0), 12)
      val record = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
        doFinal(body)
      }
      // The words, then the delimiter 2 of the last record, then padding zeros.
      var end = record.size - 1
      while (end >= 0 && record[end] == 0.toByte()) end--
      if (end < 0 || record[end] != 2.toByte()) null else record.copyOf(end)
    } catch (e: Exception) {
      null
    }
  }

  private fun privateKey(scalar: ByteArray) =
    KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, scalar), curve))

  private fun publicKey(point: ByteArray): java.security.PublicKey {
    require(point.size == 65 && point[0] == 4.toByte()) { "not an uncompressed P-256 point" }
    val x = BigInteger(1, point.copyOfRange(1, 33))
    val y = BigInteger(1, point.copyOfRange(33, 65))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), curve))
  }

  private fun uncompressed(point: ECPoint): ByteArray =
    byteArrayOf(4) + fixed(point.affineX, 32) + fixed(point.affineY, 32)

  /** A big number as exactly `size` bytes, as a key's encoding wants it. */
  private fun fixed(value: BigInteger, size: Int): ByteArray {
    val bytes = value.toByteArray()
    return when {
      bytes.size == size -> bytes
      bytes.size > size -> bytes.copyOfRange(bytes.size - size, bytes.size)
      else -> ByteArray(size - bytes.size) + bytes
    }
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(key, "HmacSHA256"))
      doFinal(data)
    }

  // HKDF (RFC 5869) with SHA-256, for outputs of one block at most.
  private fun extract(salt: ByteArray, ikm: ByteArray) = hmac(salt, ikm)
  private fun expand(prk: ByteArray, info: ByteArray, length: Int) = hmac(prk, info + byteArrayOf(1)).copyOf(length)
}
