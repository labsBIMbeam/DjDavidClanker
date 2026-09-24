import './synth.css';
import { renderLoop, encodeWav } from './render.js';
import { createLoopPlayer } from './player.js';
import { createMusicSender } from './send.js';

document.body.innerHTML = `
  <main class="instrument">
    <header>
      <p class="eyebrow">CLANKER / INSTRUMENT 01</p>
      <h1>One seed.<br><span>Four bars.</span></h1>
      <p class="intro">A little bass-and-drum machine. Shape a loop, then take it into your set.</p>
    </header>
    <section class="panel" aria-label="Loop instrument">
      <div class="panel-heading"><h2>Clanker Synth</h2><span id="duration">4 bars</span></div>
      <canvas id="waveform" width="960" height="160" role="img"
        aria-label="Waveform of the generated four-bar loop"></canvas>
      <div class="controls">
        <label>Tempo <span>BPM</span><input id="tempo" type="number" min="80" max="160"
          step="1" value="120" inputmode="numeric" aria-label="Tempo in BPM"></label>
        <label>Root note<select id="root" aria-label="Root note"></select></label>
        <label>Seed<input id="seed" type="number" min="0" max="4294967295" step="1"
          value="21" inputmode="numeric" aria-label="Pattern seed"></label>
        <button id="new-seed" class="secondary" type="button">New seed</button>
      </div>
      <div class="transport">
        <button id="play" class="primary" type="button">Play loop</button>
        <button id="stop" class="secondary" type="button" disabled>Stop</button>
        <p id="status" role="status" aria-live="polite">Ready to play.</p>
      </div>
    </section>
    <section class="handoff" aria-label="Use this loop">
      <div><h2>Take it into your set.</h2>
        <p>Download the WAV and add it through David’s LOCAL tab.</p></div>
      <div class="export-actions">
        <button id="download" class="secondary" type="button">Download WAV</button>
        <button id="send" class="secondary" type="button" disabled>Send to music</button>
      </div>
      <p class="send-explanation">Send uploads this loop through your shell and opens a compatible
        music app. You choose when to start playback there.</p>
      <p id="send-status" role="status" aria-live="polite">Checking music apps…</p>
    </section>
    <footer>Local synthesis · Four-bar loops · 44.1 kHz mono WAV</footer>
  </main>`;

const byId = (id) => document.getElementById(id);
const tempo = byId('tempo');
const root = byId('root');
const seed = byId('seed');
const play = byId('play');
const stop = byId('stop');
const download = byId('download');
const send = byId('send');
const status = byId('status');
const sendStatus = byId('send-status');
const player = createLoopPlayer();
const sender = createMusicSender();
const sampleRate = 44100;
let current = null;
let sendReady = false;

const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
for (let midi = 24; midi <= 60; midi++) {
  const option = document.createElement('option');
  option.value = String(midi);
  option.textContent = `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
  option.selected = midi === 36;
  root.append(option);
}

function buttons() {
  play.disabled = !current || player.playing;
  stop.disabled = !player.playing;
  download.disabled = !current;
  send.disabled = !current || !sendReady || sender.busy;
}

function drawWave(samples) {
  const canvas = byId('waveform');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#30291f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let bar = 0; bar <= 4; bar++) {
    const x = bar * canvas.width / 4;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
  }
  ctx.stroke();
  ctx.strokeStyle = '#ff8b3d';
  ctx.beginPath();
  const stride = Math.ceil(samples.length / canvas.width);
  for (let x = 0; x < canvas.width; x++) {
    let peak = 0;
    for (let n = x * stride; n < Math.min(samples.length, (x + 1) * stride); n++) {
      peak = Math.max(peak, Math.abs(samples[n]));
    }
    ctx.moveTo(x, 80 - peak * 72);
    ctx.lineTo(x, 80 + peak * 72);
  }
  ctx.stroke();
}

function renderCurrent() {
  player.stop();
  current = null;
  try {
    const options = { bpm: Number(tempo.value), root: Number(root.value), seed: Number(seed.value) };
    if (!tempo.value || !seed.value) throw new Error('Enter a tempo and a seed.');
    const samples = renderLoop({ ...options, sampleRate });
    current = { samples, bytes: encodeWav(samples, sampleRate), options };
    drawWave(samples);
    byId('duration').textContent = `4 bars / ${(samples.length / sampleRate).toFixed(1)} s`;
    status.textContent = 'Ready. The same seed and settings always make the same loop.';
  } catch (error) {
    status.textContent = error.message;
  }
  buttons();
}

for (const input of [tempo, root, seed]) input.addEventListener('change', renderCurrent);
byId('new-seed').addEventListener('click', () => {
  seed.value = String(crypto.getRandomValues(new Uint32Array(1))[0]);
  renderCurrent();
});
play.addEventListener('click', async () => {
  if (!current) return;
  try {
    const starting = player.play(current.samples, sampleRate);
    buttons();
    status.textContent = 'Starting audio…';
    if (await starting) status.textContent = 'Playing your four-bar loop.';
  } catch (error) {
    status.textContent = `Audio could not start: ${error.message}`;
  }
  buttons();
});
stop.addEventListener('click', () => {
  player.stop();
  status.textContent = 'Stopped.';
  buttons();
});

function exported() {
  if (!current) throw new Error('Choose valid settings first.');
  const { bpm, seed: patternSeed } = current.options;
  return { blob: new Blob([current.bytes], { type: 'audio/wav' }),
    filename: `clanker-loop-${bpm}bpm-seed-${patternSeed}.wav`,
    title: `Clanker loop · ${bpm} BPM · seed ${patternSeed}` };
}

download.addEventListener('click', () => {
  const { blob, filename } = exported();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = 'WAV ready. Add it through David’s LOCAL tab.';
});

async function checkMusic() {
  if (sender.busy) return;
  const availability = await sender.availability();
  sendReady = availability.ready;
  sendStatus.textContent = availability.message;
  buttons();
}
send.addEventListener('click', async () => {
  if (!current || sender.busy) return;
  const { blob, title, filename } = exported();
  const sending = sender.send(blob, title, filename);
  buttons();
  sendStatus.textContent = 'Uploading through your shell, then handing the loop to music…';
  try {
    await sending;
    sendStatus.textContent = 'Sent to your music app. Start playback there when you’re ready.';
  } catch (error) {
    sendStatus.textContent = error.message;
  }
  buttons();
});

window.addEventListener('focus', checkMusic);
window.addEventListener('pagehide', () => player.stop());
renderCurrent();
void checkMusic();
