// Test-only code bundled with the production player, then injected into an
// unchanged package with an empty profile. No account or microphone is used.
import { playPreview, playSound } from "../client/src/lib/sound";

(() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const NativeContext = window.AudioContext;
  let context;
  let analyser;
  let stall = false;
  window.AudioContext = class extends NativeContext {
    constructor(...args) {
      super(...args);
      context = this;
      analyser = this.createAnalyser();
      analyser.fftSize = 2048;
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
      // Both public paths, first use, repetition, delayed setup and a quiet gap.
      // Keep the same cue so the virtual-speaker check can compare every onset.
      for (const label of ["cold-preview", "repeat-preview", "delayed-preview", "live-dm", "idle-preview"]) {
        stall = label === "delayed-preview" || label === "live-dm";
        if (label === "idle-preview") await wait(2000);
        const played = label === "live-dm" ? await playSound("dm") : await playPreview("dm");
        if (!played) throw new Error(`${label} refused playback`);
        const samples = new Float32Array(analyser.fftSize);
        const started = context.currentTime;
        let peak = 0;
        let maxStep = 0;
        for (let i = 0; i < 400; i++) {
          await wait(5);
          analyser.getFloatTimeDomainData(samples);
          for (let j = 0; j < samples.length; j++) {
            peak = Math.max(peak, Math.abs(samples[j]));
            if (j) maxStep = Math.max(maxStep, Math.abs(samples[j] - samples[j - 1]));
          }
          if (context.currentTime - started >= 0.8) break;
        }
        if (peak < 0.01 || peak > 0.06 || maxStep > 0.01) {
          throw new Error(`${label} damaged or silent graph: peak=${peak}, step=${maxStep}`);
        }
        cues.push({ label, peak, maxStep, sampleRate: context.sampleRate });
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
