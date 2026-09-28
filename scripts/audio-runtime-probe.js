// Test-only code bundled with the production player, then injected into an
// unchanged package with an empty profile. No account or microphone is used.
import { playKnock, playPreview, playSound } from "../client/src/lib/sound";

(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // In the app, Linger's sounds go to the shell, which plays them on the
  // chosen speakers (#250). This probe measures the webview's own audio, the
  // fallback when the shell can't. Its bundled Tauri API talks to this
  // stand-in bridge rather than the app's (build-audio-probe.mjs), and the
  // bridge says the shell couldn't play, so every cue goes through Web Audio.
  window.__LINGER_AUDIO_INTERNALS__ = {
    invoke: async (cmd) => {
      if (cmd === "sound_play") return false;
      throw new Error(`the audio probe has no ${cmd}`);
    },
  };
  const NativeContext = window.AudioContext;
  let context;
  let analyser;
  let stall = false;
  window.AudioContext = class extends NativeContext {
    constructor(...args) {
      super(...args);
      context = this;
      analyser = this.createAnalyser();
      analyser.fftSize = 32768;
      analyser.connect(this.destination);
      // Observe the real graph without replacing its output or waveform.
      const connect = AudioNode.prototype.connect;
      const destination = this.destination;
      const meter = analyser;
      for (const factory of ["createBufferSource", "createGain"]) {
        const create = this[factory].bind(this);
        this[factory] = () => {
          if (stall) {
            const until = performance.now() + 35;
            while (performance.now() < until) { /* controlled setup delay */ }
          }
          const node = create();
          node.connect = function(target, ...ports) {
            return connect.call(this, target === destination ? meter : target, ...ports);
          };
          return node;
        };
      }
    }
  };
  window.__lingerAudioResult = { status: "pending" };
  const run = async () => {
    try {
      const cues = [];
      // Knock goes first to exercise its startup as well as the warm player.
      // Both cues use Preview and the same entry point as received events.
      for (const cue of ["knock", "dm"]) {
        for (const scenario of ["first-preview", "repeat-preview", "delayed-preview", "live", "idle-preview"]) {
          const label = `${cue}-${scenario}`;
          stall = scenario === "delayed-preview" || scenario === "live";
          if (scenario === "idle-preview") await wait(2000);
          const played = scenario === "live"
            ? await (cue === "knock" ? playKnock() : playSound("dm"))
            : await playPreview(cue);
          if (!played) throw new Error(`${label} refused playback`);
          const samples = new Float32Array(analyser.fftSize);
          const started = context.currentTime;
          let peak = 0;
          let maxStep = 0;
          let taps;
          for (let i = 0; i < 100; i++) {
            await wait(20);
            analyser.getFloatTimeDomainData(samples);
            for (let j = samples.length - 2048; j < samples.length; j++) {
              peak = Math.max(peak, Math.abs(samples[j]));
              if (j) maxStep = Math.max(maxStep, Math.abs(samples[j] - samples[j - 1]));
            }
            const elapsed = context.currentTime - started;
            // At 500 ms this window contains the whole knock and no previous
            // cue. Preserve both audible spans, including their decay.
            if (cue === "knock" && taps === undefined && elapsed >= 0.5) {
              const spans = [];
              for (let j = 0; j < samples.length; j++) {
                if (Math.abs(samples[j]) <= 0.00001) continue;
                if (!spans.length || j - spans[spans.length - 1][1] > context.sampleRate * 0.02) spans.push([j, j]);
                else spans[spans.length - 1][1] = j;
              }
              taps = spans.map(([start, end]) => ({
                start: start / context.sampleRate,
                duration: (end - start) / context.sampleRate,
                peak: samples.slice(start, end + 1).reduce((peak, value) => Math.max(peak, Math.abs(value)), 0),
              }));
            }
            if (elapsed >= 0.8) break;
          }
          // A doubled graph or a click goes over these ceilings. The knock's are
          // twice the DM's because its level is (#252: taps 0.32 and 0.24,
          // steepest natural step about 0.009).
          const [topPeak, topStep] = cue === "knock" ? [0.4, 0.02] : [0.06, 0.01];
          if (peak < 0.01 || peak > topPeak || maxStep > topStep) {
            throw new Error(`${label} damaged or silent graph: peak=${peak}, step=${maxStep}`);
          }
          if (cue === "knock" && (taps?.length !== 2 ||
            Math.abs(taps[1].start - taps[0].start - 0.14) > 0.005 ||
            taps.some((tap) => tap.duration < 0.09 || tap.duration > 0.105 || tap.peak < 0.07))) {
            throw new Error(`${label} incomplete knock: ${JSON.stringify(taps)}`);
          }
          cues.push({ label, cue, peak, maxStep, taps, sampleRate: context.sampleRate });
        }
      }
      // Keep output open: samples may still be queued in the device backend.
      window.__lingerAudioResult = { status: "passed", cues };
    } catch (error) {
      window.__lingerAudioResult = { status: "failed", error: String(error) };
    }
  };
  const button = document.createElement("button");
  button.id = "linger-audio-probe";
  button.textContent = "Test packaged audio";
  button.onclick = () => { button.disabled = true; void run(); };
  document.body.replaceChildren(button);
})();
