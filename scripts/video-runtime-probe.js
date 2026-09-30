// Test-only code injected into an unchanged package with an empty profile:
// plays a shared video's kind of file, H.264 picture and AAC sound, through
// the WebView's own media stack (GStreamer on Linux). Without the libav
// decoders a video like this played silent, or not at all (#358).
// scripts/linux-audio-check.py --video fills in the clip and records the
// sound at a private virtual speaker.
(() => {
  const CLIP = "__LINGER_VIDEO_CLIP__";
  const TYPE = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
  window.__lingerAudioResult = { status: "pending" };
  const run = async () => {
    const support = document.createElement("video").canPlayType(TYPE);
    try {
      const bytes = Uint8Array.from(atob(CLIP), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.src = url;
      video.volume = 1;
      document.body.append(video);
      const ended = new Promise((resolve, reject) => {
        video.onended = resolve;
        video.onerror = () => reject(new Error(`the video failed: ${video.error?.code} ${video.error?.message ?? ""}`));
        setTimeout(() => reject(new Error("the video didn't finish within 10 seconds")), 10_000);
      });
      await video.play();
      await ended;
      // Whether its sound was heard is for the virtual speaker to say.
      window.__lingerAudioResult = { status: "passed", support, duration: video.duration, cues: [{ cue: "video", label: "h264-aac" }] };
    } catch (error) {
      window.__lingerAudioResult = { status: "failed", support, error: String(error) };
    }
  };
  const button = document.createElement("button");
  button.id = "linger-audio-probe";
  button.textContent = "Test packaged video";
  button.onclick = () => { button.disabled = true; void run(); };
  document.body.replaceChildren(button);
})();
