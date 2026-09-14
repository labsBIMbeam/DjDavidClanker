/**
 * Napplet-artifact stand-in for ambient.js (swapped in by build/sandbox-purge.js).
 *
 * Inside a NIP-5D host the iframe is `sandbox="allow-scripts"` with an opaque
 * origin and `connect-src 'none'`: direct fetch is blocked, localStorage throws
 * and there is no NIP-07 signer. These stand-ins behave exactly like that, so
 * every caller keeps its existing degrade path, and the bundle carries no
 * forbidden browser authority for the conformance scanner to find.
 */

/** No direct network inside a napplet; bytes come through the resource domain. */
export const ambientFetch = () =>
  Promise.reject(new Error('No direct network inside a napplet: the host resource domain carries bytes'));

/** No origin storage inside a napplet; callers fall back to memory. */
export const ambientStorage = () => {
  throw new Error('No origin storage inside a napplet: the host storage domain keeps settings');
};

/** No browser signer inside a napplet; the shell signs via outbox/relay. */
export const ambientSigner = () => undefined;
