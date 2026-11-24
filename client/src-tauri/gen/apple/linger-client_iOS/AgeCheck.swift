// The age the App Store holds for the person, where a law makes Apple share it
// with apps (#953, SPEC §4.15). Linger is for people 13 and older, so the one
// question is whether the person is under 13. Apple says where the check
// applies: Linger asks only there, so nobody anywhere else sees Apple's sheet.
//
// Declared Age Range is Swift only, so this is the app's one Swift file. The
// app's main.mm hands `linger_age_check` to the Rust (src/phone_age.rs)
// before the app starts, and the Rust calls it and gets one answer back,
// 1 for a person under 13, 0 for anybody else, and -1 when it couldn't tell
// (before iOS 26.2, an error, no screen to ask from). Rust and the page treat
// -1 as 0: a check that failed never locks anybody out.
//
// The framework is only on iOS 26 and later, and the app runs from iOS 15, so
// it's weak-linked (project.yml); the simulator's run checks it is.
//
// Nothing here keeps the age range or logs it: the log says only which way the
// check went.

import Foundation
#if canImport(os)
import os
#endif
#if canImport(UIKit)
import UIKit
#endif
#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

/// How Rust is answered: once, from the main thread.
public typealias LingerAgeAnswer = @convention(c) (Int32) -> Void

@_cdecl("linger_age_check")
public func lingerAgeCheck(_ answer: LingerAgeAnswer) {
    Task { @MainActor in
        answer(await AgeCheck.ask())
    }
}

enum AgeCheck {
    /// Linger's one age gate.
    static let gate = 13

    /// A person under 13 from the range Apple shared: the top of the range is
    /// below the gate. No top means the gate or older. A region's own gates
    /// can replace Linger's, so the bottom being missing only says "under the
    /// region's lowest gate", which may be 16: the top is what tells.
    static func verdict(upperBound: Int?) -> Int32 {
        guard let top = upperBound else { return 0 }
        return top < gate ? 1 : 0
    }

    /// Which way the check went, in the phone's own log: never the age.
    static func note(_ what: String) {
        #if canImport(os)
        Logger(subsystem: "io.github.itsmattguenther.linger", category: "age").info("age check: \(what, privacy: .public)")
        #endif
    }

    @MainActor
    static func ask() async -> Int32 {
        #if canImport(DeclaredAgeRange) && canImport(UIKit)
        guard #available(iOS 26.2, *) else {
            note("not before iOS 26.2")
            return -1
        }
        do {
            guard try await required() else {
                note("not required here")
                return 0
            }
            guard let screen = presenter() else {
                note("no screen to ask from")
                return -1
            }
            let response = try await AgeRangeService.shared.requestAgeRange(ageGates: gate, in: screen)
            switch response {
            case .sharing(let range):
                note("shared")
                return verdict(upperBound: range.upperBound)
            case .declinedSharing:
                note("declined")
                return -1
            @unknown default:
                note("an answer this build doesn't know")
                return -1
            }
        } catch {
            note("failed, \(String(describing: type(of: error)))")
            return -1
        }
        #else
        return -1
        #endif
    }

    #if canImport(DeclaredAgeRange) && canImport(UIKit)
    /// Whether Apple says Linger must ask this person: the regulatory feature
    /// from iOS 26.4, which says exactly that, and before it whether the
    /// person is somewhere age assurance applies.
    @available(iOS 26.2, *)
    private static func required() async throws -> Bool {
        if #available(iOS 26.4, *) {
            return try await AgeRangeService.shared.requiredRegulatoryFeatures.contains(.declaredAgeRangeRequired)
        }
        return try await AgeRangeService.shared.isEligibleForAgeFeatures
    }

    /// The screen Apple's sheet, where there is one, shows over: the top of
    /// the window in front.
    @MainActor
    private static func presenter() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
        var top = window?.rootViewController
        while let shown = top?.presentedViewController {
            top = shown
        }
        return top
    }
    #endif
}
