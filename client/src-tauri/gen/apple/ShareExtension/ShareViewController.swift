import UIKit
import UniformTypeIdentifiers

/// Share to Linger (#785, SPEC §4.15): the iPhone's share sheet hands this
/// extension the pictures, videos or files somebody chose, and it copies them
/// into the inbox in the App Group's folder, which the app can read and this
/// can write (`src-tauri/src/shared.rs`). Each file goes in a numbered folder
/// of its own: `shared/0/IMG_0001.jpeg`. They're written into
/// `shared-incoming` and take the inbox's place with one move once every file
/// is whole, so the app never reads half a file, and a new share replaces the
/// last. The folder is marked to stay out of iCloud backups before anything
/// goes in it.
///
/// Then it opens `linger://shared` to bring Linger forward, where the list asks
/// which conversation they're for. An extension can't open its app directly;
/// this asks the responder chain for an application that can. If iOS refuses,
/// the share still waits ten minutes for the person to open Linger.
///
/// Nothing about the app that shared is read or kept (AGENTS.md hard rule 2),
/// and nothing is sent anywhere from here.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  /// The App Group the app and this extension share. The same name is in both
  /// entitlements files and in `shared.rs`.
  private static let appGroup = "group.io.github.itsmattguenther.linger"

  /// As many files as one message takes (`linger-core`,
  /// `MAX_ATTACHMENTS_PER_MESSAGE`); the activation rule says the same.
  private static let mostFiles = 10

  /// The longest name a shared file is given, in characters, keeping a short
  /// extension, by the rules downloads follow (`phone_save.rs`, `file_name`).
  private static let longestName = 120
  private static let longestExtension = 16

  private var started = false

  /// How the share ended, for what the person sees before the sheet closes.
  private enum Outcome {
    /// Linger is coming forward with it.
    case opened
    /// It's in the inbox, but iOS didn't let this open Linger.
    case waiting
    /// Nothing could be copied.
    case nothing
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    Task { await share() }
  }

  private func share() async {
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
      .flatMap { $0.attachments ?? [] }
      .prefix(Self.mostFiles)
    guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.appGroup) else {
      finish(.nothing)
      return
    }
    let incoming = group.appendingPathComponent("shared-incoming", isDirectory: true)
    let inbox = group.appendingPathComponent("shared", isDirectory: true)
    let files = FileManager.default
    try? files.removeItem(at: incoming)
    do {
      try files.createDirectory(at: incoming, withIntermediateDirectories: true)
      // Out of iCloud backups before anything is written, as the rest of
      // Linger is (SPEC §4.15, #792): an App Group's folder is backed up
      // unless told otherwise. The mark is the folder's own, so it moves with
      // it into `shared`, and on into the app's `shared-taken`. A share that
      // can't be kept out isn't taken.
      var outOfBackups = URLResourceValues()
      outOfBackups.isExcludedFromBackup = true
      var marked = incoming
      try marked.setResourceValues(outOfBackups)
    } catch {
      finish(.nothing)
      return
    }
    var place = 0
    for provider in providers {
      let folder = incoming.appendingPathComponent(String(place), isDirectory: true)
      if await copy(provider, into: folder) { place += 1 }
    }
    guard place > 0 else {
      try? files.removeItem(at: incoming)
      finish(.nothing)
      return
    }
    try? files.removeItem(at: inbox)
    do {
      try files.moveItem(at: incoming, to: inbox)
    } catch {
      try? files.removeItem(at: incoming)
      finish(.nothing)
      return
    }
    finish(openLinger() ? .opened : .waiting)
  }

  /// Copy one shared thing into `folder`, as its own name made safe. A photo
  /// goes as a JPEG, which the server takes, rather than as HEIC, which it
  /// doesn't. Answers whether a file was written.
  private func copy(_ provider: NSItemProvider, into folder: URL) async -> Bool {
    guard let type = Self.fileType(provider) else { return false }
    let heicOnly = type.conforms(to: .heic) && !provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier)
    let asked = provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier) && type.conforms(to: .image) ? UTType.jpeg : type
    return await withCheckedContinuation { done in
      _ = provider.loadFileRepresentation(forTypeIdentifier: asked.identifier) { url, _ in
        // The file is iOS's only until this returns: copy it now.
        guard let url else {
          done.resume(returning: false)
          return
        }
        let files = FileManager.default
        do {
          try files.createDirectory(at: folder, withIntermediateDirectories: true)
          let name = Self.name(provider.suggestedName, url: url, type: heicOnly ? .jpeg : asked)
          let target = folder.appendingPathComponent(name)
          if heicOnly {
            guard let jpeg = UIImage(contentsOfFile: url.path)?.jpegData(compressionQuality: 0.9) else { throw CocoaError(.fileReadCorruptFile) }
            try jpeg.write(to: target)
          } else {
            try files.copyItem(at: url, to: target)
          }
          done.resume(returning: true)
        } catch {
          try? files.removeItem(at: folder)
          done.resume(returning: false)
        }
      }
    }
  }

  /// The kind of file a shared thing is, or nil for words or a link, which
  /// Linger doesn't take (the activation rule offers Linger only for files).
  private static func fileType(_ provider: NSItemProvider) -> UTType? {
    provider.registeredTypeIdentifiers
      .compactMap { UTType($0) }
      .first { type in
        type.conforms(to: .image) || type.conforms(to: .movie)
          || (type.conforms(to: .data) && !type.conforms(to: .url) && !type.conforms(to: .plainText))
      }
  }

  /// The name a shared file is saved under: the one the sharing app suggests,
  /// or the temporary file's, made safe to be one file in one folder, with
  /// the extension of what's actually saved.
  private static func name(_ suggested: String?, url: URL, type: UTType) -> String {
    let given = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? url.deletingPathExtension().lastPathComponent
    let bare = (given as NSString).deletingPathExtension
    let stem = safe(bare.isEmpty ? given : bare)
    let named = stem.isEmpty ? "file" : stem
    let ext = type.preferredFilenameExtension ?? url.pathExtension
    return shortened(ext.isEmpty ? named : "\(named).\(ext)")
  }

  /// Only what's after the last slash, no control characters, none that turn
  /// text around (#488), no colon, no leading dots.
  private static func safe(_ name: String) -> String {
    let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
    let kept = String(String.UnicodeScalarView(last.unicodeScalars.filter { scalar in
      !CharacterSet.controlCharacters.contains(scalar) && !changesDirection(scalar) && scalar != ":"
    }))
    var trimmed = kept.trimmingCharacters(in: .whitespaces)
    while trimmed.hasPrefix(".") { trimmed.removeFirst() }
    return trimmed.trimmingCharacters(in: .whitespaces)
  }

  /// At most `longestName` characters, with a short extension kept whole.
  private static func shortened(_ name: String) -> String {
    guard name.count > longestName else { return name }
    let ext = (name as NSString).pathExtension
    let keep = ext.isEmpty || ext.count + 1 > longestExtension ? "" : ".\(ext)"
    let stem = keep.isEmpty ? name : (name as NSString).deletingPathExtension
    return String(stem.prefix(longestName - keep.count)).trimmingCharacters(in: .whitespaces) + keep
  }

  private static func changesDirection(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x202A...0x202E, 0x2066...0x2069, 0x061C, 0x200E, 0x200F: return true
    default: return false
    }
  }

  /// Ask the responder chain for the application, and have it open
  /// `linger://shared`. Answers whether there was one to ask.
  private func openLinger() -> Bool {
    guard let link = URL(string: "linger://shared") else { return false }
    var responder: UIResponder? = self
    while let next = responder {
      if let application = next as? UIApplication {
        application.open(link, options: [:], completionHandler: nil)
        return true
      }
      responder = next.next
    }
    return false
  }

  /// Close the share sheet. When Linger isn't coming forward, say why first,
  /// so the share isn't a mystery.
  private func finish(_ outcome: Outcome) {
    DispatchQueue.main.async {
      let words: (title: String, message: String)
      switch outcome {
      case .opened:
        self.extensionContext?.completeRequest(returningItems: nil)
        return
      case .waiting:
        words = ("Open Linger to share", "It's waiting there for the next ten minutes.")
      case .nothing:
        words = ("Linger couldn't take that", "Only pictures, videos and files can be shared to Linger.")
      }
      let alert = UIAlertController(title: words.title, message: words.message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
        self.extensionContext?.completeRequest(returningItems: nil)
      })
      self.present(alert, animated: true)
    }
  }
}
