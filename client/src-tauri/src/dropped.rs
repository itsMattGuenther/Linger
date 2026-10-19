//! Files dropped on a window, on Linux (#673, SPEC COMP-11).
//!
//! Everywhere else a dropped file reaches the page itself: Tauri's own drop
//! handling is off (`window.rs`), because on Windows it kept drops from the
//! page. WebKitGTK has stopped handing a page the files dropped on it: since
//! WebKit's 303828@main, `DataTransfer::allowsFileAccess()` is false on every
//! port but Apple's, so a drop arrives with no files (WebKit bugs 323277 and
//! 320301, open as of 2026-10-19). So on Linux Tauri takes the drop, which
//! also keeps the web view from opening the file in place of the app, and the
//! page asks for what was dropped: the paths of the last drop on its own
//! window, a minute at most, and nothing else. A page can't name a file to
//! read, so it can only ever have the files the person dropped on it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use linger_core::limits::MAX_FILE_BYTES;
use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

/// Whether this desktop's windows take dropped files through Tauri, for the
/// page to ask for (`window.rs`). Linux only: WebKitGTK hides them from the
/// page; WebView2 and Apple's WebKit hand them over.
pub const THROUGH_THE_SHELL: bool = cfg!(target_os = "linux");

/// How long after a drop its files can still be asked for: the page asks at
/// once, and this only bounds a page that never does.
const FRESH: Duration = Duration::from_secs(60);

/// The last drop on each window, by label.
#[derive(Default)]
pub struct Dropped(Mutex<HashMap<String, (Instant, Vec<PathBuf>)>>);

impl Dropped {
    /// A drop landed on `window`: it replaces whatever was dropped there before.
    pub fn note(&self, window: &str, paths: Vec<PathBuf>, now: Instant) {
        self.held().insert(window.to_owned(), (now, paths));
    }

    /// What was last dropped on `window`, while it's fresh.
    fn paths(&self, window: &str, now: Instant) -> Vec<PathBuf> {
        match self.held().get(window) {
            Some((at, paths)) if now.saturating_duration_since(*at) <= FRESH => paths.clone(),
            _ => Vec::new(),
        }
    }

    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, Vec<PathBuf>)>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One dropped file, as the page lists them before reading any.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DroppedFile {
    /// Its name, without the folders it's in.
    name: String,
    size: u64,
    /// Why it can't be sent, when it can't: `folder`, `too_big` or
    /// `unreadable`. The page says so in words.
    problem: Option<&'static str>,
}

/// What a path is, as a dropped file: its name and size, or why not.
fn describe(path: &std::path::Path) -> DroppedFile {
    let name = path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let (size, problem) = match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => (0, Some("folder")),
        Ok(meta) if !meta.is_file() => (0, Some("unreadable")),
        Ok(meta) if meta.len() > MAX_FILE_BYTES => (meta.len(), Some("too_big")),
        Ok(meta) => (meta.len(), None),
        Err(_) => (0, Some("unreadable")),
    };
    DroppedFile {
        name,
        size,
        problem,
    }
}

/// What was last dropped on the asking window, in the order dropped.
#[tauri::command]
pub fn dropped_files(window: tauri::Window, dropped: State<'_, Dropped>) -> Vec<DroppedFile> {
    dropped
        .paths(window.label(), Instant::now())
        .iter()
        .map(|path| describe(path))
        .collect()
}

/// The bytes of the `index`th file last dropped on the asking window. Refused
/// for a folder, a file over the 500 MB a file can be, or one that's gone.
#[tauri::command]
pub async fn dropped_file(
    window: tauri::Window,
    dropped: State<'_, Dropped>,
    index: usize,
) -> Result<Response, String> {
    let paths = dropped.paths(window.label(), Instant::now());
    let path = paths.get(index).ok_or("nothing was dropped there")?.clone();
    if describe(&path).problem.is_some() {
        return Err("that can't be sent".into());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_reads_only_its_own_last_drop_and_only_for_a_minute() {
        let dropped = Dropped::default();
        let then = Instant::now();
        dropped.note("main", vec![PathBuf::from("/tmp/a.png")], then);
        assert_eq!(dropped.paths("main", then), [PathBuf::from("/tmp/a.png")]);
        assert!(
            dropped.paths("chat-1", then).is_empty(),
            "another window's drop"
        );
        assert!(dropped
            .paths("main", then + FRESH + Duration::from_secs(1))
            .is_empty());
        dropped.note("main", vec![PathBuf::from("/tmp/b.png")], then);
        assert_eq!(
            dropped.paths("main", then),
            [PathBuf::from("/tmp/b.png")],
            "a new drop replaces the last"
        );
    }

    #[test]
    fn says_why_a_dropped_thing_cant_be_sent() {
        let folder = std::env::temp_dir().join(format!("linger-drop-{}", std::process::id()));
        std::fs::create_dir_all(&folder).expect("a folder");
        let file = folder.join("photo.png");
        std::fs::write(&file, b"not really a png").expect("a file");
        assert_eq!(
            describe(&file),
            DroppedFile {
                name: "photo.png".into(),
                size: 16,
                problem: None
            }
        );
        assert_eq!(describe(&folder).problem, Some("folder"));
        assert_eq!(
            describe(&folder.join("gone.png")).problem,
            Some("unreadable")
        );
        let _ = std::fs::remove_dir_all(&folder);
    }
}
