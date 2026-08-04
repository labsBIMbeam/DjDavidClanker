/**
 * Local audio files as deck tracks. The File object rides along in the track;
 * the engine decodes it directly — no network, no CORS, no resource domain,
 * which makes this the one source that is FULL-mode everywhere.
 */

let seq = 0;

/** Build a track object from a File. "Artist - Title.mp3" is split if present. */
export function trackFromFile(file) {
  const base = file.name.replace(/\.[a-z0-9]+$/i, '');
  const m = base.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  return {
    id: `local-${Date.now()}-${seq++}`,
    title: m ? m[2].trim() : base,
    artist: m ? m[1].trim() : 'Lokale Datei',
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
