/**
 * Ambient browser authority, for the standalone app only.
 *
 * This is the one module that names the browser's own network, storage and
 * signer. The standalone app (`npm run dev`, `npm run build:standalone`) uses
 * it as the fallback when no NIP-5D shell is around.
 *
 * The napplet artifact (`npm run build`) never contains this file: the
 * `sandboxPurge` build plugin (build/sandbox-purge.js) loads
 * `ambient.sandbox.js` in its place, so the published bundle holds no path to
 * fetch, localStorage or window.nostr. Keep both files' exports in step.
 */

/** Direct network request. */
export const ambientFetch = (input, init) => fetch(input, init);

/** Origin storage; throws where the origin has none (opaque sandbox). */
export const ambientStorage = () => localStorage;

/** NIP-07 browser signer, if an extension injected one. */
export const ambientSigner = () => (typeof window !== 'undefined' ? window.nostr : undefined);
