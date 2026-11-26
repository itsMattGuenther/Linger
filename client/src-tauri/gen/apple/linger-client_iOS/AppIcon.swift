// The icon a person picks on their Home Screen (#961, SPEC §4.15), in
// Settings › Appearance: the door, or one of five more looks the app carries
// as Apple's alternate icons (ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES in
// project.yml; scripts/app-icons.mjs makes them). The app's main.mm hands
// these two functions to the Rust (src/phone_icon.rs) before the app starts.
//
// A look crosses as its place in `AppIcon.sets`, the same order as
// scripts/app-icon-looks.mjs, whose test checks they agree: 0 is the door,
// the app's own icon. Asking answers the look in use; setting answers 1 when
// iOS changed it and 0 when it didn't. iOS says so itself, in a short message
// of its own, each time it does.

import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// How Rust is answered: once, from the main thread.
public typealias LingerIconAnswer = @convention(c) (Int32) -> Void

@_cdecl("linger_icon_current")
public func lingerIconCurrent(_ answer: LingerIconAnswer) {
    Task { @MainActor in
        answer(AppIcon.current())
    }
}

@_cdecl("linger_icon_set")
public func lingerIconSet(_ look: Int32, _ answer: LingerIconAnswer) {
    Task { @MainActor in
        answer(await AppIcon.set(look))
    }
}

enum AppIcon {
    /// The asset catalog's icon sets, a look's place in this list being what
    /// crosses to Rust. The first is the app's own, which iOS calls `nil`.
    static let sets = ["AppIcon", "AppIcon-AfterDark", "AppIcon-PorchLight", "AppIcon-Daylight", "AppIcon-Dusk", "AppIcon-Original"]

    /// The look of an alternate icon's name, or the door's for none (and
    /// for one this list doesn't know).
    static func look(named name: String?) -> Int32 {
        guard let name, let index = sets.firstIndex(of: name) else { return 0 }
        return Int32(index)
    }

    /// Whether a look is one of `sets`.
    static func known(_ look: Int32) -> Bool {
        look >= 0 && Int(look) < sets.count
    }

    /// The alternate icon's name for a known look: `nil` for the door.
    static func name(of look: Int32) -> String? {
        look == 0 ? nil : sets[Int(look)]
    }

    @MainActor
    static func current() -> Int32 {
        #if canImport(UIKit)
        return look(named: UIApplication.shared.alternateIconName)
        #else
        return 0
        #endif
    }

    @MainActor
    static func set(_ look: Int32) async -> Int32 {
        #if canImport(UIKit)
        guard known(look), UIApplication.shared.supportsAlternateIcons else { return 0 }
        let wanted = name(of: look)
        if UIApplication.shared.alternateIconName == wanted { return 1 }
        do {
            try await UIApplication.shared.setAlternateIconName(wanted)
            return 1
        } catch {
            return 0
        }
        #else
        return 0
        #endif
    }
}
