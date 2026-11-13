import Foundation
import Security
import UserNotifications

/// A phone notification arriving on an iPhone (#889, #830, SPEC §4.15,
/// PROTOCOL §5 "Phone notifications"), with Linger closed or open.
///
/// iOS runs this small program for a few seconds before it shows a
/// notification. Apple hands over what the relay sent: fallback words that
/// say only that something is new in Linger, and the server's notification,
/// encrypted to one of this phone's keys (`p`). It's opened here with the keys
/// the app keeps in the Keychain (`phone_push/ios.rs`), and shown in the
/// server's words, grouped by conversation. Nothing is kept, and nothing is
/// sent anywhere. Never a badge: the relay sends none and nothing here adds
/// one (hard rule 3).
///
/// When it can't be opened in time, or isn't for any key this phone has, the
/// fallback words show.
@objc(NotificationService)
final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fallback: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    deliver = contentHandler
    fallback = request.content
    guard
      let note = PushNote.open(request.content.userInfo["p"] as? String, keys: PushKeyStore.all()),
      let shown = request.content.mutableCopy() as? UNMutableNotificationContent
    else { return finish(request.content) }
    shown.title = note.title
    shown.body = note.body
    shown.threadIdentifier = note.thread
    shown.userInfo = note.opens
    finish(shown)
  }

  /// iOS is about to give up on this one: the fallback words, rather than
  /// anything half made.
  override func serviceExtensionTimeWillExpire() {
    if let fallback { finish(fallback) }
  }

  private func finish(_ content: UNNotificationContent) {
    guard let deliver else { return }
    self.deliver = nil
    deliver(content)
  }
}

/// The keys the app keeps for this extension (`phone_push/ios.rs`): one
/// Keychain entry in the App Group's access group, readable from the phone's
/// first unlock after it starts, so a notification to a locked phone opens.
enum PushKeyStore {
  /// The same names are in `phone_push/ios.rs`, and the group in both
  /// entitlements files.
  static let appGroup = "group.io.github.itsmattguenther.linger"
  static let service = "im.linger.push"
  static let account = "keys"

  /// Every server's keys; none when the app has kept none.
  static func all() -> [String: PushNote.Keys] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: appGroup,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else {
      return [:]
    }
    return PushNote.table(data)
  }
}
