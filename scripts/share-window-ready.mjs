// Whether Linger's share window is on screen yet, for share-photo.yaml in the
// iPhone simulator (#839).
//
// Maestro can't see inside the share window: it runs in a process of its own,
// and Maestro reads the screen through the app in front, Photos. The flow
// used to give the window 6 seconds. Its first start took 3.5 seconds to
// begin and 7 to be in place on iOS 26.5, and 33 and 42 on iOS 27.0 (run
// 41857567919), so every tap landed on the empty sheet iOS shows meanwhile.
// iOS logs a line when it puts the window's view in place, and the workflow
// keeps the simulator's log (`app.log`), so this answers over http on
// 127.0.0.1, where Maestro's scripts can ask (window-up.js), and the flow
// waits for the window itself, not a length of time.
//
// Usage: node scripts/share-window-ready.mjs <app.log> <port>
//   GET / answers "up" or "not yet"; 500 when it can't read the log.
//   Prints "listening" once it's ready for questions.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * iOS's line, from the share window's own process, once the window's view
 * controller is in the hierarchy the sheet shows. Written the same on iOS
 * 26.5 and 27.0. The flows share once a run, so any such line is this share.
 */
const INSTALLED = /\bLingerShare\[\d+:[0-9a-f]+\].*Installed materialized view controller in hierarchy: <ShareViewController\b/;

/** Whether the simulator's log says the share window is in place. */
export function windowUp(log) {
  return log.split("\n").some((line) => INSTALLED.test(line));
}

/** The http server: reads the log afresh for every question. */
export function server(file) {
  return createServer((request, response) => {
    let log;
    try {
      log = readFileSync(file, "utf8");
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(`can't read ${file}: ${error.message}`);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end(windowUp(log) ? "up" : "not yet");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, port] = process.argv.slice(2);
  if (!file || !/^\d+$/.test(port ?? "")) {
    console.error("usage: node scripts/share-window-ready.mjs <app.log> <port>");
    process.exit(2);
  }
  server(file).listen(Number(port), "127.0.0.1", () => console.log("listening"));
}
