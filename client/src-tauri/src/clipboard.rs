//! The image on the clipboard, for pasting into the message box (#276).
//!
//! On Linux the page can't see it. WebKitGTK hands a page's paste event the
//! clipboard's words, markup and nothing else: with a screenshot, an image
//! viewer's Copy or a browser's Copy Image on the clipboard, the event's
//! `clipboardData` has no types, no items and no files (measured on
//! WebKitGTK 2.52.6; the async Clipboard API is refused too). So the chat
//! window's composer cancels a paste that carries no files, asks here, and
//! attaches what comes back through the same path as "Add a file", or puts the
//! paste's words in itself when there's no image
//! (`client/src/next/core/chat/paste.ts`).
//!
//! On Windows the page sees it: WebView2 is Chromium, whose paste event
//! carries a clipboard image as a file. There, and on macOS, this answers
//! nothing and the composer never asks.
//!
//! GTK is already in the build (Tauri's webview and windows are GTK on
//! Linux), so reading the clipboard costs no new code in the app: this asks
//! GTK for what the clipboard offers, then for the image, on the main thread
//! where GTK lives, and never blocks it. `capabilities/next-chat.json` and
//! `owner.json` grant it; `acl.rs` keeps it away from the other windows.

use tauri::ipc::Response;
use tauri::AppHandle;

/// Where the image is taken from, given what the clipboard offers.
#[derive(Debug, PartialEq, Eq)]
enum Source {
    /// A PNG as it is: what screenshot tools, browsers and GTK apps offer.
    /// Taken unchanged, so nothing is decoded or re-encoded.
    Png,
    /// Only another image format (BMP, JPEG, TIFF…): decoded by GTK and
    /// saved as a PNG, so the page always gets one kind of file.
    Decoded,
}

/// The format to read, from the clipboard's offered formats (MIME types and
/// X11 names such as `TARGETS`), or `None` when nothing offered is an image.
fn source(offered: &[impl AsRef<str>]) -> Option<Source> {
    let offered = || offered.iter().map(AsRef::as_ref);
    if offered().any(|format| format == "image/png") {
        Some(Source::Png)
    } else if offered().any(|format| format.starts_with("image/")) {
        Some(Source::Decoded)
    } else {
        None
    }
}

/// A PNG's first eight bytes. Anything else isn't handed to the page, so a
/// clipboard that says `image/png` and gives something else attaches nothing.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The bytes the page gets: a PNG, or nothing at all (never an empty or
/// broken file to attach).
fn only_png(bytes: Option<Vec<u8>>) -> Vec<u8> {
    bytes
        .filter(|bytes| bytes.starts_with(&PNG_SIGNATURE))
        .unwrap_or_default()
}

/// The image on the clipboard as a PNG's bytes, or no bytes when there's no
/// image (or on Windows and macOS, where the page's own paste event has it).
/// Raw bytes rather than JSON, since a screenshot runs to megabytes.
#[tauri::command]
pub async fn clipboard_image(app: AppHandle) -> Response {
    Response::new(only_png(read(&app).await))
}

#[cfg(target_os = "linux")]
async fn read(app: &AppHandle) -> Option<Vec<u8>> {
    use std::time::Duration;

    use gtk::gdk;

    // Past this the paste goes ahead with its words: a clipboard owner that
    // doesn't answer mustn't hold the box up. GTK gives up on its own after
    // longer than this.
    const PATIENCE: Duration = Duration::from_secs(3);

    let (answer, answered) = tokio::sync::oneshot::channel::<Option<Vec<u8>>>();
    app.run_on_main_thread(move || {
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        // What gtk_clipboard_request_targets does, which gtk-rs doesn't wrap.
        clipboard.request_contents(&gdk::Atom::intern("TARGETS"), move |clipboard, offer| {
            let offered: Vec<String> = offer
                .targets()
                .unwrap_or_default()
                .into_iter()
                .map(|format| format.name().to_string())
                .collect();
            match source(&offered) {
                None => {
                    let _ = answer.send(None);
                }
                Some(Source::Png) => {
                    clipboard.request_contents(&gdk::Atom::intern("image/png"), move |_, data| {
                        let _ = answer.send(Some(data.data()));
                    });
                }
                Some(Source::Decoded) => clipboard.request_image(move |_, image| {
                    let _ =
                        answer.send(image.and_then(|image| image.save_to_bufferv("png", &[]).ok()));
                }),
            }
        });
    })
    .ok()?;
    tokio::time::timeout(PATIENCE, answered).await.ok()?.ok()?
}

#[cfg(not(target_os = "linux"))]
async fn read(_app: &AppHandle) -> Option<Vec<u8>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_png_on_offer_is_taken_as_it_is() {
        // A screenshot through wl-copy, and a browser's Copy Image, which puts
        // the picture's address in words beside it.
        assert_eq!(source(&["TARGETS", "image/png"]), Some(Source::Png));
        assert_eq!(
            source(&[
                "text/html",
                "text/plain;charset=utf-8",
                "UTF8_STRING",
                "image/png"
            ]),
            Some(Source::Png)
        );
        // GTK's own Copy offers every format it can write, PNG among them.
        assert_eq!(
            source(&["image/bmp", "image/jpeg", "image/png", "image/tiff"]),
            Some(Source::Png)
        );
    }

    #[test]
    fn another_image_format_is_decoded() {
        assert_eq!(source(&["TARGETS", "image/bmp"]), Some(Source::Decoded));
        assert_eq!(source(&["image/jpeg"]), Some(Source::Decoded));
    }

    #[test]
    fn words_and_copied_files_are_not_an_image() {
        assert_eq!(
            source(&[
                "TARGETS",
                "UTF8_STRING",
                "text/plain",
                "text/plain;charset=utf-8"
            ]),
            None
        );
        assert_eq!(
            source(&["text/uri-list", "x-special/gnome-copied-files"]),
            None
        );
        let nothing: [&str; 0] = [];
        assert_eq!(source(&nothing), None);
    }

    #[test]
    fn the_page_gets_a_png_or_nothing() {
        let png = [PNG_SIGNATURE.as_slice(), b"rest of the picture"].concat();
        assert_eq!(only_png(Some(png.clone())), png);
        assert!(only_png(None).is_empty());
        assert!(only_png(Some(Vec::new())).is_empty());
        assert!(only_png(Some(b"GIF89a, not what was promised".to_vec())).is_empty());
    }
}
