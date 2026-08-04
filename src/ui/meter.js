import { h } from './dom.js';

/**
 * Classic segmented level meter (the "LED chain"), horizontal or vertical.
 * Fire palette up to 0.72, bright to 0.9, everything above is the red
 * overshoot zone; the peak-hold tick and a clip latch make short overs
 * visible instead of flickering away between frames.
 */
export function LevelMeter(getLevel, { orient = 'h', length = 220, thickness = 14 } = {}) {
  const canvas = h('canvas', {
    class: `meter-canvas meter-${orient}`,
    width: orient === 'h' ? length : thickness,
    height: orient === 'h' ? thickness : length,
  });

  const SEGMENTS = 28;
  const OVER = 0.9; // overshoot threshold — everything above draws red
  let smooth = 0;
  let peak = 0;
  let peakAt = 0;
  let clipUntil = 0;

  function colorFor(frac) {
    if (frac >= OVER) return '#d93000';
    if (frac >= 0.72) return '#ffa733';
    return '#f7931a';
  }

  function draw() {
    // CSS is the single source of truth for the size: match the backing
    // buffer to the laid-out box so the segments stay crisp instead of being
    // scaled from the construction-time dimensions.
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = canvas.clientHeight || canvas.height;
    if (canvas.width !== cssW) canvas.width = cssW;
    if (canvas.height !== cssH) canvas.height = cssH;

    const level = Math.max(0, Math.min(1, getLevel() || 0));
    const now = performance.now();
    // Fast attack, slow release — classic meter ballistics.
    smooth = level > smooth ? level : smooth * 0.9 + level * 0.1;
    if (level >= peak || now - peakAt > 900) {
      peak = level;
      peakAt = now;
    }
    if (level >= OVER) clipUntil = now + 800;

    const g = canvas.getContext('2d');
    const w = canvas.width;
    const hgt = canvas.height;
    g.clearRect(0, 0, w, hgt);
    const along = orient === 'h' ? w : hgt;
    const seg = along / SEGMENTS;

    for (let i = 0; i < SEGMENTS; i++) {
      const frac = (i + 0.5) / SEGMENTS;
      const on = frac <= smooth;
      g.fillStyle = on ? colorFor(frac) : 'rgba(255,247,236,0.07)';
      if (orient === 'h') g.fillRect(i * seg + 1, 2, seg - 2, hgt - 4);
      else g.fillRect(2, hgt - (i + 1) * seg + 1, w - 4, seg - 2);
    }

    // Peak-hold tick.
    if (peak > 0.02) {
      g.fillStyle = colorFor(peak);
      if (orient === 'h') g.fillRect(Math.min(w - 2, peak * w) - 1, 0, 2, hgt);
      else g.fillRect(0, Math.max(1, hgt - peak * hgt) - 1, w, 2);
    }

    // Clip latch: the topmost segment stays red for a beat after an over.
    if (now < clipUntil) {
      g.fillStyle = '#d93000';
      if (orient === 'h') g.fillRect(w - seg + 1, 0, seg - 2, hgt);
      else g.fillRect(0, 0, w, seg - 1);
    }
  }

  return { canvas, draw };
}
