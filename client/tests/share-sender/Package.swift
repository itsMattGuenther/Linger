// swift-tools-version:5.9
// The iPhone share window's sender (#820), run on Linux against a real Linger
// server: `scripts/share-sender-test.sh`. `Sources/ShareSender/ShareSender.swift`
// is a link to the extension's own file, so this tests what ships.
import PackageDescription

let package = Package(
  name: "ShareSender",
  targets: [
    .target(name: "ShareSender", path: "Sources/ShareSender"),
    .testTarget(name: "ShareSenderTests", dependencies: ["ShareSender"], path: "Tests/ShareSenderTests"),
  ]
)
