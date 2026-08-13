import { h } from './dom.js';
import logoUrl from '../assets/600.png';

/**
 * The record itself: a canvas-drawn disc with the album cover as its label.
 *
 * Two layers that behave differently on purpose:
 *
 *  - The disc — grooves, sheen, label, index marker — *rotates*, driven by the
 *    deck's real rate. Brake, backspin and hand-scratch all read directly off
 *    it, which is the whole point of having a platter you can look at.
 *  - The waveform ring — the whole track mapped around 360° — stays *still*,
 *    because a spinning waveform is unreadable. The needle marker at the top
 *    and the played arc show where you are.
 */
export function Platter(deck, { accent, size = 132 }) {
  const canvas = h('canvas', { class: 'platter-canvas' });
  const root = h('div', {
    class: 'platter',
    title: 'Vinyl: drag to scratch',
    style: { width: `${size}px`, height: `${size}px` },
  }, canvas);

  const COL = accent === 'a'
    ? { hot: '#f7931a', dim: '#6b3c0a', label: '#7a480d' }
    : { hot: '#f3c244', dim: '#6e5a17', label: '#7d661a' };

  let ringCache = null;
  let ringKey = '';

  // Wavedeck: the 600 logo IS the record label on every disc — the artwork
  // stays in the browser rows and the deck head. Inlined by the bundler, so
  // it loads instantly and never touches the network (CSP-safe).
  const label = new Image();
  label.src = logoUrl;

  /**
   * The unplayed waveform ring never changes for a given track, so it is
   * rendered once into an offscreen canvas and blitted.
   */
  function buildRing(px, dpr) {
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);

    const s = px / dpr;
    const mid = s / 2;
    const rOuter = mid - 3;
    const rInner = rOuter - Math.max(9, s * 0.11);
    const peaks = deck.peaks;

    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(mid, mid, (rOuter + rInner) / 2, 0, Math.PI * 2);
    g.stroke();

    if (peaks) {
      const sectors = 220;
      const n = peaks.length / 2;
      g.lineWidth = Math.max(1.2, (2 * Math.PI * rOuter) / sectors - 1);
      g.lineCap = 'butt';
      for (let i = 0; i < sectors; i++) {
        const idx = Math.floor((i / sectors) * n);
        const amp = Math.min(1, Math.abs(peaks[idx * 2 + 1] - peaks[idx * 2]) * 0.9);
        // Start at 12 o'clock and run clockwise, matching the needle marker.
        const a = (i / sectors) * Math.PI * 2 - Math.PI / 2;
        const len = (rOuter - rInner) * (0.15 + amp * 0.85);
        g.strokeStyle = COL.dim;
        g.beginPath();
        g.moveTo(mid + Math.cos(a) * rInner, mid + Math.sin(a) * rInner);
        g.lineTo(mid + Math.cos(a) * (rInner + len), mid + Math.sin(a) * (rInner + len));
        g.stroke();
      }
    }
    return c;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.floor(size * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      ringCache = null;
    }


    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    g.scale(dpr, dpr);

    const s = size;
    const mid = s / 2;
    const rOuter = mid - 3;
    const rRing = rOuter - Math.max(9, s * 0.11);
    const rDisc = rRing - 3;
    const rLabel = rDisc * 0.46;
    const angle = (deck.platterTurns % 1) * Math.PI * 2;

    /* --- vinyl body (rotates) --- */
    g.save();
    g.translate(mid, mid);
    g.rotate(angle);

    g.fillStyle = '#141110';
    g.beginPath();
    g.arc(0, 0, rDisc, 0, Math.PI * 2);
    g.fill();

    // Grooves. Spacing is deliberately not a whole number of pixels so the
    // rings shimmer as the disc turns instead of moiré-ing into a flat blur.
    g.strokeStyle = 'rgba(255,255,255,.045)';
    g.lineWidth = 1;
    for (let r = rLabel + 3; r < rDisc - 1; r += 2.7) {
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }

    // Sheen: one broad highlight sweeping across the vinyl.
    const sheen = g.createLinearGradient(-rDisc, -rDisc, rDisc, rDisc);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.42, 'rgba(255,255,255,.05)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,.09)');
    sheen.addColorStop(0.58, 'rgba(255,255,255,.05)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.beginPath();
    g.arc(0, 0, rDisc, 0, Math.PI * 2);
    g.fill();

    /* --- label --- */
    g.save();
    g.beginPath();
    g.arc(0, 0, rLabel, 0, Math.PI * 2);
    g.clip();
    if (label.complete && label.naturalWidth) {
      // Empty deck: the logo waits at 45% — calm until a record lands.
      g.globalAlpha = deck.track ? 1 : 0.45;
      g.drawImage(label, -rLabel, -rLabel, rLabel * 2, rLabel * 2);
      g.globalAlpha = 1;
      if (deck.track) {
        g.fillStyle = 'rgba(0,0,0,.1)';
        g.fillRect(-rLabel, -rLabel, rLabel * 2, rLabel * 2);
      }
    } else {
      const lg = g.createRadialGradient(-rLabel * 0.3, -rLabel * 0.35, 1, 0, 0, rLabel);
      lg.addColorStop(0, COL.hot);
      lg.addColorStop(1, COL.label);
      g.fillStyle = lg;
      g.fillRect(-rLabel, -rLabel, rLabel * 2, rLabel * 2);
    }
    g.restore();

    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(0, 0, rLabel, 0, Math.PI * 2);
    g.stroke();

    // Index stripe — the thing your eye actually tracks when it spins.
    g.fillStyle = deck.currentRate < -0.05 ? '#d93000' : '#fff7ec';
    g.fillRect(-1.5, -rDisc + 2, 3, rDisc - rLabel - 6);

    // Spindle hole.
    g.fillStyle = '#0a0908';
    g.beginPath();
    g.arc(0, 0, Math.max(2, s * 0.022), 0, Math.PI * 2);
    g.fill();

    g.restore();

    /* --- waveform ring (stationary) --- */
    const wantKey = `${deck.peaks ? deck.peaks.length : 0}|${px}`;
    if (!ringCache || ringKey !== wantKey) {
      ringCache = buildRing(px, dpr);
      ringKey = wantKey;
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(ringCache, 0, 0);
    g.scale(dpr, dpr);

    const progress = deck.duration ? Math.min(1, Math.max(0, deck.position / deck.duration)) : 0;

    // Played portion of the ring, redrawn hot over the dim base.
    if (deck.peaks && progress > 0) {
      const sectors = 220;
      const n = deck.peaks.length / 2;
      const upTo = Math.floor(sectors * progress);
      g.lineWidth = Math.max(1.2, (2 * Math.PI * rOuter) / sectors - 1);
      g.strokeStyle = COL.hot;
      for (let i = 0; i < upTo; i++) {
        const idx = Math.floor((i / sectors) * n);
        const amp = Math.min(1, Math.abs(deck.peaks[idx * 2 + 1] - deck.peaks[idx * 2]) * 0.9);
        const a = (i / sectors) * Math.PI * 2 - Math.PI / 2;
        const len = (rOuter - rRing) * (0.15 + amp * 0.85);
        g.beginPath();
        g.moveTo(mid + Math.cos(a) * rRing, mid + Math.sin(a) * rRing);
        g.lineTo(mid + Math.cos(a) * (rRing + len), mid + Math.sin(a) * (rRing + len));
        g.stroke();
      }
    }

    // Needle: fixed at 12 o'clock, the reference the ring is read against.
    const na = progress * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(mid + Math.cos(na) * (rRing - 2), mid + Math.sin(na) * (rRing - 2));
    g.lineTo(mid + Math.cos(na) * (rOuter + 2), mid + Math.sin(na) * (rOuter + 2));
    g.stroke();

    g.restore();
  }

  return { root, draw, invalidate: () => { ringCache = null; } };
}
