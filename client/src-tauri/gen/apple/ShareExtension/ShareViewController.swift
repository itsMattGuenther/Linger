import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Share to Linger (#785, #820, SPEC §4.15): the window that rises inside the
/// iPhone's share sheet when somebody picks Linger. It shows what's being
/// shared, a message box and every conversation (`ShareView`), and posts to
/// the one picked, as the person, without leaving the app they shared from
/// (`ShareModel`, `ShareSender`). The app keeps it a sign-in of its own and
/// the list it picks from (`ShareStore`, `share_window.rs`).
///
/// This holds the window and gathers what was shared: each file copied into
/// the extension's own temporary folder, a photo kept only as HEIC made a
/// JPEG at a bounded size first (#817), and a thumbnail of each picture.
/// Nothing about the app that shared is read or kept (AGENTS.md hard rule 2).
@objc(ShareViewController)
final class ShareViewController: UIViewController {
  private var model: ShareModel?

  override func viewDidLoad() {
    super.viewDidLoad()
    // Linger is dark only (docs/decisions.md).
    overrideUserInterfaceStyle = .dark
    let model = ShareModel(
      finish: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
      cancel: { [weak self] in self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
    )
    self.model = model
    let window = UIHostingController(rootView: ShareView(model: model))
    window.view.backgroundColor = .clear
    addChild(window)
    window.view.frame = view.bounds
    window.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(window.view)
    window.didMove(toParent: self)

    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    Task {
      let gathered = await Gather.all(providers)
      model.gathered(gathered.files, previews: gathered.previews, note: gathered.note)
    }
  }
}

/// Copying what was shared where the window can send it from.
enum Gather {
  /// As many files as one message takes (`linger-core`,
  /// `MAX_ATTACHMENTS_PER_MESSAGE`); the activation rule says the same.
  static let mostFiles = 10
  /// The biggest file the server takes (`linger-core`, `MAX_FILE_BYTES`).
  static let mostBytes: Int64 = 500 * 1024 * 1024
  /// The longest name a shared file is given, in characters, keeping a short
  /// extension, by the rules downloads follow (`phone_save.rs`, `file_name`).
  static let longestName = 120
  static let longestExtension = 16
  /// The longest side, in pixels, of the JPEG a HEIC photo is made into
  /// (#817). A share extension gets about 120 MB, and decoding a recent
  /// iPhone's photo whole (24 or 48 megapixels, 100 to 200 MB) got it ended
  /// mid-share. Read at this size instead, a photo takes about 50 MB at most,
  /// and keeps the detail of a 12-megapixel one.
  static let longestSide = 4096
  /// A thumbnail's longest side, in pixels: three times the 56-point tile.
  static let thumbnailSide = 168

  struct Gathered {
    var files: [ShareFile] = []
    var previews: [SharePreview] = []
    /// What was left out, in words.
    var note: String?
  }

  /// Every file shared, in order, up to `mostFiles`, with what was left out said.
  static func all(_ providers: [NSItemProvider]) async -> Gathered {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("linger-share-\(UUID().uuidString)", isDirectory: true)
    var gathered = Gathered()
    var notes: [String] = []
    let offered = providers.filter { fileType($0) != nil }
    if offered.count > mostFiles { notes.append("A message takes \(mostFiles) files at most, so the first \(mostFiles) are here.") }
    for (place, provider) in offered.prefix(mostFiles).enumerated() {
      guard let file = await copy(provider, into: folder.appendingPathComponent(String(place), isDirectory: true)) else {
        notes.append("One couldn't be read, so it's left out.")
        continue
      }
      if file.size > mostBytes {
        notes.append("\(file.name) is too big to send. A file can be 500 MB at most.")
        try? FileManager.default.removeItem(at: file.url)
        continue
      }
      gathered.files.append(file)
      gathered.previews.append(preview(of: file))
    }
    if gathered.files.isEmpty && offered.isEmpty { notes.append("Only pictures, videos and files can be shared to Linger.") }
    // Each note once, in the order they came.
    var seen = Set<String>()
    let said = notes.filter { seen.insert($0).inserted }.joined(separator: " ")
    gathered.note = said.isEmpty ? nil : said
    return gathered
  }

  /// Copy one shared thing into `folder`, as its own name made safe. A photo
  /// goes as a JPEG, which the server takes, rather than as HEIC, which it
  /// doesn't: the sharing app's own JPEG when it offers one, or one made here
  /// at a bounded size (`jpeg`, #817).
  private static func copy(_ provider: NSItemProvider, into folder: URL) async -> ShareFile? {
    guard let type = fileType(provider) else { return nil }
    let heicOnly = type.conforms(to: .heic) && !provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier)
    let asked = provider.hasItemConformingToTypeIdentifier(UTType.jpeg.identifier) && type.conforms(to: .image) ? UTType.jpeg : type
    let saved = heicOnly ? UTType.jpeg : asked
    let suggested = provider.suggestedName
    return await withCheckedContinuation { done in
      _ = provider.loadFileRepresentation(forTypeIdentifier: asked.identifier) { url, _ in
        // The file is iOS's only until this returns: copy it now.
        guard let url else {
          done.resume(returning: nil)
          return
        }
        let files = FileManager.default
        do {
          try files.createDirectory(at: folder, withIntermediateDirectories: true)
          let name = Gather.name(suggested, url: url, type: saved)
          let target = folder.appendingPathComponent(name)
          if heicOnly {
            guard Gather.jpeg(from: url, to: target) else { throw CocoaError(.fileReadCorruptFile) }
          } else {
            try files.copyItem(at: url, to: target)
          }
          let size = (try? files.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
          let mime = saved.preferredMIMEType ?? UTType(filenameExtension: target.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
          done.resume(returning: ShareFile(url: target, name: name, mime: mime, size: size))
        } catch {
          try? files.removeItem(at: folder)
          done.resume(returning: nil)
        }
      }
    }
  }

  /// A small picture of a photo, read at thumbnail size; a symbol for the rest.
  private static func preview(of file: ShareFile) -> SharePreview {
    if file.mime.hasPrefix("image/"), let source = CGImageSourceCreateWithURL(file.url as CFURL, nil) {
      let reading: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: thumbnailSide,
      ]
      if let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, reading as CFDictionary) {
        return SharePreview(image: UIImage(cgImage: thumbnail), symbol: "photo", name: file.name)
      }
    }
    return SharePreview(image: nil, symbol: file.mime.hasPrefix("video/") ? "film" : "doc", name: file.name)
  }

  /// A photo as a JPEG at `target`, read no bigger than `longestSide` and
  /// turned upright (#817). ImageIO reads a HEIC at the size asked rather than
  /// whole, so the memory this takes is the smaller picture's, and it writes
  /// the JPEG as it goes. Answers whether one was written.
  static func jpeg(from source: URL, to target: URL) -> Bool {
    guard let image = CGImageSourceCreateWithURL(source as CFURL, nil) else { return false }
    let reading: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: longestSide,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let picture = CGImageSourceCreateThumbnailAtIndex(image, 0, reading as CFDictionary),
      let out = CGImageDestinationCreateWithURL(target as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else { return false }
    let writing: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
    CGImageDestinationAddImage(out, picture, writing as CFDictionary)
    return CGImageDestinationFinalize(out)
  }

  /// The kind of file a shared thing is, or nil for words or a link, which
  /// Linger doesn't take (the activation rule offers Linger only for files).
  static func fileType(_ provider: NSItemProvider) -> UTType? {
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
  static func name(_ suggested: String?, url: URL, type: UTType) -> String {
    let given = suggested.flatMap { $0.isEmpty ? nil : $0 } ?? url.deletingPathExtension().lastPathComponent
    let bare = (given as NSString).deletingPathExtension
    let stem = safe(bare.isEmpty ? given : bare)
    let named = stem.isEmpty ? "file" : stem
    let ext = type.preferredFilenameExtension ?? url.pathExtension
    return shortened(ext.isEmpty ? named : "\(named).\(ext)")
  }

  /// Only what's after the last slash, no control characters, none that turn
  /// text around (#488), no colon, no leading dots.
  static func safe(_ name: String) -> String {
    let last = name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
    let kept = String(String.UnicodeScalarView(last.unicodeScalars.filter { scalar in
      !CharacterSet.controlCharacters.contains(scalar) && !changesDirection(scalar) && scalar != ":"
    }))
    var trimmed = kept.trimmingCharacters(in: .whitespaces)
    while trimmed.hasPrefix(".") { trimmed.removeFirst() }
    return trimmed.trimmingCharacters(in: .whitespaces)
  }

  /// At most `longestName` characters, with a short extension kept whole.
  static func shortened(_ name: String) -> String {
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
}
