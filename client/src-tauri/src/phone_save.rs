//! Downloading a shared file on an iPhone (#703): the app fetches the file
//! itself and offers it in the iPhone's share sheet, which has Save to Files,
//! AirDrop and opening it in another app.
//!
//! Everywhere else a download goes to the browser (`lib/external.ts`,
//! FILE-6): the computer's, or Chrome on Android, which saves it. On an
//! iPhone that did nothing anybody could see. A file that isn't a picture, a
//! video or a sound is served as a download (`application/octet-stream`
//! with `Content-Disposition: attachment`, ARCHITECTURE §7), and Safari,
//! handed one by another app, opened a blank tab. So here the shell fetches
//! it with the iPhone's own networking (`NSURLSession`, which goes through
//! the phone's proxy, VPN and certificates as Safari would), into the app's
//! temporary folder under the file's own name made safe, and presents the
//! share sheet (`UIActivityViewController`) for it. The bytes go from the
//! server to that file and from the file to the sheet: they never pass
//! through the page, which only hears whether the sheet opened.
//!
//! Each download gets a folder of its own, removed when its sheet closes.
//! What a closed app left behind is cleared when it starts again
//! (`clear_leftovers`), and iOS empties the folder itself in time.
//!
//! Only web addresses are fetched: checked here as well as in the page, the
//! same two locks as a link (`lib/external.ts`), since the page renders
//! other people's messages. The parts that need no iPhone (the address and
//! the name) are outside the iOS code, so they're tested on any computer.

/// What the page hears when it asks for something that isn't a web address.
const NOT_A_WEB_ADDRESS: &str = "Only web addresses can be downloaded.";

/// The longest name a download is given, in bytes: well inside the 255 an
/// iPhone's disk allows, and still the whole of nearly any real name.
const LONGEST_NAME: usize = 120;

/// The longest extension kept whole when a name is shortened, dot included.
const LONGEST_EXTENSION: usize = 16;

/// A download's name when its own leaves nothing usable.
const NAMELESS: &str = "file";

/// Fetch a shared file and show it in the iPhone's share sheet. Resolves once
/// the sheet is showing; the sheet is the answer, so nothing more is said.
/// An error is the reason in words, for the page to say it couldn't get the
/// file. Android's downloads go to Chrome (`lib/external.ts`), so there this
/// only refuses.
#[cfg(mobile)]
#[tauri::command]
pub async fn phone_save(webview: tauri::Webview, url: String, name: String) -> Result<(), String> {
    web_address(&url).map_err(str::to_string)?;
    #[cfg(target_os = "ios")]
    {
        ios::save(webview, url, file_name(&name)).await
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (webview, name);
        Err("On this phone, downloads go to the browser.".to_string())
    }
}

/// Clear what downloads a closed app left behind, before anything else asks.
#[cfg(target_os = "ios")]
pub fn clear_leftovers() {
    ios::clear_leftovers();
}

/// The address, if it's a web address: http or https, with a host. Anything
/// else (a file on the phone, a script, an app's own scheme) is refused,
/// whatever the page asks.
fn web_address(address: &str) -> Result<tauri::Url, &'static str> {
    let url = tauri::Url::parse(address).map_err(|_| NOT_A_WEB_ADDRESS)?;
    let web = matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some_and(|host| !host.is_empty());
    if web {
        Ok(url)
    } else {
        Err(NOT_A_WEB_ADDRESS)
    }
}

/// The name a download is saved under: the attachment's own, made safe to be
/// one file in one folder. Only what's after the last slash or backslash, so
/// it can't climb out of its folder; no control characters, none that turn
/// text around (#488), and no colon, which Files shows as a slash; no leading
/// dots, which would hide it; at most `LONGEST_NAME` bytes, keeping a short
/// extension; and `NAMELESS` when nothing is left.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
fn file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let kept: String = last
        .chars()
        .filter(|&c| !c.is_control() && !changes_direction(c) && c != ':')
        .collect();
    let trimmed = kept.trim().trim_start_matches('.').trim_start();
    let short = shortened(trimmed);
    if short.is_empty() {
        NAMELESS.to_string()
    } else {
        short
    }
}

/// At most `LONGEST_NAME` bytes, cut between characters, with the extension
/// (from the last dot) kept whole when it's short.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
fn shortened(name: &str) -> String {
    if name.len() <= LONGEST_NAME {
        return name.to_string();
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot <= LONGEST_EXTENSION => name.split_at(dot),
        _ => (name, ""),
    };
    let mut kept = String::new();
    for c in stem.chars() {
        if kept.len() + c.len_utf8() + extension.len() > LONGEST_NAME {
            break;
        }
        kept.push(c);
    }
    format!("{}{extension}", kept.trim_end())
}

/// The characters that change the direction of text (#488): a download named
/// `invoice` + U+202E + `fdp.exe` would read "invoiceexe.pdf" in the share
/// sheet and in Files. The server takes them out of names on the way in
/// (`validate::filename`); one stored before that loses them here.
#[cfg_attr(not(any(target_os = "ios", test)), allow(dead_code))]
fn changes_direction(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{200E}' | '\u{200F}')
}

/// The iPhone's half: its networking and its share sheet, through objc2's
/// bindings to Apple's own frameworks. Every `unsafe` is here, each with what
/// makes it sound.
#[cfg(target_os = "ios")]
mod ios {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{MainThreadMarker, MainThreadOnly, Message};
    use objc2_foundation::{
        NSArray, NSError, NSHTTPURLResponse, NSPoint, NSRect, NSSize, NSString, NSURLResponse,
        NSURLSession, NSURL,
    };
    use objc2_ui_kit::{
        UIActivityType, UIActivityTypeAssignToContact, UIActivityTypeSaveToCameraRoll,
        UIActivityViewController, UIPopoverArrowDirection, UIViewController,
    };
    use tokio::sync::oneshot;

    const COULDNT_GET: &str = "Couldn't get the file.";
    const NO_SHEET: &str = "Couldn't show the file.";

    /// Where downloads wait for the share sheet: in the app's own temporary
    /// folder, which nothing else can read and iOS may empty while the app
    /// isn't running.
    fn downloads() -> PathBuf {
        std::env::temp_dir().join("linger-downloads")
    }

    pub fn clear_leftovers() {
        let _ = std::fs::remove_dir_all(downloads());
    }

    /// A folder for one download, so two files of the same name never meet
    /// and a sheet's closing removes only its own.
    fn fresh_folder() -> std::io::Result<PathBuf> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let folder = downloads().join(NEXT.fetch_add(1, Ordering::Relaxed).to_string());
        std::fs::create_dir_all(&folder)?;
        Ok(folder)
    }

    /// Fetch `address` as `name`, then show the sheet. The folder goes
    /// with any failure; once the sheet shows, its closing removes it.
    pub async fn save(
        webview: tauri::Webview,
        address: String,
        name: String,
    ) -> Result<(), String> {
        let folder = fresh_folder().map_err(|_| COULDNT_GET.to_string())?;
        let file = folder.join(name);
        let result = async {
            fetch(&address, file.clone())?
                .await
                .unwrap_or_else(|_| Err(COULDNT_GET.to_string()))?;
            present(&webview, file, folder.clone())?
                .await
                .unwrap_or_else(|_| Err(NO_SHEET.to_string()))
        }
        .await;
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&folder);
        }
        result
    }

    /// Start fetching `address` into `file`. The answer comes once the file
    /// is there, or the session has given up (a minute with nothing arriving,
    /// by the session's own default). Nothing here outlives the call but the
    /// session's task, which holds the handler, so the future that waits on
    /// the answer holds nothing of Apple's.
    fn fetch(
        address: &str,
        file: PathBuf,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let url = NSURL::URLWithString(&NSString::from_str(address))
            .ok_or_else(|| COULDNT_GET.to_string())?;
        let (tell, told) = oneshot::channel();
        // The session calls the handler once, on a queue of its own: the
        // Mutex hands what it needs to that one call.
        let once = Mutex::new(Some((tell, file)));
        let handler = RcBlock::new(
            move |location: *mut NSURL, response: *mut NSURLResponse, error: *mut NSError| {
                let Some((tell, file)) = once.lock().ok().and_then(|mut held| held.take()) else {
                    return;
                };
                // SAFETY: the session passes each of these as a valid object
                // or null, alive until this call returns.
                let (location, response, failed) =
                    unsafe { (location.as_ref(), response.as_ref(), !error.is_null()) };
                let _ = tell.send(downloaded(location, response, failed, &file));
            },
        );
        // SAFETY: the session may call the handler on any thread, and all it
        // holds is a Mutex around a sender and a path, which may be sent and
        // shared between threads.
        let task = unsafe {
            NSURLSession::sharedSession().downloadTaskWithURL_completionHandler(&url, &handler)
        };
        task.resume();
        Ok(told)
    }

    /// The fetched file moved to where the sheet will find it, if the server
    /// handed it over. The session deletes its own copy when the handler
    /// returns, so it moves now.
    fn downloaded(
        location: Option<&NSURL>,
        response: Option<&NSURLResponse>,
        failed: bool,
        file: &Path,
    ) -> Result<(), String> {
        let status = response
            .and_then(|response| response.downcast_ref::<NSHTTPURLResponse>())
            .map(NSHTTPURLResponse::statusCode);
        let fetched = location
            .and_then(NSURL::path)
            .map(|path| PathBuf::from(path.to_string()));
        match (failed, status, fetched) {
            (false, Some(200..=299), Some(from)) => std::fs::rename(&from, file)
                .or_else(|_| std::fs::copy(&from, file).map(|_| ()))
                .map_err(|_| COULDNT_GET.to_string()),
            _ => Err(COULDNT_GET.to_string()),
        }
    }

    /// Show the sheet for `file`, on the main thread, where UIKit must be
    /// used. The answer says whether it opened.
    fn present(
        webview: &tauri::Webview,
        file: PathBuf,
        folder: PathBuf,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let (tell, told) = oneshot::channel();
        webview
            .with_webview(move |shown| {
                let _ = tell.send(sheet(shown.view_controller(), &file, folder));
            })
            .map_err(|_| NO_SHEET.to_string())?;
        Ok(told)
    }

    /// The share sheet for one file, presented over whatever is showing. Its
    /// closing removes `folder`.
    fn sheet(root: *mut c_void, file: &Path, folder: PathBuf) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or(NO_SHEET)?;
        // SAFETY: Tauri hands over the window's root view controller, which
        // lives as long as the window, and calls this on the main thread,
        // checked just above.
        let root = unsafe { root.cast::<UIViewController>().as_ref() }.ok_or(NO_SHEET)?;
        let top = topmost(root);

        let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
        let item: &AnyObject = &url;
        let items = NSArray::from_slice(&[item]);
        // SAFETY: the sheet takes any objects as its items, and a file's URL
        // is one it knows how to offer.
        let sheet = unsafe {
            UIActivityViewController::initWithActivityItems_applicationActivities(
                UIActivityViewController::alloc(mtm),
                &items,
                None,
            )
        };
        // Saving to Photos, which a video would be offered, needs a
        // permission the app doesn't ask for, and asking for it here would
        // stop the app; so would giving a picture to a contact. Files has it.
        // SAFETY: UIKit's own constants, alive as long as the app.
        let (photos, contact) = unsafe {
            (
                UIActivityTypeSaveToCameraRoll,
                UIActivityTypeAssignToContact,
            )
        };
        let left_out = NSArray::from_slice(&[photos, contact]);
        sheet.setExcludedActivityTypes(Some(&*left_out));
        // Somebody who backs out of one of the sheet's choices (Files' own
        // picker, say) is back at the sheet, which tells this with that
        // choice and not done: the file stays for their next one. It goes
        // once one is done, or the sheet is closed with none.
        let finished = RcBlock::new(
            move |chose: *mut UIActivityType, done: Bool, _: *mut NSArray, _: *mut NSError| {
                if done.as_bool() || chose.is_null() {
                    let _ = std::fs::remove_dir_all(&folder);
                }
            },
        );
        // SAFETY: a valid block, which the sheet copies and keeps.
        unsafe { sheet.setCompletionWithItemsHandler(RcBlock::as_ptr(&finished)) };
        // An iPad shows the sheet as a popover, and one with nothing to point
        // at stops the app: it points at the middle of the screen, arrowless.
        if let Some(popover) = sheet.popoverPresentationController() {
            let view = top.view().ok_or(NO_SHEET)?;
            let bounds = view.bounds();
            popover.setSourceView(Some(&*view));
            popover.setSourceRect(NSRect {
                origin: NSPoint {
                    x: bounds.size.width / 2.0,
                    y: bounds.size.height / 2.0,
                },
                size: NSSize {
                    width: 0.0,
                    height: 0.0,
                },
            });
            popover.setPermittedArrowDirections(UIPopoverArrowDirection::empty());
        }
        top.presentViewController_animated_completion(&sheet, true, None);
        // UIKit turns down a presentation it can't make with only a line in
        // its log; one it makes has its presenter straight away.
        if sheet.presentingViewController().is_some() {
            Ok(())
        } else {
            Err(NO_SHEET.to_string())
        }
    }

    /// What is showing on top: the root, or whatever it presented, and so on.
    fn topmost(root: &UIViewController) -> Retained<UIViewController> {
        let mut top = root.retain();
        while let Some(next) = top.presentedViewController() {
            if next.isBeingDismissed() {
                break;
            }
            top = next;
        }
        top
    }
}

#[cfg(test)]
mod tests {
    use super::{file_name, web_address, LONGEST_NAME, NAMELESS};

    #[test]
    fn fetches_only_web_addresses() {
        for address in [
            "https://cdn.good-company.example/objects/0190/report.pdf",
            "http://192.168.1.20:8080/objects/a/b.zip",
            "https://bucket.s3.example/key?X-Amz-Signature=a%2Fb&X-Amz-Expires=600",
        ] {
            assert!(web_address(address).is_ok(), "{address}");
        }
        for address in [
            "file:///var/mobile/Containers/Data/secret.db",
            "javascript:alert(1)",
            "data:text/html,hello",
            "linger://join/abc",
            "ftp://files.example/report.pdf",
            "/objects/report.pdf",
            "https://",
            "",
        ] {
            assert!(web_address(address).is_err(), "{address}");
        }
    }

    #[test]
    fn a_name_keeps_to_its_own_folder() {
        assert_eq!(
            file_name("river-loop-trail-map.pdf"),
            "river-loop-trail-map.pdf"
        );
        assert_eq!(file_name("../../Library/Preferences/x.plist"), "x.plist");
        assert_eq!(file_name("..\\..\\boot.ini"), "boot.ini");
        assert_eq!(file_name("folder/"), NAMELESS);
        assert_eq!(file_name(".."), NAMELESS);
        assert_eq!(file_name("..."), NAMELESS);
    }

    #[test]
    fn a_name_is_never_hidden_and_never_empty() {
        assert_eq!(file_name(".hidden"), "hidden");
        assert_eq!(file_name("  ..profile  "), "profile");
        assert_eq!(file_name(""), NAMELESS);
        assert_eq!(file_name("   "), NAMELESS);
        assert_eq!(file_name("\u{0}\u{7}\n"), NAMELESS);
    }

    #[test]
    fn a_name_loses_what_could_disguise_it() {
        assert_eq!(file_name("invoice\u{202E}fdp.exe"), "invoicefdp.exe");
        assert_eq!(file_name("a\u{2066}b\u{2069}\u{200F}.txt"), "ab.txt");
        assert_eq!(file_name("notes\u{0}\r\n.txt"), "notes.txt");
        assert_eq!(file_name("10:30 meeting.txt"), "1030 meeting.txt");
        // Writing in any alphabet stays.
        assert_eq!(file_name("רשימת קניות.txt"), "רשימת קניות.txt");
        assert_eq!(file_name("café menu 🍰.pdf"), "café menu 🍰.pdf");
    }

    #[test]
    fn a_long_name_is_shortened_between_characters_keeping_its_extension() {
        let long = format!("{}.pdf", "trail map ".repeat(30));
        let short = file_name(&long);
        assert!(short.len() <= LONGEST_NAME, "{}", short.len());
        assert!(
            short.starts_with("trail map") && short.ends_with(".pdf"),
            "{short}"
        );

        // Four bytes a character: cut where a character ends, never inside one.
        let wide = format!("{}.zip", "🍰".repeat(60));
        let short = file_name(&wide);
        assert!(short.len() <= LONGEST_NAME);
        assert!(
            short.ends_with(".zip") && short.starts_with('🍰'),
            "{short}"
        );

        // An extension too long to be one is just more of the name.
        let odd = format!("notes.{}", "x".repeat(200));
        assert_eq!(file_name(&odd).len(), LONGEST_NAME);
    }
}
