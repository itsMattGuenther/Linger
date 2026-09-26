// Test-only: injected into an unchanged packaged app with an empty profile,
// signed in nowhere, to prove the Buddy list client really starts there
// (T-1812): the list window's sign-in is drawn, with its stylesheet, fonts
// and title-bar mark, at every interface size, with nothing sideways. No
// account, server or microphone is used. It reports through the same
// `#linger-audio-probe` button and `__lingerAudioResult` the audio probe does,
// so the same harnesses carry it.
(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  window.__lingerAudioResult = { status: "pending" };
  const run = async () => {
    for (let tries = 0; tries < 400 && !document.querySelector("[data-screen='signin']"); tries++) await wait(50);
    const signin = document.querySelector("[data-screen='signin']");
    if (!signin) {
      throw new Error(`no sign-in screen at ${location.href}: ${(document.body?.innerText ?? "").slice(0, 200)}`);
    }
    const checks = { page: location.pathname };
    const background = getComputedStyle(signin).backgroundColor;
    if (background !== "rgb(19, 26, 40)") throw new Error(`the stylesheet isn't applied: background ${background}`);
    if (!signin.querySelector("input")) throw new Error("no box to paste into");
    const mark = document.querySelector(".nx-logomark");
    if (!mark || mark.getBoundingClientRect().width < 10) throw new Error("the title-bar mark isn't drawn");
    await document.fonts.ready;
    await document.fonts.load("12px 'Departure Mono'");
    if (!document.fonts.check("12px 'Departure Mono'")) throw new Error("the bundled label font didn't load");
    checks.fonts = [...new Set([...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family))];
    // Every interface size (Settings → Appearance), as a person would pick it.
    checks.sizes = [];
    for (const scale of [100, 110, 125, 150, 175, 200]) {
      document.documentElement.style.setProperty("zoom", `${scale}%`);
      await wait(120);
      const root = document.documentElement;
      if (root.scrollWidth > root.clientWidth + 1) throw new Error(`sideways overflow at ${scale}%: ${root.scrollWidth} > ${root.clientWidth}`);
      checks.sizes.push(scale);
    }
    document.documentElement.style.removeProperty("zoom");
    return checks;
  };
  const button = document.createElement("button");
  button.id = "linger-audio-probe";
  button.hidden = true;
  button.addEventListener("click", () => {
    run().then(
      (checks) => {
        window.__lingerAudioResult = { status: "passed", checks };
      },
      (error) => {
        window.__lingerAudioResult = { status: "failed", error: String(error) };
      },
    );
  });
  document.body.append(button);
})();
