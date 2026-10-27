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
    // Watching a shared screen (#360), asked first as the app asks
    // (lib/screen/shell.ts `shellPlays`): where WebKit draws on the CPU,
    // building a decoder aborts the page (#729), so the shell says no and
    // nothing is decoded. The harness checks the answer fits how it started
    // the app. Otherwise this engine's WebCodecs plays a real frame of each
    // format the app asks for, with the codec strings and settings the app
    // uses (lib/screen/presets.ts). VP8 is what every watcher must play;
    // H.264, what Windows sends, is said, and the harness requires it where
    // the package depends on its player. One 64×64 frame each, made with
    // ffmpeg: VP8 red, H.264 (Annex B, Constrained Baseline) blue.
    const shell = window.__TAURI_INTERNALS__;
    checks.watch = typeof shell?.invoke === "function" ? await shell.invoke("screen_watch_available").catch((error) => `no answer: ${error}`) : "no shell";
    if (checks.watch !== true) {
      checks.screens = null;
      return checks;
    }
    checks.screens = {
      vp8: await playsOne("vp8", "0AMAnQEqQABAAABHCIWFiIWEiAICAnWqA/gD+gIHGkZGAXDHSEvEAP79bvP/45k3MMT/jm3/8WE8DijI//FRAA==", [255, 0, 0]),
      avc1: await playsOne("avc1.42E02A", "AAAAAWdCwArZBCbARAAAAwAEAAADAMg8SJkgAAAAAWjLg8sgAAABBgX//23cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj0yNSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAWWIhArxGKAAJ6ccAAS+I4AAguycnJ1111111111114=", [0, 0, 255]),
    };
    if (checks.screens.vp8 !== "plays") throw new Error(`a shared screen in VP8 doesn't play here: ${checks.screens.vp8}`);
    return checks;
  };
  /** Play one key frame with WebCodecs and say what came out: "plays", or why not. */
  const playsOne = async (codec, base64, want) => {
    if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function") return "no WebCodecs";
    const config = { codec, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (!support.supported) return "not supported";
    const data = Uint8Array.from(atob(base64), (letter) => letter.charCodeAt(0));
    return new Promise((settle) => {
      const timer = setTimeout(() => settle("no picture within 10 s"), 10000);
      const decoder = new VideoDecoder({
        output: (frame) => {
          clearTimeout(timer);
          const canvas = document.createElement("canvas");
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          const context = canvas.getContext("2d");
          context.drawImage(frame, 0, 0);
          const pixel = [...context.getImageData(32, 32, 1, 1).data];
          frame.close();
          decoder.close();
          settle(want.every((value, at) => Math.abs(value - pixel[at]) < 40) ? "plays" : `the wrong colour, ${pixel}`);
        },
        error: (error) => {
          clearTimeout(timer);
          settle(`failed: ${error}`);
        },
      });
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data }));
      decoder.flush().catch(() => undefined);
    });
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
