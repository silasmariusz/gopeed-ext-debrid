// A TTL cache over gopeed.storage. Gopeed stores strings only, so each entry is JSON: {"v": <value>, "exp": <ms>}.
// A missing, corrupt or expired entry is a miss, and an expired one is removed when it is read.

function store() {
  return gopeed.storage;
}

async function entry(key) {
  const raw = await store().get(key);
  if (raw === null || raw === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.exp !== 'number' || !('v' in parsed)) return null;
  if (Date.now() >= parsed.exp) {
    await store().remove(key);
    return null;
  }
  return parsed;
}

export async function remember(key, value, ttlMs) {
  await store().set(key, JSON.stringify({ v: value, exp: Date.now() + ttlMs }));
}

export async function recall(key) {
  const hit = await entry(key);
  return hit ? hit.v : null;
}

// Serves the stored value until ttlMs has passed, then calls loader() again. A loader that throws stores nothing,
// and neither does one that returns undefined. A failed write is logged and the loaded value is returned anyway.
export async function cached(key, ttlMs, loader) {
  const hit = await entry(key);
  if (hit) return hit.v;
  const value = await loader();
  if (value !== undefined) {
    // Best effort: a value that cannot be stored is still returned (and loaded again next time).
    try {
      await remember(key, value, ttlMs);
    } catch (e) {
      try {
        gopeed.logger.warn(`debrid: ${key} could not be stored: ${e && e.message !== undefined ? e.message : e}`);
      } catch (e2) {
        // no logger
      }
    }
  }
  return value;
}

// Removes the entries under the given key prefixes that have expired or cannot be read. recall() removes an expired
// entry only when that key is read again, and some keys never are (the records of finished tasks), while Gopeed
// reads and rewrites the whole storage map on every access. It runs at most once per everyMs: the time of the last
// sweep is kept under sweep:at, and it returns how many entries it removed (0 when it did not run).
export async function sweep(prefixes, everyMs) {
  if (await recall('sweep:at')) return 0;
  await remember('sweep:at', Date.now(), everyMs);
  const keys = await store().keys();
  let removed = 0;
  for (let i = 0; keys && i < keys.length; i++) {
    const key = String(keys[i]);
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    const raw = await store().get(key);
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.exp !== 'number' || Date.now() >= parsed.exp) {
      await store().remove(key);
      removed++;
    }
  }
  return removed;
}
