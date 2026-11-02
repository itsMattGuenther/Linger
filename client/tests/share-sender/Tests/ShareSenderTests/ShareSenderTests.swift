import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest

@testable import ShareSender

// The iPhone share window's sender (#820), against a real Linger server that
// `scripts/share-sender-test.sh` starts from this checkout: what it posts
// arrives once, as one message, its sign-in renews and is handed back, and
// what goes wrong is said in words.

/// The server the script started, the host's sign-in on it, and a room.
private struct Server {
  let base: URL
  let access: String
  let refresh: String
  let room: String

  static func fromEnvironment() throws -> Server {
    let env = ProcessInfo.processInfo.environment
    guard let base = env["LINGER_TEST_SERVER"].flatMap(URL.init(string:)),
      let access = env["LINGER_TEST_ACCESS"], let refresh = env["LINGER_TEST_REFRESH"], let room = env["LINGER_TEST_ROOM"]
    else { throw XCTSkip("no server: run scripts/share-sender-test.sh") }
    return Server(base: base, access: access, refresh: refresh, room: room)
  }

  func call(_ method: String, _ path: String, json: Any? = nil, token: String? = nil) async throws -> (Data, Int) {
    var request = URLRequest(url: URL(string: base.absoluteString + "/api/v1" + path)!)
    request.httpMethod = method
    if let json {
      request.httpBody = try JSONSerialization.data(withJSONObject: json)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    return try await withCheckedThrowingContinuation { done in
      URLSession.shared.dataTask(with: request) { data, response, error in
        if let error { done.resume(throwing: error); return }
        done.resume(returning: (data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0))
      }.resume()
    }
  }

  /// A sign-in of the window's own (`POST /auth/share-sign-in`), as the app asks for it.
  func shareSignIn() async throws -> String {
    let (data, status) = try await call("POST", "/auth/share-sign-in", json: ["refresh_token": refresh])
    XCTAssertEqual(status, 200, String(decoding: data, as: UTF8.self))
    let answer = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    return try XCTUnwrap(answer?["refresh_token"] as? String)
  }

  /// The room's newest messages, as the host reads them.
  func messages() async throws -> [[String: Any]] {
    let (data, status) = try await call("GET", "/rooms/\(room)/messages?limit=20", token: access)
    XCTAssertEqual(status, 200)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
  }
}

/// A 1×1 PNG, real enough for the server to read and re-encode.
private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!

private func file(_ name: String, _ bytes: Data, _ mime: String) throws -> ShareFile {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString)-\(name)")
  try bytes.write(to: url)
  return ShareFile(url: url, name: name, mime: mime, size: Int64(bytes.count))
}

/// Tokens the sender handed back, in order.
private final class Kept: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [String] = []
  func add(_ token: String) { lock.lock(); tokens.append(token); lock.unlock() }
  var all: [String] { lock.lock(); defer { lock.unlock() }; return tokens }
}

final class ShareSenderTests: XCTestCase {
  /// A photo and a file of more than one 8 MB part go up and arrive as one
  /// message with the words, and the renewed sign-in is handed back.
  func testFilesAndWordsArriveAsOneMessage() async throws {
    let server = try Server.fromEnvironment()
    let kept = Kept()
    let first = try await server.shareSignIn()
    let sender = ShareSender(base: server.base, serverName: "Share test", refreshToken: first, keep: { kept.add($0) })
    let big = Data(repeating: 0x61, count: 9 * 1024 * 1024 + 123)
    let files = [try file("dot.png", png, "image/png"), try file("notes.txt", big, "text/plain")]
    let words = "from the share sheet \(UUID().uuidString)"
    let sentSoFar = Kept()
    try await sender.send(files: files, message: "  \(words)\n", roomId: server.room, nonce: UUID().uuidString) { sentSoFar.add(String($0)) }

    let latest = try await server.messages()
    // The words, trimmed, on one message.
    let posted = latest.filter { $0["body"] as? String == words }
    XCTAssertEqual(posted.count, 1)
    let newest = try XCTUnwrap(posted.first)
    let attachments = try XCTUnwrap(newest["attachments"] as? [[String: Any]])
    XCTAssertEqual(attachments.compactMap { $0["filename"] as? String }, ["dot.png", "notes.txt"])
    XCTAssertEqual(attachments.last?["size_bytes"] as? Int, big.count)
    XCTAssertEqual(sentSoFar.all.last, "1.0", "progress ends at 1")

    // The sign-in was renewed, and the renewed one handed back: the first is spent.
    let renewed = try XCTUnwrap(kept.all.last)
    XCTAssertNotEqual(renewed, first)
    let (_, replayed) = try await server.call("POST", "/auth/refresh", json: ["refresh_token": first])
    XCTAssertEqual(replayed, 401)
  }

  /// The same share sent again under the same nonce, as a retry whose first
  /// answer was lost, posts once.
  func testARetryWithTheSameNoncePostsOnce() async throws {
    let server = try Server.fromEnvironment()
    let kept = Kept()
    let sender = ShareSender(base: server.base, serverName: "Share test", refreshToken: try await server.shareSignIn(), keep: { kept.add($0) })
    let nonce = UUID().uuidString
    let words = "once \(nonce)"
    try await sender.send(files: [try file("a.png", png, "image/png")], message: words, roomId: server.room, nonce: nonce) { _ in }
    try await sender.send(files: [try file("a.png", png, "image/png")], message: words, roomId: server.room, nonce: nonce) { _ in }
    let posted = try await server.messages().filter { $0["body"] as? String == words }
    XCTAssertEqual(posted.count, 1)
  }

  /// A sign-in that has ended says so, and that only Linger can mend it.
  func testAnEndedSignInSaysSo() async throws {
    let server = try Server.fromEnvironment()
    let token = try await server.shareSignIn()
    _ = try await server.call("POST", "/auth/logout", json: ["refresh_token": token])
    let sender = ShareSender(base: server.base, serverName: "Share test", refreshToken: token, keep: { _ in })
    do {
      try await sender.send(files: [try file("a.png", png, "image/png")], message: "", roomId: server.room, nonce: UUID().uuidString) { _ in }
      XCTFail("an ended sign-in sent")
    } catch let failure as ShareFailure {
      XCTAssertTrue(failure.signInGone)
      XCTAssertTrue(failure.words.hasPrefix("Open Linger, then share again"), failure.words)
    }
  }

  /// What the server refuses is said in the server's words, and nothing is posted.
  func testARefusedFileIsSaidInTheServersWords() async throws {
    let server = try Server.fromEnvironment()
    let sender = ShareSender(base: server.base, serverName: "Share test", refreshToken: try await server.shareSignIn(), keep: { _ in })
    let words = "never \(UUID().uuidString)"
    do {
      try await sender.send(files: [try file("fake.png", Data("not a picture".utf8), "image/png")], message: words, roomId: server.room, nonce: UUID().uuidString) { _ in }
      XCTFail("a file that isn't what it says went up")
    } catch let failure as ShareFailure {
      XCTAssertFalse(failure.signInGone)
      XCTAssertFalse(failure.words.isEmpty)
    }
    let after = try await server.messages()
    XCTAssertTrue(after.allSatisfy { $0["body"] as? String != words })
  }

  /// A server that can't be reached says so, by name.
  func testAnUnreachableServerSaysSo() async throws {
    let sender = ShareSender(base: URL(string: "http://127.0.0.1:9")!, serverName: "The Porch", refreshToken: "any", keep: { _ in })
    do {
      try await sender.send(files: [], message: "hi", roomId: "r", nonce: UUID().uuidString) { _ in }
      XCTFail("an unreachable server sent")
    } catch let failure as ShareFailure {
      XCTAssertEqual(failure.words, "Linger couldn't reach The Porch. Check your connection and try again.")
    }
  }
}
