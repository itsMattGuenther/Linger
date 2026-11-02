import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One file to share: where it is on this phone, the name it goes up under,
/// its type, and its size in bytes.
struct ShareFile: Sendable, Equatable {
  let url: URL
  let name: String
  let mime: String
  let size: Int64
}

/// The nonce each send goes with (#524, #822). A retry of the same words to
/// the same conversation keeps the last one, so a send whose answer was lost
/// posts once. Once the words or the conversation change, a new one: with the
/// old one, the server would answer with the message it already has, and the
/// window would say Sent without posting the change.
struct ShareNonces {
  private var last: (nonce: String, words: String, target: ShareTarget)?

  mutating func next(words: String, target: ShareTarget, make: () -> String = { UUID().uuidString }) -> String {
    if let last, last.words == words, last.target == target { return last.nonce }
    let nonce = make()
    last = (nonce, words, target)
    return nonce
  }
}

/// Why a share didn't go, in words a person can act on (#820). `signInGone`
/// when the share window's sign-in on that server has ended, and only opening
/// Linger can mend it.
struct ShareFailure: Error, Sendable, Equatable {
  let words: String
  var signInGone = false
}

/// Posts what was shared to one conversation, as the person, on one server
/// (#820, SPEC §4.15): the share window's half of PROTOCOL §6 and §4.
///
/// - **Signed in with the window's own sign-in** (PROTOCOL §2,
///   `POST /auth/share-sign-in`): a refresh token of its own family, renewed
///   here with `POST /auth/refresh`, and handed back through `keep` each time
///   so the next share starts from it. Never the app's.
/// - **Each file goes up in a slot** (`POST /uploads`), its bytes PUT straight
///   to where the slot says, a part at a time past 8 MB, then completed,
///   waiting out a busy server's `retry_after_ms` up to three times (#801),
///   as the app does.
/// - **Then one message** with every file and the words, under `nonce`, which
///   the caller keeps for this share: a retry whose first answer was lost
///   can't post it twice (#524).
///
/// Foundation only, so `client/tests/share-sender` runs it on Linux against a
/// real server.
final class ShareSender: @unchecked Sendable {
  private let base: URL
  private let serverName: String
  private let session: URLSession
  private let keep: @Sendable (String) -> Void
  private let lock = NSLock()
  private var refreshToken: String
  private var accessToken: String?
  private let progress = UploadProgress()
  /// The longest a busy server's wait is taken; one longer goes to the person (#801).
  static let longestWaitMs: UInt64 = 30_000
  /// How many times a busy server is waited out.
  static let busyTries = 3
  /// How many goes each part gets, as the app's uploads (`lib/upload.ts`).
  static let partTries = 3

  init(base: URL, serverName: String, refreshToken: String, keep: @escaping @Sendable (String) -> Void) {
    self.base = base
    self.serverName = serverName
    self.refreshToken = refreshToken
    self.keep = keep
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 60
    session = URLSession(configuration: configuration, delegate: progress, delegateQueue: nil)
  }

  deinit {
    session.finishTasksAndInvalidate()
  }

  /// Upload `files` and post them, with `message`, to `roomId`. `sent` hears
  /// how far along it is, from 0 to 1. Throws a `ShareFailure`.
  func send(files: [ShareFile], message: String, roomId: String, nonce: String, sent: @escaping @Sendable (Double) -> Void) async throws {
    let total = max(files.reduce(Int64(0)) { $0 + max($1.size, 0) }, 1)
    var done: Int64 = 0
    var attachments: [String] = []
    var slots: [String] = []
    sent(0)
    do {
      try await renew()
      for file in files {
        let slot = try await openSlot(for: file)
        slots.append(slot.upload_id)
        let before = done
        let parts = try await put(file, into: slot) { bytes in
          sent(min(0.97, 0.97 * Double(before + bytes) / Double(total)))
        }
        done += file.size
        attachments.append(try await complete(slot, parts: parts))
      }
      let words = message.trimmingCharacters(in: .whitespacesAndNewlines)
      try await post(words, attachments: attachments, to: roomId, nonce: nonce)
      sent(1)
    } catch {
      // Nothing posted: give back what was reserved, rather than leave the
      // slots holding the person's space for an hour (PROTOCOL §6).
      for slot in slots { try? await discard(slot) }
      throw failure(from: error)
    }
  }

  // MARK: - The server's answers

  private struct Renew: Encodable { let refresh_token: String }
  private struct Renewed: Decodable { let access_token: String; let refresh_token: String }
  private struct Open: Encodable { let filename: String; let size_bytes: Int64; let mime: String }
  private struct Done: Encodable {
    let parts: [Part]?
    struct Part: Encodable { let number: Int; let etag: String }
  }
  private struct Post: Encodable { let body: String; let attachment_ids: [String]; let nonce: String }
  struct Slot: Decodable {
    let upload_id: String
    let method: String
    let url: String
    let headers: [String: String]
    let part_size_bytes: Int64
    let parts: [Part]?
    struct Part: Decodable { let number: Int; let url: String }
  }
  private struct Finished: Decodable { let id: String }
  private struct Refusal: Decodable {
    let error: Body
    struct Body: Decodable { let code: String; let message: String; let retry_after_ms: UInt64? }
  }

  /// A refusal the server explained, kept whole so the caller can tell a busy
  /// server from the rest.
  struct Refused: Error {
    let status: Int
    let code: String
    let message: String
    let retryAfterMs: UInt64?
  }

  // MARK: - Steps

  /// A fresh access token from the window's sign-in, and the renewed sign-in
  /// kept for next time. A refusal ends it: only Linger can mend that.
  private func renew() async throws {
    let token = lock.holding { refreshToken }
    let body = try JSONEncoder().encode(Renew(refresh_token: token))
    let (data, response) = try await call("POST", "/auth/refresh", body: body, authorized: false)
    guard response.statusCode == 200 else {
      if response.statusCode == 401 || response.statusCode == 403 {
        throw ShareFailure(words: "Open Linger, then share again: its sign-in on \(serverName) needs renewing.", signInGone: true)
      }
      throw refusal(data, response)
    }
    let renewed = try JSONDecoder().decode(Renewed.self, from: data)
    lock.holding {
      refreshToken = renewed.refresh_token
      accessToken = renewed.access_token
    }
    keep(renewed.refresh_token)
  }

  private func openSlot(for file: ShareFile) async throws -> Slot {
    let body = try JSONEncoder().encode(Open(filename: file.name, size_bytes: file.size, mime: file.mime))
    let (data, response) = try await authorized("POST", "/uploads", body: body)
    guard response.statusCode == 200 else { throw refusal(data, response) }
    return try JSONDecoder().decode(Slot.self, from: data)
  }

  /// The file's bytes, sent where the slot says: whole, or one part at a time,
  /// so no more than a part is in memory (a share extension has little).
  /// Each part gets a few goes, a short growing wait apart. Answers each
  /// part's number and ETag, as the store sent it, to complete with.
  private func put(_ file: ShareFile, into slot: Slot, sent: @escaping @Sendable (Int64) -> Void) async throws -> [(Int, String?)] {
    let plan: [(number: Int, url: String)] = slot.parts.map { $0.map { ($0.number, $0.url) } } ?? [(1, slot.url)]
    let handle = try FileHandle(forReadingFrom: file.url)
    defer { try? handle.close() }
    var tagged: [(Int, String?)] = []
    var before: Int64 = 0
    for (index, part) in plan.enumerated() {
      let length = index == plan.count - 1 ? file.size - before : slot.part_size_bytes
      try handle.seek(toOffset: UInt64(before))
      let bytes = handle.readData(ofLength: Int(max(length, 0)))
      guard let url = URL(string: part.url, relativeTo: base)?.absoluteURL else {
        throw ShareFailure(words: "\(serverName) gave an address Linger can't use.")
      }
      var request = URLRequest(url: url)
      request.httpMethod = slot.method
      for (name, value) in slot.headers { request.setValue(value, forHTTPHeaderField: name) }
      let start = before
      var answer: HTTPURLResponse?
      var last: Error?
      for attempt in 0..<Self.partTries {
        do {
          let tried = try await upload(request, bytes) { partSent in sent(start + partSent) }
          if (200..<300).contains(tried.1.statusCode) { answer = tried.1; break }
          last = refusal(tried.0, tried.1)
        } catch {
          last = error
        }
        try await Task.sleep(nanoseconds: UInt64(250_000_000 * (attempt + 1)))
      }
      guard let response = answer else { throw last ?? URLError(.unknown) }
      tagged.append((part.number, response.value(forHTTPHeaderField: "ETag")))
      before += Int64(bytes.count)
    }
    return tagged
  }

  /// Finish the slot, waiting out a busy server (#801): `RATE_LIMITED` keeps
  /// the slot, and completing again after its wait is the way through.
  private func complete(_ slot: Slot, parts: [(Int, String?)]) async throws -> String {
    // Every part's ETag, or none: the server checks them against what landed,
    // so a partial list is worse than none (`lib/upload.ts`).
    let tagged = parts.compactMap { part in part.1.map { Done.Part(number: part.0, etag: $0) } }
    let body = try JSONEncoder().encode(Done(parts: tagged.count == parts.count ? tagged : nil))
    var waited = 0
    while true {
      let (data, response) = try await authorized("POST", "/uploads/\(slot.upload_id)/complete", body: body)
      if response.statusCode == 200 { return try JSONDecoder().decode(Finished.self, from: data).id }
      let refused = refusal(data, response)
      if refused.code == "RATE_LIMITED", waited < Self.busyTries, let wait = refused.retryAfterMs, wait <= Self.longestWaitMs {
        waited += 1
        try await Task.sleep(nanoseconds: wait * 1_000_000)
        continue
      }
      throw refused
    }
  }

  private func post(_ words: String, attachments: [String], to roomId: String, nonce: String) async throws {
    let body = try JSONEncoder().encode(Post(body: words, attachment_ids: attachments, nonce: nonce))
    let (data, response) = try await authorized("POST", "/rooms/\(roomId)/messages", body: body)
    guard response.statusCode == 200 else { throw refusal(data, response) }
  }

  private func discard(_ slot: String) async throws {
    _ = try await authorized("DELETE", "/uploads/\(slot)", body: nil)
  }

  // MARK: - Calls

  /// A call with the access token, renewed and tried again once when the
  /// server says it has run out: a long upload can outlast its 15 minutes.
  private func authorized(_ method: String, _ path: String, body: Data?) async throws -> (Data, HTTPURLResponse) {
    let first = try await call(method, path, body: body, authorized: true)
    guard first.1.statusCode == 401 else { return first }
    try await renew()
    return try await call(method, path, body: body, authorized: true)
  }

  private func call(_ method: String, _ path: String, body: Data?, authorized: Bool) async throws -> (Data, HTTPURLResponse) {
    guard let url = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/api/v1" + path) else {
      throw ShareFailure(words: "Linger can't reach \(serverName) at that address.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if authorized, let token = lock.holding({ accessToken }) {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return try await exchange(request)
  }

  private func exchange(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    try await withCheckedThrowingContinuation { done in
      session.dataTask(with: request) { data, response, error in
        if let error { done.resume(throwing: error); return }
        guard let response = response as? HTTPURLResponse else { done.resume(throwing: URLError(.badServerResponse)); return }
        done.resume(returning: (data ?? Data(), response))
      }.resume()
    }
  }

  private func upload(_ request: URLRequest, _ bytes: Data, sent: @escaping @Sendable (Int64) -> Void) async throws -> (Data, HTTPURLResponse) {
    try await withCheckedThrowingContinuation { done in
      let task = session.uploadTask(with: request, from: bytes) { data, response, error in
        if let error { done.resume(throwing: error); return }
        guard let response = response as? HTTPURLResponse else { done.resume(throwing: URLError(.badServerResponse)); return }
        done.resume(returning: (data ?? Data(), response))
      }
      progress.follow(task, sent)
      task.resume()
    }
  }

  // MARK: - Words

  private func refusal(_ data: Data, _ response: HTTPURLResponse) -> Refused {
    let said = try? JSONDecoder().decode(Refusal.self, from: data)
    return Refused(
      status: response.statusCode,
      code: said?.error.code ?? "HTTP_\(response.statusCode)",
      message: said?.error.message ?? "",
      retryAfterMs: said?.error.retry_after_ms
    )
  }

  /// What went wrong, as the person reads it. The server's own words when it
  /// gave some (they're written for people, PROTOCOL §1), else ours.
  private func failure(from error: Error) -> ShareFailure {
    if let failure = error as? ShareFailure { return failure }
    if let refused = error as? Refused {
      if refused.status == 404 && refused.code == "NOT_FOUND" && refused.message.isEmpty {
        return ShareFailure(words: "\(serverName) needs updating before Linger can share to it from here.")
      }
      if !refused.message.isEmpty { return ShareFailure(words: refused.message) }
      return ShareFailure(words: "\(serverName) couldn't take that just now. Try again in a moment.")
    }
    if error is URLError {
      return ShareFailure(words: "Linger couldn't reach \(serverName). Check your connection and try again.")
    }
    return ShareFailure(words: "That didn't go. Try again in a moment.")
  }
}

/// How far each upload has got, from the session's delegate.
private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var following: [Int: @Sendable (Int64) -> Void] = [:]

  func follow(_ task: URLSessionTask, _ sent: @escaping @Sendable (Int64) -> Void) {
    lock.holding { following[task.taskIdentifier] = sent }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    let sent = lock.holding { following[task.taskIdentifier] }
    sent?(totalBytesSent)
  }
}

/// The folder a share's files are copied into to be sent (#822). The window
/// removes it when it closes, sent or not, rather than leaving it for iOS to
/// clear: ten files can be 5 GB. Copies that land after it closed (the window
/// closed while they were being gathered) go the same way (`closed`).
final class ShareCopies: @unchecked Sendable {
  let folder: URL
  private let lock = NSLock()
  private var isClosed = false

  init(in parent: URL = FileManager.default.temporaryDirectory) {
    folder = parent.appendingPathComponent("linger-share-\(UUID().uuidString)", isDirectory: true)
  }

  var closed: Bool { lock.holding { isClosed } }

  /// Remove the folder and everything in it.
  func close() {
    lock.holding { isClosed = true }
    try? FileManager.default.removeItem(at: folder)
  }
}

extension NSLock {
  /// `body` with the lock held. `NSLocking.withLock` needs iOS 16, and the
  /// app runs on iOS 15 (#743).
  func holding<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
