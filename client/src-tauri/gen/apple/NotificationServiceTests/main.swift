import Foundation

// The iPhone's notification extension, on a Mac (#889, PROTOCOL §5): it opens
// RFC 8291's own example and the notification the server makes
// (crates/linger-server/tests/fixtures/push-notification.json, which the
// server's own test makes again), refuses anything changed or not its own,
// and reads the keys as the app writes them (keys-table.json, which the
// shell's test checks too). Android's PushCryptoTest.kt does the same.
//
// No Xcode project: the iPhone simulator workflow compiles the extension's
// own files with this one and runs it, from the repository's root:
//
//   swiftc gen/apple/NotificationService/PushCrypto.swift \
//     gen/apple/NotificationService/PushNote.swift \
//     gen/apple/NotificationServiceTests/main.swift -o push-tests
//   ./push-tests crates/linger-server/tests/fixtures/push-notification.json \
//     gen/apple/NotificationServiceTests/keys-table.json
//
// (with `client/src-tauri/` in front of each gen/apple path).

var failed = 0

func check(_ ok: Bool, _ what: String) {
  print(ok ? "ok - \(what)" : "FAILED - \(what)")
  if !ok { failed += 1 }
}

func b64(_ text: String) -> Data {
  guard let data = PushNote.base64url(text) else { fatalError("not base64url: \(text)") }
  return data
}

func json(_ path: String) -> [String: Any] {
  guard
    let data = FileManager.default.contents(atPath: path),
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { fatalError("couldn't read \(path)") }
  return object
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  fatalError("usage: push-tests <push-notification.json> <keys-table.json>")
}
let fixture = json(arguments[1])
func field(_ name: String) -> String {
  guard let value = fixture[name] as? String else { fatalError("no \(name) in the server's fixture") }
  return value
}

// RFC 8291 §5 and Appendix A.
let uaPrivate = b64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")
let uaPublic = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
let auth = b64("BTBZMqHH6r4Tts7J_aSIgg")
let rfcMessage = b64(
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
    + "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
    + "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")

// Opens the RFC's own example.
let rfcWords = PushCrypto.decrypt(privateKey: uaPrivate, publicKey: uaPublic, auth: auth, message: rfcMessage)
check(
  rfcWords.flatMap { String(data: $0, encoding: .utf8) } == "When I grow up, I want to be a watermelon",
  "opens RFC 8291's own example")

// Opens what the server sends, padding and all.
let serverWords = PushCrypto.decrypt(
  privateKey: b64(field("ua_private")), publicKey: b64(field("ua_public")),
  auth: b64(field("auth_secret")), message: b64(field("message")))
check(serverWords.flatMap { String(data: $0, encoding: .utf8) } == field("plaintext"), "opens what the server sends")

// Opens nothing that isn't its own or was changed.
check(
  PushCrypto.decrypt(privateKey: uaPrivate, publicKey: uaPublic, auth: Data(count: 16), message: rfcMessage) == nil,
  "another phone's secret opens nothing")
var changed = rfcMessage
changed[changed.count - 1] &+= 1
check(
  PushCrypto.decrypt(privateKey: uaPrivate, publicKey: uaPublic, auth: auth, message: changed) == nil,
  "a changed byte opens nothing")
check(
  PushCrypto.decrypt(privateKey: uaPrivate, publicKey: uaPublic, auth: auth, message: rfcMessage.prefix(90)) == nil,
  "a message cut short opens nothing")
check(
  PushCrypto.decrypt(privateKey: uaPrivate, publicKey: uaPublic, auth: auth, message: Data()) == nil,
  "nothing opens nothing")
check(
  PushCrypto.decrypt(privateKey: Data(count: 32), publicKey: uaPublic, auth: auth, message: rfcMessage) == nil,
  "a key that isn't one opens nothing")

// Reads the keys as the app writes them, and the server's notification
// opens with the right server's: the first server's secret is wrong.
guard let table = json(arguments[2])["table"] as? [String: Any],
  let tableData = try? JSONSerialization.data(withJSONObject: table)
else { fatalError("no table in keys-table.json") }
let keys = PushNote.table(tableData)
check(keys.count == 2, "reads every server's keys")
check(
  keys["https://linger.example"] == PushNote.Keys(privateKey: uaPrivate, publicKey: uaPublic, auth: auth),
  "reads a server's keys as they were written")
check(PushNote.table(Data("not json".utf8)).isEmpty, "a table it can't read is no keys")
check(
  PushNote.table(Data(#"{"https://s":{"private_key":"q1dX"}}"#.utf8)).isEmpty,
  "a server missing a key is left out")

let note = PushNote.open(field("message"), keys: keys)
check(note?.server == "https://linger.example", "the server whose keys open it is the one it's from")
check(note?.title == "Sam in #general", "shows the server's title")
check(note?.body == "you around tonight? @jo", "shows the server's words")
check(note?.thread == "https://linger.example 0190b6c2-6b1a-7c3e-9d2f-2a2b3c4d5e6f", "grouped with its conversation")
check(
  note?.opens == [
    "linger_server": "https://linger.example",
    "linger_room": "0190b6c2-6b1a-7c3e-9d2f-2a2b3c4d5e6f",
    "linger_message": "0190b6c2-6b1a-7c3e-9d2f-3a2b3c4d5e6f",
  ],
  "a tap opens its conversation, and nothing encrypted is kept with it")
check(PushNote.open(field("message"), keys: [:]) == nil, "with no keys, nothing opens")
check(PushNote.open("not base64url!", keys: keys) == nil, "what isn't a notification opens nothing")
check(PushNote.open(nil, keys: keys) == nil, "a push without one opens nothing")

// What shows, from the words the server writes.
func words(_ text: String) -> Data { Data(text.utf8) }
let knock = PushNote.read(
  words(#"{"v":1,"kind":"knock","title":"Sam knocked","body":"","user_id":"u"}"#), server: "https://s")
check(knock?.thread == "https://s knocks", "a server's knocks are grouped together")
check(knock?.opens == ["linger_server": "https://s"], "a knock opens Linger, not a conversation")
check(
  PushNote.read(words(#"{"v":2,"kind":"dm","title":"Sam","body":"hi","user_id":"u"}"#), server: "https://s") == nil,
  "a version this phone doesn't know shows the fallback")
check(
  PushNote.read(words(#"{"v":1,"kind":"poll","title":"Sam","body":"hi","user_id":"u"}"#), server: "https://s") == nil,
  "a kind this phone doesn't know shows the fallback")
check(
  PushNote.read(words(#"{"v":1,"kind":"dm","body":"hi","user_id":"u"}"#), server: "https://s") == nil,
  "words without a title show the fallback")
for kind in ["mention", "dm", "follow", "room"] {
  check(
    PushNote.read(
      words(#"{"v":1,"kind":"\#(kind)","title":"Sam","body":"hi","user_id":"u","room_id":"r"}"#), server: "https://s")
      != nil,
    "a \(kind) shows")
}

print(failed == 0 ? "all passed" : "\(failed) failed")
exit(failed == 0 ? 0 : 1)
