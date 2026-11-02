import Foundation
import Security

/// What the app keeps for the share window, and the window keeps for itself
/// (#820), through the App Group the two share (`share_window.rs`):
///
/// - **The sign-ins**: one Keychain entry in the App Group's access group, a
///   table from each server's address to the window's own refresh token
///   there and when it was last saved. The app asks for them and drops them;
///   the window writes back each one it renews, so the next share starts from
///   it. Kept to this phone, as the app's own sign-ins are (#790).
/// - **The list** the app writes, `share-window/list.json`.
/// - **The conversations shared to last**, `share-window/recent.json`, the
///   window's own, for "Recent".
///
/// The folder is marked "don't back up" by the app, which makes it.
enum ShareStore {
  /// The same name is in both entitlements files, `shared.rs` and `share_window.rs`.
  static let appGroup = "group.io.github.itsmattguenther.linger"
  /// The Keychain entry; `share_window.rs` uses the same.
  static let service = "im.linger.share-window"
  static let account = "sign-ins"

  /// One server's sign-in for the window, as `share_window.rs` keeps it.
  struct Kept: Codable, Equatable {
    var refresh_token: String
    /// Unix milliseconds.
    var saved_at: UInt64
  }

  static var folder: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("share-window", isDirectory: true)
  }

  /// The list the app last wrote, or nil when there's none this window can read.
  static func list() -> ShareList? {
    guard let url = folder?.appendingPathComponent("list.json"), let data = try? Data(contentsOf: url) else { return nil }
    return ShareList.read(data)
  }

  // MARK: - Sign-ins

  private static func entry() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrAccessGroup as String: appGroup,
    ]
  }

  /// Every server's sign-in for the window; empty when there are none.
  static func signIns() -> [String: Kept] {
    var query = entry()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return [:] }
    return (try? JSONDecoder().decode([String: Kept].self, from: data)) ?? [:]
  }

  /// Keep `token` as `server`'s renewed sign-in. The table is read again
  /// first, so a sign-in the app changed meanwhile on another server stays.
  static func renewed(_ token: String, for server: String) {
    var table = signIns()
    table[server] = Kept(refresh_token: token, saved_at: UInt64(Date().timeIntervalSince1970 * 1000))
    guard let data = try? JSONEncoder().encode(table) else { return }
    let changes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(entry() as CFDictionary, changes as CFDictionary)
    if status == errSecItemNotFound {
      SecItemAdd(entry().merging(changes) { _, new in new } as CFDictionary, nil)
    }
  }

  /// Drop `server`'s sign-in, which the server has ended (a password change,
  /// say), so the app asks for a new one the next time it's opened.
  static func forget(_ server: String) {
    var table = signIns()
    guard table.removeValue(forKey: server) != nil, let data = try? JSONEncoder().encode(table) else { return }
    SecItemUpdate(entry() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
  }

  // MARK: - Recent

  private static var recentFile: URL? { folder?.appendingPathComponent("recent.json") }

  /// The conversations shared to last, newest first.
  static func recent() -> [ShareTarget] {
    guard let url = recentFile, let data = try? Data(contentsOf: url) else { return [] }
    return (try? JSONDecoder().decode([ShareTarget].self, from: data)) ?? []
  }

  /// Remember a share to `target`, for next time's "Recent".
  static func remember(_ target: ShareTarget) {
    guard let url = recentFile, let data = try? JSONEncoder().encode(remembering(target, in: recent())) else { return }
    try? data.write(to: url, options: .atomic)
  }
}
