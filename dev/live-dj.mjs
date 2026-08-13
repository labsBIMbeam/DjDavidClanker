/**
 * DJ David Clanker — live. An LLM-driven driver that plays the real app.
 *
 * The napplet is sandboxed with no network, so the "brain" has to live
 * outside: this script drives the same `window.__djclanker` handle the E2E
 * suites use. Claude curates (what to play next, when to talk, when to touch
 * an effect); the engine keeps the mechanics deterministic (automix does the
 * beatmatching and crossfading, DROP/SYNC stay sample-accurate).
 *
 *   node dev/serve-shell.mjs        (running)
 *   node dev/live-dj.mjs            (headed — sound comes out of your box)
 *
 * Env: HEADLESS=1 (no window), CYCLE_MS (default 25000), MAX_CYCLES (0 = ∞).
 * Credentials resolve like every Anthropic SDK app (ANTHROPIC_API_KEY or an
 * `ant auth login` profile). Without credentials the DJ still runs in a
 * heuristic mode — less witty, same mixing.
 */

import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';

const BASE = process.env.BASE || 'http://127.0.0.1:5178';
const CYCLE_MS = parseInt(process.env.CYCLE_MS || '25000', 10);
const MAX_CYCLES = parseInt(process.env.MAX_CYCLES || '0', 10);
const HEADLESS = process.env.HEADLESS === '1';

/* ------------------------------ the brain ------------------------------ */

let claude = null;
try {
  claude = new Anthropic();
} catch {
  console.log('[dj] no Anthropic credentials — running in heuristic mode');
}

const DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commentary', 'action', 'style', 'order', 'fx'],
  properties: {
    commentary: {
      type: 'string',
      description: 'One short MC line for the crowd (max ~120 chars). Dry, warm, bitcoin-orange humor. No hashtags.',
    },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'query'],
      properties: {
        type: {
          type: 'string',
          enum: ['keep', 'charts', 'search', 'server', 'audius', 'archive'],
          description: 'keep = current list is fine; charts = Wavlake top 40; search = Wavlake search; server = your own crate (query optional, empty = random 30); audius = Audius (empty query = trending); archive = dig archive.org netlabels for `query` (finds auto-promote into the crate)',
        },
        query: {
          type: 'string',
          description: 'Search term for search/server/audius/archive. Empty string otherwise.',
        },
      },
    },
    style: {
      type: 'string',
      enum: ['', 'auto', 'blend', 'cut', 'echo', 'fade'],
      description: 'Transition style override; empty = leave as is. auto plans per pair (default). Switch only with a musical reason.',
    },
    order: {
      type: 'string',
      enum: ['', 'smart', 'list', 'shuffle'],
      description: 'Queue order; empty = leave as is. smart picks by key/BPM/energy continuity (recommended).',
    },
    fx: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['deck', 'effect'],
          properties: {
            deck: { type: 'string', enum: ['A', 'B'] },
            effect: {
              type: 'string',
              enum: ['flanger', 'phaser', 'gater', 'echo', 'reverb',
                'macro:echo', 'macro:space', 'macro:noise', 'macro:gate', 'macro:barber'],
            },
          },
        },
        { type: 'null' },
      ],
      description: 'Optionally ride one effect for a few bars on the live deck. macro:* are the one-knob combos (punched in/out). Use sparingly.',
    },
  },
};

const SYSTEM = `You are DJ David Clanker, a robot DJ playing a live value4value set. You control a real
two-deck mixer with a phrase-aware auto-DJ underneath: tracks are analyzed (BPM, Camelot key,
structure), transitions land sample-accurately on phrase boundaries with a bass swap, and the
SMART order picks harmonically compatible continuations from the queue on its own.
Your sources, by role: Wavlake charts/search (bitcoin-native artists, zaps flow while you play),
"server" = the crate — the curated home library; "audius" = spontaneous digging with a DJ-heavy
catalog (empty query = trending); "archive" = archive.org netlabels — anything you play from
there is automatically promoted into the crate for next time.
Each cycle: keep the browser list pointed at good music (automix refills from it), drop one
short MC line, occasionally ride an effect. The state shows each deck's Camelot key and the
planned transition — prefer steering toward keys near the live deck's. Leave style=auto and
order=smart unless you have a musical reason. Talk like a laconic club MC who happens to be a
robot: warm, dry, no cringe, no hashtags, at most one emoji per ten lines.`;

async function decideLLM(state) {
  const msg = await claude.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: DECISION_SCHEMA },
    },
    messages: [{
      role: 'user',
      content: `Current state of the decks:\n${JSON.stringify(state, null, 2)}\n\nDecide this cycle.`,
    }],
  });
  if (msg.stop_reason === 'refusal') {
    console.log('[dj] model declined this cycle — using heuristic');
    return null;
  }
  const text = msg.content.find((b) => b.type === 'text');
  return text ? JSON.parse(text.text) : null;
}

const CANNED = [
  'Signal locked. Decks are warm.',
  'This one goes out to every node still standing.',
  'Sats in, music out. That is the whole machine.',
  'Hold your position — the drop knows where you live.',
  'Two decks, one chain, zero rehearsals.',
];
let heuristicTick = 0;

function decideHeuristic(state) {
  heuristicTick++;
  let action = { type: 'keep', query: '' };
  if (state.queueLength < 3) action = { type: 'charts', query: '' };
  else if (heuristicTick % 6 === 2) action = { type: 'audius', query: '' };
  else if (heuristicTick % 6 === 4) action = { type: 'server', query: '' };
  return {
    commentary: CANNED[heuristicTick % CANNED.length],
    action,
    style: '',
    order: heuristicTick === 1 ? 'smart' : '',
    fx: heuristicTick % 4 === 0 ? { deck: state.liveDeck || 'A', effect: 'macro:echo' } : null,
  };
}

/* ------------------------------ the hands ------------------------------ */

async function gatherState(frame) {
  return frame.evaluate(() => {
    const { decks, automix, mixer, browser, analysisCache } = window.__djclanker;
    const deck = (d) => ({
      title: d.track ? d.track.title : null,
      artist: d.track ? d.track.artist : null,
      bpm: d.effectiveBpm ? Math.round(d.effectiveBpm * 10) / 10 : null,
      key: d.musicalKey ? d.musicalKey.camelot : null,
      structureConfidence: d.structure && d.structure.ok
        ? Math.round(d.structure.confidence * 100) / 100 : null,
      playing: d.playing,
      remainingSec: d.duration ? Math.round(d.duration - d.position) : null,
    });
    const status = automix.describe();
    return {
      deckA: deck(decks.A),
      deckB: deck(decks.B),
      liveDeck: automix.liveId || null,
      automixOn: automix.enabled,
      transition: { style: automix.transitionStyle, order: automix.order, plan: status.detail || status.label },
      lastTransition: automix.lastTransition ? automix.lastTransition.style : null,
      queueLength: automix.queue.length,
      crossfader: Math.round(mixer.crossfader * 100) / 100,
      browserList: browser.currentItems().slice(0, 12).map((t) => {
        const e = analysisCache.getAnalysis(analysisCache.trackCacheId(t));
        const tag = e && e.bpm ? ` [${Math.round(e.bpm)}]` : '';
        return `${t.artist} – ${t.title}${tag}`;
      }),
    };
  });
}

async function runSearch(frame, query) {
  await frame.locator('.tab', { hasText: 'Search' }).click();
  await frame.locator('.search-input').first().fill(query);
  await frame.locator('.side-group .btn-primary').click();
  await frame.locator('.browser-h1', { hasText: `Search: ${query}` }).waitFor({ timeout: 20000 }).catch(() => {});
  // Prefer the artist view when the search surfaced artists — full discographies
  // beat one-off title matches for set flow.
  const chip = frame.locator('.side-group .crate-row .chip').first();
  if (await chip.count()) {
    await chip.click();
    await frame.waitForTimeout(2500);
  }
}

async function applyDecision(page, frame, decision) {
  const a = decision.action;
  if (a.type === 'charts') {
    await frame.locator('.tab').first().click();
    await frame.waitForTimeout(2500);
  } else if (a.type === 'search' && a.query) {
    await runSearch(frame, a.query);
  } else if (a.type === 'server') {
    await frame.locator('.tab', { hasText: 'Server' }).click();
    if (a.query) {
      await frame.locator('.server-search').fill(a.query);
      await frame.locator('.server-search').press('Enter');
    }
    await frame.waitForTimeout(2500);
  } else if (a.type === 'audius') {
    await frame.locator('.tab', { hasText: 'Discover' }).click();
    if (a.query) {
      await frame.locator('.audius-search').fill(a.query);
      await frame.locator('.side-group .btn-primary').first().click();
    } else {
      await frame.locator('.side-group .chip', { hasText: 'Trending' }).click();
    }
    await frame.waitForTimeout(3500);
  } else if (a.type === 'archive' && a.query) {
    await frame.locator('.tab', { hasText: 'Discover' }).click();
    await frame.locator('.archive-search').fill(a.query);
    await frame.locator('.side-group .btn-primary').nth(2).click();
    // Items arrive as side chips; open the first find so tracks hit the list.
    const item = frame.locator('.side-group .chip', { hasText: '💿' }).first();
    await item.waitFor({ timeout: 30000 }).catch(() => {});
    if (await item.count()) {
      await item.click();
      await frame.waitForTimeout(3000);
    }
  }

  if (decision.style) {
    await frame.evaluate((s) => { window.__djclanker.automix.transitionStyle = s; }, decision.style);
    console.log(`[mix] transition style → ${decision.style}`);
  }
  if (decision.order) {
    await frame.evaluate((o) => { window.__djclanker.automix.order = o; }, decision.order);
    console.log(`[mix] queue order → ${decision.order}`);
  }

  if (decision.commentary) {
    await frame.evaluate((line) => window.__djclanker.toast(`🎙 ${line}`, 'ok', 8000), decision.commentary);
    console.log(`[mc] ${decision.commentary}`);
  }

  if (decision.fx && decision.fx.deck) {
    const { deck, effect } = decision.fx;
    await frame.evaluate(([id, fx]) => window.__djclanker.decks[id].toggleFx(fx, true), [deck, effect]);
    setTimeout(() => {
      frame.evaluate(([id, fx]) => window.__djclanker.decks[id].toggleFx(fx, false), [deck, effect]).catch(() => {});
    }, 9000);
    console.log(`[fx] ${effect} on deck ${deck} for a few bars`);
  }
}

async function ensureAutomix(frame) {
  await frame.evaluate(() => {
    const { automix, browser } = window.__djclanker;
    automix.syncTempo = true;
    if (!automix.queue.length) automix.setQueue(browser.currentItems());
    if (!automix.enabled) automix.toggle();
  });
}

/* ------------------------------ the set ------------------------------ */

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const frame = await (await page.waitForSelector('#frame')).contentFrame();
await frame.waitForSelector('.track-row', { timeout: 30000 });
await frame.locator('.tab').first().click();

console.log(`[dj] on air — ${claude ? 'Claude Opus 5 behind the decks' : 'heuristic mode'} (${HEADLESS ? 'headless' : 'headed'})`);
await ensureAutomix(frame);

let cycle = 0;
for (;;) {
  cycle++;
  const state = await gatherState(frame);
  console.log(`[state] live=${state.liveDeck} A="${state.deckA.title}" B="${state.deckB.title}" queue=${state.queueLength}`);

  let decision = null;
  if (claude) {
    try {
      decision = await decideLLM(state);
    } catch (e) {
      console.log(`[dj] LLM cycle failed (${e.constructor.name}: ${e.message}) — heuristic fallback`);
      if (/authentication method|status 401/i.test(String(e.message))) {
        claude = null; // no credentials — stop asking every cycle
        console.log('[dj] credentials unavailable — staying in heuristic mode');
      }
    }
  }
  if (!decision) decision = decideHeuristic(state);
  console.log(`[decision] ${decision.action.type}${decision.action.query ? `:"${decision.action.query}"` : ''}`);

  await applyDecision(page, frame, decision);
  await ensureAutomix(frame);

  if (MAX_CYCLES && cycle >= MAX_CYCLES) break;
  await page.waitForTimeout(CYCLE_MS);
}

console.log('[dj] set finished');
await browser.close();
