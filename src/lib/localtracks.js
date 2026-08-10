/**
 * Local audio files as deck tracks. The File object rides along in the track;
 * the engine decodes it directly — no network, no CORS, no resource domain,
 * which makes this the one source that is FULL-mode everywhere.
 */

let seq = 0;

/** The scratch-lab listing, already ordered. Empty outside `npm run dev`. */
export async function fetchLabTracks() {
  if (!import.meta.env.DEV) return [];
  try {
    const res = await fetch('/__scratch-lab', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.files || []).map(trackFromLab);
  } catch {
    return []; // the plugin is dev-only; its absence is not an error
  }
}

/**
 * Track for a file the dev server is serving out of ./scratch-lab. Same-origin,
 * so it decodes to a buffer and gets the full platter — see dev/scratch-lab.mjs.
 */
export function trackFromLab({ name, url, size }) {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  return {
    ...trackFromFile({ name }),
    id: `lab-${name}`,
    title: m ? m[2].trim() : base,
    artist: m ? m[1].trim() : 'Scratch lab',
    streamUrls: [url],
    localFile: null,
    labSize: size || 0,
  };
}

/** Build a track object from a File. "Artist - Title.mp3" is split if present. */
export function trackFromFile(file) {
  const base = file.name.replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  return {
    id: `local-${Date.now()}-${seq++}`,
    title: m ? m[2].trim() : base,
    artist: m ? m[1].trim() : 'Local file',
    artistId: '',
    artistUrl: '',
    artistNpub: '',
    albumId: '',
    albumTitle: '',
    artworkUrl: '',
    avatarUrl: '',
    duration: 0,
    streamUrls: [],
    pageUrl: '',
    sats7d: 0,
    satsTotal: 0,
    colorInfo: null,
    localFile: file,
  };
}
