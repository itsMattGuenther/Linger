// The icon a person picks on their Home Screen (#961, SPEC §4.15), in
// Settings › Appearance: the door, or one of five more looks the app carries
// as Apple's alternate icons (ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES in
// project.yml; scripts/app-icons.mjs makes them). The app's main.mm hands
// these two functions to the Rust (src/phone_icon.rs) before the app starts.
//
// A look crosses as its place in `AppIcon.sets`, the same order as
// scripts/app-icon-looks.mjs, whose test checks they agree: 0 is the door,
// the app's own icon. Asking answers the look in use. Setting answers at
// once, 1 when the look is one this phone can show and 0 when it isn't, and
// iOS then makes the change, one at a time, since it refuses a change asked
// for while another is under way. iOS says each change itself, in a short
// message of its own. Rust never waits on iOS: every answer comes straight
// from the main thread.

import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// How Rust is answered: once, from the main thread, with the number the
/// ask came with, then the answer. Rust waits for the answer with its own
/// number, so one that comes too late answers nobody.
public typealias LingerIconAnswer = @convention(c) (Int32, Int32) -> Void

@_cdecl("linger_icon_current")
public func lingerIconCurrent(_ number: Int32, _ answer: LingerIconAnswer) {
    Task { @MainActor in
        answer(number, AppIcon.current())
    }
}

@_cdecl("linger_icon_set")
public func lingerIconSet(_ look: Int32, _ number: Int32, _ answer: LingerIconAnswer) {
    Task { @MainActor in
        answer(number, AppIcon.take(look))
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

    /// The change iOS is making now, which the next one waits for.
    @MainActor private static var making: Task<Void, Never>?

    /// Takes a look to put up: 1 once it's on its way, after any change
    /// still under way, and 0 for a look this phone can't show.
    @MainActor
    static func take(_ look: Int32) -> Int32 {
        #if canImport(UIKit)
        guard known(look), UIApplication.shared.supportsAlternateIcons else { return 0 }
        let wanted = name(of: look)
        let before = making
        making = Task { @MainActor in
            await before?.value
            guard UIApplication.shared.alternateIconName != wanted else { return }
            try? await UIApplication.shared.setAlternateIconName(wanted)
        }
        return 1
        #else
        return 0
        #endif
    }
}
