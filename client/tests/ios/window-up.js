// Run by share-photo.yaml while it waits for the share window: whether iOS
// has put it in place, as scripts/share-window-ready.mjs reads iOS's log, in
// `output.windowUp` (#839). Maestro can't see inside the window itself.
const answer = http.get(WINDOW_READY);
if (answer.status !== 200) throw new Error("share-window-ready: " + answer.status + " " + answer.body);
output.windowUp = answer.body === "up";
