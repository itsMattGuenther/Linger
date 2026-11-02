import Foundation
import XCTest

@testable import ShareSender

// What the share window offers (#820, ShareList.swift): the list the app
// wrote, read; the rows, recent first; search.

private func list(_ servers: [ShareList.Server]) -> ShareList {
  let theme = ShareList.Theme(
    background: "#182135ff", raised: "#1b2436ff", field: "#0f1522ff", chosen: "#f3b55c1f", chosenEdge: "#f3b55c73",
    text: "#f1ebe0ff", textSecondary: "#c0c6d2ff", textMuted: "#8d96a9ff", hairline: "#222d44ff",
    accent: "#f3b55cff", onAccent: "#1c1206ff", danger: "#ff7a7aff")
  return ShareList(version: ShareList.version, written_at: 0, theme: theme, servers: servers)
}

private func room(_ id: String, _ name: String) -> ShareList.Conversation {
  ShareList.Conversation(room_id: id, kind: "room", name: name, colors: [])
}

private func dm(_ id: String, _ name: String) -> ShareList.Conversation {
  ShareList.Conversation(room_id: id, kind: "dm", name: name, colors: ["#3d8bfdff"])
}

private let good = ShareList.Server(base_url: "https://good.example", name: "The Good Company", share: "ready",
  conversations: [room("r-general", "general"), room("r-raid", "raid-night"), dm("d-jose", "José")])
private let other = ShareList.Server(base_url: "https://other.example", name: "Other", share: "old",
  conversations: [room("r-x", "general")])

final class ShareListTests: XCTestCase {
  func testTheAppsListIsRead() throws {
    let json = """
      {"version":1,"written_at":5,"theme":{"background":"#182135ff","raised":"#1b2436ff","field":"#0f1522ff",
      "chosen":"#f3b55c1f","chosenEdge":"#f3b55c73","text":"#f1ebe0ff","textSecondary":"#c0c6d2ff",
      "textMuted":"#8d96a9ff","hairline":"#222d44ff","accent":"#f3b55cff","onAccent":"#1c1206ff","danger":"#ff7a7aff"},
      "servers":[{"base_url":"https://good.example","name":"G","share":"ready",
      "conversations":[{"room_id":"r","kind":"room","name":"general","colors":[]}]}]}
      """
    let read = try XCTUnwrap(ShareList.read(Data(json.utf8)))
    XCTAssertEqual(read.servers.first?.conversations.first?.name, "general")
    XCTAssertEqual(read.theme.accent, "#f3b55cff")
    // A list of another version is one this window can't read.
    XCTAssertNil(ShareList.read(Data(json.replacingOccurrences(of: "\"version\":1", with: "\"version\":2").utf8)))
    XCTAssertNil(ShareList.read(Data("not json".utf8)))
  }

  func testColoursAreRead() {
    let read = rgba("#f3b55cff")
    XCTAssertEqual(read?.0 ?? 0, 243.0 / 255, accuracy: 0.0001)
    XCTAssertEqual(read?.3 ?? 0, 1, accuracy: 0.0001)
    XCTAssertEqual(rgba("#ffffff")?.3, 1)
    XCTAssertNil(rgba("rgb(1, 2, 3)"))
    XCTAssertNil(rgba("#12"))
  }

  /// One server, nothing shared before: its conversations in the list's order, untitled.
  func testOneServersConversationsInTheListsOrder() {
    let sections = shareSections(list([good]), signedIn: ["https://good.example"], recent: [], search: "")
    XCTAssertEqual(sections.count, 1)
    XCTAssertNil(sections[0].title)
    XCTAssertEqual(sections[0].rows.map(\.conversation.name), ["general", "raid-night", "José"])
    XCTAssertTrue(sections[0].rows.allSatisfy { $0.unavailable == nil })
  }

  /// The ones shared to last on top, those still there and ready, at most
  /// four; the server then under its name.
  func testRecentOnTop() {
    let recent = [
      ShareTarget(server: "https://good.example", room: "d-jose"),
      ShareTarget(server: "https://good.example", room: "gone"),
      ShareTarget(server: "https://other.example", room: "r-x"),
      ShareTarget(server: "https://good.example", room: "r-general"),
    ]
    let sections = shareSections(list([good, other]), signedIn: ["https://good.example", "https://other.example"], recent: recent, search: "")
    XCTAssertEqual(sections.map(\.title), ["Recent", "The Good Company", "Other"])
    // Gone, and on a server that needs updating: left out of Recent.
    XCTAssertEqual(sections[0].rows.map(\.target.room), ["d-jose", "r-general"])
    // Recent's rows say their server; a server's own section's don't.
    XCTAssertEqual(sections.map(\.namesServers), [true, false, false])
    let one = shareSections(list([good]), signedIn: ["https://good.example"], recent: recent, search: "")
    XCTAssertEqual(one.map(\.namesServers), [false, false])
  }

  /// A server that needs updating, or where the window has no sign-in, is
  /// shown and says why it can't be sent to.
  func testWhyARowCantBeSentTo() {
    let sections = shareSections(list([good, other]), signedIn: ["https://other.example"], recent: [], search: "")
    XCTAssertEqual(sections[0].rows.first?.unavailable, "Open Linger once to share here")
    XCTAssertEqual(sections[1].rows.first?.unavailable, "Other needs updating to share from here")
  }

  /// Searched: every conversation with the words, across servers, in one
  /// list, ignoring case and accents.
  func testSearchFindsAcrossServers() {
    let found = shareSections(list([good, other]), signedIn: ["https://good.example"], recent: [], search: " GENERAL ")
    XCTAssertEqual(found.count, 1)
    XCTAssertEqual(found[0].rows.map(\.serverName), ["The Good Company", "Other"])
    XCTAssertTrue(found[0].namesServers)
    XCTAssertEqual(shareSections(list([good]), signedIn: [], recent: [], search: "jose").first?.rows.first?.conversation.name, "José")
    XCTAssertTrue(shareSections(list([good]), signedIn: [], recent: [], search: "nobody").isEmpty)
  }

  func testRememberingPutsTheNewestFirstOnce() {
    let a = ShareTarget(server: "s", room: "a")
    let b = ShareTarget(server: "s", room: "b")
    XCTAssertEqual(remembering(b, in: [a, b]), [b, a])
    let many = (0..<20).map { ShareTarget(server: "s", room: "\($0)") }
    XCTAssertEqual(remembering(a, in: many).count, mostRecent + 4)
  }
}
