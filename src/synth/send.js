import { intent, upload } from '@napplet/sdk';

const CONVENTION = 'napplet:music/open';

/** Route a rendered file through host upload and the proposed music convention. */
export function createMusicSender({
  intentApi = intent, uploadApi = upload,
  getHost = () => typeof window === 'undefined' ? undefined : window.napplet,
  timeoutMs = 60000,
} = {}) {
  let busy = false;
  const availability = async () => {
    const host = getHost();
    if (!host?.intent || !host?.upload) return {
      ready: false, message: 'Send needs a shell with upload and intent support. Download WAV is available.',
    };
    try {
      const result = await intentApi.available('music');
      const compatible = (candidate) => candidate.actions?.includes('open')
        && candidate.conventions?.includes(CONVENTION);
      const defaultApp = result.candidates?.find((candidate) => candidate.isDefault);
      if (defaultApp && !compatible(defaultApp)) return {
        ready: false, message: 'Your default music app cannot receive this loop. '
          + 'Choose a compatible default in your shell, or download the WAV.',
      };
      const ready = result.available && result.candidates?.some(compatible);
      return { ready: Boolean(ready), message: ready ? 'Ready to send to a music app.'
        : 'No compatible music app is installed. Download WAV is available.' };
    } catch {
      return { ready: false, message: 'The shell could not check music apps. Download WAV is available.' };
    }
  };
  const completeUpload = async (request) => {
    let active = true;
    let subscription;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        let uploadId;
        const accept = (result) => {
          if (!active || result.uploadId !== uploadId) return;
          if (!result.ok || ['failed', 'cancelled'].includes(result.status)) {
            reject(new Error(result.error || 'The host upload was not completed.'));
          } else if (result.status === 'complete') resolve(result);
        };
        timer = setTimeout(() => reject(new Error(
          'Upload timed out. The host may still finish it; no music intent was sent.')), timeoutMs);
        Promise.resolve().then(() => uploadApi.upload(request)).then((result) => {
          if (!active) return;
          uploadId = result.uploadId;
          accept(result);
          if (!result.ok || ['complete', 'failed', 'cancelled'].includes(result.status)) return;
          subscription = uploadApi.onStatus(accept);
          // Read after subscribing so completion between the reply and listener is not lost.
          return uploadApi.status(uploadId).then(accept);
        }).catch(reject);
      });
    } finally {
      active = false;
      clearTimeout(timer);
      subscription?.close();
    }
  };
  return {
    availability,
    get busy() { return busy; },
    async send(blob, title, filename = 'clanker-loop.wav') {
      if (busy) throw new Error('A send is already in progress.');
      busy = true;
      try {
        const state = await availability();
        if (!state.ready) throw new Error(state.message);
        const uploaded = await completeUpload({
          data: blob, mimeType: 'audio/wav', filename, noTransform: true,
        });
        if (!uploaded.ok || uploaded.status !== 'complete') {
          throw new Error(uploaded.error || 'The host upload did not complete.');
        }
        const url = new URL(uploaded.url);
        if (url.protocol !== 'https:' || url.username || url.password || uploaded.url.includes('#')
          || url.href.length > 4096) throw new Error('The upload did not return a usable HTTPS URL.');
        const dispatched = await intentApi.invoke({
          archetype: 'music', action: 'open', convention: CONVENTION,
          payload: { version: 1, tracks: [{ url: uploaded.url, title, artist: 'Clanker Synth' }] },
        });
        if (!dispatched.ok || !dispatched.handled) {
          throw new Error('Upload finished, but the music app did not accept the handoff.');
        }
        return dispatched;
      } finally {
        busy = false;
      }
    },
  };
}
