/**
 * Stage visualizer — ZapViz's viewer mechanics, ported to pure audio.
 *
 * The core is ZapViz's display loop: a CANVAS FEEDBACK LOOP (the previous
 * frame drawn back slightly zoomed/rotated and dimmed — trails for free)
 * whose strength rides an AUTO-DRIFT — the damped random walk with momentum
 * from ZapViz's viewer (accelerate a little, velocity *= 0.85, clamp, bounce
 * off soft bounds) — plus per-frame noise sparkles. On top of that loop a
 * small set of presets paints fresh material from the master analyser.
 *
 * Winamp rules: AUTOMODE ONLY. Presets rotate on a timer and on handovers;
 * there is no picker, no sliders. Lives behind the stage view, pointer-blind,
 * and stands down entirely under prefers-reduced-motion.
 */

const COLS = ['#f7931a', '#f3c244', '#ff6a00', '#ffa733'];
const PRESET_SECONDS = 30;

export function Visualizer(mixer) {
  const canvas = document.createElement('canvas');
  canvas.className = 'vis-canvas';
  const g = canvas.getContext('2d');

  // Offscreen copy for the feedback pass.
  const prev = document.createElement('canvas');
  const pg = prev.getContext('2d');

  let active = false;
  let w = 0;
  let hgt = 0;
  let preset = 0;
  let presetAt = 0;
  let phase = 0;
  const parts = []; // starburst particles

  const reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- ZapViz auto-drift: damped momentum walk inside soft bounds --- */
  const drift = { val: 40, vel: 0, min: 15, max: 65 };
  function driftStep() {
    const accel = (Math.random() - 0.5) * 1.6;
    drift.vel = drift.vel * 0.85 + accel;
    drift.vel = Math.max(-3, Math.min(3, drift.vel));
    drift.val += drift.vel;
    if (drift.val < drift.min) { drift.val = drift.min; drift.vel = Math.abs(drift.vel) * 0.5; }
    if (drift.val > drift.max) { drift.val = drift.max; drift.vel = -Math.abs(drift.vel) * 0.5; }
  }

  function size() {
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    if (w !== ww || hgt !== wh) {
      w = ww;
      hgt = wh;
      canvas.width = w; // dpr 1 on purpose — this is a beamer background
      canvas.height = hgt;
      prev.width = w;
      prev.height = hgt;
    }
  }

  const freq = new Uint8Array(1024);
  const wavef = new Uint8Array(1024);

  function audio() {
    const an = mixer.masterAnalyser;
    if (!an) return { bass: 0, mid: 0, ok: false };
    an.getByteFrequencyData(freq);
    an.getByteTimeDomainData(wavef);
    let bass = 0;
    for (let i = 1; i < 9; i++) bass += freq[i];
    let mid = 0;
    for (let i = 24; i < 96; i++) mid += freq[i];
    return { bass: bass / (8 * 255), mid: mid / (72 * 255), ok: true };
  }

  /* ------------------------------ presets ------------------------------ */

  function emberSpectrum(a) {
    const cx = w / 2;
    const cy = hgt / 2;
    const bars = 96;
    const base = Math.min(w, hgt) * 0.16;
    for (let i = 0; i < bars; i++) {
      const v = freq[Math.floor((i / bars) * 320)] / 255;
      const ang = (i / bars) * Math.PI * 2 + phase * 0.25;
      const len = base * 0.25 + v * Math.min(w, hgt) * 0.24;
      g.strokeStyle = COLS[i % COLS.length];
      g.globalAlpha = 0.25 + v * 0.75;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(ang) * base, cy + Math.sin(ang) * base);
      g.lineTo(cx + Math.cos(ang) * (base + len), cy + Math.sin(ang) * (base + len));
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  function oscRing(a) {
    const cx = w / 2;
    const cy = hgt / 2;
    const r = Math.min(w, hgt) * (0.22 + a.bass * 0.1);
    g.strokeStyle = '#f7931a';
    g.lineWidth = 2.5;
    g.globalAlpha = 0.9;
    g.beginPath();
    for (let i = 0; i <= 256; i++) {
      const s = (wavef[Math.floor((i / 256) * 1023)] - 128) / 128;
      const ang = (i / 256) * Math.PI * 2 + phase * 0.4;
      const rr = r + s * r * 0.55;
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.stroke();
    g.globalAlpha = 1;
  }

  let lastBurst = 0;
  function starburst(a, now) {
    if (a.bass > 0.5 && now - lastBurst > 240) {
      lastBurst = now;
      for (let i = 0; i < 26; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 7 * (0.6 + a.bass);
        parts.push({
          x: w / 2, y: hgt / 2,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          life: 1, col: COLS[(Math.random() * COLS.length) | 0],
        });
      }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.016;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      g.fillStyle = p.col;
      g.globalAlpha = p.life;
      g.fillRect(p.x, p.y, 3, 3);
    }
    g.globalAlpha = 1;
  }

  function tunnel(a) {
    // The zoom feedback does the tunnel; here just a rotating spectral rim.
    const cx = w / 2;
    const cy = hgt / 2;
    const r = Math.min(w, hgt) * 0.36;
    for (let i = 0; i < 48; i++) {
      const v = freq[8 + i * 4] / 255;
      const ang = (i / 48) * Math.PI * 2 + phase * 0.8;
      g.fillStyle = COLS[i % COLS.length];
      g.globalAlpha = 0.2 + v * 0.8;
      const s = 2 + v * 9;
      g.fillRect(cx + Math.cos(ang) * r - s / 2, cy + Math.sin(ang) * r - s / 2, s, s);
    }
    g.globalAlpha = 1;
  }

  function rainstorm(a) {
    // 600B rain, thickness riding the mids.
    const n = 6 + Math.floor(a.mid * 26);
    g.font = '16px "JetBrains Mono", monospace';
    for (let i = 0; i < n; i++) {
      g.fillStyle = Math.random() < 0.14 ? '#ffa733' : '#f90';
      g.globalAlpha = 0.25 + Math.random() * 0.6;
      g.fillText(Math.random() < 0.6 ? '6' : '0', Math.random() * w, Math.random() * hgt);
    }
    g.globalAlpha = 1;
  }

  const PRESETS = [emberSpectrum, oscRing, starburst, tunnel, rainstorm];

  /* ------------------------------- loop ------------------------------- */

  function tick(now) {
    if (!active || reduced) return;
    size();
    if (!w) return;
    const a = audio();
    phase += 0.016 + a.bass * 0.02;
    driftStep();

    // Feedback pass: last frame back in, slightly zoomed/rotated, dimmed.
    // drift.val (15..65) is the ZapViz knob: more drift = deeper trails.
    const k = drift.val / 100;
    pg.clearRect(0, 0, w, hgt);
    pg.drawImage(canvas, 0, 0);
    g.clearRect(0, 0, w, hgt);
    g.save();
    g.translate(w / 2, hgt / 2);
    const zoom = preset === 3 ? 1.035 : 1.006 + k * 0.02;
    g.scale(zoom, zoom);
    g.rotate((k - 0.4) * 0.012);
    g.globalAlpha = 0.86 + k * 0.1;
    g.drawImage(prev, -w / 2, -hgt / 2);
    g.restore();
    g.globalAlpha = 1;
    g.fillStyle = `rgba(13, 11, 9, ${0.16 - k * 0.1})`;
    g.fillRect(0, 0, w, hgt);

    // Per-frame noise sparkles (the ZapViz noise slider, audio-driven).
    const nn = Math.floor(2 + a.mid * 14);
    for (let i = 0; i < nn; i++) {
      g.fillStyle = 'rgba(255, 167, 51, 0.5)';
      g.fillRect(Math.random() * w, Math.random() * hgt, 2, 2);
    }

    PRESETS[preset](a, now);

    // Winamp automode: rotate presets on the clock.
    if (now - presetAt > PRESET_SECONDS * 1000) nextPreset(now);
  }

  function nextPreset(now) {
    let n = preset;
    while (n === preset) n = (Math.random() * PRESETS.length) | 0;
    preset = n;
    presetAt = now || performance.now();
    parts.length = 0;
  }

  return {
    canvas,
    tick,
    /** A handover is a scene change — cut to a fresh preset with it. */
    onTransition: () => nextPreset(),
    setActive(v) {
      active = Boolean(v) && !reduced;
      canvas.classList.toggle('show', active);
      if (active) {
        presetAt = performance.now();
        size();
        g.clearRect(0, 0, w, hgt);
      }
    },
    get active() { return active; },
  };
}
