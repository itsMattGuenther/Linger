//! Files shared to Linger from the phone's share sheet (#785, SPEC §4.15).
//!
//! The phone hands them over outside the page, into one folder, the inbox:
//! Android's `MainActivity.kt` copies what an `ACTION_SEND` carried into the
//! app's own `files/shared`, and the iPhone's share extension, a separate
//! program that can't reach the app's storage, copies into `shared` in the App
//! Group's folder, which both can reach. Each file goes in a numbered folder
//! of its own (`shared/0/Screenshot.png`, `shared/1/…`), so its name is kept,
//! the order is the share's, and two files with one name don't collide. A new
//! share empties the inbox first.
//!
//! The page asks for what's there, as it does for files dropped on Linux
//! (`dropped.rs`): the list, each file's bytes by its place in that list, and,
//! once they are in a message box, a word that they can go (`shared_done`).
//! A page can't name a file to read: it only ever gets what is in the inbox,
//! and only for `FRESH` after it arrived. Nothing here learns which app shared
//! a file (AGENTS.md hard rule 2), and nothing is sent anywhere: the files go
//! to a message box, and the person sends them from there.

// Its commands are registered by the phone app alone (`phone_app`); a desktop
// build compiles it only for its tests.
#![cfg_attr(not(mobile), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use linger_core::limits::MAX_ATTACHMENTS_PER_MESSAGE;
use tauri::ipc::Response;

use crate::dropped::{describe, DroppedFile};

/// How long after a share its files can still be taken. Android brings Linger
/// forward with the share, but an iPhone may not let the share extension open
/// the app, and then the person opens it themselves: this is time for that.
/// Anything older is deleted, not offered.
const FRESH: Duration = Duration::from_secs(10 * 60);

/// The App Group the iPhone app and its share extension both belong to: the
/// one folder both can reach. The same name is in both entitlements files and
/// in `ShareViewController.swift`.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
const APP_GROUP: &str = "group.io.github.itsmattguenther.linger";

/// The inbox's name inside the folder each phone gives it.
const INBOX: &str = "shared";

/// The files waiting in `inbox`, in the share's order: the one file in each
/// numbered folder, while it's fresh, and no more than one message takes.
/// Anything else there (a link, a folder with two files, a name that isn't a
/// number) is left out and never read.
fn waiting(inbox: &Path, now: SystemTime) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(inbox) else {
        return Vec::new();
    };
    let mut found: Vec<(u32, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let place: u32 = entry.file_name().to_str()?.parse().ok()?;
            let kind = entry.file_type().ok()?;
            if !kind.is_dir() || kind.is_symlink() {
                return None;
            }
            let file = only_file(&entry.path())?;
            fresh(&file, now).then_some((place, file))
        })
        .collect();
    found.sort_by_key(|(place, _)| *place);
    found
        .into_iter()
        .take(MAX_ATTACHMENTS_PER_MESSAGE)
        .map(|(_, file)| file)
        .collect()
}

/// The single plain file in `folder`, or `None` when there isn't exactly one.
fn only_file(folder: &Path) -> Option<PathBuf> {
    let mut files = std::fs::read_dir(folder).ok()?.filter_map(Result::ok);
    let first = files.next()?;
    if files.next().is_some() {
        return None;
    }
    let kind = first.file_type().ok()?;
    (kind.is_file() && !kind.is_symlink()).then(|| first.path())
}

/// Whether `file` arrived less than `FRESH` ago. A time in the future (a clock
/// put back) counts as fresh, since it can only have just arrived.
fn fresh(file: &Path, now: SystemTime) -> bool {
    std::fs::symlink_metadata(file)
        .and_then(|meta| meta.modified())
        .map(|at| now.duration_since(at).map_or(true, |age| age <= FRESH))
        .unwrap_or(false)
}

/// Empty the inbox: everything in it, not the inbox itself.
fn empty(inbox: &Path) {
    let Ok(entries) = std::fs::read_dir(inbox) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let gone = match entry.file_type() {
            Ok(kind) if kind.is_dir() && !kind.is_symlink() => std::fs::remove_dir_all(&path),
            _ => std::fs::remove_file(&path),
        };
        if let Err(error) = gone {
            eprintln!("shared: couldn't delete {}: {error}", path.display());
        }
    }
}

/// Empty the inbox if nothing in it is fresh any more: a share nobody took.
/// Run when the app starts, so a file shared and never taken doesn't stay on
/// the phone.
fn sweep(inbox: &Path, now: SystemTime) {
    if waiting(inbox, now).is_empty() {
        empty(inbox);
    }
}

/// Where this phone's inbox is, or `None` when it can't be found (and off a
/// phone, where nothing shares to Linger).
fn inbox() -> Option<PathBuf> {
    #[cfg(target_os = "android")]
    {
        android::files_dir().map(|files| files.join(INBOX))
    }
    #[cfg(target_os = "ios")]
    {
        ios::group_dir().map(|group| group.join(INBOX))
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        None
    }
}

/// Clear out a share nobody took. Called from the phone app's `setup`.
pub fn clear_leftovers() {
    if let Some(inbox) = inbox() {
        sweep(&inbox, SystemTime::now());
    }
}

/// What was last shared to Linger, in the order shared, with why any can't be
/// sent (the same words as a dropped file's).
#[tauri::command]
pub fn shared_files() -> Vec<DroppedFile> {
    inbox()
        .map(|inbox| waiting(&inbox, SystemTime::now()))
        .unwrap_or_default()
        .iter()
        .map(|path| describe(path))
        .collect()
}

/// The bytes of the `index`th file last shared. Refused for a file over the
/// 500 MB a file can be, or one that's gone.
#[tauri::command]
pub async fn shared_file(index: usize) -> Result<Response, String> {
    let paths = inbox()
        .map(|inbox| waiting(&inbox, SystemTime::now()))
        .unwrap_or_default();
    let path = paths.get(index).ok_or("nothing was shared")?.clone();
    if describe(&path).problem.is_some() {
        return Err("that can't be sent".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

/// The files are in a message box, or the person turned the share down:
/// delete them from the phone.
#[tauri::command]
pub fn shared_done() {
    if let Some(inbox) = inbox() {
        empty(&inbox);
    }
}

/// Android's half: the app's own files folder, from the app context
/// `MainActivity` handed over, which is where `MainActivity.kt` writes.
#[cfg(target_os = "android")]
mod android {
    use std::path::PathBuf;

    use jni::objects::JString;

    use crate::phone_sound::android::with_env;

    /// `context.getFilesDir().getAbsolutePath()`.
    pub fn files_dir() -> Option<PathBuf> {
        with_env(|env, app| {
            let dir = env
                .call_method(app, "getFilesDir", "()Ljava/io/File;", &[])
                .ok()?
                .l()
                .ok()?;
            let path = env
                .call_method(&dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
                .ok()?
                .l()
                .ok()?;
            let path = JString::from(path);
            let path: String = env.get_string(&path).ok()?.into();
            Some(PathBuf::from(path))
        })
    }
}

/// The iPhone's half: the App Group's folder, which the share extension
/// writes to.
#[cfg(target_os = "ios")]
mod ios {
    use std::path::PathBuf;

    use objc2_foundation::{NSFileManager, NSString};

    use super::APP_GROUP;

    /// `FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:)`,
    /// which is `None` when the app wasn't signed into the group.
    pub fn group_dir() -> Option<PathBuf> {
        let url = NSFileManager::defaultManager()
            .containerURLForSecurityApplicationGroupIdentifier(&NSString::from_str(APP_GROUP))?;
        url.path().map(|path| PathBuf::from(path.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inbox(name: &str) -> PathBuf {
        let inbox =
            std::env::temp_dir().join(format!("linger-shared-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&inbox);
        std::fs::create_dir_all(&inbox).expect("an inbox");
        inbox
    }

    /// One shared file, as the phone leaves it: `inbox/place/name`.
    fn share(inbox: &Path, place: &str, name: &str) -> PathBuf {
        let folder = inbox.join(place);
        std::fs::create_dir_all(&folder).expect("its folder");
        let file = folder.join(name);
        std::fs::write(&file, b"not really a picture").expect("a file");
        file
    }

    #[test]
    fn files_come_in_the_share_s_order_with_their_own_names() {
        let inbox = inbox("order");
        let third = share(&inbox, "10", "c.png");
        let first = share(&inbox, "0", "Screenshot.png");
        let second = share(&inbox, "2", "Screenshot.png");
        assert_eq!(
            waiting(&inbox, SystemTime::now()),
            [first, second, third],
            "by number, not by name"
        );
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn no_more_files_than_one_message_takes() {
        let inbox = inbox("most");
        for place in 0..=MAX_ATTACHMENTS_PER_MESSAGE {
            share(&inbox, &place.to_string(), "photo.png");
        }
        let waiting = waiting(&inbox, SystemTime::now());
        assert_eq!(waiting.len(), MAX_ATTACHMENTS_PER_MESSAGE);
        assert_eq!(
            waiting.first(),
            Some(&inbox.join("0").join("photo.png")),
            "the first ones, in order"
        );
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn a_share_can_be_taken_only_while_it_s_fresh() {
        let inbox = inbox("fresh");
        let photo = share(&inbox, "0", "photo.png");
        let now = SystemTime::now();
        assert_eq!(waiting(&inbox, now), [photo]);
        assert!(waiting(&inbox, now + FRESH + Duration::from_secs(1)).is_empty());
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn nothing_but_one_plain_file_in_a_numbered_folder_is_offered() {
        let inbox = inbox("strays");
        std::fs::write(inbox.join("loose.png"), b"x").expect("a loose file");
        share(&inbox, "notes", "a.png");
        share(&inbox, "1", "a.png");
        share(&inbox, "1", "b.png");
        std::fs::create_dir_all(inbox.join("2").join("deeper")).expect("a folder in a folder");
        std::fs::create_dir_all(inbox.join("3")).expect("an empty folder");
        assert!(waiting(&inbox, SystemTime::now()).is_empty());
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn no_inbox_is_no_share() {
        let gone = std::env::temp_dir().join(format!("linger-shared-none-{}", std::process::id()));
        assert!(waiting(&gone, SystemTime::now()).is_empty());
        empty(&gone);
        sweep(&gone, SystemTime::now());
    }

    #[test]
    fn done_empties_the_inbox_but_keeps_it() {
        let inbox = inbox("done");
        let photo = share(&inbox, "0", "photo.png");
        std::fs::write(inbox.join("loose.png"), b"x").expect("a loose file");
        empty(&inbox);
        assert!(!photo.exists());
        assert!(inbox.exists());
        assert_eq!(std::fs::read_dir(&inbox).expect("the inbox").count(), 0);
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn a_share_nobody_took_is_swept_and_a_fresh_one_is_kept() {
        let inbox = inbox("sweep");
        let photo = share(&inbox, "0", "photo.png");
        sweep(&inbox, SystemTime::now());
        assert!(photo.exists(), "still fresh");
        sweep(&inbox, SystemTime::now() + FRESH + Duration::from_secs(1));
        assert!(!photo.exists(), "stale");
        let _ = std::fs::remove_dir_all(&inbox);
    }
}
