//! Keeping the iPhone app's files out of the phone's backups (SPEC §4.15,
//! #790). Android leaves Linger out with `allowBackup="false"`; an iPhone
//! has no switch like that for an app.
//!
//! An iPhone backs up what's in an app's folder (to iCloud, or to a
//! computer), except `Library/Caches` and `tmp`, which iOS empties itself and
//! never backs up. Anything else is left out only if it, or a folder it's
//! in, is marked "don't back up" (`NSURLIsExcludedFromBackupKey`; Apple's
//! "Optimizing your app's data for iCloud backup"). So every start, before
//! there's a window, the app marks the folders its data is kept in,
//! making any that aren't there yet so the mark is in place before the web
//! view writes anything. Every start, not once: Apple warns that some file
//! operations reset the mark, so it's set again rather than trusted.
//!
//! Which folders (`kept_out`), all in the app's `Library`:
//!
//! - `WebKit`: the web view's storage, where the page keeps your list of
//!   servers and your settings. WebKit keeps a default store's data in
//!   `Library/WebKit/WebsiteData` and any other store's in
//!   `Library/WebKit/WebsiteDataStore/<id>` (WebKit's
//!   `WebsiteDataStoreCocoa.mm`); its caches go in `Library/Caches`.
//! - `Cookies`: cookies, the web view's and the phone's networking's
//!   (`Cookies.binarycookies`, from the same WebKit file).
//! - `HTTPStorages`: where newer iOS keeps the phone's networking's own
//!   records for each app, which the downloads in `phone_save.rs` go
//!   through.
//! - `Application Support`: where Tauri and its plugins keep an app's files
//!   on an iPhone (`app_data_dir()` and the rest are
//!   `Library/Application Support/<identifier>`).
//!
//! Left alone: `Library/Caches` and `tmp`, never backed up (a download for
//! the share sheet goes in `tmp`); `Documents`, where Linger keeps nothing;
//! and `Library/Preferences`, iOS's own settings file for every app, which
//! Linger doesn't write to. The sign-ins aren't files: they're in the
//! Keychain, kept to this phone by `secrets.rs`.
//!
//! Apple calls the mark guidance for the system rather than a guarantee, so
//! the testers' check is the real one: Linger should show next to nothing in
//! the iPhone's list of what its iCloud backup holds.
//!
//! The choice of folders takes a home folder and touches nothing, so it's
//! tested on any computer; the iPhone's half is in `ios`.

use std::path::{Path, PathBuf};

/// The folders marked "don't back up", in the app's own folder `home`
/// (its sandbox on an iPhone, `NSHomeDirectory`).
fn kept_out(home: &Path) -> [PathBuf; 4] {
    let library = home.join("Library");
    ["Application Support", "Cookies", "HTTPStorages", "WebKit"].map(|name| library.join(name))
}

/// Mark the app's folders "don't back up". A folder that can't be marked is
/// said in the log and the rest are still marked; the app starts either way.
#[cfg(target_os = "ios")]
pub fn keep_out_of_backups() {
    // This runs before the app's run loop, which would otherwise hold what
    // Foundation hands back, so it has a pool of its own.
    objc2::rc::autoreleasepool(|_| {
        let home = ios::home();
        for folder in kept_out(&home) {
            if let Err(reason) = ios::mark(&folder) {
                eprintln!(
                    "linger: {} may go into the phone's backups: {reason}",
                    folder.display()
                );
            }
        }
    });
}

/// The iPhone's half, through objc2's bindings to Foundation. Every
/// `unsafe` is here, each with what makes it sound.
#[cfg(target_os = "ios")]
mod ios {
    use std::path::{Path, PathBuf};

    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        NSHomeDirectory, NSNumber, NSString, NSURLIsExcludedFromBackupKey, NSURL,
    };

    /// The app's own folder on the phone, the one Apple's documentation
    /// calls its sandbox; WebKit's and Tauri's folders are inside it.
    pub fn home() -> PathBuf {
        PathBuf::from(NSHomeDirectory().to_string())
    }

    /// Make the folder if it isn't there, then mark it "don't back up",
    /// which covers everything that's in it or goes into it.
    pub fn mark(folder: &Path) -> Result<(), String> {
        std::fs::create_dir_all(folder).map_err(|err| err.to_string())?;
        let path = NSString::from_str(&folder.to_string_lossy());
        let url = NSURL::fileURLWithPath_isDirectory(&path, true);
        let yes = NSNumber::numberWithBool(true);
        let value: &AnyObject = &yes;
        // SAFETY: Apple's documentation gives this key's value as an NSNumber
        // holding a boolean, which `value` is, and the key is a constant
        // Foundation exports, alive as long as the app is.
        unsafe { url.setResourceValue_forKey_error(Some(value), NSURLIsExcludedFromBackupKey) }
            .map_err(|err| err.localizedDescription().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An iPhone app's folder, as one looks.
    fn home() -> PathBuf {
        PathBuf::from(
            "/var/mobile/Containers/Data/Application/0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0",
        )
    }

    fn marked(path: &Path) -> bool {
        kept_out(&home())
            .iter()
            .any(|folder| path.starts_with(folder))
    }

    /// Everything Linger keeps in files on an iPhone is inside a marked
    /// folder: the web view's storage in each layout WebKit has used (where
    /// the page's list of servers and settings are), its cookies, the phone's
    /// networking's own storage, and Tauri's folders for the app.
    #[test]
    fn where_linger_keeps_things_is_marked() {
        let home = home();
        for kept in [
            "Library/WebKit/WebsiteData/LocalStorage/tauri_localhost_0.localstorage",
            "Library/WebKit/WebsiteData/Default/salt/salt/LocalStorage/localstorage.sqlite3",
            "Library/WebKit/WebsiteData/IndexedDB/v1/tauri_localhost_0/IndexedDB.sqlite3",
            "Library/WebKit/WebsiteDataStore/5C2B0A3E-0000-4000-8000-000000000000/Default",
            "Library/Cookies/Cookies.binarycookies",
            "Library/HTTPStorages/io.github.itsmattguenther.linger/httpstorages.sqlite",
            "Library/Application Support/io.github.itsmattguenther.linger",
        ] {
            assert!(marked(&home.join(kept)), "{kept} would be backed up");
        }
    }

    /// What iOS already leaves out isn't touched, nor is anything outside
    /// `Library`: not the app's whole folder, and not Documents.
    #[test]
    fn nothing_else_is_marked() {
        let home = home();
        for left in [
            "Library/Caches/WebKit",
            "tmp/linger-download",
            "Documents",
            "Library/Preferences",
        ] {
            assert!(!marked(&home.join(left)), "{left} shouldn't be marked");
        }
        for folder in kept_out(&home) {
            assert!(folder.starts_with(home.join("Library")));
            assert_ne!(folder, home.join("Library"));
        }
    }
}
