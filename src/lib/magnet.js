// Magnet links: the v1 info-hash as 40 lowercase hex (from hex or base32), the name and the trackers.
// Anything without a valid urn:btih info-hash gives null. Parsed with string splits, not URL, so it runs in goja.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s) {
  let bits = 0;
  let value = 0;
  let hex = '';
  for (const ch of s.toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((value >>> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

function decode(s) {
  const plus = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(plus);
  } catch (e) {
    return plus;
  }
}

function infoHash(xt) {
  const m = /^urn:btih:(.+)$/i.exec(xt);
  if (!m) return null;
  const h = m[1].trim();
  if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(h)) return base32ToHex(h);
  return null;
}

export function parseMagnet(uri) {
  if (typeof uri !== 'string' || !/^magnet:\?/i.test(uri)) return null;
  let hash = null;
  let name = '';
  const trackers = [];
  for (const part of uri.slice(8).split('#')[0].split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    const value = decode(part.slice(eq + 1));
    if (/^xt(\.\d+)?$/.test(key)) {
      if (!hash) hash = infoHash(value);
    } else if (key === 'dn') {
      if (!name) name = value;
    } else if (/^tr(\.\d+)?$/.test(key)) {
      if (value && trackers.indexOf(value) < 0) trackers.push(value);
    }
  }
  if (!hash) return null;
  return { hash, name, trackers };
}
