//! Files shared to Linger from the phone's share sheet (#785, SPEC §4.15).
//!
//! The phone hands the files over outside the page: Android's intent filter,
//! and the iPhone's share extension through the App Group's folder. Either one
//! copies what was shared into a folder of the app's own and tells this module
//! the paths (`note`). The page then asks for them, as it does for files
//! dropped on Linux (`dropped.rs`): the list of what was shared, each file's
//! bytes by its place in that list, and, once they are in a message box, a
//! word that they can go (`shared_done`).
//!
//! A page can't name a file to read: it only ever gets what the phone just
//! handed over, for a minute at most, and only from the folder the handoff
//! writes to. Nothing here learns which app shared a file (AGENTS.md hard rule
//! 2), and nothing is sent anywhere: the files only go to a message box, and
//! the person sends them from there.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::ipc::Response;
use tauri::State;

use crate::dropped::{describe, DroppedFile};

/// How long after a share its files can still be asked for. The page asks as
/// soon as the app comes forward, so this only bounds a page that never does.
const FRESH: Duration = Duration::from_secs(60);

/// The files of the last share, and when they arrived. Only the newest share:
/// a second share replaces the first, and the first's files are deleted.
#[derive(Default)]
pub struct Shared(Mutex<Option<(Instant, Vec<PathBuf>)>>);

impl Shared {
    /// A share arrived: `paths` replace whatever was shared before. Only files
    /// directly inside `folder` are kept, the handoff's own folder; a path
    /// anywhere else is dropped here and never read. What was replaced is
    /// deleted, since nothing will ask for it now.
    pub fn note(&self, folder: &Path, paths: Vec<PathBuf>, now: Instant) {
        let kept: Vec<PathBuf> = paths
            .into_iter()
            .filter(|path| inside(folder, path))
            .collect();
        let before = self.held().replace((now, kept));
        if let Some((_, old)) = before {
            delete(&old);
        }
    }

    /// What was last shared, while it's fresh.
    fn paths(&self, now: Instant) -> Vec<PathBuf> {
        match &*self.held() {
            Some((at, paths)) if now.saturating_duration_since(*at) <= FRESH => paths.clone(),
            _ => Vec::new(),
        }
    }

    /// Forget the last share and delete its files.
    fn clear(&self) {
        if let Some((_, paths)) = self.held().take() {
            delete(&paths);
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, Option<(Instant, Vec<PathBuf>)>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Whether `path` is a file directly inside `folder`, once both are resolved,
/// so a `..` or a link out of the folder doesn't count.
fn inside(folder: &Path, path: &Path) -> bool {
    let (Ok(folder), Ok(path)) = (folder.canonicalize(), path.canonicalize()) else {
        return false;
    };
    path.parent() == Some(folder.as_path())
}

/// Delete shared files, whichever are still there.
fn delete(paths: &[PathBuf]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

/// What was last shared to Linger, in the order shared, with why any can't be
/// sent (the same words as a dropped file's).
#[tauri::command]
pub fn shared_files(shared: State<'_, Shared>) -> Vec<DroppedFile> {
    shared
        .paths(Instant::now())
        .iter()
        .map(|path| describe(path))
        .collect()
}

/// The bytes of the `index`th file last shared. Refused for a folder, a file
/// over the 500 MB a file can be, or one that's gone.
#[tauri::command]
pub async fn shared_file(shared: State<'_, Shared>, index: usize) -> Result<Response, String> {
    let paths = shared.paths(Instant::now());
    let path = paths.get(index).ok_or("nothing was shared")?.clone();
    if describe(&path).problem.is_some() {
        return Err("that can't be sent".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

/// The files are in a message box (or the person dropped them): forget them
/// and delete them from the phone.
#[tauri::command]
pub fn shared_done(shared: State<'_, Shared>) {
    shared.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("linger-shared-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).expect("a folder");
        folder
    }

    fn file(folder: &Path, name: &str) -> PathBuf {
        let path = folder.join(name);
        std::fs::write(&path, b"not really a picture").expect("a file");
        path
    }

    #[test]
    fn what_was_shared_can_be_asked_for_only_for_a_minute() {
        let inbox = folder("fresh");
        let photo = file(&inbox, "photo.png");
        let shared = Shared::default();
        let then = Instant::now();
        shared.note(&inbox, vec![photo.clone()], then);
        assert_eq!(shared.paths(then), [photo]);
        assert!(shared
            .paths(then + FRESH + Duration::from_secs(1))
            .is_empty());
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn a_path_outside_the_handoff_folder_is_never_kept() {
        let inbox = folder("inbox");
        let elsewhere = folder("elsewhere");
        let secret = file(&elsewhere, "secret.txt");
        let sneaky = inbox.join("..").join(elsewhere.file_name().expect("a name")).join("secret.txt");
        let shared = Shared::default();
        let then = Instant::now();
        shared.note(&inbox, vec![secret, sneaky, inbox.join("gone.png")], then);
        assert!(shared.paths(then).is_empty(), "outside, through .., or not there");
        let _ = std::fs::remove_dir_all(&inbox);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn a_new_share_replaces_and_deletes_the_last_one() {
        let inbox = folder("replace");
        let first = file(&inbox, "first.png");
        let second = file(&inbox, "second.png");
        let shared = Shared::default();
        let then = Instant::now();
        shared.note(&inbox, vec![first.clone()], then);
        shared.note(&inbox, vec![second.clone()], then);
        assert_eq!(shared.paths(then), [second.clone()]);
        assert!(!first.exists(), "the replaced share's file is deleted");
        assert!(second.exists());
        let _ = std::fs::remove_dir_all(&inbox);
    }

    #[test]
    fn done_forgets_the_share_and_deletes_its_files() {
        let inbox = folder("done");
        let photo = file(&inbox, "photo.png");
        let shared = Shared::default();
        let then = Instant::now();
        shared.note(&inbox, vec![photo.clone()], then);
        shared.clear();
        assert!(shared.paths(then).is_empty());
        assert!(!photo.exists());
        let _ = std::fs::remove_dir_all(&inbox);
    }
}
