//! How much room the disk under the data folder has: the export's check before
//! it builds (#504), the nightly copy's before it writes one, and the host's
//! "nearly full" line (#582).
//!
//! A full disk does not fail politely. SQLite cannot write its journal, and the
//! server stops for everybody, so the server looks before it adds anything
//! big, and tells the host while there is still time to do something.

use std::path::{Path, PathBuf};

/// The share of the disk that must be left free before the host is told it is
/// nearly full: a tenth, so "nearly full" means 90% used (#582).
pub const NEARLY_FULL_FREE_FRACTION: f64 = 0.10;

/// What the disk under a path has: the bytes this process may still use, and
/// the size of the whole disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Room {
    pub available: u64,
    pub total: u64,
}

impl Room {
    /// Less than a tenth left ([`NEARLY_FULL_FREE_FRACTION`]). A disk that
    /// says it has no size is not called full.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn nearly_full(self) -> bool {
        self.total > 0 && (self.available as f64) < (self.total as f64) * NEARLY_FULL_FREE_FRACTION
    }
}

/// The disk under `path`, or `None` where the platform can't say. Asked on a
/// blocking thread, since it is a filesystem call.
pub async fn room(path: PathBuf) -> Option<Room> {
    tokio::task::spawn_blocking(move || room_now(&path))
        .await
        .ok()
        .flatten()
}

/// Free bytes on the disk under `path` that this process may use, or `None`
/// where the platform can't say.
pub async fn free_bytes(path: PathBuf) -> Option<u64> {
    room(path).await.map(|room| room.available)
}

#[cfg(unix)]
fn room_now(path: &Path) -> Option<Room> {
    let disk = rustix::fs::statvfs(path).ok()?;
    Some(Room {
        available: disk.f_bavail.saturating_mul(disk.f_frsize),
        total: disk.f_blocks.saturating_mul(disk.f_frsize),
    })
}

/// The published server is Linux only; elsewhere it builds for development
/// and does without the checks.
#[cfg(not(unix))]
fn room_now(_path: &Path) -> Option<Room> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearly_full_is_less_than_a_tenth_left() {
        let room = |available, total| Room { available, total };
        assert!(!room(100, 1000).nearly_full());
        assert!(room(99, 1000).nearly_full());
        assert!(room(0, 1000).nearly_full());
        assert!(
            !room(0, 0).nearly_full(),
            "a disk with no size isn't called full"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_disk_under_a_folder_has_a_size() {
        let dir = tempfile::tempdir().unwrap();
        let room = room(dir.path().to_path_buf()).await.unwrap();
        assert!(room.total > 0);
        assert!(room.available <= room.total);
    }
}
