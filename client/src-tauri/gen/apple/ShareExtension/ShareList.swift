import Foundation
#if canImport(Glibc)
  import Glibc
#endif

/// The list the share window picks from (#820), as the app writes it
/// (`client/src/next/core/shareWindow.ts`, `ShareWindowList`) into the App
/// Group: every server, its conversations in the list's order, and Linger's
/// colours. A change to one side is a change to the other, and `version`
/// says which; a list of another version is one this window can't read.
struct ShareList: Decodable, Equatable {
  static let version = 1

  let version: Int
  /// When the app wrote it, in Unix milliseconds.
  let written_at: UInt64
  let theme: Theme
  let servers: [Server]

  /// Each colour as `#rrggbbaa`, from the app's design tokens.
  struct Theme: Decodable, Equatable {
    let background: String
    let raised: String
    let field: String
    let chosen: String
    let chosenEdge: String
    let text: String
    let textSecondary: String
    let textMuted: String
    let hairline: String
    let accent: String
    let onAccent: String
    let danger: String
  }

  struct Server: Decodable, Equatable {
    let base_url: String
    let name: String
    /// `ready` when the app keeps the window a sign-in there; `old` when the
    /// server needs updating for it; `none` when the app hasn't one yet.
    let share: String
    let conversations: [Conversation]
  }

  struct Conversation: Decodable, Equatable, Hashable {
    let room_id: String
    /// `room`, `group` or `dm`.
    let kind: String
    let name: String
    /// People's colours: a DM's person, a group's first three; none for a room.
    let colors: [String]
  }

  /// The list from its JSON, or nil when it isn't one this window reads.
  static func read(_ data: Data) -> ShareList? {
    guard let list = try? JSONDecoder().decode(ShareList.self, from: data), list.version == version else { return nil }
    return list
  }
}

/// `#rrggbbaa` (or `#rrggbb`) as red, green, blue and alpha from 0 to 1; nil
/// for anything else.
func rgba(_ hex: String) -> (Double, Double, Double, Double)? {
  guard hex.hasPrefix("#") else { return nil }
  let digits = String(hex.dropFirst())
  guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else { return nil }
  let full = digits.count == 6 ? (value << 8) | 0xff : value
  return (
    Double((full >> 24) & 0xff) / 255,
    Double((full >> 16) & 0xff) / 255,
    Double((full >> 8) & 0xff) / 255,
    Double(full & 0xff) / 255
  )
}

/// One conversation on one server: what the window sends to.
struct ShareTarget: Hashable, Codable {
  let server: String
  let room: String
}

/// A row in the window: a conversation, its server, and whether it can be
/// sent to now.
struct ShareRow: Hashable {
  let target: ShareTarget
  let conversation: ShareList.Conversation
  let serverName: String
  /// Why it can't be sent to, in words; nil when it can.
  let unavailable: String?
}

/// A titled group of rows.
struct ShareSection: Hashable {
  /// "Recent", a server's name, or nil for one server's only section.
  let title: String?
  let rows: [ShareRow]
  /// Whether each row says its server: Recent and what a search found, when
  /// there are several, or two rooms called "general" would look the same.
  var namesServers = false
}

/// The most recent conversations shown above the rest.
let mostRecent = 4

/// What a server's state means for sending there, in words; nil when it can.
/// `signedIn` is whether the window holds a sign-in there.
///
/// The sign-in decides: the app writes the list before it has one on a new
/// server, and may not have written it again since.
func unavailable(_ server: ShareList.Server, signedIn: Bool) -> String? {
  if server.share == "old" { return "\(server.name) needs updating to share from here" }
  if !signedIn { return "Open Linger once to share here" }
  return nil
}

/// The window's rows (#820): with nothing searched, the few conversations
/// shared to last on top ("Recent", those still there and ready), then each
/// server's in the list's order, under its name when there are several;
/// searched, every conversation whose name has the words, in one list.
func shareSections(_ list: ShareList, signedIn: Set<String>, recent: [ShareTarget], search: String) -> [ShareSection] {
  let rows = list.servers.map { server in
    server.conversations.map { conversation in
      ShareRow(
        target: ShareTarget(server: server.base_url, room: conversation.room_id),
        conversation: conversation,
        serverName: server.name,
        unavailable: unavailable(server, signedIn: signedIn.contains(server.base_url))
      )
    }
  }
  let words = search.trimmingCharacters(in: .whitespacesAndNewlines)
  if !words.isEmpty {
    let found = rows.joined().filter { matches($0.conversation.name, words) }
    return found.isEmpty ? [] : [ShareSection(title: nil, rows: Array(found), namesServers: list.servers.count > 1)]
  }
  var sections: [ShareSection] = []
  let byTarget = Dictionary(rows.joined().map { ($0.target, $0) }, uniquingKeysWith: { first, _ in first })
  var seen = Set<ShareTarget>()
  let recents = recent.compactMap { target -> ShareRow? in
    guard let row = byTarget[target], row.unavailable == nil, seen.insert(target).inserted else { return nil }
    return row
  }.prefix(mostRecent)
  let several = list.servers.count > 1
  if !recents.isEmpty { sections.append(ShareSection(title: "Recent", rows: Array(recents), namesServers: several)) }
  for (server, serverRows) in zip(list.servers, rows) where !serverRows.isEmpty {
    sections.append(ShareSection(title: several || !recents.isEmpty ? server.name : nil, rows: serverRows))
  }
  return sections
}

/// Whether `name` has `words` in it, ignoring case and accents, as a person
/// typing "jose" expects to find "José".
func matches(_ name: String, _ words: String) -> Bool {
  let fold: (String) -> String = { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
  return fold(name).contains(fold(words))
}

/// The conversations shared to last, newest first, at most a few more than
/// shown, with `target` now the newest.
func remembering(_ target: ShareTarget, in recent: [ShareTarget]) -> [ShareTarget] {
  Array(([target] + recent.filter { $0 != target }).prefix(mostRecent + 4))
}

/// Run `change` holding the lock on `folder`'s `sign-ins.lock`, which the app
/// takes too (`while_locked` in `share_window.rs`, #822). Each side reads the
/// sign-ins, changes one server's and writes them back; without the lock, one
/// could write back what it read just before the other's write, and undo it.
/// Held only for the read and write, never while asking a server. Without a
/// folder, or a lock to be had, it runs anyway.
func whileLocked<T>(_ folder: URL?, _ change: () -> T) -> T {
  guard let folder else { return change() }
  try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  let file = open(folder.appendingPathComponent("sign-ins.lock").path, O_CREAT | O_RDWR, 0o600)
  guard file >= 0 else { return change() }
  // Closing the file lets go of the lock.
  defer { close(file) }
  guard flock(file, LOCK_EX) == 0 else { return change() }
  return change()
}
