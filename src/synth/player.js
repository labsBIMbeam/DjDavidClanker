/** Own one local audio session; construction never opens an AudioContext. */
export function createLoopPlayer(createContext = () => new AudioContext()) {
  let current = null;
  const stop = () => {
    if (!current) return;
    const { context, source } = current;
    current = null;
    try { source?.stop(); } catch { /* a source may still be waiting for audio unlock */ }
    source?.disconnect();
    void context.close().catch(() => {});
  };
  return {
    get playing() { return Boolean(current); },
    stop,
    async play(samples, sampleRate) {
      stop();
      const context = createContext();
      const session = { context, source: null };
      current = session;
      try {
        const buffer = context.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        session.source = source;
        source.buffer = buffer;
        source.loop = true;
        source.connect(context.destination);
        await context.resume();
        if (current !== session) return false;
        source.start();
        return true;
      } catch (error) {
        if (current !== session) return false;
        stop();
        throw error;
      }
    },
  };
}
