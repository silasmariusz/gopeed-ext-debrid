// TorBox. The API key goes in "Authorization: Bearer <key>", except for requestdl, which takes it as the `token`
// query parameter (that endpoint is made for a redirect). The permalink form of requestdl (`redirect=true`) embeds
// the key in a URL Gopeed would store, so it is never used: requestdl is called without it and the CDN URL it
// returns is the download URL.
//
// Hoster link: createwebdownload, mylist until the file is there, requestdl.
// Magnet: checkcached; only a hit is added (createtorrent with add_only_if_cached), then requestdl per file.
// Source: docs/notes/2026-10-02-hoster-apis.md, the TorBox section, and https://api.torbox.app/openapi.json.
import { parseMagnet } from '../lib/magnet.js';
import { redact } from '../lib/redact.js';
import { createApi, claims, hostList, known, limit, text, num, baseName, sleep, HOUR, HOSTS_TIMEOUT_MS } from './common.js';

const ID = 'torbox';
const TITLE = 'TorBox';
const BASE = 'https://api.torbox.app';
const API = '/v1/api';
const POLL_MS = 5000;
const READY_MS = 60 * 1000;
const FILES_POLL_MS = 2000;
const FILES_MS = 10 * 1000;

const AUTH_CODES = ['BAD_TOKEN', 'NO_AUTH', 'AUTH_ERROR'];

// The error codes TorBox documents (the table in the note). A code ending in ERROR is the server's fault.
function classify(body, status) {
  if (!body || typeof body !== 'object' || typeof body.error !== 'string' || !body.error) return null;
  const code = body.error;
  if (AUTH_CODES.indexOf(code) >= 0) return known('auth_invalid');
  switch (code) {
    case 'PLAN_RESTRICTED_FEATURE':
      return known('account_expired', 'the account has expired or its plan does not include this');
    case 'MONTHLY_LIMIT':
      return limit('monthly data limit of the plan');
    case 'COOLDOWN_LIMIT':
      return limit('cooldown, try again later');
    case 'ACTIVE_LIMIT':
      return limit('too many active downloads');
    case 'DOWNLOAD_TOO_LARGE':
      return limit('the file is larger than the plan allows');
    case 'UNSUPPORTED_SITE':
      return known('not_supported');
    case 'LINK_OFFLINE':
      return known('dead_link');
    default:
      return /ERROR$/.test(code) ? known('service_down') : null;
  }
}

// Any other answer that says it failed: success false, with the error code and TorBox's own message for the user.
function envelope(body) {
  if (!body || typeof body !== 'object' || body.success !== false) return null;
  const code = typeof body.error === 'string' && body.error ? body.error.toLowerCase() : 'error';
  return { code, text: text(body.detail) };
}

function makeApi(s) {
  return createApi({
    id: ID,
    title: TITLE,
    base: BASE,
    settings: s,
    credential: () => s.apikey,
    authHeaders: () => ({ Authorization: `Bearer ${s.apikey}` }),
    classify,
    envelope,
  });
}

async function hosts(s) {
  return hostList(ID, async () => {
    const body = await makeApi(s).call('GET', `${API}/webdl/hosters`, { auth: false, timeoutMs: HOSTS_TIMEOUT_MS });
    const out = [];
    for (const h of body && Array.isArray(body.data) ? body.data : []) {
      if (h && h.status !== false && Array.isArray(h.domains)) out.push(...h.domains);
    }
    return out;
  });
}

// The CDN URL of one file. requestdl answers { data: "<url>" }.
async function requestDownload(api, s, kind, query) {
  const res = await api.call('GET', `${API}/${kind}/requestdl`, { query: Object.assign({ token: s.apikey }, query) });
  const url = res && typeof res.data === 'string' ? res.data : '';
  if (!url) throw api.fail('bad_response', 'the service gave no download link');
  // The URL becomes a task URL, which Gopeed stores and shows. It must never hold the API key.
  if (redact(url, [s.apikey]) !== url) throw api.fail('bad_response', 'the service returned a link that holds the API key');
  return url;
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const api = makeApi(s);
  await api.guard();
  const created = await api.call('POST', `${API}/webdl/createwebdownload`, { form: { link: url } });
  const webId = created && created.data ? created.data.webdownload_id : undefined;
  if (webId === undefined || webId === null) throw api.fail('bad_response', 'the service gave no download id');

  // A web download is ready when its files are listed and its progress is 1 (the docs do not list the download_state
  // values). The first look is at once; the next ones follow every 5 s, for 60 s in all.
  const deadline = Date.now() + READY_MS;
  let item = null;
  for (;;) {
    const res = await api.call('GET', `${API}/webdl/mylist`, { query: { id: webId, bypass_cache: 'true' } });
    const found = res && Array.isArray(res.data) ? res.data[0] : res && res.data;
    if (found && Array.isArray(found.files) && found.files.length && num(found.progress) >= 1) {
      item = found;
      break;
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(POLL_MS, left));
  }
  if (!item) throw api.fail('not_ready', 'the file is not ready yet, add the link again in a minute');

  const file = item.files[0];
  const direct = await requestDownload(api, s, 'webdl', { web_id: webId, file_id: file.id });
  return { name: text(file.short_name) || baseName(file.name) || text(item.name), size: num(file.size) || num(item.size), url: direct, headers: {} };
}

// checkcached answers a list of the hashes it has (format=list), or an object keyed by hash.
function cachedEntry(res, hash) {
  const data = res ? res.data : null;
  const entries = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.keys(data).map((k) => data[k]) : [];
  return entries.find((e) => e && typeof e === 'object' && String(e.hash || '').toLowerCase() === hash) || null;
}

// controltorrent with operation "delete" (from the live openapi.json; the operation name is UNVERIFIED).
async function removeQuietly(api, torrentId) {
  try {
    await api.call('POST', `${API}/torrents/controltorrent`, { json: { operation: 'delete', torrent_id: torrentId }, noTrip: true });
  } catch (e) {
    // The first error matters more than a failed clean-up.
  }
}

async function cachedMagnet(s, magnet) {
  const parsed = parseMagnet(magnet);
  if (!parsed) return null;
  const api = makeApi(s);
  await api.guard();
  const check = await api.call('GET', `${API}/torrents/checkcached`, { query: { hash: parsed.hash, format: 'list', list_files: 'true' } });
  if (!cachedEntry(check, parsed.hash)) return null;

  // Cached on TorBox: add_only_if_cached refuses anything else, so nothing uncached is ever added. seed=3 is "do not
  // seed", and allow_zip=false keeps one link per file (the default is a zip for a torrent with many files).
  const created = await api.call('POST', `${API}/torrents/createtorrent`, {
    form: { magnet, add_only_if_cached: 'true', seed: '3', allow_zip: 'false' },
  });
  const torrentId = created && created.data ? created.data.torrent_id : undefined;
  if (torrentId === undefined || torrentId === null) throw api.fail('bad_response', 'the service gave no torrent id');

  // The torrent exists from here on, and it is cached, so "no files yet" is not "not cached": mylist is asked again
  // for up to 10 s, and a torrent that never lists its files is removed and reported as not ready.
  try {
    const deadline = Date.now() + FILES_MS;
    let entries = [];
    for (;;) {
      const list = await api.call('GET', `${API}/torrents/mylist`, { query: { id: torrentId, bypass_cache: 'true' } });
      const torrent = list && Array.isArray(list.data) ? list.data[0] : list && list.data;
      entries = torrent && Array.isArray(torrent.files) ? torrent.files : [];
      const left = deadline - Date.now();
      if (entries.length || left <= 0) break;
      await sleep(Math.min(FILES_POLL_MS, left));
    }
    if (!entries.length) throw api.fail('not_ready', 'the torrent is on TorBox but lists no files yet, add the magnet again in a minute');
    const files = [];
    for (const f of entries) {
      const direct = await requestDownload(api, s, 'torrents', { torrent_id: torrentId, file_id: f.id });
      files.push({ name: text(f.short_name) || baseName(f.name), size: num(f.size), url: direct, headers: {} });
    }
    return files;
  } catch (e) {
    // A refused key cannot delete anything, and the pause it started forbids another call.
    if (!e || e.code !== 'auth_invalid') await removeQuietly(api, torrentId);
    throw e;
  }
}

export default {
  id: ID,
  title: TITLE,
  kind: 'debrid',
  base: BASE,
  // requestdl "opens the link for 3 hours" and says elsewhere "1 hour": the shorter value is used.
  linkTTLms: HOUR,
  enabled: (s) => !!s.enabled && !!s.apikey,
  hosts,
  unrestrict,
  cachedMagnet,
};
