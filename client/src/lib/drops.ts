/**
 * Files dropped on the window (COMP-11). Tauri's own drop handling is off
 * (`dragDropEnabled: false`, `disable_drag_drop_handler`), because on Windows
 * it keeps drops from ever reaching the page. With it off, a file dropped
 * anywhere that isn't a drop zone would make the WebView open the file in
 * place of the app, so the page refuses those itself. A drop zone (the
 * message box) accepts by cancelling `dragover` first, and this leaves it be.
 */
export function refuseStrayDrops(target: Window): () => void {
  const over = (event: DragEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const drop = (event: DragEvent) => event.preventDefault();
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => {
    target.removeEventListener("dragover", over);
    target.removeEventListener("drop", drop);
  };
}
