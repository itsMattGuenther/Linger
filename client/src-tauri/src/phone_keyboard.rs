//! iOS's bar over the keyboard, hidden (#881).
//!
//! An iPhone's web view puts a bar of its own over the keyboard whenever a
//! field has it: Previous and Next, to move between a page's fields, and
//! Done, to put the keyboard away. Linger's page is sized to what the
//! keyboard leaves (`followKeyboard` in core/phone.ts), and that was measured
//! sometimes with the bar and sometimes without it: in the simulator, the
//! message box once sat half under the bar, and a tap on Send landed on the
//! bar and sent nothing. The page can't see the bar, so it can't make up the
//! difference. With no bar, the keyboard alone is what the page makes room
//! for, every time, and the conversation keeps the 68 points the bar took.
//! A message box needs no Previous and Next; a finger on the conversation
//! puts the keyboard away instead of Done (`closeKeyboardOnTouch` in
//! core/phone.ts), as in the phone's own messages app.
//!
//! The bar is the web view's `inputAccessoryView`, which iOS asks the view
//! taking the typing (WebKit's `WKContentView`) for when the keyboard comes
//! up. WebKit has no setting to leave it out, so Linger answers for that view
//! instead: there is none.

use objc2::ffi::class_replaceMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;

/// `-[WKContentView inputAccessoryView]` as Linger answers it: no bar.
unsafe extern "C-unwind" fn no_bar(_view: *mut AnyObject, _cmd: Sel) -> *mut AnyObject {
    std::ptr::null_mut()
}

/// Leave the bar out of every keyboard the web view brings up. Before there's
/// a window, so the first keyboard already comes without it; a later web view
/// is of the same class and gets the same answer. Said in the log either way,
/// since only the simulator and a phone can show it.
pub fn hide_bar() {
    let Some(view) = AnyClass::get(c"WKContentView") else {
        eprintln!("Linger: WebKit has no WKContentView, so iOS's bar over the keyboard stays (#881)");
        return;
    };
    // SAFETY: an Objective-C method is called with its receiver and selector
    // first, and `inputAccessoryView` takes nothing else and answers an
    // object or nil, as the type encoding "@@:" says; `no_bar` has that
    // shape. The replacement is on WKContentView alone (added there if only a
    // superclass has the method), so no other view's keyboard changes.
    let replaced = unsafe {
        let imp = std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject, Imp>(no_bar);
        class_replaceMethod(std::ptr::from_ref(view).cast_mut(), sel!(inputAccessoryView), imp, c"@@:".as_ptr())
    };
    eprintln!(
        "Linger: iOS's bar over the keyboard is hidden (#881), {}",
        if replaced.is_some() { "WebKit's answer replaced" } else { "an answer added" }
    );
}
