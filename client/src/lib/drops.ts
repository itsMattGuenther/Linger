/**
 * Files dropped on the window (COMP-11). Tauri's own drop handling is off
 * (`dragDropEnabled: false`, `disable_drag_drop_handler`), because on Windows
 * it keeps drops from ever reaching the page. With it off, a file dropped
 * anywhere that isn't a drop zone would make the WebView open the file in
 * place of the app, so the page refuses those itself. A drop zone (the
 * message box) accepts by cancelling `dragover` first, and this leaves it be.
 * Text and links dragged into a text box aren't files, and go on as ever.
 */
export function refuseStrayDrops(target: Window): () => void {
  // Only files: text or a link dragged into a text box is the box's to take,
  // and it takes them without any script.
  const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
  const over = (event: DragEvent) => {
    if (event.defaultPrevented || !files(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const drop = (event: DragEvent) => {
    if (files(event)) event.preventDefault();
  };
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => {
    target.removeEventListener("dragover", over);
    target.removeEventListener("drop", drop);
  };
}
