// The login cooldown. After a provider refuses a credential (an invalid key, a revoked login), the extension makes
// no further call for that provider for 10 minutes, so a wrong key cannot trigger the lockouts and IP bans some
// services apply to repeated failed logins. It never retries a login on its own.
//
// The state is one record per provider under `cooldown:<id>` in gopeed.storage: {h, until, reason}. `h` is a hash of
// the provider id and the credential, so a changed setting (a new key) is a different credential and ends the pause
// at once. The credential itself is never stored. The hash is not cryptographic (goja has no crypto): it only tells
// two credentials apart.
import { recall, remember } from './cache.js';

export const COOLDOWN_MS = 10 * 60 * 1000;

// cyrb53, a 53-bit string hash.
function hashOf(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const keyOf = (id) => `cooldown:${id}`;
const credentialHash = (id, credential) => hashOf(`${id}\u0000${credential === undefined || credential === null ? '' : credential}`);

// A hash of a provider's settings (every field but the on/off switch, plus advanced_api_base), for records that must
// end when the user changes a key, a login or the API base. Field order does not matter. The values are never stored.
export function settingsHash(id, fields, apiBase = '') {
  const parts = Object.keys(fields || {}).filter((k) => k !== 'enabled').sort().map((k) => `${k}=${fields[k] === undefined || fields[k] === null ? '' : fields[k]}`);
  return hashOf(`${id}\u0000${apiBase || ''}\u0000${parts.join('\u0000')}`);
}

// null when the credential is not paused, else { ms, minutes, reason }: the time left, in whole minutes rounded up,
// and the reason the pause started with.
export async function cooldownLeft(id, credential) {
  const record = await recall(keyOf(id));
  if (!record || typeof record !== 'object' || record.h !== credentialHash(id, credential)) return null;
  const ms = Number(record.until) - Date.now();
  if (!(ms > 0)) return null;
  return { ms, minutes: Math.max(1, Math.ceil(ms / 60000)), reason: typeof record.reason === 'string' ? record.reason : '' };
}

// ms is the length of the pause: COOLDOWN_MS unless the service names a longer lock (the Polish REST error 4 locks a
// login for 60 minutes).
export async function startCooldown(id, credential, reason, ms = COOLDOWN_MS) {
  await remember(keyOf(id), { h: credentialHash(id, credential), until: Date.now() + ms, reason: String(reason || '') }, ms);
}
