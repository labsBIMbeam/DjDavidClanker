/**
 * Minimal bech32 (BIP-173) for NIP-19 npub <-> hex.
 * The shell exposes `common.encodeNip19` / `decodeNip19`, but standalone dev
 * runs need a local implementation and it is ~40 lines.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

export function bech32Decode(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const dataChars = s.slice(pos + 1);
  const data = [];
  for (const c of dataChars) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) return null;
    data.push(idx);
  }
  if (polymod(hrpExpand(hrp).concat(data)) !== 1) return null;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  return bytes ? { hrp, bytes: Uint8Array.from(bytes) } : null;
}

export function bech32Encode(hrp, bytes) {
  const data = convertBits(Array.from(bytes), 8, 5, true);
  if (!data) return '';
  const checksum = [];
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((d) => CHARSET[d]).join('')}`;
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** npub / nsec-less bare hex passthrough -> 64-char hex pubkey, or ''. */
export function npubToHex(npub) {
  if (!npub) return '';
  if (/^[0-9a-f]{64}$/i.test(npub)) return npub.toLowerCase();
  const d = bech32Decode(npub);
  if (!d || d.hrp !== 'npub' || d.bytes.length !== 32) return '';
  return toHex(d.bytes);
}

export function hexToNpub(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) return '';
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bech32Encode('npub', bytes);
}
