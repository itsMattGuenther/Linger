// Waiting on a packaged app's WebView2 in the Windows checks (#813).
//
// They waited by counting tries: 60 tries, a quarter of a second apart. A
// refused connection fails at once, so that was about 15 seconds, and a busy
// runner's first WebView2 start can take longer: the audio check gave up 17
// seconds after starting the app (#813). So the checks wait by the clock,
// and say how long it took, so a run shows how much room is left.

const SECOND = 1000;

/**
 * Try `attempt` until it gives something, or `within` milliseconds have
 * passed since the first try. `check` runs before each try, to fail at once
 * on what waiting won't mend, such as the app having exited. Gives what
 * `attempt` gave and how long it took; throws naming `what` and the last
 * error otherwise.
 */
export async function waitFor(what, attempt, {
  within = 90 * SECOND,
  every = SECOND / 4,
  check = () => {},
  now = () => performance.now(),
  sleep = (ms) => new Promise((settle) => setTimeout(settle, ms)),
} = {}) {
  const start = now();
  let last;
  for (;;) {
    check();
    try {
      const got = await attempt();
      if (got) return { got, took: now() - start };
    } catch (error) {
      last = error;
    }
    if (now() - start >= within) {
      const why = last ? `: ${last.message ?? last}` : "";
      throw new Error(`${what} within ${Math.round(within / SECOND)} s${why}`);
    }
    await sleep(every);
  }
}

/**
 * `waitFor`, for one app the check started: every wait first checks that the
 * app started and hasn't exited, and fails at once if it has. A wait for its
 * page once left that out, so an app that quit after WebView2 answered was
 * reported, 90 seconds later, as a page that never came (#814). `name` starts
 * the message: "Packaged app exited: 1".
 */
export function whileRunning(app, name, options = {}) {
  let launchError;
  app.on("error", (error) => { launchError = error; });
  const check = () => {
    if (launchError) throw launchError;
    if (app.exitCode !== null || app.signalCode) {
      throw new Error(`${name} app exited: ${app.exitCode ?? app.signalCode}`);
    }
  };
  return (what, attempt, more = {}) => waitFor(what, attempt, { ...options, ...more, check });
}

/** Seconds, for a log line: "4.2 s". */
export function seconds(ms) {
  return `${(ms / SECOND).toFixed(1)} s`;
}
