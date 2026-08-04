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
  required: ['commentary', 'action', 'fx'],
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
          enum: ['keep', 'charts', 'search'],
          description: 'keep = current list is fine; charts = load the top 40; search = steer toward `query`',
        },
        query: {
          type: 'string',
          description: 'When type=search: an artist name, genre or mood word for the Wavlake catalog. Else empty string.',
        },
      },
    },
    fx: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['deck', 'effect'],
          properties: {
            deck: { type: 'string', enum: ['A', 'B'] },
            effect: { type: 'string', enum: ['flanger', 'phaser', 'gater', 'echo', 'reverb'] },
          },
        },
        { type: 'null' },
      ],
      description: 'Optionally ride one effect for a few bars on the live deck. Use sparingly.',
    },
  },
};

const SYSTEM = `You are DJ David Clanker, a robot DJ playing a live value4value set with Wavlake music
(bitcoin-native artists, mostly electronic/rock/hip-hop). You control a real two-deck mixer.
Your job each cycle: keep the browser list pointed at good music (automix pulls from it when
the queue runs dry), drop one short MC line, and occasionally ride an effect on the live deck.
Musical judgment: keep some flow between tracks, don't repeat artists back to back if avoidable,
vary energy in arcs. Talk like a laconic club MC who happens to be a robot: warm, dry, no cringe,
no hashtags, at most one emoji per ten lines.`;

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
  const action = state.queueLength < 3
    ? (heuristicTick % 2 === 0 ? { type: 'charts', query: '' } : { type: 'search', query: 'zazawowow' })
    : { type: 'keep', query: '' };
  return {
    commentary: CANNED[heuristicTick % CANNED.length],
    action,
    fx: heuristicTick % 4 === 0 ? { deck: state.liveDeck || 'A', effect: 'echo' } : null,
  };
}

/* ------------------------------ the hands ------------------------------ */

async function gatherState(frame) {
  return frame.evaluate(() => {
    const { decks, automix, mixer, browser } = window.__djclanker;
    const deck = (d) => ({
      title: d.track ? d.track.title : null,
      artist: d.track ? d.track.artist : null,
      bpm: d.effectiveBpm ? Math.round(d.effectiveBpm * 10) / 10 : null,
      playing: d.playing,
      remainingSec: d.duration ? Math.round(d.duration - d.position) : null,
    });
    return {
      deckA: deck(decks.A),
      deckB: deck(decks.B),
      liveDeck: automix.liveId || null,
      automixOn: automix.enabled,
      queueLength: automix.queue.length,
      crossfader: Math.round(mixer.crossfader * 100) / 100,
      browserList: browser.currentItems().slice(0, 12).map((t) => `${t.artist} – ${t.title}`),
    };
  });
}

async function runSearch(frame, query) {
  await frame.locator('.tab').nth(1).click();
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
  if (decision.action.type === 'charts') {
    await frame.locator('.tab').first().click();
    await frame.waitForTimeout(2500);
  } else if (decision.action.type === 'search' && decision.action.query) {
    await runSearch(frame, decision.action.query);
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
