//! How this copy of Linger was installed, when a system package manager did it.
//!
//! The Arch package (#188) installs `share/linger/package-manager` next to the
//! program, holding the manager's name (`pacman`). A copy installed that way is
//! updated by the system — on Omarchy, its Update runs `pacman -Syu` — so the
//! in-app updater must not try to replace it: the program inside is the `.deb`'s,
//! stamped for Debian's installer, which an Arch system does not have.
//!
//! The marker sits beside the program rather than at a fixed path, so the same
//! build finds it wherever the package puts it, and a dev build or an AppImage,
//! which have no such file, is left alone.

use std::path::{Path, PathBuf};

/// Where the marker would be for a program at `exe`: `<prefix>/share/linger/`
/// for `<prefix>/bin/linger-client`.
pub fn marker_for(exe: &Path) -> Option<PathBuf> {
    let prefix = exe.parent()?.parent()?;
    Some(prefix.join("share/linger/package-manager"))
}

/// The package manager named by the marker at `path`, if there is one.
pub fn read_marker(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let name = text.lines().next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// The package manager that installed this running copy, if any.
pub fn package_manager() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    read_marker(&marker_for(&exe)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_marker_sits_beside_the_program() {
        assert_eq!(
            marker_for(Path::new("/usr/bin/linger-client")),
            Some(PathBuf::from("/usr/share/linger/package-manager"))
        );
    }

    #[test]
    fn a_marker_names_its_manager() {
        let dir = std::env::temp_dir().join(format!("linger-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("package-manager");
        assert_eq!(read_marker(&marker), None);
        std::fs::write(&marker, "pacman\n").unwrap();
        assert_eq!(read_marker(&marker).as_deref(), Some("pacman"));
        std::fs::write(&marker, "  \n").unwrap();
        assert_eq!(read_marker(&marker), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
