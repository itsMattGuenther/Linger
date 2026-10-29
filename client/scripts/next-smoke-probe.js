// Test-only: injected into an unchanged packaged app with an empty profile,
// signed in nowhere, to prove the Buddy list client really starts there
// (T-1812): the list window's sign-in is drawn, with its stylesheet, fonts
// and title-bar mark, at every interface size, with nothing sideways. No
// account, server or microphone is used. It reports through the same
// `#linger-audio-probe` button and `__lingerAudioResult` the audio probe does,
// so the same harnesses carry it.
(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** The chat video (#756): one second of rgb(230, 39, 149), H.264 High in MP4, 320×180, made with ffmpeg's libx264. */
  const CHAT_VIDEO =
    "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAQ3bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA4Z0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAUAAAAC0AAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAEAAABAAAAAAL+bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAPABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACqW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAmlzdGJsAAAAwXN0c2QAAAAAAAAAAQAAALFhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAUAAtABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAN2F2Y0MBZAAe/+EAGmdkAB6s2UFBn58BEAAAAwAQAAADA8DxYtlgAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAACaAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAeAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAuGN0dHMAAAAAAAAAFQAAAAEAAAQAAAAAAQAACAAAAAACAAACAAAAAAEAAAgAAAAAAgAAAgAAAAABAAAIAAAAAAIAAAIAAAAAAQAACAAAAAACAAACAAAAAAEAAAgAAAAAAgAAAgAAAAABAAAIAAAAAAIAAAIAAAAAAQAACAAAAAACAAACAAAAAAEAAAgAAAAAAgAAAgAAAAABAAAIAAAAAAIAAAIAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAHgAAAAEAAACMc3RzegAAAAAAAAAAAAAAHgAAAvIAAAAQAAAADQAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAWAAAADwAAAA0AAAAXAAAADQAAABRzdGNvAAAAAAAAAAEAAARnAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAE2G1kYXQAAAKsBgX//6jcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIyIGIzNTYwNWEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9NiBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTIgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MzAga2V5aW50X21pbj0zIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9MzAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAPmWIhAA3//7hA/gUtrnmJqYE+9DlcuRtxKXTNnzkBiPXQVxBGAAJZTkDZ2geVuIPgEqAAASgNaNNhqpyT1thAAAADEGaI2xDf/6nhAAD/AAAAAlBnkF4hX8AA1MAAAAJAZ5iakJ/AAQ8AAAAEkGaZkmoQWiZTAhv//6nhAAD/QAAAAtBnoRFESwr/wADUwAAAAkBnqVqQn8ABD0AAAASQZqpSahBbJlMCG///qeEAAP9AAAAC0Gex0UVLCv/AANSAAAACQGe6GpCfwAEPAAAABJBmuxJqEFsmUwIb//+p4QAA/0AAAALQZ8KRRUsK/8AA1IAAAAJAZ8rakJ/AAQ8AAAAEkGbL0moQWyZTAhv//6nhAAD/QAAAAtBn01FFSwr/wADUwAAAAkBn25qQn8ABD0AAAASQZtySahBbJlMCG///qeEAAP8AAAAC0GfkEUVLCv/AANSAAAACQGfsWpCfwAEPQAAABJBm7VJqEFsmUwIZ//+nhAAD5gAAAALQZ/TRRUsK/8AA1IAAAAJAZ/0akJ/AAQ9AAAAEkGb+EmoQWyZTAhn//6eEAAPmAAAAAtBnhZFFSwr/wADUwAAAAkBnjdqQn8ABD0AAAASQZo7SahBbJlMCF///oywAA+4AAAAC0GeWUUVLCv/AANTAAAACQGeempCfwAEPAAAABNBmn1JqEFsmUwUTCf//fEAAJeBAAAACQGenGpCfwAEPQ==";
  /** A voice message as the app records one (#401): one second of a 440 Hz tone, Opus in WebM, made with ffmpeg. */
  const VOICE_MESSAGE =
    "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";
  /** A sound file somebody shared: one second of a 440 Hz tone, MP3, made with ffmpeg's LAME. */
  const SOUND_FILE =
    "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gEFgDTAEIThP4DaY7jHQRjDICgICRgYBRgYAS7OKgAAS2220Wi0WiAAAAAaN9QBSwrg9uIjTXicF//sSxJADxPQfGA37QmCdBCNBr2hIKAhiZKepAqEsk94Eg6hALNj/HeQo74POe3/y80o4nNOi//z7xAQaM9KaFmABwAaDqPUI6GCcKmOU0TpcVMcyiuwgQU2Cm4gvhTwo7xXQX+VMQU1F//sQxJKDxFwfHg17ImiNhCOBr2RMNC4wVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xLEmIPEoCEaDXtCaJ6D4wGvaEhVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/+xDEnAAERB0qFdAAKRGRLDcesAJVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7EsSSA8S0Juwc8QAIAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVQ==";
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
    // A video somebody shared in a conversation (#756): an H.264 MP4 played
    // in a <video> element, as a chat shows one, then what's on its picture,
    // read back. It goes through WebKit's own video player, not WebCodecs,
    // so it's a different road from a shared screen's: 0.5.3 broke it on
    // NVIDIA (solid green) while shared screens played. One second of one
    // colour, 320×180, made with ffmpeg the way phones and sites make
    // video: H.264 High, 4:2:0, 8-bit, with B-frames.
    checks.video = await chatVideo(CHAT_VIDEO, [230, 39, 149]);
    // A voice message and a sound file in a conversation go through the same
    // player, and its decoders, as a chat's video (#756): each must play,
    // its time moving on.
    checks.sounds = { voice: await playsSound(VOICE_MESSAGE, "audio/webm"), file: await playsSound(SOUND_FILE, "audio/mpeg") };
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
  /**
   * Play an MP4 in a <video> element on the page, as a conversation does, and
   * say what's on its picture once it's playing: "plays", or why not. Looked
   * at several times over two seconds, since the first frame drawn can come
   * before the player has the picture.
   */
  const chatVideo = async (base64, want) => {
    const data = Uint8Array.from(atob(base64), (letter) => letter.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));
    const video = document.createElement("video");
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.src = url;
    video.style.cssText = "position: fixed; left: 0; top: 0; width: 320px; height: 180px";
    document.body.append(video);
    try {
      const started = await Promise.race([video.play().then(() => "playing", (error) => `didn't play: ${error}`), wait(10000).then(() => "didn't start within 10 s")]);
      if (started !== "playing") return started;
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      let pixel = null;
      for (let look = 0; look < 20; look++) {
        await wait(100);
        if (video.readyState < 2) continue;
        context.drawImage(video, 0, 0, 320, 180);
        pixel = [...context.getImageData(160, 90, 1, 1).data];
        if (want.every((value, at) => Math.abs(value - pixel[at]) < 40)) return "plays";
      }
      return pixel === null ? `no picture within 2 s (readyState ${video.readyState})` : `the wrong colour, ${pixel}`;
    } finally {
      video.pause();
      video.remove();
      URL.revokeObjectURL(url);
    }
  };
  /** Play a sound in an <audio> element, as a conversation does, muted: "plays" once its time moves on, or why not. */
  const playsSound = async (base64, type) => {
    const data = Uint8Array.from(atob(base64), (letter) => letter.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([data], { type }));
    const audio = document.createElement("audio");
    audio.muted = true;
    audio.src = url;
    document.body.append(audio);
    try {
      const started = await Promise.race([audio.play().then(() => "playing", (error) => `didn't play: ${error}`), wait(10000).then(() => "didn't start within 10 s")]);
      if (started !== "playing") return started;
      for (let look = 0; look < 50; look++) {
        if (audio.error) return `failed: ${audio.error.message || audio.error.code}`;
        if (audio.currentTime >= 0.3) return "plays";
        await wait(100);
      }
      return `stuck at ${audio.currentTime} s`;
    } finally {
      audio.pause();
      audio.remove();
      URL.revokeObjectURL(url);
    }
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
