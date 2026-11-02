import SwiftUI
import UIKit

// The iPhone's share window (#820), drawn with sample conversations and
// photos in each of its states, for screenshots on the iPhone Simulator
// (`scripts/share-window-shots.sh`, `share-window.yml`): the real ShareView
// and ShareModel, compiled with SHARE_PREVIEW, presented as the share sheet
// presents it. Only for looking at; it signs in and sends nothing.

/// Linger's colours as the app writes them (`core/shareWindow.ts`).
private let theme = ShareList.Theme(
  background: "#182135ff", raised: "#1b2436ff", field: "#0f1522ff", chosen: "#f3b55c1f", chosenEdge: "#f3b55c73",
  text: "#f1ebe0ff", textSecondary: "#c0c6d2ff", textMuted: "#8d96a9ff", hairline: "#222d44ff",
  accent: "#f3b55cff", onAccent: "#1c1206ff", danger: "#f06e6eff")

private func room(_ id: String, _ name: String) -> ShareList.Conversation {
  ShareList.Conversation(room_id: id, kind: "room", name: name, colors: [])
}

private func person(_ id: String, _ name: String, _ color: String) -> ShareList.Conversation {
  ShareList.Conversation(room_id: id, kind: "dm", name: name, colors: [color])
}

private let good = "https://good.example"
private let porch = "https://porch.example"

private let list = ShareList(
  version: ShareList.version, written_at: 0, theme: theme,
  servers: [
    ShareList.Server(base_url: good, name: "The Good Company", share: "ready", conversations: [
      room("r-general", "general"), room("r-raid", "raid-night"), room("r-photos", "photos-and-things"),
      ShareList.Conversation(room_id: "g-trip", kind: "group", name: "Eli, Sam and Jules", colors: ["#6fa8ffff", "#7fd1a0ff", "#e8a06aff"]),
      person("d-eli", "Eli", "#6fa8ffff"), person("d-sam", "Sam", "#7fd1a0ff"), person("d-jules", "Jules", "#e8a06aff"),
      person("d-long", "Bartholomew Featherstonehaugh-Smythe", "#d79be6ff"),
    ]),
    ShareList.Server(base_url: porch, name: "Porch", share: "old", conversations: [room("p-general", "general")]),
  ])

/// A picture standing in for a photo: a sky and a field.
private func photo(_ top: UIColor, _ bottom: UIColor) -> UIImage {
  UIGraphicsImageRenderer(size: CGSize(width: 168, height: 168)).image { context in
    let colors = [top.cgColor, bottom.cgColor] as CFArray
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
    context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: 168), options: [])
    UIColor(red: 0.25, green: 0.45, blue: 0.22, alpha: 1).setFill()
    context.fill(CGRect(x: 0, y: 112, width: 168, height: 56))
  }
}

private func file(_ name: String, _ mime: String) -> ShareFile {
  ShareFile(url: URL(fileURLWithPath: "/tmp/\(name)"), name: name, mime: mime, size: 3_000_000)
}

@main
final class PreviewApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let state = ProcessInfo.processInfo.arguments.dropFirst().first ?? "picking"
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = Behind(state: state)
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}

/// What the share sheet rises over, and the window rising.
private final class Behind: UIViewController {
  let state: String
  init(state: String) {
    self.state = state
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("not from a storyboard") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(white: 0.12, alpha: 1)
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    let recent = [ShareTarget(server: good, room: "d-eli"), ShareTarget(server: good, room: "r-general")]
    let model = ShareModel(
      list: state == "blocked" ? nil : list, signedIn: [good], recent: state == "first" ? [] : recent,
      finish: {}, cancel: {}, hold: { _ in })
    let photos = [photo(.systemTeal, .systemBlue), photo(.systemOrange, .systemPink), photo(.systemIndigo, .systemPurple)]
    switch state {
    case "gathering":
      break
    case "files":
      model.gathered([file("trip-notes.pdf", "application/pdf"), file("clip.mov", "video/quicktime")],
        previews: [SharePreview(image: nil, symbol: "doc", name: "trip-notes.pdf"), SharePreview(image: nil, symbol: "film", name: "clip.mov")],
        note: nil)
    default:
      let count = state == "one" ? 1 : 3
      model.gathered(
        (0..<count).map { file("IMG_000\($0).jpeg", "image/jpeg") },
        previews: photos.prefix(count).map { SharePreview(image: $0, symbol: "photo", name: "IMG") },
        note: state == "note" ? "IMG_0004.mov is too big to send. A file can be 500 MB at most." : nil)
    }
    let chosen = model.sections.flatMap(\.rows).first { $0.target.room == "r-general" }
    switch state {
    case "chosen", "sending", "failed", "sent":
      if let chosen { model.choose(chosen) }
      model.message = "Look at this sky from the trip!"
    case "search":
      model.search = "e"
    default:
      break
    }
    switch state {
    case "sending": model.showing(.sending, progress: 0.42)
    case "sent": model.showing(.sent, progress: 1)
    case "failed": model.showing(.picking, failure: "Linger couldn't reach The Good Company. Check your connection and try again.")
    default: break
    }
    let sheet = UIHostingController(rootView: ShareView(model: model))
    sheet.overrideUserInterfaceStyle = .dark
    present(sheet, animated: false)
  }
}
