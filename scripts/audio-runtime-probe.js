// Test-only code injected into a packaged WebView with an empty user profile.
// A realtime graph is essential: OfflineAudioContext does not open an output.
// The Linux runner connects only to its private, virtual PulseAudio sink.
(() => {
  window.__lingerAudioResult = { status: "pending" };
  const run = async () => {
    let context;
    try {
      context = new AudioContext();
      await Promise.race([
        context.resume(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Audio resume timed out")), 5000)),
      ]);
      if (context.state !== "running") throw new Error(`Audio state: ${context.state}`);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const analyser = context.createAnalyser();
      gain.gain.value = 0.02;
      oscillator.frequency.value = 440;
      oscillator.connect(gain).connect(analyser).connect(context.destination);
      const started = context.currentTime;
      oscillator.start();
      const samples = new Float32Array(analyser.fftSize);
      let peak = 0;
      // Opening the system output can take longer than one short chime on a
      // busy runner. Measure rendered audio time, not 500 ms of wall time.
      for (let i = 0; i < 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        analyser.getFloatTimeDomainData(samples);
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        if (context.currentTime - started >= 0.5 && peak >= 0.005) break;
      }
      oscillator.stop();
      const elapsed = context.currentTime - started;
      if (elapsed < 0.2 || peak < 0.005) {
        throw new Error(`No realtime audio: elapsed=${elapsed}, peak=${peak}`);
      }
      // Rendered samples can still be queued before the output device. Keep
      // the context open until the host records them and ends this disposable
      // process; closing here can discard the entire cue on a buffered sink.
      window.__lingerAudioResult = { status: "passed", elapsed, peak };
    } catch (error) {
      window.__lingerAudioResult = { status: "failed", error: String(error) };
      if (context) await context.close().catch(() => {});
    }
  };
  // Windows automation supplies a real click. Linux's test-only GTK module
  // disables gesture gating so this check isolates the packaged media runtime.
  const button = document.createElement("button");
  button.id = "linger-audio-probe";
  button.textContent = "Test packaged audio";
  button.onclick = () => { button.disabled = true; void run(); };
  document.body.replaceChildren(button);
})();
