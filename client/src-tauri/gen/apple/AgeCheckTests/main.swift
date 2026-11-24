import Foundation

// The iPhone's age check (#953): which ranges Apple shares count as a person
// under 13, and that the bridge Rust calls answers once without Apple's
// framework (a Mac or Linux build has no UIKit, as an iPhone before iOS 26.2
// has no Declared Age Range). Apple's sandbox cases
// (developer.apple.com/documentation/storekit/testing-age-assurance-in-sandbox)
// are the ranges below.
//
// No Xcode project: the iPhone simulator workflow compiles the app's file
// with this one and runs it, from the repository's root:
//
//   swiftc client/src-tauri/gen/apple/linger-client_iOS/AgeCheck.swift \
//     client/src-tauri/gen/apple/AgeCheckTests/main.swift -o age-tests
//   ./age-tests

var failed = 0

func check(_ ok: Bool, _ what: String) {
  print(ok ? "ok - \(what)" : "FAILED - \(what)")
  if !ok { failed += 1 }
}

// Apple's sandbox: under 13 shares no bottom and a top of 12.
check(AgeCheck.verdict(upperBound: 12) == 1, "under 13 (top 12) is a child")
check(AgeCheck.verdict(upperBound: 0) == 1, "a top of 0 is a child")
// 13 to 15 and 16 to 17 share a top of 15 and 17.
check(AgeCheck.verdict(upperBound: 15) == 0, "13 to 15 is not")
check(AgeCheck.verdict(upperBound: 17) == 0, "16 to 17 is not")
// 18 and older share no top. (A region whose own lowest gate is 16 shares
// a top of 15 for anybody under it, the 13 to 15 case above: the bottom
// isn't read at all, so its being missing there changes nothing.)
check(AgeCheck.verdict(upperBound: nil) == 0, "no top (the gate or older) is not")
check(AgeCheck.gate == 13, "Linger's gate is 13")

// The bridge, with no framework to ask: it answers once, that it couldn't tell.
var answers: [Int32] = []
let answered = DispatchSemaphore(value: 0)
let record: LingerAgeAnswer = { answer in
  answers.append(answer)
  answered.signal()
}
lingerAgeCheck(record)
#if canImport(UIKit)
#else
// The main thread has to run for the answer to arrive.
let deadline = Date().addingTimeInterval(5)
while answers.isEmpty && Date() < deadline {
  RunLoop.main.run(until: Date().addingTimeInterval(0.05))
}
check(answers == [-1], "without the framework, the bridge answers once that it couldn't tell")
#endif

if failed > 0 {
  print("\(failed) failed")
  exit(1)
}
print("all passed")
