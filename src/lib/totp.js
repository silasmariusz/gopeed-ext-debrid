// TOTP (RFC 6238) for Rapidgator's two-factor login, in plain JS: goja has no WebCrypto and no BigInt is needed.
// SHA-1 (FIPS 180-4), HMAC-SHA1 (RFC 2104), base32 (RFC 4648) and the dynamic truncation of HOTP (RFC 4226).
// Bytes are arrays of numbers 0..255.
//
// The defaults are the ones authenticator apps use: a 30 s step, 6 digits, SHA-1. Rapidgator's docs do not name the
// algorithm or the step (UNVERIFIED, docs/notes/2026-10-02-hoster-apis.md).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

export function sha1(bytes) {
  const msg = bytes.slice();
  const bitLength = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // The 64-bit length, big-endian. The high word is computed by division, so lengths above 2^32 bits stay right.
  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  msg.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  msg.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const out = [];
  for (const h of [h0, h1, h2, h3, h4]) out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  return out;
}

export function sha1Hex(bytes) {
  return sha1(bytes).map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
}

export function hmacSha1(key, message) {
  let k = key.length > 64 ? sha1(key) : key.slice();
  while (k.length < 64) k.push(0);
  const inner = sha1(k.map((b) => b ^ 0x36).concat(message));
  return sha1(k.map((b) => b ^ 0x5c).concat(inner));
}

// The bytes of a base32 secret, as authenticator apps show it: any case, spaces and "=" padding allowed. null when
// it is empty or has another character.
export function base32Decode(text) {
  const clean = String(text === undefined || text === null ? '' : text).replace(/[\s=]+/g, '').toUpperCase();
  if (!clean) return null;
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) return null;
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return out.length ? out : null;
}

// The code for the time timeMs (milliseconds since 1970), as a string of `digits` digits.
export function totp(keyBytes, timeMs, { step = 30, digits = 6 } = {}) {
  const counter = Math.floor(timeMs / 1000 / step);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  const msg = [(hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
  const h = hmacSha1(keyBytes, msg);
  const o = h[19] & 0x0f;
  const bin = ((h[o] & 0x7f) * 0x1000000) + (h[o + 1] << 16) + (h[o + 2] << 8) + h[o + 3];
  const code = String(bin % Math.pow(10, digits));
  return code.length < digits ? '0'.repeat(digits - code.length) + code : code;
}
