import CryptoKit
import Foundation

/// A phone notification opened (#889, #830, PROTOCOL §5 "Phone
/// notifications"): RFC 8291, the standard web push encryption, with RFC
/// 8188's `aes128gcm` coding in one record. The same steps as Android's
/// `PushCrypto.kt`.
///
/// The server encrypts each notification to this phone's key with a key pair
/// made for that one notification, and only this phone's private key opens
/// it, so the relay and Apple carry it without reading it. Foundation and
/// CryptoKit only, so it runs the same in the extension and in its tests on
/// a Mac (`NotificationServiceTests/main.swift`, against the RFC's own example
/// and one the server made).
enum PushCrypto {
  /// The words inside `message`, or nil when it isn't for this key or was
  /// changed. `privateKey` is the 32-byte scalar, `publicKey` the 65-byte
  /// uncompressed point, `auth` the 16-byte secret: what `phone_push.rs`
  /// keeps for each server.
  static func decrypt(privateKey: Data, publicKey: Data, auth: Data, message: Data) -> Data? {
    let bytes = [UInt8](message)
    // The header (RFC 8188 §2.1): salt, record size, and the sender's key,
    // which is a 65-byte P-256 point, then at least a tag and a delimiter.
    guard bytes.count >= 16 + 4 + 1 + 65 + 17, bytes[20] == 65 else { return nil }
    let salt = Data(bytes[0..<16])
    let sender = Data(bytes[21..<86])
    let body = Data(bytes[86...])
    guard
      let mine = try? P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey),
      let theirs = try? P256.KeyAgreement.PublicKey(x963Representation: sender),
      let shared = try? mine.sharedSecretFromKeyAgreement(with: theirs)
    else { return nil }
    let secret = shared.withUnsafeBytes { Data($0) }
    // RFC 8291 §3.3, then RFC 8188 §2.2 and §2.3.
    let ikm = expand(extract(salt: auth, from: secret), info: label("WebPush: info") + publicKey + sender, count: 32)
    let prk = extract(salt: salt, from: ikm)
    let key = expand(prk, info: label("Content-Encoding: aes128gcm"), count: 16)
    let nonce = expand(prk, info: label("Content-Encoding: nonce"), count: 12)
    guard
      let box = try? AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce), ciphertext: body.dropLast(16), tag: body.suffix(16)),
      let record = try? AES.GCM.open(box, using: SymmetricKey(data: key))
    else { return nil }
    // The words, then the delimiter 2 of the last record, then padding zeros.
    let padded = [UInt8](record)
    guard let end = padded.lastIndex(where: { $0 != 0 }), padded[end] == 2 else { return nil }
    return Data(padded[..<end])
  }

  /// A label as RFC 8291 and RFC 8188 write it: its letters, then a zero.
  private static func label(_ text: String) -> Data {
    Data(text.utf8) + [0]
  }

  private static func hmac(_ key: Data, _ data: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
  }

  // HKDF (RFC 5869) with SHA-256, for outputs of one block at most.
  private static func extract(salt: Data, from ikm: Data) -> Data {
    hmac(salt, ikm)
  }

  private static func expand(_ prk: Data, info: Data, count: Int) -> Data {
    Data(hmac(prk, info + [1]).prefix(count))
  }
}
