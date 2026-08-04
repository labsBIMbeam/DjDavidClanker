/**
 * NIP-5D host bridge.
 *
 * Inside a napplet shell, `window.napplet` is injected before any napplet
 * script runs and is the ONLY way out of the sandbox: the iframe is
 * `sandbox="allow-scripts"` with `connect-src 'none'`, so there is no fetch(),
 * no WebSocket, no localStorage.
 *
 * Standalone (plain browser tab, `npm run dev`) none of that exists, so every
 * helper here degrades to a native equivalent. That keeps the app testable
 * outside a shell without forking the code paths above this module.
 */

import * as sdk from '@napplet/sdk';

const NS = () => (typeof window !== 'undefined' ? window.napplet : undefined);

/** True when running inside a NIP-5D shell. */
export const inShell = () => Boolean(NS());

/** Domain-presence check. Absence of a domain object means "unavailable". */
export function has(domain) {
  const ns = NS();
  return Boolean(ns && ns[domain]);
}

/** Snapshot of which host domains this napplet actually got. */
export function capabilities() {
  const wanted = ['resource', 'identity', 'storage', 'outbox', 'relay', 'common', 'link', 'media'];
  const out = {};
  for (const d of wanted) out[d] = has(d);
  out.shell = inShell();
  return out;
}

/* ------------------------------------------------------------------ *
 * Network                                                             *
 * ------------------------------------------------------------------ */

/**
 * Fetch a URL as bytes.
 *
 * In-shell: `resource.bytes()` — the shell performs the request, so the
 * napplet is not subject to the origin's CORS policy. This matters a lot
 * here: Wavlake's audio CDN sends no `Access-Control-Allow-Origin`, so a
 * direct browser fetch of an mp3 is impossible.
 *
 * Standalone: plain fetch, which will succeed for the catalog API (CORS on)
 * and fail for the CDN unless a proxy is configured.
 */
export async function fetchBlob(url, { signal, proxy } = {}) {
  if (has('resource')) return sdk.resource.bytes(url, signal ? { signal } : undefined);
  const target = proxy ? proxy.replace('{url}', encodeURIComponent(url)) : url;
  const res = await fetch(target, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.blob();
}

/** Fetch + parse JSON. */
export async function fetchJson(url, opts) {
  const blob = await fetchBlob(url, opts);
  return JSON.parse(await blob.text());
}

/**
 * Fetch bytes and hand back a same-origin `blob:` URL.
 * A blob URL is same-origin by definition, so it can be fed to
 * `decodeAudioData` or an `<audio>` element without CORS trouble.
 */
export async function fetchObjectUrl(url, opts) {
  const blob = await fetchBlob(url, opts);
  const objUrl = URL.createObjectURL(blob);
  return { url: objUrl, size: blob.size, revoke: () => URL.revokeObjectURL(objUrl) };
}

/* ------------------------------------------------------------------ *
 * Storage (512 KB quota in-shell, strings only)                       *
 * ------------------------------------------------------------------ */

const memStore = new Map();

export const store = {
  async get(key) {
    if (has('storage')) {
      try {
        return await sdk.storage.getItem(key);
      } catch {
        return null;
      }
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return memStore.has(key) ? memStore.get(key) : null;
    }
  },
  async set(key, value) {
    if (has('storage')) {
      try {
        return await sdk.storage.setItem(key, value);
      } catch {
        return;
      }
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      memStore.set(key, value);
    }
  },
  async getJson(key, fallback) {
    const raw = await store.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  async setJson(key, value) {
    return store.set(key, JSON.stringify(value));
  },
};

/* ------------------------------------------------------------------ *
 * Identity / Nostr                                                    *
 * ------------------------------------------------------------------ */

export async function getPublicKey() {
  if (!has('identity')) return '';
  try {
    return (await sdk.identity.getPublicKey()) || '';
  } catch {
    return '';
  }
}

export function onIdentityChanged(cb) {
  if (!has('identity')) return { close() {} };
  try {
    return sdk.identity.onChanged(cb);
  } catch {
    return { close() {} };
  }
}

/** Kind-0 profile for an arbitrary pubkey (used to resolve an artist's lud16). */
export async function getProfile(pubkeyHex) {
  if (has('common')) {
    try {
      const res = await sdk.common.getProfile(pubkeyHex);
      // `common.getProfile` resolves the response envelope minus type/id/ok, so
      // the metadata may sit under `.profile`, `.metadata`, or at the top level.
      const p = res && (res.profile || res.metadata || res);
      if (p && typeof p === 'object') return p.content ? safeParse(p.content) : p;
    } catch {
      /* fall through */
    }
  }
  const events = await queryEvents([{ kinds: [0], authors: [pubkeyHex], limit: 1 }]);
  if (!events.length) return null;
  return safeParse(events[0].content);
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** One-shot relay query. Prefers outbox (NIP-65 aware) over the raw relay pool. */
export async function queryEvents(filters, options) {
  // outbox.query resolves `{ events: RelayEventResult[] }`; relay.query may
  // resolve the bare array. Accept either, and unwrap the event envelope.
  const unwrap = (res) => {
    const rows = Array.isArray(res) ? res : res && Array.isArray(res.events) ? res.events : [];
    return rows.map((r) => (r && r.event ? r.event : r)).filter(Boolean);
  };
  if (has('outbox')) {
    try {
      return unwrap(await sdk.outbox.query(filters, options));
    } catch {
      /* fall through */
    }
  }
  if (has('relay')) {
    try {
      return unwrap(await sdk.relay.query(filters));
    } catch {
      /* fall through */
    }
  }
  return [];
}

/**
 * Publish an unsigned event template. The shell signs it — napplets never
 * touch keys and there is no sign-only API in NIP-5D.
 */
export async function publishEvent(template) {
  if (has('outbox')) {
    const res = await sdk.outbox.publish(template, { toOutbox: true });
    if (!res || res.ok === false) throw new Error((res && res.error) || 'publish failed');
    return res;
  }
  if (has('relay')) return sdk.relay.publish(template);
  // Standalone dev: NIP-07 browser extension, if present.
  if (typeof window !== 'undefined' && window.nostr) {
    const signed = await window.nostr.signEvent(template);
    return { ok: true, event: signed, eventId: signed.id, standalone: true };
  }
  throw new Error('No publish capability (no outbox/relay domain, no NIP-07 signer)');
}

/* ------------------------------------------------------------------ *
 * Misc host services                                                  *
 * ------------------------------------------------------------------ */

/** User-visible navigation. Also our escape hatch for `lightning:` URIs. */
export async function openLink(url, label) {
  if (has('link')) {
    try {
      const res = await sdk.link.open(url, label ? { label } : undefined);
      return !res || res.status !== 'denied';
    } catch {
      return false;
    }
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

/** Optional OS/shell transport integration (media keys, lock screen). */
export function mediaSession() {
  if (!has('media')) return null;
  try {
    return sdk.media;
  } catch {
    return null;
  }
}
