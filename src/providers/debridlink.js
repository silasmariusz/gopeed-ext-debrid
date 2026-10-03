// Debrid-Link. The account API key goes in "Authorization: Bearer <key>", the way Torrentio sends it. The vendor
// documents only OAuth2 grants, so that the key works as a Bearer token is UNVERIFIED (see the note). A refused key
// answers `badToken`, which starts the 10-minute cooldown like any refused credential.
//
// Hoster link: downloader/add with url=<link>; value.downloadUrl is the download URL.
// Magnet: seedbox/add with the bare info hash. The API adds a hash only when it is already cached, and a magnet
// URI would be added uncached, so the hash is what is sent. A file is ready when downloadPercent is 100.
// Host list: downloader/hosts?types=host, public; a host is online when its status is 1 or more.
// Source: docs/notes/2026-10-02-hoster-apis.md, the Debrid-Link section, and https://debrid-link.com/api/v2/api_doc/infos.
import { parseMagnet } from '../lib/magnet.js';
import { createApi, claims, hostList, known, limit, text, num, HOUR, HOSTS_TIMEOUT_MS } from './common.js';

const ID = 'debridlink';
const TITLE = 'Debrid-Link';
const BASE = 'https://debrid-link.com';
const API = '/api/v2';

// The error codes Debrid-Link documents, in { success: false, error: "<code>", error_description }.
function classify(body) {
  if (!body || typeof body !== 'object' || body.success !== false) return null;
  switch (body.error) {
    case 'badToken':
      return known('auth_invalid');
    case 'floodDetected':
      return known('rate_limited');
    case 'hostNotValid':
    case 'notDebrid':
      return known('not_supported');
    case 'fileNotFound':
    case 'fileNotAvailable':
    case 'badFileUrl':
    case 'infringingFile':
      return known('dead_link');
    case 'badFilePassword':
      return known('bad_password');
    case 'maintenanceHost':
    case 'freeServerOverload':
      return known('service_down');
    case 'maxLink':
    case 'maxData':
      return limit('the daily limit');
    case 'maxLinkHost':
    case 'maxDataHost':
      return limit('the daily limit of this host');
    case 'maxTorrent':
    case 'maxTransfer':
    case 'torrentTooBig':
      return limit('the seedbox limit');
    case 'unverifiedEmail':
    case 'notFreeHost':
      return known('account_expired');
    case 'notAddTorrent':
      // seedbox/add refuses a hash it does not have cached.
      return { code: 'not_added', reason: 'the torrent is not cached' };
    default:
      return null;
  }
}

function envelope(body) {
  if (!body || typeof body !== 'object' || body.success !== false) return null;
  return { code: text(body.error) || 'error', text: text(body.error_description) };
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
    const body = await makeApi(s).call('GET', `${API}/downloader/hosts`, { auth: false, query: { types: 'host' }, timeoutMs: HOSTS_TIMEOUT_MS });
    const out = [];
    for (const h of body && Array.isArray(body.value) ? body.value : []) {
      if (h && num(h.status) >= 1 && Array.isArray(h.domains)) out.push(...h.domains);
    }
    return out;
  });
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const api = makeApi(s);
  await api.guard();
  const res = await api.call('POST', `${API}/downloader/add`, { form: { url } });
  // A folder link gives an array of links. The first one with a download URL is used.
  const value = res ? res.value : null;
  const link = Array.isArray(value) ? value.find((v) => v && v.downloadUrl) : value;
  if (!link || typeof link.downloadUrl !== 'string' || !link.downloadUrl) throw api.fail('bad_response', 'the service gave no download link');
  return { name: text(link.name), size: num(link.size), url: link.downloadUrl, headers: {} };
}

async function removeQuietly(api, id) {
  try {
    await api.call('DELETE', `${API}/seedbox/${encodeURIComponent(id)}/remove`, { noTrip: true });
  } catch (e) {
    // The first error matters more than a failed clean-up.
  }
}

async function cachedMagnet(s, magnet) {
  const parsed = parseMagnet(magnet);
  if (!parsed) return null;
  const api = makeApi(s);
  await api.guard();
  let added;
  try {
    added = await api.call('POST', `${API}/seedbox/add`, { form: { url: parsed.hash } });
  } catch (e) {
    if (e && e.code === 'not_added') return null;
    throw e;
  }
  let torrent = added ? added.value : null;
  if (!torrent || typeof torrent !== 'object' || !torrent.id) throw api.fail('bad_response', 'the service did not accept the torrent');
  const id = torrent.id;

  try {
    // A torrent with many files comes back as one zip entry, and its metadata can be incomplete: seedbox/list has
    // the whole file list.
    if (torrent.isZip === true || !Array.isArray(torrent.files) || !torrent.files.length) {
      const listed = await api.call('GET', `${API}/seedbox/list`, { query: { ids: id } });
      const full = listed && Array.isArray(listed.value) ? listed.value.find((t) => t && t.id === id) || listed.value[0] : null;
      if (full) torrent = full;
    }
    const files = (Array.isArray(torrent.files) ? torrent.files : [])
      .filter((f) => f && typeof f.downloadUrl === 'string' && f.downloadUrl && num(f.downloadPercent) === 100)
      .map((f) => ({ name: text(f.name), size: num(f.size), url: f.downloadUrl, headers: {} }));
    if (num(torrent.downloadPercent) === 100 && files.length) return files;
    // Added, but not complete: leave nothing behind.
    await removeQuietly(api, id);
    return null;
  } catch (e) {
    // A refused key cannot delete anything, and the pause it started forbids another call.
    if (!e || e.code !== 'auth_invalid') await removeQuietly(api, id);
    throw e;
  }
}

export default {
  id: ID,
  title: TITLE,
  kind: 'debrid',
  base: BASE,
  linkTTLms: 3 * HOUR,
  enabled: (s) => !!s.enabled && !!s.apikey,
  hosts,
  unrestrict,
  cachedMagnet,
};
