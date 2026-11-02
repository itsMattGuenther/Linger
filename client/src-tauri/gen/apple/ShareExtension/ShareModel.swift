import SwiftUI
import UIKit

/// One thing being shared, as the window shows it: a picture's thumbnail, or
/// a symbol and the file's name.
struct SharePreview: Identifiable {
  let id = UUID()
  let image: UIImage?
  /// An SF Symbol for what has no thumbnail: "film", "doc".
  let symbol: String
  let name: String
}

/// What the share window shows and does (#820): what's being shared, the
/// words, the conversation picked, and sending it.
@MainActor
final class ShareModel: ObservableObject {
  enum Stage: Equatable {
    /// Copying what was shared, and making thumbnails.
    case gathering
    case picking
    case sending
    case sent
  }

  @Published private(set) var stage: Stage = .gathering
  @Published private(set) var files: [ShareFile] = []
  @Published private(set) var previews: [SharePreview] = []
  /// Something about what was shared that was left out, in words.
  @Published private(set) var note: String?
  /// Why the window can't share at all, in words; nil when it can.
  @Published private(set) var blocked: String?
  @Published var message = ""
  @Published var search = ""
  @Published private(set) var chosen: ShareTarget?
  /// How far the send has got, 0 to 1.
  @Published private(set) var progress: Double = 0
  /// Why the last send didn't go, in words.
  @Published private(set) var failure: String?

  let colors: ShareColors
  private let list: ShareList?
  private let signedIn: Set<String>
  private let recent: [ShareTarget]
  /// One for the whole share, so a retry whose first answer was lost can't
  /// post it twice (#524).
  private let nonce = UUID().uuidString
  private let finish: () -> Void
  private let cancel: () -> Void
  /// Hold the share sheet still while sending: swiped away, the share
  /// would end half-way.
  private let hold: (Bool) -> Void

  init(finish: @escaping () -> Void, cancel: @escaping () -> Void, hold: @escaping (Bool) -> Void) {
    self.finish = finish
    self.cancel = cancel
    self.hold = hold
    let list = ShareStore.list()
    self.list = list
    colors = ShareColors(list?.theme)
    signedIn = Set(ShareStore.signIns().keys)
    recent = ShareStore.recent()
    if list == nil {
      blocked = "Open Linger and sign in, then share again."
    } else if list?.servers.isEmpty == true {
      blocked = "Sign in to a server in Linger, then share again."
    }
  }

  var sections: [ShareSection] {
    guard let list else { return [] }
    return shareSections(list, signedIn: signedIn, recent: recent, search: search)
  }

  /// Several servers: a found conversation says which.
  var severalServers: Bool { (list?.servers.count ?? 0) > 1 }

  var canSend: Bool {
    stage == .picking && !files.isEmpty && chosenRow?.unavailable == nil && chosen != nil
  }

  /// The chosen conversation's row, wherever it is in the list.
  var chosenRow: ShareRow? {
    guard let list, let chosen else { return nil }
    return shareSections(list, signedIn: signedIn, recent: [], search: "")
      .flatMap(\.rows)
      .first { $0.target == chosen }
  }

  /// What's being shared, in a few words: "2 photos", "notes.pdf".
  var what: String {
    let pictures = files.filter { $0.mime.hasPrefix("image/") }.count
    let videos = files.filter { $0.mime.hasPrefix("video/") }.count
    if files.count == 1, let only = files.first {
      if pictures == 1 { return "a photo" }
      if videos == 1 { return "a video" }
      return only.name
    }
    if pictures == files.count { return "\(files.count) photos" }
    if videos == files.count { return "\(files.count) videos" }
    return "\(files.count) files"
  }

  /// "#general", or a person's or group's name.
  func label(_ conversation: ShareList.Conversation) -> String {
    conversation.kind == "room" ? "#\(conversation.name)" : conversation.name
  }

  func gathered(_ files: [ShareFile], previews: [SharePreview], note: String?) {
    self.files = files
    self.previews = previews
    self.note = note
    if files.isEmpty, blocked == nil {
      blocked = note ?? "Only pictures, videos and files can be shared to Linger."
    }
    stage = .picking
  }

  func choose(_ row: ShareRow) {
    guard stage == .picking, row.unavailable == nil else { return }
    chosen = chosen == row.target ? nil : row.target
    failure = nil
  }

  func close() {
    if stage == .sending { return }
    cancel()
  }

  func send() {
    guard canSend, let target = chosen, let row = chosenRow else { return }
    guard let kept = ShareStore.signIns()[target.server], let base = URL(string: target.server) else {
      failure = "Open Linger once, then share again."
      return
    }
    stage = .sending
    failure = nil
    progress = 0
    hold(true)
    let sender = ShareSender(base: base, serverName: row.serverName, refreshToken: kept.refresh_token) { token in
      ShareStore.renewed(token, for: target.server)
    }
    let files = files
    let words = message
    let nonce = nonce
    Task { [weak self] in
      do {
        try await sender.send(files: files, message: words, roomId: target.room, nonce: nonce) { sent in
          Task { @MainActor [weak self] in
            guard let self, self.stage == .sending else { return }
            self.progress = max(self.progress, sent)
          }
        }
        ShareStore.remember(target)
        self?.hold(false)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        self?.stage = .sent
        try? await Task.sleep(nanoseconds: 900_000_000)
        self?.finish()
      } catch {
        self?.hold(false)
        self?.stage = .picking
        let failure = error as? ShareFailure
        // Ended on the server: dropped here, so the app asks for a new one.
        if failure?.signInGone == true { ShareStore.forget(target.server) }
        self?.failure = failure?.words ?? "That didn't go. Try again in a moment."
      }
    }
  }
}

/// Linger's colours, from the list the app wrote. Before there is one (Linger
/// not opened yet), its dark ones as they are today, so the window still
/// looks like Linger while it says to open it.
struct ShareColors {
  let background: Color
  let raised: Color
  let field: Color
  let chosen: Color
  let chosenEdge: Color
  let text: Color
  let textSecondary: Color
  let textMuted: Color
  let hairline: Color
  let accent: Color
  let onAccent: Color
  let danger: Color

  init(_ theme: ShareList.Theme?) {
    func color(_ hex: String?, _ fallback: String) -> Color {
      let (red, green, blue, alpha) = rgba(hex ?? fallback) ?? rgba(fallback) ?? (0, 0, 0, 1)
      return Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha)
    }
    background = color(theme?.background, "#182135ff")
    raised = color(theme?.raised, "#1b2436ff")
    field = color(theme?.field, "#0f1522ff")
    chosen = color(theme?.chosen, "#f3b55c1f")
    chosenEdge = color(theme?.chosenEdge, "#f3b55c73")
    text = color(theme?.text, "#f1ebe0ff")
    textSecondary = color(theme?.textSecondary, "#c0c6d2ff")
    textMuted = color(theme?.textMuted, "#8d96a9ff")
    hairline = color(theme?.hairline, "#222d44ff")
    accent = color(theme?.accent, "#f3b55cff")
    onAccent = color(theme?.onAccent, "#1c1206ff")
    danger = color(theme?.danger, "#f06e6eff")
  }
}
