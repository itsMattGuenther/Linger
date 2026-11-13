import Foundation

/// One phone notification, opened and read (#889, #830, PROTOCOL §5): what
/// the server wrote (`PushPayload` in `linger-core`), which server it came
/// from, and how it shows on this phone. Foundation only, so the tests run it
/// on a Mac as it is (`NotificationServiceTests/main.swift`).
struct PushNote: Equatable {
  /// The server whose key opened it, as the page names servers.
  let server: String
  let kind: String
  let title: String
  let body: String
  /// Where a tap opens: none for a knock.
  let room: String?
  let message: String?

  /// One server's keys, as `phone_push.rs` keeps them (`Keys` there).
  struct Keys: Equatable {
    let privateKey: Data
    let publicKey: Data
    let auth: Data
  }

  /// The kinds this phone knows. Anything else shows Apple's fallback words,
  /// which say only that something is new in Linger.
  static let kinds: Set<String> = ["mention", "dm", "knock", "follow", "room"]

  /// Every server's keys, from the table `phone_push.rs` writes into the
  /// Keychain: `{ server: { private_key, public_key, auth_secret } }`, each
  /// base64url. A server whose keys can't be read is left out.
  static func table(_ data: Data) -> [String: Keys] {
    guard let table = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    var keys: [String: Keys] = [:]
    for (server, entry) in table {
      guard
        let entry = entry as? [String: Any],
        let privateKey = (entry["private_key"] as? String).flatMap(base64url),
        let publicKey = (entry["public_key"] as? String).flatMap(base64url),
        let auth = (entry["auth_secret"] as? String).flatMap(base64url)
      else { continue }
      keys[server] = Keys(privateKey: privateKey, publicKey: publicKey, auth: auth)
    }
    return keys
  }

  /// The notification the relay passed on (`p`, base64url), opened with
  /// whichever server's keys open it: each server has keys of its own, so no
  /// two servers can tell they reach this phone, and the one that opens it
  /// says which server it's from. Nil when none does, or it says something
  /// this phone can't show.
  static func open(_ sealed: String?, keys: [String: Keys]) -> PushNote? {
    guard let message = sealed.flatMap(base64url) else { return nil }
    // In a fixed order, so the same notification always meets the same keys first.
    for server in keys.keys.sorted() {
      guard let mine = keys[server] else { continue }
      if let words = PushCrypto.decrypt(
        privateKey: mine.privateKey, publicKey: mine.publicKey, auth: mine.auth, message: message)
      {
        return read(words, server: server)
      }
    }
    return nil
  }

  /// The words the server encrypted, read. Nil for a version or a kind this
  /// phone doesn't know, or words without a title and a body.
  static func read(_ words: Data, server: String) -> PushNote? {
    guard
      let note = try? JSONSerialization.jsonObject(with: words) as? [String: Any],
      (note["v"] as? NSNumber)?.intValue == 1,
      let kind = note["kind"] as? String, kinds.contains(kind),
      let title = note["title"] as? String,
      let body = note["body"] as? String
    else { return nil }
    return PushNote(
      server: server, kind: kind, title: title, body: body,
      room: note["room_id"] as? String, message: note["message_id"] as? String)
  }

  /// Which notifications iOS groups together: one conversation's, or one
  /// server's knocks. Only this phone sees it.
  var thread: String {
    "\(server) \(room ?? "knocks")"
  }

  /// What a tap hands the app, which opens that conversation
  /// (`phone_push/ios.rs` reads the same keys). Replaces everything the relay
  /// sent, so the encrypted notification isn't kept with what's shown.
  var opens: [String: String] {
    var opens = ["linger_server": server]
    opens["linger_room"] = room
    opens["linger_message"] = message
    return opens
  }

  /// base64url without padding, as the server, the relay and the shell write it.
  static func base64url(_ text: String) -> Data? {
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
    return Data(base64Encoded: standard)
  }
}
