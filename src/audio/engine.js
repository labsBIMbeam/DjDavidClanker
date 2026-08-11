/**
 * Two-deck DJ engine.
 *
 * Two playback backends, chosen per load and hidden behind one Deck API:
 *
 *  buffer  — the track was decoded into an AudioBuffer, so we get the full
 *            chain: trim, 3-band EQ, filter sweep, insert FX, waveform, VU,
 *            BPM detect, sample-accurate cueing, and everything vinyl-like
 *            (scratch, brake, backspin). Requires the raw bytes, which in a
 *            shell come from `resource.bytes`.
 *
 *  element — plain <audio>. Crossfade via element volume, tempo via
 *            playbackRate. No EQ/filter/FX/waveform/scratch. Fallback for a
 *            standalone tab, where Wavlake's CDN sends no CORS headers.
 *
 * Transport inside the buffer backend runs in one of three modes:
 *
 *   idle     nothing sounding
 *   source   one long AudioBufferSourceNode — the steady state
 *   platter  the granular Turntable — scratching, braking, spin-up, backspin
 *
 * The deck moves between `source` and `platter` transparently; `position` and
 * `currentRate` read correctly in all three.
 */

import { fetchBlob } from '../lib/nap.js';
import { detectBpm, waveformPeaks, rms, analyzeStructure, detectKey, keyObject } from './analyze.js';
import { trackCacheId, getAnalysis, putAnalysis } from '../lib/analysiscache.js';
import { Turntable, reversedBuffer } from './scratch.js';
import { Flanger, Gater, Phaser, Echo, Reverb, ChannelFilter } from './fx.js';
import { MacroFX, MACRO_TYPES } from './macrofx.js';

/** Insert order in the chain — modulation first, gate, then time-based tails. */
export const FX_TYPES = ['flanger', 'phaser', 'gater', 'echo', 'reverb'];
export { FILTER_MODELS } from './fx.js';
export { MACRO_TYPES, MACRO_LABELS } from './macrofx.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Seconds per platter revolution at 33⅓ rpm — the reference for jog feel. */
export const SEC_PER_REV = 1.8;

class Emitter {
  constructor() {
    this._subs = new Set();
  }
  on(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  emit(what) {
    for (const fn of this._subs) {
      try {
        fn(what, this);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export class Deck extends Emitter {
  constructor(mixer, id) {
    super();
    this.mixer = mixer;
    this.id = id; // 'A' | 'B'

    this.track = null;
    this.status = 'empty'; // empty | loading | ready | error
    this.error = '';
    this.backend = null; // 'buffer' | 'element'
    this.progress = 0;

    this.playing = false; // transport intent, not "is sound coming out"
    this.duration = 0;
    this.cuePoint = 0;

    this.tempo = 0; // percent
    this.tempoRange = 8;
    this.nudgeAmount = 0;

    this.volume = 1;
    this.trim = 1;
    this.eq = { low: 0, mid: 0, high: 0 };
    this.filter = 0;
    this.cueOn = false; // pre-fader listen onto the mixer's headphone bus

    this.bpm = 0;
    this.bpmConfidence = 0;
    this.bpmManual = false;
    this.beatOffset = null; // seconds of the first detected beat, for the grid
    this.barOffset = null; // seconds of a detected bar-1 (downbeat)
    this._drop = null; // armed quantized start: { when }
    this.peaks = null;
    this.peaksHi = null; // fine peaks (8k buckets) for the zoomed waveform

    /* loop + sync */
    this.loop = { active: false, start: 0, end: 0, beats: 0 };
    this.syncedTo = null; // other deck while SYNC is latched
    this._lastPhaseSeek = 0;
    this._taps = []; // tap-tempo ring: { t: wall ms, pos: track seconds }
    this.autoScratch = null; // active auto-scratch pattern name
    this._as = null;

    /* vinyl */
    this.vinylMode = true;
    this.spinUpTime = 0.32; // s from stop to nominal
    this.brakeTime = 0.55; // s from nominal to stop
    this.scratching = false; // hand is on the record
    this.rewinding = false;
    this.platterTurns = 0; // for the UI, accumulates with real rate

    /* fx state mirrored for the UI */
    this.fx = {
      flanger: { on: false, rate: 0.35, depth: 0.0022, feedback: 0.55, mix: 0.6 },
      phaser: { on: false, rate: 0.4, depth: 0.7, feedback: 0.35, mix: 0.7 },
      gater: { on: false, division: 0.5, duty: 0.5, depth: 1, smooth: 0.25 },
      echo: { on: false, division: 0.5, feedback: 0.45, mix: 0.5 },
      reverb: { on: false, decay: 1.6, tone: 5000, mix: 0.35 },
    };
    /** Which two units the deck's FX buttons drive. The chain holds all five. */
    this.fxSlots = ['flanger', 'gater'];
    /** Channel-filter personality: 'clean' | 'djm' | 'xone'. */
    this.filterModel = 'clean';
    /** One-knob macro FX (Traktor Mixer FX-style): type + bipolar value. */
    this.macro = { type: 'echo', value: 0 };

    this._mode = 'idle';
    this._buffer = null;
    this._reverse = null;
    this._src = null;
    this._startCtxTime = 0;
    this._startOffset = 0;
    this._pausedAt = 0;
    this._el = null;
    this._loadToken = 0;

    this._platterRate = 0;
    this._targetRate = 0;
    this._accel = 4;
    this._afterMotor = null; // what to do once the motor reaches its target
    this._rewindHeldFor = 0;
    this._handVelocity = 0;
  }

  /* ---------------------------- graph ---------------------------- */

  _buildGraph() {
    const ctx = this.mixer.ctx;
    if (this._graph || !ctx) return this._graph;

    const trim = ctx.createGain();
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1000;
    mid.Q.value = 0.8;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 4000;
    const filter = new ChannelFilter(ctx);
    filter.setModel(this.filterModel);

    const flanger = new Flanger(ctx);
    const phaser = new Phaser(ctx);
    const gater = new Gater(ctx);
    const echo = new Echo(ctx);
    const reverb = new Reverb(ctx);
    const macro = new MacroFX(ctx);

    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    trim.connect(low).connect(mid).connect(high).connect(filter.input);
    filter.output.connect(flanger.input);
    flanger.output.connect(phaser.input);
    phaser.output.connect(gater.input);
    gater.output.connect(echo.input);
    echo.output.connect(reverb.input);
    reverb.output.connect(macro.input);
    macro.output.connect(gain).connect(analyser);
    analyser.connect(this.mixer.crossGain[this.id]);

    // Pre-fader listen: tap after the FX chain (macro included) but before
    // the volume fader, so the headphone hears the deck no matter where the
    // faders sit.
    const cueSend = ctx.createGain();
    cueSend.gain.value = this.cueOn ? 1 : 0;
    macro.output.connect(cueSend);
    if (this.mixer.cueBus) cueSend.connect(this.mixer.cueBus);

    macro.setType(this.macro.type);
    macro.setValue(this.macro.value);

    this._graph = { trim, low, mid, high, filter, flanger, phaser, gater, echo, reverb, macro, gain, analyser, cueSend };
    this._analyseBuf = new Float32Array(analyser.fftSize);
    this._turntable = new Turntable(ctx, trim);
    this._applyMix();
    this._applyFx();
    return this._graph;
  }

  /* ---------------------------- loading ---------------------------- */

  async load(track) {
    const token = ++this._loadToken;
    this.stop();
    this.track = track;
    this.status = 'loading';
    this.error = '';
    this.progress = 0;
    this.backend = null;
    this._buffer = null;
    this._reverse = null;
    this.peaks = null;
    this.peaksHi = null;
    this.bpm = 0;
    this.bpmConfidence = 0;
    this.bpmManual = false;
    this.beatOffset = null;
    this.barOffset = null;
    this.structure = null;
    this.musicalKey = null;
    this._analysisFromCache = false;
    this._drop = null;
    this._taps = [];
    this.autoScratch = null;
    this._as = null;
    this.loop = { active: false, start: 0, end: 0, beats: 0 };
    this.cuePoint = 0;
    this._pausedAt = 0;
    this._mode = 'idle';
    this.duration = track.duration || 0;
    this.emit('load');

    this.mixer.ensureContext();

    // Local file: decode straight from disk — no host, no proxy, no CORS.
    if (track.localFile) {
      try {
        const ab = await track.localFile.arrayBuffer();
        if (token !== this._loadToken) return;
        this.progress = 0.6;
        this.emit('progress');
        const buffer = await this.mixer.ctx.decodeAudioData(ab);
        if (token !== this._loadToken) return;
        this._buffer = buffer;
        this.backend = 'buffer';
        this.duration = buffer.duration;
        this.status = 'ready';
        this.progress = 1;
        this._buildGraph();
        this._turntable.setBuffers(buffer, null);
        this.emit('ready');
        this._analyseAsync(token, buffer);
      } catch (e) {
        if (token !== this._loadToken) return;
        this.status = 'error';
        this.error = `File could not be decoded: ${(e && e.message) || e}`;
        this.emit('error');
      }
      return;
    }

    const urls = track.streamUrls && track.streamUrls.length ? track.streamUrls : [];
    let lastErr = null;

    for (const url of urls) {
      try {
        const blob = await fetchBlob(url, { proxy: this.mixer.proxy });
        if (token !== this._loadToken) return;
        this.progress = 0.6;
        this.emit('progress');
        const ab = await blob.arrayBuffer();
        const buffer = await this.mixer.ctx.decodeAudioData(ab);
        if (token !== this._loadToken) return;
        this._buffer = buffer;
        this.backend = 'buffer';
        this.duration = buffer.duration;
        this.status = 'ready';
        this.progress = 1;
        this._buildGraph();
        this._turntable.setBuffers(buffer, null);
        this.emit('ready');
        this._analyseAsync(token, buffer);
        return;
      } catch (e) {
        lastErr = e;
      }
    }

    for (const url of urls) {
      try {
        await this._loadElement(url, token);
        if (token !== this._loadToken) return;
        this.backend = 'element';
        this.status = 'ready';
        this.progress = 1;
        this.emit('ready');
        return;
      } catch (e) {
        lastErr = e;
      }
    }

    if (token !== this._loadToken) return;
    this.status = 'error';
    this.error = (lastErr && lastErr.message) || 'Track could not be loaded';
    this.emit('error');
  }

  _loadElement(url, token) {
    return new Promise((resolve, reject) => {
      const el = new Audio();
      el.preload = 'auto';
      el.crossOrigin = null;
      el.src = url;
      const done = () => {
        cleanup();
        if (token !== this._loadToken) return reject(new Error('superseded'));
        this._el = el;
        this.duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : this.duration;
        this._applyMix();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('audio element load failed'));
      };
      const cleanup = () => {
        el.removeEventListener('canplay', done);
        el.removeEventListener('error', fail);
        clearTimeout(timer);
      };
      const timer = setTimeout(fail, 25_000);
      el.addEventListener('canplay', done);
      el.addEventListener('error', fail);
      el.addEventListener('ended', () => {
        this.playing = false;
        this.emit('ended');
      });
      el.load();
    });
  }

  async _analyseAsync(token, buffer) {
    try {
      this.peaks = waveformPeaks(buffer, 1000);
      this.peaksHi = waveformPeaks(buffer, 8000);
      this.loudness = rms(buffer);
      if (this.loudness > 0) this.trim = clamp(0.25 / this.loudness, 0.5, 2);
      this._applyMix();
      this.emit('peaks');

      // Cache hit skips the two expensive passes (tempo comb + chromagram);
      // structure always runs fresh — it is cheap and carries the per-bar
      // arrays the UI wants, which the cache deliberately does not store.
      const cacheId = trackCacheId(this.track);
      const cached = cacheId ? getAnalysis(cacheId) : null;
      if (cached && cached.bpm > 0 && !this.bpmManual) {
        this._analysisFromCache = true;
        this.bpm = cached.bpm;
        this.bpmConfidence = cached.cf || 0;
        this.beatOffset = Number.isFinite(cached.bo) ? cached.bo : null;
        this.barOffset = Number.isFinite(cached.ro) ? cached.ro : null;
        if (cached.k && cached.k[0] >= 0) {
          this.musicalKey = keyObject(cached.k[0], cached.k[1] === 0 ? 'major' : 'minor', cached.k[2] || 0);
        }
        this.emit('bpm');
      } else {
        const res = await detectBpm(buffer);
        if (token !== this._loadToken) return;
        if (!this.bpmManual) {
          this.bpm = res.bpm;
          this.bpmConfidence = res.confidence;
        }
        this.beatOffset = Number.isFinite(res.beatOffset) ? res.beatOffset : null;
        this.barOffset = Number.isFinite(res.barOffset) ? res.barOffset : null;
        this.emit('bpm');
      }

      // Reversing a 6-minute stereo buffer costs ~60 MB and ~100 ms, so it is
      // built after the track is already playable, not on the critical path.
      const rev = reversedBuffer(this.mixer.ctx, buffer);
      if (token !== this._loadToken) return;
      this._reverse = rev;
      if (this._turntable) this._turntable.setBuffers(buffer, rev);
      this.emit('vinyl-ready');

      const st = await analyzeStructure(buffer, {
        bpm: this.bpm, beatOffset: this.beatOffset, barOffset: this.barOffset,
      });
      if (token !== this._loadToken) return;
      this.structure = st && st.ok ? st : null;
      if (!this.musicalKey) {
        const key = await detectKey(buffer);
        if (token !== this._loadToken) return;
        if (key.pitchClass >= 0) this.musicalKey = key;
      }
      this.emit('structure');

      if (cacheId && this.bpm > 0) {
        putAnalysis(cacheId, {
          v: 1,
          bpm: this.bpm,
          cf: this.bpmConfidence,
          bo: this.beatOffset,
          ro: this.barOffset,
          ld: this.loudness,
          k: this.musicalKey
            ? [this.musicalKey.pitchClass, this.musicalKey.mode === 'major' ? 0 : 1,
              this.musicalKey.confidence]
            : null,
          s: this.structure
            ? { pb: this.structure.phraseBars, po: this.structure.phraseOffset,
              mi: this.structure.mixInSec, mo: this.structure.mixOutSec,
              ei: this.structure.energyIn, eo: this.structure.energyOut,
              sc: this.structure.confidence }
            : null,
        });
      }
    } catch (e) {
      console.warn('analysis failed', e);
    }
  }

  /* ---------------------------- rates ---------------------------- */

  /** Rate the pitch fader alone asks for. */
  get nominalRate() {
    return (1 + this.tempo / 100) * (1 + this.nudgeAmount);
  }

  /** Backwards-compatible alias. */
  get rate() {
    return this.nominalRate;
  }

  get pitch() {
    return this.tempo;
  }

  /** What the platter is actually doing right now — drives the UI and BPM readout. */
  get currentRate() {
    if (this._mode === 'platter') return this._platterRate;
    if (this.backend === 'element') return this._el && !this._el.paused ? this.nominalRate : 0;
    return this._mode === 'source' ? this.nominalRate : 0;
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.nominalRate : 0;
  }

  /** Live BPM including scratch/brake — what the gater follows. */
  get liveBpm() {
    return this.bpm ? this.bpm * Math.abs(this.currentRate || this.nominalRate) : 0;
  }

  get canVinyl() {
    return this.backend === 'buffer' && this.status === 'ready';
  }

  get position() {
    if (this.backend === 'element') return this._el ? this._el.currentTime : 0;
    if (this._mode === 'platter') return this._turntable.position;
    if (this._mode !== 'source') return this._pausedAt;
    const ctx = this.mixer.ctx;
    // max(0, …): an armed drop schedules the start in the future.
    let p = this._startOffset + Math.max(0, ctx.currentTime - this._startCtxTime) * this.nominalRate;
    // A looping source wraps in the buffer while the clock keeps counting.
    const L = this.loop;
    if (L.active && L.end > L.start + 0.01 && this._startOffset < L.end && p > L.end) {
      p = L.start + ((p - L.start) % (L.end - L.start));
    }
    return clamp(p, 0, this.duration);
  }

  /* ---------------------------- transport ---------------------------- */

  /** Toggle pre-fader listen (headphone cue) for this deck. */
  setCue(on) {
    this.cueOn = on === undefined ? !this.cueOn : Boolean(on);
    if (this._graph) {
      const t = this.mixer.ctx.currentTime;
      this._graph.cueSend.gain.setTargetAtTime(this.cueOn ? 1 : 0, t, 0.02);
    }
    this.emit('cue-listen');
  }

  play() {
    if (this.status !== 'ready') return;
    this.mixer.ensureContext();
    this.mixer.resumeAudio();

    if (this.backend === 'element') {
      this._el.playbackRate = this.nominalRate;
      this._el.play().catch((e) => {
        this.error = e.message;
        this.emit('error');
      });
      this.playing = true;
      this.emit('transport');
      return;
    }

    if (this.playing && this._mode !== 'idle') return;
    this.playing = true;

    if (this.vinylMode) {
      // Spin-up: the motor takes the record from a standstill to speed, and
      // you hear it — that is the whole point of the vinyl mode.
      this._enterPlatter(0);
      this._motorTo(this.nominalRate, this.spinUpTime, () => this._enterSource(this._turntable.position));
    } else {
      this._enterSource(this._pausedAt);
    }
    this.emit('transport');
  }

  pause() {
    if (this.backend === 'element') {
      if (this._el) this._el.pause();
      this.playing = false;
      this.emit('transport');
      return;
    }
    if (!this.playing && this._mode === 'idle') return;
    this.playing = false;

    if (this.vinylMode && this._mode !== 'idle') {
      const from = this._mode === 'source' ? this.nominalRate : this._platterRate;
      this._enterPlatter(from);
      this._motorTo(0, this.brakeTime, () => this._enterIdle());
    } else {
      this._enterIdle();
    }
    this.emit('transport');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  stop() {
    if (this.backend === 'element') {
      if (this._el) {
        this._el.pause();
        this._el.currentTime = 0;
      }
      this.playing = false;
      return;
    }
    this.playing = false;
    this._enterIdle();
    this._pausedAt = 0;
  }

  seek(seconds) {
    const t = clamp(seconds, 0, this.duration || 0);
    if (this.backend === 'element') {
      if (this._el) this._el.currentTime = t;
      this.emit('transport');
      return;
    }
    this._pausedAt = t;
    if (this._mode === 'platter') this._turntable.setPosition(t);
    else if (this._mode === 'source') this._enterSource(t);
    this.emit('transport');
  }

  /** CDJ-style: sets the point when stopped, jumps back to it when playing. */
  cue() {
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else {
      this.cuePoint = this.position;
      this.emit('cue');
    }
  }

  jumpToCue() {
    this.seek(this.cuePoint);
  }

  /* ---------------------------- loops ---------------------------- */

  /** Arm the loop-in point at the playhead (manual loop, first half). */
  loopIn() {
    if (this.backend !== 'buffer') return;
    this.loop = { active: false, start: this.position, end: 0, beats: 0 };
    this.emit('loop');
  }

  /** Close a manual loop from the armed in-point to the playhead. */
  loopOut() {
    if (this.backend !== 'buffer' || this.loop.active) return;
    const end = this.position;
    if (end <= this.loop.start + 0.05) return;
    this._applyLoop(this.loop.start, end, 0);
  }

  /**
   * Beat loop: `beats` long, snapped onto the detected grid when there is one.
   * Loop lengths live in track time, so they stay musical at any pitch.
   */
  setLoopBeats(beats) {
    if (this.backend !== 'buffer' || !this.bpm) return;
    // Second press on the same length toggles the loop off.
    if (this.loop.active && this.loop.beats === beats) return this.exitLoop();
    const beatLen = 60 / this.bpm;
    const pos = this.position;
    const start = Number.isFinite(this.beatOffset)
      ? this.beatOffset + Math.floor((pos - this.beatOffset) / beatLen) * beatLen
      : pos;
    this._applyLoop(Math.max(0, start), Math.min(this.duration, start + beats * beatLen), beats);
  }

  exitLoop() {
    if (!this.loop.active) return;
    // Freeze the wrapped position as the new linear origin before unlooping,
    // otherwise the clock math would jump ahead by every lap taken.
    const p = this.position;
    this.loop = { ...this.loop, active: false };
    if (this._mode === 'source' && this._src) {
      this._src.loop = false;
      this._startOffset = p;
      this._startCtxTime = this.mixer.ctx.currentTime;
    }
    this.emit('loop');
  }

  _applyLoop(start, end, beats) {
    if (end <= start + 0.01) return;
    this.loop = { active: true, start, end, beats };
    if (this._mode === 'source' && this._src) {
      const p = this.position;
      this._src.loopStart = start;
      this._src.loopEnd = end;
      this._src.loop = true;
      // Already past the region? Jump in, the node alone would run through.
      if (p > end) this.seek(start);
      else {
        this._startOffset = p;
        this._startCtxTime = this.mixer.ctx.currentTime;
      }
    }
    this.emit('loop');
  }

  /* ---------------------------- mode switching ---------------------------- */

  _enterSource(offset) {
    if (!this._buffer) return;
    this._stopSource();
    if (this._turntable && this._turntable.active) this._turntable.stop();

    const ctx = this.mixer.ctx;
    const g = this._buildGraph();
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    src.playbackRate.value = this.nominalRate;
    if (this.loop.active) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
      // Restarting outside the region would play straight past it.
      if (offset > this.loop.end) offset = this.loop.start;
    }
    src.connect(g.trim);
    src.onended = () => {
      if (this._src === src && this._mode === 'source' && this.position >= this.duration - 0.05) {
        this.playing = false;
        this._mode = 'idle';
        this.emit('ended');
      }
    };
    src.start(0, clamp(offset, 0, this.duration));
    this._src = src;
    this._startCtxTime = ctx.currentTime;
    this._startOffset = offset;
    this._mode = 'source';
    this._afterMotor = null;
    this.emit('transport');
  }

  _enterPlatter(initialRate) {
    if (!this._buffer) return;
    const pos = this.position;
    this._buildGraph();
    this._stopSource();
    if (!this._turntable.active) this._turntable.start(pos, initialRate);
    else {
      this._turntable.setPosition(pos);
      this._turntable.setRate(initialRate);
    }
    this._platterRate = initialRate;
    this._mode = 'platter';
  }

  _enterIdle() {
    this._pausedAt = this.position;
    this._stopSource();
    if (this._turntable && this._turntable.active) this._turntable.stop();
    this._platterRate = 0;
    this._afterMotor = null;
    this._mode = 'idle';
    this.emit('transport');
  }

  _stopSource() {
    if (this._src) {
      try {
        this._src.onended = null;
        this._src.stop();
      } catch {
        /* already stopped */
      }
      this._src = null;
    }
  }

  /** Ask the motor to reach `target` in roughly `seconds`, then run `done`. */
  _motorTo(target, seconds, done) {
    this._targetRate = target;
    const delta = Math.abs(target - this._platterRate) || 1;
    this._accel = delta / Math.max(0.05, seconds);
    this._afterMotor = done || null;
  }

  /* ---------------------------- vinyl gestures ---------------------------- */

  /** Hand goes down on the record. */
  touchPlatter() {
    if (!this.canVinyl || !this.vinylMode) return false;
    this.scratching = true;
    this._afterMotor = null;
    this._enterPlatter(this._mode === 'source' ? this.nominalRate : this._platterRate);
    this._turntable.autoAdvance = false; // the hand owns the position now
    this._handVelocity = 0;
    this.emit('scratch');
    return true;
  }

  /**
   * Move the record by hand.
   * @param {number} deltaSeconds  audio time the hand just dragged through
   * @param {number} dt            wall time it took, for the resulting speed
   */
  movePlatter(deltaSeconds, dt) {
    if (!this.scratching || this._mode !== 'platter') return;
    const inst = dt > 0.001 ? deltaSeconds / dt : 0;
    // Light smoothing: raw pointer deltas are spiky and make the grain player
    // chatter; too much smoothing and the scratch loses its bite.
    this._handVelocity = this._handVelocity * 0.35 + inst * 0.65;
    this._turntable.setPosition(this._turntable.position + deltaSeconds);
    this._platterRate = clamp(this._handVelocity, -16, 16);
    this._turntable.setRate(this._platterRate);
  }

  /** Hand comes off — the motor takes over again. */
  releasePlatter() {
    if (!this.scratching) return;
    this.scratching = false;
    this._turntable.autoAdvance = true;
    if (this.playing) this._motorTo(this.nominalRate, 0.22, () => this._enterSource(this._turntable.position));
    else this._motorTo(0, 0.25, () => this._enterIdle());
    this.emit('scratch');
  }

  /**
   * Dynamic rewind: hold it and the backspin keeps accelerating, so a tap is a
   * short stutter back and a long press is a full-blown rewind.
   */
  startRewind() {
    if (!this.canVinyl) return;
    this.rewinding = true;
    this._rewindHeldFor = 0;
    this._afterMotor = null;
    this._enterPlatter(this._mode === 'source' ? this.nominalRate : this._platterRate);
    this._turntable.autoAdvance = true;
    this.emit('rewind');
  }

  stopRewind() {
    if (!this.rewinding) return;
    this.rewinding = false;
    this._rewindHeldFor = 0;
    if (this.playing) this._motorTo(this.nominalRate, 0.28, () => this._enterSource(this._turntable.position));
    else this._motorTo(0, 0.3, () => this._enterIdle());
    this.emit('rewind');
  }

  /**
   * Per-frame physics + FX housekeeping. Called by the mixer's audio tick.
   * @param {number} dt seconds since the previous call
   */
  tickAudio(dt) {
    const step = clamp(dt, 0, 0.1);

    // Auto-scratch: the scripted hand moves the platter each frame.
    if (this.autoScratch && this._as && this.scratching) {
      const as = this._as;
      const beat = 60 / (this.effectiveBpm || 120);
      as.t += step;
      if (as.t >= as.bars * 4 * beat) {
        this.stopAutoScratch();
      } else {
        const ph = (as.t % beat) / beat;
        let rate = 0;
        let gate = 1;
        switch (this.autoScratch) {
          case 'baby': rate = Math.sin(ph * 2 * Math.PI) * 1.8; break;
          case 'scribble': rate = Math.sin((as.t / beat) * 8 * Math.PI) * 0.9; break;
          case 'chirp': rate = ph < 0.5 ? 2.2 : -2.2; gate = ph < 0.5 ? 1 : 0; break;
          case 'transformer': rate = 0.9; gate = (ph * 4) % 1 < 0.5 ? 1 : 0; break;
          case 'backspin': rate = -(2 + (as.t / (as.bars * 4 * beat)) * 10); break;
          default: break;
        }
        this.movePlatter(rate * step, step);
        if (this._graph) {
          this._graph.gain.gain.setTargetAtTime(gate * this.volume * this.trim, this.mixer.ctx.currentTime, 0.004);
        }
      }
    }

    if (this._mode === 'platter' && !this.scratching) {
      if (this.rewinding) {
        // Torque builds with hold time: -4x after ~0.2 s, floored at -14x.
        this._rewindHeldFor += step;
        const target = -clamp(2 + this._rewindHeldFor * 14, 2, 14);
        this._platterRate += (target - this._platterRate) * clamp(step * 9, 0, 1);
        this._turntable.setRate(this._platterRate);
      } else {
        const target = this._targetRate;
        const dir = Math.sign(target - this._platterRate);
        if (dir !== 0) {
          this._platterRate += dir * this._accel * step;
          if (Math.sign(target - this._platterRate) !== dir) this._platterRate = target;
        }
        this._turntable.setRate(this._platterRate);
        if (Math.abs(this._platterRate - target) < 0.005) {
          const done = this._afterMotor;
          this._afterMotor = null;
          if (done) done();
        }
      }
    }

    // Platter angle for the UI, in revolutions.
    this.platterTurns += (this.currentRate * step) / SEC_PER_REV;

    // An armed drop disarms itself the moment its scheduled start has fired.
    if (this._drop && this.mixer.ctx && this.mixer.ctx.currentTime >= this._drop.when) {
      this._drop = null;
      this.emit('drop');
    }

    // SYNC latch: a hand permanently on the pitch fader. Small phase errors
    // are ridden out with micro-nudges; big ones (deck was scratched, or it
    // just started) get one hard realign, rate-limited so it cannot flutter.
    const o = this.syncedTo;
    if (o && this.backend === 'buffer' && this._mode === 'source' && this.playing
      && o.playing && this.bpm && o.effectiveBpm) {
      const beat = 60 / this.effectiveBpm;
      const obeat = 60 / o.effectiveBpm;
      const mod = (x, m) => ((x % m) + m) % m;
      let err = mod(this.position - (this.beatOffset || 0), beat) / beat
        - mod(o.position - (o.beatOffset || 0), obeat) / obeat;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      const nowMs = performance.now();
      if (Math.abs(err) > 0.1) {
        // A big jump (seek, scratch landing) gets caught immediately; the
        // cooldown only guards against flutter around the threshold.
        const cooldown = Math.abs(err) > 0.25 ? 250 : 900;
        if (nowMs - this._lastPhaseSeek > cooldown) {
          this._lastPhaseSeek = nowMs;
          this.alignPhase(o);
        }
      } else if (Math.abs(err) > 0.004) {
        this.setNudge(clamp(-err * 0.08, -0.008, 0.008));
      } else if (this.nudgeAmount !== 0) {
        this.setNudge(0);
      }
    }

    if (this._graph) {
      const bpm = this.liveBpm || this.effectiveBpm || 120;
      this._graph.gater.set({ bpm });
      this._graph.gater.tick();
      this._graph.echo.set({ bpm });
      this._graph.macro.tick(bpm);
    }
  }

  /* ---------------------------- tempo ---------------------------- */

  setTempo(percent) {
    const p = clamp(percent, -this.tempoRange, this.tempoRange);
    this._reRate(() => {
      this.tempo = p;
    });
    this.emit('tempo');
  }

  /** Kept for callers using the old name. */
  setPitch(percent) {
    this.setTempo(percent);
  }

  setNudge(amount) {
    this._reRate(() => {
      this.nudgeAmount = clamp(amount, -0.3, 0.3);
    });
  }

  _reRate(mutate) {
    if (this.backend === 'buffer' && this._mode === 'source') {
      // Freeze the elapsed time first: a rate change must not retroactively
      // rescale the seconds already played by the current source node.
      const pos = this.position;
      mutate();
      this._startOffset = pos;
      this._startCtxTime = this.mixer.ctx.currentTime;
      if (this._src) this._src.playbackRate.value = this.nominalRate;
    } else {
      mutate();
      if (this._src) this._src.playbackRate.value = this.nominalRate;
      if (this._el) this._el.playbackRate = clamp(this.nominalRate, 0.25, 4);
      if (this._mode === 'platter' && !this.scratching && !this.rewinding) {
        this._targetRate = this.playing ? this.nominalRate : 0;
      }
    }
  }

  /**
   * Match another deck's tempo, and — when both are actually running — nudge
   * this deck onto the other's beat grid. BPM alone gets you the same speed;
   * phase is what makes the kicks land together.
   */
  syncTo(other) {
    const targetBpm = typeof other === 'number' ? other : other && other.effectiveBpm;
    if (!this.bpm || !targetBpm) return false;

    // 2:3 relations included: two detectors reading the same groove on
    // different metrical levels (92.5 vs 138.75) must still sync to 0 %.
    let best = null;
    for (const t of [targetBpm, targetBpm * 2, targetBpm / 2, targetBpm * 1.5, targetBpm / 1.5]) {
      const pct = (t / this.bpm - 1) * 100;
      if (Math.abs(pct) <= this.tempoRange && (!best || Math.abs(pct) < Math.abs(best))) best = pct;
    }
    if (best === null) return false;
    this.setTempo(best);

    if (typeof other === 'object' && other && other.playing && this.playing) this.alignPhase(other);
    return true;
  }

  /**
   * Tap tempo: call once per beat you hear. Works off playback-position
   * deltas, so the result is the track's BASE bpm no matter where the tempo
   * fader sits. From the fourth tap on, bpm and the beat grid are set (and
   * marked manual so the detector won't overwrite them); further taps refine.
   */
  tapBeat() {
    if (this.backend !== 'buffer' || !this.playing) return { count: 0, bpm: 0 };
    const now = performance.now();
    if (this._taps.length && now - this._taps[this._taps.length - 1].t > 2000) this._taps = [];
    this._taps.push({ t: now, pos: this.position });
    if (this._taps.length > 9) this._taps.shift();

    const n = this._taps.length;
    if (n >= 4) {
      const deltas = [];
      for (let i = 1; i < n; i++) deltas.push(this._taps[i].pos - this._taps[i - 1].pos);
      deltas.sort((a, b) => a - b);
      const beatLen = deltas[Math.floor(deltas.length / 2)]; // median beats jitter
      if (beatLen > 0.2 && beatLen < 2) {
        this.bpm = Math.round((60 / beatLen) * 100) / 100;
        this.bpmManual = true;
        // Circular mean of the tap phases anchors the grid on the taps.
        let sx = 0;
        let sy = 0;
        for (const tap of this._taps) {
          const ph = ((tap.pos % beatLen) / beatLen) * 2 * Math.PI;
          sx += Math.cos(ph);
          sy += Math.sin(ph);
        }
        const phase = (Math.atan2(sy, sx) / (2 * Math.PI) + 1) % 1;
        this.beatOffset = phase * beatLen;
        this.barOffset = this.beatOffset; // taps give the beat, not the 1
        this.emit('bpm');
      }
    }
    this.emit('tap');
    return { count: n, bpm: n >= 4 ? this.bpm : 0 };
  }

  /* ---------------------------- auto-scratch ---------------------------- */

  /**
   * Scripted turntablism: beat-synced hand gestures over the granular
   * platter, driven from tickAudio (no timers of its own). Volume gating for
   * chirp/transformer cuts the deck channel, not the crossfader.
   */
  toggleAutoScratch(pattern) {
    if (this.autoScratch === pattern) return this.stopAutoScratch();
    return this.startAutoScratch(pattern);
  }

  startAutoScratch(pattern) {
    if (!this.canVinyl || !this._reverse || !this.bpm) return false;
    this.stopAutoScratch();
    this.touchPlatter();
    this.autoScratch = pattern;
    this._as = { t: 0, bars: pattern === 'backspin' ? 1 : 2 };
    this.emit('scratch');
    return true;
  }

  stopAutoScratch() {
    if (!this.autoScratch) return;
    this.autoScratch = null;
    this._as = null;
    if (this._graph) {
      this._graph.gain.gain.setTargetAtTime(this.volume * this.trim, this.mixer.ctx.currentTime, 0.01);
    }
    this.releasePlatter();
    this.emit('scratch');
  }

  /** Latch or release SYNC. While latched, tickAudio keeps the phase locked. */
  setSynced(other) {
    this.syncedTo = other || null;
    if (!this.syncedTo) this.setNudge(0);
    this.emit('sync');
  }

  /**
   * Quantized drop: match the tempo, then start this deck — CDJ-style, no
   * spin-up — exactly on the other deck's next bar-1. Our start point is the
   * cue (or the first downbeat) snapped onto our own bar grid, so a 1 lands
   * on a 1. Arming while armed cancels.
   */
  armDrop(other) {
    if (this._drop) {
      this.cancelDrop();
      return 'cancelled';
    }
    if (this.backend !== 'buffer' || this.status !== 'ready' || !this._buffer) return false;
    if (!other || !other.playing || !other.effectiveBpm || !this.bpm) return false;
    this.mixer.ensureContext();
    this.mixer.resumeAudio();
    this.syncTo(other.effectiveBpm);

    const ctx = this.mixer.ctx;
    const mod = (x, m) => ((x % m) + m) % m;
    const obeat = 60 / other.effectiveBpm;
    const obar = 4 * obeat;
    const oAnchor = Number.isFinite(other.barOffset) ? other.barOffset : other.beatOffset || 0;
    const trackWait = obar - mod(other.position - oAnchor, obar);
    const otherRate = Math.abs(other.currentRate || other.nominalRate) || 1;
    let wait = trackWait / otherRate;
    if (wait < 0.06) wait += obar / otherRate; // too tight to schedule cleanly
    const when = ctx.currentTime + wait;

    const bar = 4 * (60 / this.bpm);
    const anchor = Number.isFinite(this.barOffset) ? this.barOffset : this.beatOffset || 0;
    const raw = this.cuePoint || anchor;
    const offset = clamp(anchor + Math.round((raw - anchor) / bar) * bar, 0, this.duration);

    this._stopSource();
    if (this._turntable && this._turntable.active) this._turntable.stop();
    const g = this._buildGraph();
    const src = ctx.createBufferSource();
    src.buffer = this._buffer;
    src.playbackRate.value = this.nominalRate;
    if (this.loop.active) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }
    src.connect(g.trim);
    src.onended = () => {
      if (this._src === src && this._mode === 'source' && this.position >= this.duration - 0.05) {
        this.playing = false;
        this._mode = 'idle';
        this.emit('ended');
      }
    };
    src.start(when, offset);
    this._src = src;
    this._startCtxTime = when;
    this._startOffset = offset;
    this._mode = 'source';
    this.playing = true;
    this._afterMotor = null;
    this._drop = { when };
    this.emit('drop');
    this.emit('transport');
    return true;
  }

  cancelDrop() {
    if (!this._drop) return;
    this._drop = null;
    this.playing = false;
    this._enterIdle();
    this.emit('drop');
  }

  /** Shift by less than one beat so both decks sit on the same grid phase. */
  alignPhase(other) {
    const bpm = this.effectiveBpm;
    const otherBpm = other.effectiveBpm;
    if (!bpm || !otherBpm || this.backend !== 'buffer' || other.backend !== 'buffer') return false;
    const beat = 60 / bpm;
    const otherBeat = 60 / otherBpm;
    const mod = (x, m) => ((x % m) + m) % m;
    // With detected beat grids, compare phase relative to each track's own
    // first beat — that is knowing the phase instead of guessing it from t=0.
    const offA = Number.isFinite(this.beatOffset) ? this.beatOffset : 0;
    const offB = Number.isFinite(other.beatOffset) ? other.beatOffset : 0;
    const phase = mod(other.position - offB, otherBeat) / otherBeat - mod(this.position - offA, beat) / beat;
    let delta = phase * beat;
    if (delta > beat / 2) delta -= beat;
    if (delta < -beat / 2) delta += beat;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.002) return false;
    this.seek(this.position + delta);
    return true;
  }

  /* ---------------------------- fx ---------------------------- */

  setFx(unit, params) {
    Object.assign(this.fx[unit], params);
    this._applyFx();
    this.emit('fx');
  }

  toggleFx(unit, on) {
    if (Deck.isMacroEntry(unit)) {
      // A macro's "on" is a non-zero knob — the button punches it in and out,
      // remembering the last amount so a re-punch lands where you left it.
      const engaged = Math.abs(this.macro.value) >= 0.06;
      const want = on === undefined ? !engaged : Boolean(on);
      if (want === engaged) return;
      if (want) {
        this.setMacroValue(this._macroPunch || 0.5);
      } else {
        this._macroPunch = this.macro.value;
        this.setMacroValue(0);
      }
      return;
    }
    if (!this.fx[unit]) return;
    this.fx[unit].on = on === undefined ? !this.fx[unit].on : Boolean(on);
    this._applyFx();
    this.emit('fx');
  }

  /** Slot entries are insert FX ('flanger') or macro combos ('macro:space'). */
  static isMacroEntry(t) {
    return typeof t === 'string' && t.startsWith('macro:');
  }

  /**
   * Put an effect type into slot 0 or 1. If the other slot already holds that
   * type the two swap, so both buttons always drive distinct units. The unit
   * leaving a slot is switched off — nothing keeps running without a button.
   * There is only ONE macro engine per deck, so any macro-vs-macro collision
   * swaps like an exact duplicate would.
   */
  setFxSlot(slot, type) {
    const macroSel = Deck.isMacroEntry(type) && MACRO_TYPES.includes(type.slice(6));
    if ((!FX_TYPES.includes(type) && !macroSel) || (slot !== 0 && slot !== 1)) return;
    const other = 1 - slot;
    const prev = this.fxSlots[slot];
    if (prev === type) return;
    if (this.fxSlots[other] === type || (macroSel && Deck.isMacroEntry(this.fxSlots[other]))) {
      this.fxSlots[other] = prev;
    } else {
      this.toggleFx(prev, false);
    }
    this.fxSlots[slot] = type;
    if (macroSel) this.setMacroType(type.slice(6));
    this.emit('fx');
  }

  _applyFx() {
    if (!this._graph) return;
    for (const type of FX_TYPES) {
      const unit = this._graph[type];
      const { on, ...params } = this.fx[type];
      unit.set(params);
      unit.setEnabled(on);
    }
  }

  /* ---------------------------- mixing ---------------------------- */

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    this._applyMix();
    this.emit('mix');
  }

  setTrim(v) {
    this.trim = clamp(v, 0, 2);
    this._applyMix();
    this.emit('mix');
  }

  setEq(band, db) {
    this.eq[band] = clamp(db, -26, 6);
    if (this._graph) this._graph[band].gain.value = this.eq[band];
    this.emit('mix');
  }

  setFilter(v) {
    this.filter = clamp(v, -1, 1);
    if (this._graph) this._graph.filter.setPosition(this.filter);
    this.emit('mix');
  }

  setFilterModel(model) {
    this.filterModel = model;
    if (this._graph) this._graph.filter.setModel(model);
    this.emit('mix');
  }

  setMacroType(type) {
    this.macro.type = type;
    if (this._graph) this._graph.macro.setType(type);
    this.emit('fx');
  }

  setMacroValue(v) {
    this.macro.value = clamp(v, -1, 1);
    if (this._graph) this._graph.macro.setValue(this.macro.value);
    this.emit('fx');
  }

  _applyMix() {
    const level = this.volume * this.trim;
    if (this._graph) {
      // Automation-safe: auto-scratch gates this param with setTargetAtTime,
      // and a plain .value assignment would lose against a pending target.
      const g = this._graph.gain.gain;
      const t = this.mixer.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(level, t, 0.01);
    }
    if (this._el) {
      this._el.volume = clamp(level * this.mixer.crossValue(this.id) * this.mixer.master, 0, 1);
    }
  }

  level() {
    if (!this._graph || this._mode === 'idle') return 0;
    const a = this._graph.analyser;
    a.getFloatTimeDomainData(this._analyseBuf);
    let peak = 0;
    for (let i = 0; i < this._analyseBuf.length; i++) {
      const v = Math.abs(this._analyseBuf[i]);
      if (v > peak) peak = v;
    }
    return clamp(peak, 0, 1);
  }

  dispose() {
    this._loadToken++;
    this._stopSource();
    if (this._turntable) this._turntable.stop();
    if (this._el) {
      this._el.pause();
      this._el.src = '';
      this._el = null;
    }
    this._buffer = null;
    this._reverse = null;
    this._mode = 'idle';
  }
}

export class Mixer extends Emitter {
  constructor() {
    super();
    this.ctx = null;
    this.master = 0.85;
    this.crossfader = 0;
    this.proxy = '';
    this.crossGain = {};
    this.cueVolume = 0.9;
    this.cueAvailable = false;
    this.outputs = { master: '', cue: '' };
    this.decks = {};
    this.decks.A = new Deck(this, 'A');
    this.decks.B = new Deck(this, 'B');
    this._lastTick = 0;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.master;
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterGain.connect(this.masterAnalyser).connect(this.ctx.destination);
    this._masterBuf = new Float32Array(this.masterAnalyser.fftSize);

    for (const id of ['A', 'B']) {
      const g = this.ctx.createGain();
      g.connect(this.masterGain);
      this.crossGain[id] = g;
    }

    // Cue (headphone) bus. The deck sends land on cueGain inside the main
    // context; a MediaStream bridge carries the sum into a second context,
    // which is what can be pointed at different hardware via setSinkId.
    this.cueGain = this.ctx.createGain();
    this.cueGain.gain.value = this.cueVolume;
    this.cueBus = this.cueGain;
    try {
      this.cueDest = this.ctx.createMediaStreamDestination();
      this.cueGain.connect(this.cueDest);
      this.cueCtx = new Ctx({ latencyHint: 'interactive' });
      // The bridge stays MUTED until a distinct cue device is chosen: on the
      // same device as the master it would play everything twice a few ms
      // apart — comb filtering that eats the bass first.
      this._cueOut = this.cueCtx.createGain();
      this._cueOut.gain.value = 0;
      this.cueCtx.createMediaStreamSource(this.cueDest.stream).connect(this._cueOut).connect(this.cueCtx.destination);
      this.cueAvailable = true;
    } catch {
      this.cueAvailable = false;
    }

    this._applyCrossfader();
    this.emit('context');
    return this.ctx;
  }

  resumeAudio() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    if (this.cueCtx && this.cueCtx.state === 'suspended') this.cueCtx.resume();
  }

  setCueVolume(v) {
    this.cueVolume = clamp(v, 0, 1);
    if (this.cueGain) this.cueGain.gain.value = this.cueVolume;
    this.emit('cue');
  }

  /** All audio outputs the browser will let us see. Labels may need permission. */
  async listOutputs() {
    if (!(navigator.mediaDevices && navigator.mediaDevices.enumerateDevices)) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all
        .filter((d) => d.kind === 'audiooutput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Ausgang ${i + 1}` }));
    } catch {
      return [];
    }
  }

  /**
   * Route master or cue onto a hardware device (AudioContext.setSinkId).
   * Returns false where the API or the permission is missing — the caller
   * decides whether that is worth a warning.
   */
  async setOutputDevice(which, deviceId) {
    const target = which === 'cue' ? this.cueCtx : this.ctx;
    if (!target || typeof target.setSinkId !== 'function') return false;
    try {
      await target.setSinkId(deviceId || '');
      this.outputs[which] = deviceId || '';
      this._updateCueGate();
      return true;
    } catch {
      return false;
    }
  }

  /** Cue audio flows only onto a device that differs from the master. */
  _updateCueGate() {
    if (!this._cueOut) return;
    const distinct = Boolean(this.outputs.cue) && this.outputs.cue !== this.outputs.master;
    this._cueOut.gain.value = distinct ? 1 : 0;
  }

  /** Drive deck physics and FX scheduling. Call once per animation frame. */
  tickAudio() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const dt = this._lastTick ? now - this._lastTick : 0;
    this._lastTick = now;
    this.decks.A.tickAudio(dt);
    this.decks.B.tickAudio(dt);
  }

  crossValue(id) {
    const x = (this.crossfader + 1) / 2;
    return id === 'A' ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2);
  }

  setCrossfader(v) {
    this.crossfader = clamp(v, -1, 1);
    this._applyCrossfader();
    this.emit('crossfader');
  }

  setMaster(v) {
    this.master = clamp(v, 0, 1);
    if (this.masterGain) this.masterGain.gain.value = this.master;
    this._applyCrossfader();
    this.emit('master');
  }

  _applyCrossfader() {
    for (const id of ['A', 'B']) {
      if (this.crossGain[id]) this.crossGain[id].gain.value = this.crossValue(id);
      this.decks[id]._applyMix();
    }
  }

  masterLevel() {
    if (!this.masterAnalyser) return 0;
    this.masterAnalyser.getFloatTimeDomainData(this._masterBuf);
    let peak = 0;
    for (let i = 0; i < this._masterBuf.length; i++) {
      const v = Math.abs(this._masterBuf[i]);
      if (v > peak) peak = v;
    }
    return clamp(peak, 0, 1);
  }

  get fullMode() {
    return this.decks.A.backend === 'buffer' || this.decks.B.backend === 'buffer';
  }
}
