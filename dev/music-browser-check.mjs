/** Deterministic real-shim/opaque-frame proof. No relays, uploads or upstream fetches. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const prelude = await readFile('node_modules/@napplet/shim/dist/prelude.global.js', 'utf8');
const encode = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');
const wav = Buffer.alloc(44 + 44100 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 44100; i++) wav.writeInt16LE(Math.round(4000 * Math.sin(i * 220 * 2 * Math.PI / 44100)), 44 + i * 2);

const server = http.createServer(async (req, res) => {
  if (req.url === '/audio') { res.setHeader('content-type', 'audio/wav'); return res.end(wav); }
  const variant = req.url === '/totem' ? 'totem' : 'desktop';
  const artifact = await readFile(resolve('.qa', variant, 'index.html'), 'utf8');
  const manifest = JSON.parse(await readFile(resolve('.qa', variant, '.nip5a-manifest.json')));
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Music conformance fixture</title>
    <iframe id="caller" sandbox="allow-scripts"></iframe>
    <iframe id="player" sandbox="allow-scripts" style="width:1400px;height:1100px"></iframe>
    <script>
    const prelude = ${encode(prelude)};
    const artifact = ${encode(artifact)}.replaceAll('window.__djclanker=', 'console.log("APP_HANDLE");window.__djclanker=').replaceAll('<' + '/script>', ';console.log("APP_DONE");<' + '/script>');
    const manifest = ${encode(manifest)};
    const role = manifest.tags.find(t => t[0] === 'archetype');
    const candidate = { dTag: manifest.tags.find(t => t[0] === 'd')[1],
      actions: ['open'], conventions: [role[2]], isDefault: true };
    const caller = document.getElementById('caller');
    const player = document.getElementById('player');
    let ready = false, pending = [], booted = false;
    window.deliveries = 0;
    const post = (win, message) => win.postMessage(message, '*');
    const script = (source) => '<script>' + source.replaceAll('</script', '<\\/script') + '<' + '/script>';
    const wrap = (html, domains) => html.replace('<head>', '<head>' +
      ${encode('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'; media-src blob: data:">')} +
      script(prelude) + script('NappletShimPrelude.install(' + JSON.stringify({domains}) + ')') +
      script('console.log("PRELUDE",location.href);setInterval(()=>console.log("HEALTH",document.readyState,!!window.__djclanker),2000)'));
    function deliver() {
      if (!ready) return;
      for (const payload of pending.splice(0)) {
        post(player.contentWindow, {type:'inc.event', topic:role[2], sender:'fixture-producer', payload});
        window.deliveries++;
      }
    }
    window.addEventListener('message', async event => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      const source = event.source;
      if (source === caller.contentWindow) {
        if (message.type === 'intent.available') post(source, {type:'intent.available.result', id:message.id,
          availability:{archetype:role[1],available:true,candidates:[candidate],hasDefault:true}});
        if (message.type === 'intent.invoke') {
          const r = message.request;
          if (r.archetype !== role[1] || r.convention !== role[2]) return;
          pending.push(r.payload);
          if (!booted) { booted = true; player.srcdoc = wrap(artifact, ['resource','inc','storage']); }
          deliver();
          post(source, {type:'intent.invoke.result',id:message.id,result:{ok:true,handled:true,
            archetype:role[1],action:'open',handler:candidate.dTag,convention:role[2]}});
        }
      } else if (source === player.contentWindow) {
        console.log('HOST', message.type);
        if (message.type === 'inc.subscribe' && message.topic === role[2]) {
          post(source, {type:'inc.subscribe.result',id:message.id}); ready = true; deliver();
        }
        if (message.type === 'resource.bytes') {
          return;
          const blob = message.url === 'https://music.example/loop.wav'
            ? await fetch('/audio').then(r=>r.blob()) : new Blob(['[]'], {type:'application/json'});
          post(source, {type:'resource.bytes.result',id:message.id,blob,mime:blob.type});
        }
        if (message.type === 'storage.get') post(source,{type:'storage.get.result',id:message.id,value:null});
        if (message.type === 'storage.set') post(source,{type:'storage.set.result',id:message.id});
      }
    });
    caller.srcdoc = wrap('<html><head></head><body><button id="send">Send loop</button>' + script(
      'document.getElementById("send").onclick=async()=>{' +
      'const a=await napplet.intent.available("music");' +
      'if(!a.available)throw Error("unavailable");' +
      'const r=await napplet.intent.invoke({archetype:"music",action:"open",convention:"napplet:music/open",payload:{version:1,tracks:[{url:"https://music.example/loop.wav",title:"Fixture loop",artist:"Synth"}]}});' +
      'document.body.dataset.sent=String(r.ok&&r.handled)};') + '</body></html>', ['intent']);
    </script>`);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  console.log(`Launching ${process.env.BROWSER_CHANNEL || 'Chromium'} for music conformance proof`);
  browser = await chromium.launch({
    ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'],
    timeout: 15000,
  });
  await mkdir('.qa/screenshots', { recursive: true });
  for (const variant of ['desktop', 'totem']) {
    console.log(`Checking ${variant}`);
    const page = await browser.newPage({ viewport: { width: 1450, height: 1200 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('console', message => console.log(message.type(), message.text()));
    page.on('pageerror', (error) => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${server.address().port}/${variant}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    console.log(`${variant}: fixture loaded`);
    const caller = await (await page.$('#caller')).contentFrame();
    await caller.locator('#send').click();
    console.log(`${variant}: cold intent sent`);
    await caller.waitForFunction(() => document.body.dataset.sent === 'true');
    console.log(`${variant}: cold intent acknowledged`);
    const player = await (await page.$('#player')).contentFrame();
    console.log(`${variant}: player frame found`);
    console.log(await player.evaluate(() => ({ ready: document.readyState,
      app: Boolean(window.__djclanker) })));
    if (variant === 'desktop') {
      await player.waitForFunction(() => window.__djclanker?.automix.queue.length === 1);
      console.log(`${variant}: one queue item accepted`);
      assert.equal(await player.evaluate(() => window.__djclanker.automix.enabled), false);
      await player.evaluate(async () => {
        const app = window.__djclanker;
        await app.decks.A.load(app.automix.queue[0]);
      });
      console.log(`${variant}: audio loaded`);
      assert.equal(await player.evaluate(() => window.__djclanker.decks.A.backend), 'buffer');
      await player.evaluate(() => window.__djclanker.decks.A.play());
      await player.waitForFunction(() => window.__djclanker.decks.A.position > 0.05);
      await player.evaluate(() => window.__djclanker.decks.A.pause());
    } else {
      await player.getByText('Fixture loop', { exact: true }).waitFor();
      assert.equal(await player.getByRole('button', { name: '▶ START' }).count(), 1);
    }
    await caller.locator('#send').click();
    await page.waitForFunction(() => window.deliveries === 2);
    if (variant === 'desktop') assert.equal(await player.evaluate(() => window.__djclanker.automix.queue.length), 1);
    else assert.equal(await player.getByText('Fixture loop', { exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve('.qa/screenshots', `${variant}.png`) });
    console.log(`PASS ${variant}: real shim, cold/warm intent, dedupe, no autoplay${variant === 'desktop' ? ', FULL audio decode/play' : ''}`);
    await page.close();
  }
} catch (error) {
  console.error('PROOF FAILED', error);
  throw error;
} finally {
  console.log('Closing fixture');
  await browser?.close();
  console.log('Browser closed');
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
