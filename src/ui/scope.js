import { h } from './dom.js';

/**
 * Live sound-wave display fed straight from an AnalyserNode.
 *
 * Three looks off the same data:
 *   wave   time-domain trace — what the signal actually is
 *   mirror the same trace mirrored around the centre, filled; reads as a
 *          classic "sound wave" and survives being glanced at
 *   bars   frequency bars — useful for spotting where the mix is crowded
 */
export function Scope(getAnalyser, { height = 56, mode = 'mirror', colors = ['#3fe0c8', '#ff9d3f'] } = {}) {
  const canvas = h('canvas', { class: 'scope-canvas', height: String(height) });
  const root = h('div', { class: 'scope', style: { height: `${height}px` } }, canvas);

  let current = mode;
  let time = null;
  let freq = null;

  const btn = h('button', {
    class: 'btn btn-mini scope-mode',
    title: 'Darstellung wechseln',
    onclick: () => {
      current = current === 'mirror' ? 'wave' : current === 'wave' ? 'bars' : 'mirror';
      btn.textContent = current.toUpperCase();
    },
  }, current.toUpperCase());
  root.appendChild(btn);

  function draw() {
    const analyser = getAnalyser();
    const dpr = window.devicePixelRatio || 1;
    const w = root.clientWidth || 400;
    if (canvas.width !== Math.floor(w * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
    }
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.scale(dpr, dpr);

    const mid = height / 2;
    g.strokeStyle = 'rgba(255,255,255,.06)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();

    if (!analyser) return;

    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, colors[0]);
    grad.addColorStop(1, colors[1]);

    if (current === 'bars') {
      if (!freq || freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(freq);
      // Log-ish binning: linear FFT bins give almost all the width to treble.
      const bars = Math.min(72, Math.floor(w / 6));
      const bw = w / bars;
      g.fillStyle = grad;
      for (let i = 0; i < bars; i++) {
        const lo = Math.floor(Math.pow(i / bars, 2) * freq.length);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 2) * freq.length));
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += freq[j];
        const v = sum / (hi - lo) / 255;
        const bh = Math.max(1, v * height * 0.92);
        g.fillRect(i * bw + 1, height - bh, bw - 2, bh);
      }
      return;
    }

    if (!time || time.length !== analyser.fftSize) time = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(time);
    const step = Math.max(1, Math.floor(time.length / w));

    if (current === 'wave') {
      g.strokeStyle = grad;
      g.lineWidth = 1.6;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const v = time[Math.min(time.length - 1, x * step)];
        const y = mid - v * mid * 0.92;
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      return;
    }

    // mirror: envelope of |v| per column, filled both ways from the centre.
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, mid);
    const peaks = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let peak = 0;
      const base = x * step;
      for (let i = 0; i < step; i += 2) {
        const v = Math.abs(time[Math.min(time.length - 1, base + i)]);
        if (v > peak) peak = v;
      }
      peaks[x] = peak;
    }
    for (let x = 0; x < w; x++) g.lineTo(x, mid - peaks[x] * mid * 0.92);
    for (let x = w - 1; x >= 0; x--) g.lineTo(x, mid + peaks[x] * mid * 0.92);
    g.closePath();
    g.fill();
  }

  return { root, draw, setMode: (m) => { current = m; btn.textContent = m.toUpperCase(); } };
}
