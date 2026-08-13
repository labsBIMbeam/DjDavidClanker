/**
 * Matrix rain — the canonical 600B idle state, painted onto an empty deck
 * lane. Port of the repo's matrix.html: a glyph stream heavily weighted
 * toward '6', ember-orange on black, with the trail made of a translucent
 * black wash per step instead of per-glyph fading.
 *
 * Owns an offscreen canvas sized to the lane; `draw(g, w, h)` steps the
 * simulation at its own 42 ms cadence and blits — cheap enough to sit in
 * the global rAF loop only while a deck is empty.
 */
export function MatrixRain() {
  const GLYPHS = ['6', '0', '0', '0', '0', '0', '0', '0', '0'];
  let off = null;
  let ctx = null;
  let drops = [];
  let fontSize = 12;
  let last = 0;

  function reset(w, h) {
    off = document.createElement('canvas');
    off.width = Math.max(2, w);
    off.height = Math.max(2, h);
    ctx = off.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    fontSize = Math.max(8, h / 3.2);
    drops = new Array(Math.max(1, Math.floor(w / fontSize))).fill(0)
      .map(() => Math.floor(Math.random() * (h / fontSize)));
  }

  function step() {
    const { width: w, height: h } = off;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f90';
    ctx.font = `${fontSize}px Arial`;
    for (let i = 0; i < drops.length; i++) {
      const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      ctx.fillText(glyph, i * fontSize, drops[i] * fontSize);
      if (drops[i] * fontSize > h && Math.random() > 0.88) drops[i] = 0;
      drops[i]++;
    }
  }

  return {
    draw(g, w, h) {
      if (!off || off.width !== w || off.height !== h) reset(w, h);
      const now = performance.now();
      if (now - last > 42) {
        last = now;
        step();
      }
      g.drawImage(off, 0, 0);
    },
  };
}
