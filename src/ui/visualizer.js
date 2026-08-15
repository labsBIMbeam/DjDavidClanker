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

import logoUrl from '../assets/600.png';

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

  /* --- the 600 head: source image + flat RGB tints for chromatic splits --- */
  const logo = new Image();
  let logoReady = false;
  const logoTints = []; // [red, blue] ghost copies, built once on load
  logo.onload = () => {
    const side = 256;
    const ratio = logo.height / logo.width;
    for (const col of ['#ff2a1a', '#2a6aff']) {
      const c = document.createElement('canvas');
      c.width = side;
      c.height = Math.round(side * ratio);
      const cg = c.getContext('2d');
      cg.drawImage(logo, 0, 0, c.width, c.height);
      cg.globalCompositeOperation = 'source-atop';
      cg.globalAlpha = 0.85;
      cg.fillStyle = col;
      cg.fillRect(0, 0, c.width, c.height);
      logoTints.push(c);
    }
    logoReady = true;
  };
  logo.src = logoUrl;

  /** The head, anywhere: rotated, faded, optionally torn into RGB ghosts. */
  function drawLogo(x, y, size, ang = 0, alpha = 1, split = 0) {
    if (!logoReady || size < 4) return;
    const h2 = size * (logo.height / logo.width);
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    if (split > 0.5) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = alpha * 0.7;
      g.drawImage(logoTints[0], -size / 2 - split, -h2 / 2, size, h2);
      g.drawImage(logoTints[1], -size / 2 + split, -h2 / 2, size, h2);
      g.globalCompositeOperation = 'source-over';
    }
    g.globalAlpha = alpha;
    g.drawImage(logo, -size / 2, -h2 / 2, size, h2);
    g.restore();
    g.globalAlpha = 1;
  }

  /* --- beat clock off the audible deck: pumps and slams lock to the GRID,
     not to an energy threshold — that is what makes it ridiculous IN TIME --- */
  let lastBeatIdx = null;
  let beatPump = 0; // feedback-zoom kick, every beat
  let slam = 0; // giant logo slam, every bar-1
  let slamAng = 0;
  function beatClock() {
    let best = null;
    for (const id of ['A', 'B']) {
      const d = mixer.decks[id];
      if (!d || !d.playing || !d.bpm) continue;
      const lvl = d.level ? d.level() : 0;
      if (!best || lvl > best.lvl) best = { d, lvl };
    }
    if (!best) { lastBeatIdx = null; return; }
    const d = best.d;
    const beat = 60 / d.bpm;
    const anchor = Number.isFinite(d.barOffset) ? d.barOffset : (d.beatOffset || 0);
    const idx = Math.floor((d.position - anchor) / beat);
    if (idx !== lastBeatIdx) {
      const fresh = lastBeatIdx !== null;
      lastBeatIdx = idx;
      if (fresh) {
        beatPump = 1;
        if (((idx % 4) + 4) % 4 === 0) {
          slam = 1;
          slamAng = (Math.random() - 0.5) * 0.6;
        }
      }
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
    // The head breathes with the kick inside the spectral crown.
    drawLogo(cx, cy, base * 1.6 * (1 + a.bass * 0.5), Math.sin(phase * 0.5) * 0.14,
      0.95, a.bass > 0.55 ? 2 + a.bass * 5 : 0);
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
    // Three heads orbit the scope ring, leaning into their orbit.
    for (let i = 0; i < 3; i++) {
      const ang = phase * 0.55 + (i * Math.PI * 2) / 3;
      drawLogo(cx + Math.cos(ang) * r * 1.45, cy + Math.sin(ang) * r * 1.45,
        44 + a.bass * 40, ang + Math.PI / 2, 0.85);
    }
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
          head: Math.random() < 0.3, // some sparks are 600 confetti
          spin: (Math.random() - 0.5) * 8,
        });
      }
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.016;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      if (p.head) {
        drawLogo(p.x, p.y, 16 + p.life * 20, p.life * p.spin, p.life);
        continue;
      }
      g.fillStyle = p.col;
      g.globalAlpha = p.life;
      g.fillRect(p.x, p.y, 3, 3);
    }
    g.globalAlpha = 1;
  }

  function tunnel(a) {
    // The zoom feedback does the tunnel; a fresh head every frame turns it
    // into an infinite 600 corridor. A rotating spectral rim frames it.
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
    drawLogo(cx, cy, Math.min(w, hgt) * 0.2 * (1 + a.bass * 0.6),
      Math.sin(phase * 0.35) * 0.5, 0.9, a.bass > 0.5 ? 2 + a.bass * 6 : 0);
  }

  function rainstorm(a) {
    // 600B rain, thickness riding the mids — with the head itself raining in.
    const n = 6 + Math.floor(a.mid * 26);
    g.font = '16px "JetBrains Mono", monospace';
    for (let i = 0; i < n; i++) {
      g.fillStyle = Math.random() < 0.14 ? '#ffa733' : '#f90';
      g.globalAlpha = 0.25 + Math.random() * 0.6;
      g.fillText(Math.random() < 0.6 ? '6' : '0', Math.random() * w, Math.random() * hgt);
    }
    g.globalAlpha = 1;
    if (Math.random() < 0.05 + a.bass * 0.1) {
      drawLogo(Math.random() * w, Math.random() * hgt, 22 + Math.random() * 26,
        (Math.random() - 0.5) * 1.2, 0.75);
    }
  }

  function logoStorm(a) {
    // Seven heads on interleaved orbits — the feedback loop drags their
    // trails into orange spaghetti. Pure ridiculousness, on purpose.
    const cx = w / 2;
    const cy = hgt / 2;
    const m = Math.min(w, hgt);
    for (let i = 0; i < 7; i++) {
      const sp = 0.3 + i * 0.13;
      const ang = phase * sp + i * 0.9;
      const r = (0.12 + 0.05 * i) * m * (1 + a.bass * 0.25);
      drawLogo(cx + Math.cos(ang) * r, cy + Math.sin(ang * 1.3) * r * 0.8,
        34 + a.mid * 70 + i * 6, ang * 2, 0.8, a.bass > 0.5 ? 2 : 0);
    }
  }

  const PRESETS = [emberSpectrum, oscRing, starburst, tunnel, rainstorm, logoStorm];

  /* ------------------------------- loop ------------------------------- */

  function tick(now) {
    if (!active || reduced) return;
    size();
    if (!w) return;
    const a = audio();
    phase += 0.016 + a.bass * 0.02;
    driftStep();
    beatClock();

    // Feedback pass: last frame back in, slightly zoomed/rotated, dimmed.
    // drift.val (15..65) is the ZapViz knob: more drift = deeper trails.
    // beatPump rides on top: the whole feedback BREATHES on the grid.
    const k = drift.val / 100;
    pg.clearRect(0, 0, w, hgt);
    pg.drawImage(canvas, 0, 0);
    g.clearRect(0, 0, w, hgt);
    g.save();
    g.translate(w / 2, hgt / 2);
    const zoom = (preset === 3 ? 1.035 : 1.006 + k * 0.02) + beatPump * 0.022;
    g.scale(zoom, zoom);
    g.rotate((k - 0.4) * 0.012 + beatPump * 0.004);
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

    // Bar-1 slam: the 600 head fills the frame, torn into RGB ghosts, with a
    // shockwave ring flying out — then the feedback loop eats the corpse.
    if (slam > 0.02 && logoReady) {
      const m = Math.min(w, hgt);
      drawLogo(w / 2, hgt / 2, m * (0.5 + (1 - slam) * 0.55), slamAng * slam,
        slam * 0.85, 3 + a.bass * 9);
      g.strokeStyle = `rgba(247, 147, 26, ${slam * 0.7})`;
      g.lineWidth = 3 + slam * 6;
      g.beginPath();
      g.arc(w / 2, hgt / 2, (1 - slam) * m * 0.75 + 8, 0, Math.PI * 2);
      g.stroke();
    }
    slam *= 0.92;
    beatPump *= 0.86;

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
    /**
     * `v` gates DRAWING, `show` gates the on-page canvas. The pop-out window
     * needs frames without the desk showing them (captureStream reads the
     * bitmap, layout does not matter) — so drawing may run with show=false.
     */
    setActive(v, { show } = {}) {
      active = Boolean(v) && !reduced;
      canvas.classList.toggle('show', active && (show === undefined || Boolean(show)));
      if (active) {
        presetAt = performance.now();
        size();
        g.clearRect(0, 0, w, hgt);
      }
    },
    get active() { return active; },
    get logoReady() { return logoReady; },
  };
}
