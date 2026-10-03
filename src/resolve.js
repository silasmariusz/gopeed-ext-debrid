// onResolve: which provider turns a link into a direct download, and what Gopeed gets back.
//
// Hoster links. The enabled providers are asked in the order of the `order` setting (unknown ids are ignored, the
// ids it leaves out follow in the registry's order). A provider claims a link when the link's host is in its
// hosts(). The lists are loaded at the same time, for 10 s at most, so a link waits for one round of host lists at
// most; a list that fails or is empty claims nothing for 10 minutes (a hoster account keeps its own domains). The
// first provider that claims the link and answers is used. When it fails:
//   - with a credential problem (auth_invalid, cooldown, login_required such as Real-Debrid's device prompt,
//     token_invalid), a dead link or a file password (dead_link, bad_password), or an error that is not a
//     ProviderError, that error is shown and no other provider is asked: another account cannot fix it, and a
//     device prompt must reach the user;
//   - with anything else (not_supported, limit_reached, not_ready, ip_not_allowed, an expired account, a service
//     that is down, a timeout, ...), the next provider that claims the link is asked. When none succeeds, the user
//     sees every reason, joined with "; ".
// No claim leaves ctx.res unset, and Gopeed downloads the link itself. A Mega link no provider claims is refused,
// because Gopeed would save the encrypted bytes.
//
// Magnets (only "magnet:" links; a .torrent URL is an ordinary link). Only debrid providers are asked, in order,
// through cachedMagnet, and the first non-null answer wins. A credential problem stops and is shown (the device
// prompt again); any other error is logged and counts as "not cached". With nothing cached, the label
// rt16.debrid=cached-or-refuse (set by the rtorrent16 shim) gives RT16_NOT_CACHED, so the shim hands the magnet to
// rtorrent; without it, ctx.res stays unset and Gopeed's own BitTorrent engine takes the magnet.
// magnets_via_debrid=false asks no provider at all.
//
// Every direct URL handed out is remembered under orig:<url> for 7 days, for the renewal in renew.js.
// Every MessageError text goes through redact() with the secrets of the settings.
import { PROVIDERS } from './providers/index.js';
import { ProviderError } from './lib/http.js';
import { settings, providerSettings, secretsOf } from './lib/settings.js';
import { redact } from './lib/redact.js';
import { remember, recall, sweep } from './lib/cache.js';
import { hostOf, hostMatches } from './lib/hosts.js';
import { settingsHash } from './lib/cooldown.js';
import { parseMagnet } from './lib/magnet.js';

export const ORIGIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Host lists: all enabled providers load theirs at the same time, each for at most HOSTS_ROUND_MS, so a link waits
// for one round at most. A list that fails to load (or loads empty) is not asked for again for HOSTS_FAIL_MS.
export const HOSTS_ROUND_MS = 10 * 1000;
export const HOSTS_FAIL_MS = 10 * 60 * 1000;
// Storage keys this extension writes with an expiry and never reads again once a task is gone: swept once a day.
export const SWEEP_PREFIXES = ['orig:', 'renewed:', 'magnetfiles:', 'hostsfail:'];
export const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
export const LABEL = 'rt16.debrid';
export const NOT_CACHED = 'RT16_NOT_CACHED';
export const MEGA_TEXT =
  'Mega links are not supported: Mega encrypts files in the browser with a key that never leaves the link, so a ' +
  'download would only save encrypted data';
const MEGA_DOMAINS = ['mega.nz', 'mega.co.nz'];

// The codes that end the search for a hoster link, and for a magnet.
const LINK_STOP = ['auth_invalid', 'cooldown', 'login_required', 'token_invalid', 'dead_link', 'bad_password'];
const MAGNET_STOP = ['auth_invalid', 'cooldown', 'login_required', 'token_invalid'];

// The text with every secret of the settings hidden.
export function clean(text) {
  return redact(text, secretsOf(settings()));
}

export function userError(text) {
  return new MessageError(clean(text));
}

function log(level, text) {
  try {
    gopeed.logger[level](`debrid: ${clean(text)}`);
  } catch (e) {
    // no logger: nothing to say it to
  }
}
export const info = (text) => log('info', text);
export const warn = (text) => log('warn', text);

// "<Title>: <reason>". A ProviderError already reads that way; anything else gets the provider's title.
export function messageOf(provider, err) {
  if (err instanceof ProviderError) return err.message;
  return `${provider.title}: ${textOf(err)}`;
}

export function isMagnet(url) {
  return /^magnet:/i.test(String(url || '').trim());
}

// The providers in the order of the `order` setting. `list` is the registry (tests pass stubs).
export function orderedProviders(list = PROVIDERS) {
  const raw = settings().order;
  const ids = typeof raw === 'string' ? raw.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean) : [];
  const out = [];
  for (const id of ids) {
    const p = list.find((x) => x.id === id);
    if (p && out.indexOf(p) < 0) out.push(p);
  }
  for (const p of list) if (out.indexOf(p) < 0) out.push(p);
  return out;
}

// The enabled providers, in order, each with its settings.
function enabledProviders(list) {
  const out = [];
  for (const p of orderedProviders(list)) {
    const s = providerSettings(p.id);
    let on = false;
    try {
      on = !!p.enabled(s);
    } catch (e) {
      on = false;
    }
    if (on) out.push({ p, s });
  }
  return out;
}

function textOf(err) {
  return err && err.message !== undefined ? String(err.message) : String(err);
}

// The promise, or a rejection after ms.
async function within(promise, ms) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

// The provider's host list, or [] when it cannot be had. A list that cannot be loaded (the service is down, the key
// is paused) or loads empty means "claims nothing": an ordinary download must never fail because of a provider, and
// the failure is remembered under hostsfail:<id> for 10 minutes, so the next links do not wait for it again. A
// hoster account's own domains need no request, so they are used even then. The record holds a hash of the
// provider's settings, so a corrected key or login ends the pause at once.
async function loadHosts(p, s) {
  const failKey = `hostsfail:${p.id}`;
  const h = settingsHash(p.id, s, settings().advanced_api_base);
  let failed = false;
  try {
    const record = await recall(failKey);
    failed = !!record && typeof record === 'object' && record.h === h;
  } catch (e) {
    failed = false;
  }
  if (failed && p.kind !== 'hoster') return [];
  let list;
  try {
    list = await within(Promise.resolve().then(() => p.hosts(s)), HOSTS_ROUND_MS);
  } catch (e) {
    warn(`${messageOf(p, e)} (its host list could not be loaded, so it claims no link for 10 minutes)`);
    list = null;
  }
  if (Array.isArray(list) && list.length) return list;
  if (!failed) {
    try {
      await remember(failKey, { h }, HOSTS_FAIL_MS);
    } catch (e) {
      // best effort: without the record the next link asks again
    }
  }
  return [];
}

// { provider, file } from the first provider that claims the link and answers, or null when none claims it.
// Throws a MessageError as described at the top.
export async function unrestrictLink(url, { providers } = {}) {
  const host = hostOf(url);
  if (!host) return null;
  const enabled = enabledProviders(providers);
  const lists = await Promise.all(enabled.map(({ p, s }) => loadHosts(p, s)));
  const failures = [];
  for (let i = 0; i < enabled.length; i++) {
    const { p, s } = enabled[i];
    if (!hostMatches(host, lists[i])) continue;
    let file;
    try {
      file = await p.unrestrict(s, url);
    } catch (e) {
      const text = messageOf(p, e);
      if (!(e instanceof ProviderError) || LINK_STOP.indexOf(e.code) >= 0) throw userError(text);
      warn(`${text}; asking the next provider`);
      failures.push(text);
      continue;
    }
    if (file && typeof file.url === 'string' && file.url) return { provider: p, file };
  }
  if (failures.length) throw userError(failures.join('; '));
  return null;
}

// { provider, files } from the first debrid provider that has the magnet cached, or null.
export async function findCachedMagnet(magnet, { providers } = {}) {
  for (const { p, s } of enabledProviders(providers)) {
    if (p.kind !== 'debrid') continue;
    let files;
    try {
      files = await p.cachedMagnet(s, magnet);
    } catch (e) {
      const text = messageOf(p, e);
      if (e instanceof ProviderError && MAGNET_STOP.indexOf(e.code) >= 0) throw userError(text);
      warn(`${text}; the magnet counts as not cached there`);
      continue;
    }
    if (Array.isArray(files) && files.length) return { provider: p, files };
  }
  return null;
}

function lastSegment(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(String(url || ''));
  const parts = (m ? m[1] : '').split('/').filter(Boolean);
  if (!parts.length) return '';
  try {
    return decodeURIComponent(parts[parts.length - 1]);
  } catch (e) {
    return parts[parts.length - 1];
  }
}

// Gopeed drops a resource whose file has no name (Resource.Validate), so a name is always set.
export function fileName(file, original) {
  const own = typeof file.name === 'string' ? file.name.trim() : '';
  return own || lastSegment(file.url) || lastSegment(original) || 'download';
}

function toFile(file, original) {
  const size = Number(file.size);
  return {
    name: fileName(file, original),
    size: Number.isFinite(size) && size > 0 ? size : 0,
    req: { url: file.url, extra: { header: Object.assign({}, file.headers || {}) } },
  };
}

// Remembers where a direct URL came from. record: { original, provider } and, for a file of a magnet, file and index.
// Best effort: a storage error is logged, and the link is still handed out (it only cannot be renewed then).
export async function rememberOrigin(url, record) {
  try {
    await remember(`orig:${url}`, Object.assign({}, record, { at: Date.now() }), ORIGIN_TTL_MS);
  } catch (e) {
    warn(`the origin of a direct link could not be stored, so it cannot be renewed: ${textOf(e)}`);
  }
}

// Removes the expired records of SWEEP_PREFIXES, at most once a day. Never throws.
export async function housekeeping() {
  try {
    await sweep(SWEEP_PREFIXES, SWEEP_EVERY_MS);
  } catch (e) {
    warn(`the storage clean-up failed: ${textOf(e)}`);
  }
}

function magnetsAllowed() {
  const v = settings().magnets_via_debrid;
  return !(v === false || v === 'false');
}

function torrentName(magnet) {
  const parsed = parseMagnet(magnet);
  if (!parsed) return 'magnet';
  return parsed.name.trim() || parsed.hash;
}

async function resolveMagnet(ctx, magnet, refuse, providers) {
  const hit = magnetsAllowed() ? await findCachedMagnet(magnet, { providers }) : null;
  if (!hit) {
    if (refuse) throw userError(NOT_CACHED);
    return;
  }
  const files = hit.files.map((f) => toFile(f, ''));
  for (let i = 0; i < files.length; i++) {
    await rememberOrigin(files[i].req.url, { original: magnet, provider: hit.provider.id, file: files[i].name, size: files[i].size });
  }
  ctx.res = { name: torrentName(magnet), files };
  info(`${hit.provider.title} has the magnet cached: ${files.length} file${files.length === 1 ? '' : 's'}`);
}

export async function onResolve(ctx, { providers } = {}) {
  const req = (ctx && ctx.req) || {};
  const url = String(req.url || '').trim();
  const labels = req.labels && typeof req.labels === 'object' ? req.labels : {};
  await housekeeping();
  if (isMagnet(url)) return resolveMagnet(ctx, url, labels[LABEL] === 'cached-or-refuse', providers);

  const hit = await unrestrictLink(url, { providers });
  if (!hit) {
    if (hostMatches(hostOf(url), MEGA_DOMAINS)) throw userError(MEGA_TEXT);
    return;
  }
  const file = toFile(hit.file, url);
  await rememberOrigin(file.req.url, { original: url, provider: hit.provider.id });
  ctx.res = { name: file.name, files: [file] };
  info(`${hit.provider.title} resolved a link from ${hostOf(url)}`);
}
