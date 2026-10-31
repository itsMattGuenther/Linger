//! Files shared to Linger from the phone's share sheet (#785, SPEC §4.15).
//!
//! The phone hands them over outside the page, into one folder, the inbox:
//! Android's `MainActivity.kt` copies what an `ACTION_SEND` carried into the
//! app's own `files/shared`, and the iPhone's share extension, a separate
//! program that can't reach the app's storage, copies into `shared` in the App
//! Group's folder, which both can reach. Each file goes in a numbered folder
//! of its own (`shared/0/Screenshot.png`, `shared/1/…`), so its name is kept,
//! the order is the share's, and two files with one name don't collide. Both
//! write into `shared-incoming` first and move it into place whole.
//!
//! The page asks for what's there, as it does for files dropped on Linux
//! (`dropped.rs`). Asking takes the share: the inbox is moved aside into
//! `shared-taken/<id>`, and the page gets that id with the list. Each file's
//! bytes are asked for by the id and the file's place in the list, and the
//! word that they can go (`shared_done`) names the id too. So a share that
//! arrives while the page is still reading the last one lands in an empty
//! inbox: it can't mix its files into the one being read, or be deleted with
//! it (#792). A newer share taken replaces an older one whole.
//!
//! A page can't name a file to read: an id is digits only, and it only ever
//! gets what is in a taken share, and only for `FRESH` after it arrived.
//! Nothing here learns which app shared a file (AGENTS.md hard rule 2), and
//! nothing is sent anywhere: the files go to a message box, and the person
//! sends them from there.

// Its commands are registered by the phone app alone (`phone_app`); a desktop
// build compiles it only for its tests.
#![cfg_attr(not(mobile), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use linger_core::limits::MAX_ATTACHMENTS_PER_MESSAGE;
use serde::Serialize;
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

/// Where each phone writes a share before moving it into the inbox whole.
const INCOMING: &str = "shared-incoming";

/// Where shares the page has asked for are set aside, each in a folder named
/// by its id.
const TAKEN: &str = "shared-taken";

/// What was shared, as the page gets it: the id that names it from now on,
/// and its files.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Share {
    id: String,
    files: Vec<DroppedFile>,
}

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

/// Whether `path` was written less than `FRESH` ago. A time in the future (a
/// clock put back) counts as fresh, since it can only have just been written.
fn fresh(path: &Path, now: SystemTime) -> bool {
    std::fs::symlink_metadata(path)
        .and_then(|meta| meta.modified())
        .map(|at| now.duration_since(at).map_or(true, |age| age <= FRESH))
        .unwrap_or(false)
}

/// Whether `id` can only be a taken share's name: digits, as `id_at` makes.
fn is_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|byte| byte.is_ascii_digit())
}

/// A new share's id: when it was taken, in nanoseconds, so a later one sorts
/// after.
fn id_at(now: SystemTime) -> String {
    now.duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos())
        .to_string()
}

/// The taken shares in `taken`, by id. Anything else there is left alone.
fn shares(taken: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(taken) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_owned();
            let kind = entry.file_type().ok()?;
            (is_id(&id) && kind.is_dir() && !kind.is_symlink()).then(|| (id, entry.path()))
        })
        .collect()
}

/// The folder of the taken share `id`, or `None` for anything that isn't an id.
fn folder_of(root: &Path, id: &str) -> Option<PathBuf> {
    is_id(id).then(|| root.join(TAKEN).join(id))
}

/// Delete `path`, a folder with everything in it or a file; already gone is fine.
fn remove(path: &Path) {
    let gone = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        _ => std::fs::remove_file(path),
    };
    if let Err(error) = gone {
        eprintln!("shared: couldn't delete {}: {error}", path.display());
    }
}

/// Take the share waiting under `root`: a fresh one in the inbox is moved
/// aside under a new id, replacing any taken before it. Answers the newest
/// taken share with anything fresh in it, which is the one already taken
/// when nothing new has arrived.
fn take(root: &Path, now: SystemTime) -> Option<(String, PathBuf)> {
    let taken = root.join(TAKEN);
    let inbox = root.join(INBOX);
    if !waiting(&inbox, now).is_empty() {
        let id = id_at(now);
        match std::fs::create_dir_all(&taken)
            .and_then(|()| std::fs::rename(&inbox, taken.join(&id)))
        {
            Ok(()) => {
                for (other, folder) in shares(&taken) {
                    if other != id {
                        remove(&folder);
                    }
                }
            }
            Err(error) => eprintln!("shared: couldn't take the share: {error}"),
        }
    }
    shares(&taken)
        .into_iter()
        .filter(|(_, folder)| !waiting(folder, now).is_empty())
        .max_by_key(|(id, _)| id.parse::<u128>().unwrap_or(0))
}

/// The share `id` is in a message box, or was turned down: delete it, and
/// nothing else.
fn done(root: &Path, id: &str) {
    if let Some(folder) = folder_of(root, id) {
        remove(&folder);
    }
}

/// Delete what nobody will take: an inbox or taken share with nothing fresh
/// left in it, and a copy into `shared-incoming` that stopped partway (the
/// phone ended it). A copy still going is left alone: `shared-incoming`
/// counts as stopped only once it's had nothing new for `FRESH`.
fn sweep(root: &Path, now: SystemTime) {
    let inbox = root.join(INBOX);
    if waiting(&inbox, now).is_empty() {
        remove(&inbox);
    }
    let incoming = root.join(INCOMING);
    if !fresh(&incoming, now) {
        remove(&incoming);
    }
    for (_, folder) in shares(&root.join(TAKEN)) {
        if waiting(&folder, now).is_empty() {
            remove(&folder);
        }
    }
}

/// The folder this phone's inbox and its neighbours are in, or `None` when it
/// can't be found (and off a phone, where nothing shares to Linger).
fn root() -> Option<PathBuf> {
    #[cfg(target_os = "android")]
    {
        android::files_dir()
    }
    #[cfg(target_os = "ios")]
    {
        ios::group_dir()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        None
    }
}

/// Clear out what nobody will take. Called from the phone app's `setup`.
pub fn clear_leftovers() {
    if let Some(root) = root() {
        sweep(&root, SystemTime::now());
    }
}

/// What was last shared to Linger, taken so nothing newer can mix with it: its
/// id, and its files in the order shared, with why any can't be sent (the same
/// words as a dropped file's). `None` when nothing is waiting. The file checks
/// run off the async runtime, as all of this module's do.
#[tauri::command]
pub async fn shared_files() -> Option<Share> {
    crate::off_thread(
        || {
            let now = SystemTime::now();
            let (id, folder) = take(&root()?, now)?;
            let files = waiting(&folder, now)
                .iter()
                .map(|path| describe(path))
                .collect();
            Some(Share { id, files })
        },
        || None,
    )
    .await
}

/// The bytes of the `index`th file of the share `share`. Refused for a file
/// over the 500 MB a file can be, one that's gone, or a share that is.
#[tauri::command]
pub async fn shared_file(share: String, index: usize) -> Result<Response, String> {
    let path = crate::off_thread(
        move || {
            let folder = folder_of(&root()?, &share)?;
            let path = waiting(&folder, SystemTime::now()).into_iter().nth(index)?;
            describe(&path).problem.is_none().then_some(path)
        },
        || None,
    )
    .await
    .ok_or("that can't be sent")?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

/// The share `share` is in a message box, or the person turned it down:
/// delete it from the phone. A newer share waiting is left alone.
#[tauri::command]
pub async fn shared_done(share: String) {
    crate::off_thread(
        move || {
            if let Some(root) = root() {
                done(&root, &share);
            }
        },
        || (),
    )
    .await;
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

    fn root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("linger-shared-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a root");
        root
    }

    /// One shared file, as the phone leaves it: `inbox/place/name`.
    fn share(inbox: &Path, place: &str, name: &str) -> PathBuf {
        let folder = inbox.join(place);
        std::fs::create_dir_all(&folder).expect("its folder");
        let file = folder.join(name);
        std::fs::write(&file, b"not really a picture").expect("a file");
        file
    }

    fn later(now: SystemTime) -> SystemTime {
        now + Duration::from_secs(1)
    }

    fn stale(now: SystemTime) -> SystemTime {
        now + FRESH + Duration::from_secs(1)
    }

    #[test]
    fn files_come_in_the_share_s_order_with_their_own_names() {
        let inbox = root("order");
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
        let inbox = root("most");
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
        let inbox = root("fresh");
        let photo = share(&inbox, "0", "photo.png");
        let now = SystemTime::now();
        assert_eq!(waiting(&inbox, now), [photo]);
        assert!(waiting(&inbox, stale(now)).is_empty());
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn nothing_but_one_plain_file_in_a_numbered_folder_is_offered() {
        let inbox = root("strays");
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
    fn no_folder_is_no_share() {
        let gone = std::env::temp_dir().join(format!("linger-shared-none-{}", std::process::id()));
        assert!(take(&gone, SystemTime::now()).is_none());
        done(&gone, "1");
        sweep(&gone, SystemTime::now());
    }

    // Greptile's catch on #792: the list and each file were looked up afresh,
    // so a share arriving mid-read mixed into the one being read.
    #[test]
    fn a_taken_share_is_set_aside_so_a_new_one_can_t_mix_with_it() {
        let root = root("mix");
        let inbox = root.join(INBOX);
        share(&inbox, "0", "first.png");
        let now = SystemTime::now();
        let (first, folder) = take(&root, now).expect("the first share");
        assert!(!inbox.exists(), "moved aside");
        let first_file = folder.join("0").join("first.png");
        assert_eq!(waiting(&folder, now), std::slice::from_ref(&first_file));

        // A second share arrives while the first is being read.
        share(&inbox, "0", "second.png");
        assert_eq!(
            waiting(&folder, now),
            [first_file],
            "the first share's files are still its own"
        );

        let (second, newer) = take(&root, later(now)).expect("the second share");
        assert_ne!(first, second);
        assert_eq!(waiting(&newer, now), [newer.join("0").join("second.png")]);
        assert!(!folder.exists(), "a newer share replaces the last whole");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_taken_share_is_offered_again_until_it_s_done() {
        let root = root("again");
        share(&root.join(INBOX), "0", "photo.png");
        let now = SystemTime::now();
        let (id, _) = take(&root, now).expect("the share");
        assert_eq!(
            take(&root, later(now)).map(|(again, _)| again),
            Some(id.clone()),
            "asked again, the same share"
        );
        done(&root, &id);
        assert!(take(&root, later(now)).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn done_deletes_only_its_own_share() {
        let root = root("done");
        let inbox = root.join(INBOX);
        share(&inbox, "0", "first.png");
        let now = SystemTime::now();
        let (first, folder) = take(&root, now).expect("the first share");
        let second = share(&inbox, "0", "second.png");
        done(&root, &first);
        assert!(!folder.exists());
        assert!(second.exists(), "the share that arrived since is kept");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_a_taken_share_s_own_folder_can_be_named() {
        let root = root("names");
        let long = "9".repeat(41);
        for id in ["", "..", "../..", "1/2", "12a", "-1", long.as_str()] {
            assert_eq!(folder_of(&root, id), None, "{id:?}");
        }
        assert_eq!(folder_of(&root, "123"), Some(root.join(TAKEN).join("123")));
        let _ = std::fs::remove_dir_all(&root);
    }

    // Greptile's catch on #792: a copy the phone stopped partway stayed.
    #[test]
    fn what_nobody_will_take_is_swept_and_what_s_fresh_is_kept() {
        let root = root("sweep");
        let waiting_photo = share(&root.join(INBOX), "0", "photo.png");
        let half_copied = share(&root.join(INCOMING), "0", "video.mov");
        let taken_photo = share(&root.join(TAKEN).join("1"), "0", "taken.png");
        sweep(&root, SystemTime::now());
        assert!(waiting_photo.exists(), "a fresh share is kept");
        assert!(
            half_copied.exists(),
            "a copy that may still be going is kept"
        );
        assert!(taken_photo.exists(), "a fresh taken share is kept");

        sweep(&root, stale(SystemTime::now()));
        assert!(!root.join(INBOX).exists(), "a share nobody took");
        assert!(
            !root.join(INCOMING).exists(),
            "a copy the phone stopped partway"
        );
        assert!(
            !root.join(TAKEN).join("1").exists(),
            "a taken share nobody finished"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
