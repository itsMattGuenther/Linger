//! Sharing a screen from Linux (#360, T-1907).
//!
//! The page asks for a screen with `getDisplayMedia`, as on Windows, and
//! WebKitGTK passes the question on to the desktop's own screen picker (the
//! ScreenCast portal, over PipeWire) only once the app says yes to its
//! permission request. wry connects no answer, so WebKitGTK says no for it
//! and the page hears `NotAllowedError`. This says yes to a request for a
//! screen and to nothing else: a camera or a microphone stays a no. The
//! desktop's picker still asks the person every time, and they choose what
//! to share; the app never sees a window's name (SPEC §4.20, hard rule 2).
//!
//! WebKitGTK also keeps its track processor, which hands over a track's
//! frames as they come, behind a feature switch, and offers it only in a
//! worker (`client/src/lib/screen/reader.worker.ts`). This turns it on. The
//! switches arrived in WebKitGTK 2.42, after the 2.40 wry builds against, so
//! they're looked up when the window opens rather than linked: on an older
//! WebKitGTK they aren't there, the page finds no track processor in its
//! worker, and Share isn't offered.

use std::ffi::{c_char, c_void, CStr};

use gtk::glib::translate::ToGlibPtr;
use gtk::glib::Cast;
use tauri::WebviewWindow;
use webkit2gtk::{
    PermissionRequest, PermissionRequestExt, UserMediaPermissionRequest,
    UserMediaPermissionRequestExt, WebViewExt,
};

/// WebKit's name for the track processor's switch.
const TRACK_PROCESSOR: &CStr = c"MediaStreamTrackProcessing";

/// Let `window`'s page ask for a screen, and read it in a worker. Call it
/// as the window is built, before its page could want either.
pub fn allow(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            turn_on(&settings, TRACK_PROCESSOR);
        }
        view.connect_permission_request(|_, request| answer(request));
    });
}

/// Yes to a screen, alone; anything else is left to WebKitGTK, which says
/// no. True when answered here.
fn answer(request: &PermissionRequest) -> bool {
    let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
        return false;
    };
    // SAFETY: `media` is a live request, borrowed for the length of the call.
    let screen = unsafe {
        webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(media.to_glib_none().0)
    } != 0;
    if !screen_alone(
        screen,
        media.is_for_audio_device(),
        media.is_for_video_device(),
    ) {
        return false;
    }
    request.allow();
    true
}

/// A request is let through when it's for a screen and for no camera or
/// microphone with it. WebKitGTK names a screen request as a display device
/// and not as a video one, so a video device in it is a camera.
fn screen_alone(display: bool, audio: bool, video: bool) -> bool {
    display && !audio && !video
}

type AllFeatures = unsafe extern "C" fn() -> *mut c_void;
type ListLength = unsafe extern "C" fn(*mut c_void) -> usize;
type ListGet = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type SetEnabled = unsafe extern "C" fn(*mut webkit2gtk::ffi::WebKitSettings, *mut c_void, i32);
type ListUnref = unsafe extern "C" fn(*mut c_void);

/// WebKitGTK's own function `name`, if this WebKitGTK has it.
///
/// # Safety
/// `F` must be the function's real type.
unsafe fn find<F: Copy>(name: &CStr) -> Option<F> {
    // SAFETY: dlsym with RTLD_DEFAULT reads the symbols already loaded;
    // WebKitGTK is, since this window is drawn with it.
    let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    if found.is_null() {
        return None;
    }
    debug_assert_eq!(std::mem::size_of::<F>(), std::mem::size_of::<*mut c_void>());
    // SAFETY: a function pointer the size of a pointer, of the type the
    // caller vouches for.
    Some(unsafe { std::mem::transmute_copy(&found) })
}

/// Turn on WebKit's feature named `wanted` for `settings`, if this
/// WebKitGTK has the switches (2.42 on) and the feature. False when it
/// couldn't.
fn turn_on(settings: &webkit2gtk::Settings, wanted: &CStr) -> bool {
    // SAFETY: each type is the function's own, from WebKitGTK's
    // `WebKitFeature.h` and `WebKitSettings.h` (2.42).
    let found = unsafe {
        (
            find::<AllFeatures>(c"webkit_settings_get_all_features"),
            find::<ListLength>(c"webkit_feature_list_get_length"),
            find::<ListGet>(c"webkit_feature_list_get"),
            find::<Identifier>(c"webkit_feature_get_identifier"),
            find::<SetEnabled>(c"webkit_settings_set_feature_enabled"),
            find::<ListUnref>(c"webkit_feature_list_unref"),
        )
    };
    let (Some(all), Some(length), Some(get), Some(identifier), Some(set), Some(unref)) = found
    else {
        return false;
    };
    let mut done = false;
    // SAFETY: the list is WebKitGTK's own and lives until `unref`; each
    // feature in it lives as long as the list, and its identifier as long
    // as the feature. `settings` is a live WebKitSettings.
    unsafe {
        let list = all();
        if list.is_null() {
            return false;
        }
        for at in 0..length(list) {
            let feature = get(list, at);
            if feature.is_null() {
                continue;
            }
            let name = identifier(feature);
            if !name.is_null() && CStr::from_ptr(name) == wanted {
                set(settings.to_glib_none().0, feature, 1);
                done = true;
                break;
            }
        }
        unref(list);
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_screen_is_let_through() {
        assert!(screen_alone(true, false, false));
        // A camera, a microphone, or either with a screen: no.
        assert!(!screen_alone(false, false, true));
        assert!(!screen_alone(false, true, false));
        assert!(!screen_alone(true, true, false));
        assert!(!screen_alone(true, false, true));
        assert!(!screen_alone(false, false, false));
    }

    #[test]
    fn a_missing_function_is_none_rather_than_a_crash() {
        // SAFETY: never called; the type only has to be a function pointer.
        let found = unsafe { find::<AllFeatures>(c"webkit_no_such_function_anywhere") };
        assert!(found.is_none());
    }
}
