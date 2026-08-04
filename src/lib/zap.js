/**
 * Value4Value payouts per track.
 *
 * Constraint worth stating plainly: NIP-5D exposes **no payment domain and no
 * sign-only API**. A napplet cannot open a wallet, and cannot produce a signed
 * kind-9734 zap request without also publishing it. So this module offers two
 * routes and lets the user pick:
 *
 *   'lnurl'  (default) — plain LNURL-pay to the artist's lightning address
 *                        with the boost message as an LNURL comment. No event
 *                        is signed or published. No zap receipt on Nostr.
 *
 *   'nip57'            — a real NIP-57 zap. The 9734 request is signed by the
 *                        shell via `outbox.publish`, which as a side effect
 *                        also broadcasts it. Produces a proper 9735 receipt.
 *
 * Either way the invoice is handed off: WebLN if present, otherwise a
 * `lightning:` URI through `link.open`, plus the bolt11 string for manual
 * copy / QR.
 */

import { fetchJson, getProfile, publishEvent, openLink, has } from './nap.js';
import { npubToHex } from './bech32.js';
import { bech32Decode } from './bech32.js';
import { resolveNpub } from './wavlake.js';

const DEFAULT_RELAYS = ['wss://relay.wavlake.com', 'wss://relay.damus.io', 'wss://nos.lol'];

function lud16ToUrl(lud16) {
  const [name, domain] = String(lud16).split('@');
  if (!name || !domain) return '';
  const host = domain.replace(/^www\./, '');
  return `https://${host}/.well-known/lnurlp/${name}`;
}

function lud06ToUrl(lud06) {
  const d = bech32Decode(lud06);
  if (!d || d.hrp !== 'lnurl') return '';
  return new TextDecoder().decode(d.bytes);
}

/**
 * Find where a track's sats should go.
 * @returns {Promise<{pubkey:string, lnurl:string, address:string, name:string}|null>}
 */
export async function resolveRecipient(track) {
  const npub = await resolveNpub(track);
  const pubkey = npubToHex(npub);
  if (!pubkey) return null;

  const profile = await getProfile(pubkey);
  const address = (profile && (profile.lud16 || profile.lightningAddress)) || '';
  const lnurl16 = address ? lud16ToUrl(address) : '';
  const lnurl06 = profile && profile.lud06 ? lud06ToUrl(profile.lud06) : '';

  return {
    pubkey,
    npub,
    address,
    lnurl: lnurl16 || lnurl06,
    name: (profile && (profile.display_name || profile.name)) || track.artist || '',
  };
}

/** Fetch and validate the LNURL-pay parameters. */
export async function lnurlParams(lnurl) {
  const params = await fetchJson(lnurl);
  if (!params || params.status === 'ERROR') {
    throw new Error((params && params.reason) || 'LNURL endpoint error');
  }
  if (params.tag !== 'payRequest' || !params.callback) throw new Error('Kein gültiger LNURL-pay Endpoint');
  return params;
}

/**
 * Build the invoice for a zap.
 * @returns {Promise<{invoice:string, params:object, mode:string}>}
 */
export async function createInvoice(track, {
  amountSats = 210,
  comment = '',
  mode = 'lnurl',
  recipient = null,
  relays = DEFAULT_RELAYS,
} = {}) {
  const rec = recipient || (await resolveRecipient(track));
  if (!rec || !rec.lnurl) {
    const err = new Error('Für diesen Artist ist keine Lightning-Adresse im Nostr-Profil hinterlegt.');
    err.code = 'NO_LNURL';
    throw err;
  }

  const params = await lnurlParams(rec.lnurl);
  const msats = Math.round(amountSats * 1000);
  if (params.minSendable && msats < params.minSendable) {
    throw new Error(`Minimum sind ${Math.ceil(params.minSendable / 1000)} sats`);
  }
  if (params.maxSendable && msats > params.maxSendable) {
    throw new Error(`Maximum sind ${Math.floor(params.maxSendable / 1000)} sats`);
  }

  const url = new URL(params.callback);
  url.searchParams.set('amount', String(msats));

  let usedMode = 'lnurl';
  if (mode === 'nip57' && params.allowsNostr && params.nostrPubkey && (has('outbox') || has('relay'))) {
    const zapRequest = {
      kind: 9734,
      created_at: Math.floor(Date.now() / 1000),
      content: comment || '',
      tags: [
        ['relays', ...relays],
        ['amount', String(msats)],
        ['lnurl', rec.lnurl],
        ['p', rec.pubkey],
        ['r', track.pageUrl],
        ['client', 'dj-david-clanker'],
      ],
    };
    // The shell signs on publish; we keep the signed copy for the callback.
    const res = await publishEvent(zapRequest);
    const signed = res && res.event;
    if (signed && signed.sig) {
      url.searchParams.set('nostr', JSON.stringify(signed));
      usedMode = 'nip57';
    }
  }

  if (usedMode === 'lnurl' && comment && params.commentAllowed) {
    url.searchParams.set('comment', comment.slice(0, params.commentAllowed));
  }

  const res = await fetchJson(url.toString());
  if (!res || res.status === 'ERROR' || !res.pr) {
    throw new Error((res && res.reason) || 'Keine Invoice erhalten');
  }
  return { invoice: res.pr, params, mode: usedMode, recipient: rec };
}

/**
 * Hand the invoice to a wallet.
 * @returns {Promise<{method:string, ok:boolean, preimage?:string}>}
 */
export async function payInvoice(invoice) {
  if (typeof window !== 'undefined' && window.webln) {
    try {
      await window.webln.enable();
      const r = await window.webln.sendPayment(invoice);
      return { method: 'webln', ok: true, preimage: r && r.preimage };
    } catch (e) {
      if (/user reject|denied/i.test(e.message || '')) return { method: 'webln', ok: false };
    }
  }
  const ok = await openLink(`lightning:${invoice}`, 'Zap bezahlen');
  return { method: 'link', ok };
}

/** Last resort when the artist has no lightning address: Wavlake's own boost UI. */
export async function openWavlakeBoost(track) {
  return openLink(track.pageUrl, `Boost ${track.artist} auf Wavlake`);
}
