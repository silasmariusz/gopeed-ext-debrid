// AllDebrid. The API key goes in "Authorization: Bearer <key>". No `agent` or `version` parameter is sent (AllDebrid
// dropped them on 2025-01-15).
//
// Hoster link: link/unlock; when the answer is "delayed", link/delayed is polled every 5 s for up to 60 s.
// Magnet: magnet/upload says `ready` when AllDebrid already has it; then magnet/files lists the tree and every file
// link goes through link/unlock. A magnet that is not ready is removed again with magnet/delete.
// Host list: GET /v4.1/user/hosts, which needs the key (the hosts of this account). The public /v4/hosts/domains
// is not used.
// Source: docs/notes/2026-10-02-hoster-apis.md, the AllDebrid section, and https://docs.alldebrid.com/.
import { parseMagnet } from '../lib/magnet.js';
import { createApi, claims, hostList, known, limit, text, num, sleep, HOUR, HOSTS_TIMEOUT_MS } from './common.js';

const ID = 'alldebrid';
const TITLE = 'AllDebrid';
const BASE = 'https://api.alldebrid.com';
const POLL_MS = 5000;
const READY_MS = 60 * 1000;

// The error codes AllDebrid documents, in { status: "error", error: { code, message } }. They come with HTTP 200
// as well as with 4xx.
function classify(body) {
  if (!body || typeof body !== 'object' || body.status !== 'error' || !body.error) return null;
  switch (body.error.code) {
    case 'AUTH_MISSING_APIKEY':
    case 'AUTH_BAD_APIKEY':
      return known('auth_invalid');
    case 'AUTH_BLOCKED':
      return known('auth_invalid', 'the key is blocked for this location (confirm it by e-mail on alldebrid.com)');
    case 'AUTH_USER_BANNED':
      return known('auth_invalid', 'the account is banned');
    case 'NO_SERVER':
    case 'MAGNET_NO_SERVER':
      return known('ip_not_allowed');
    case 'LINK_HOST_NOT_SUPPORTED':
    case 'LINK_NOT_SUPPORTED':
      return known('not_supported');
    case 'LINK_DOWN':
      return known('dead_link');
    case 'LINK_TEMPORARY_UNAVAILABLE':
    case 'LINK_HOST_UNAVAILABLE':
    case 'LINK_HOST_FULL':
    case 'LINK_TOO_MANY_DOWNLOADS':
      return known('service_down');
    case 'LINK_HOST_LIMIT_REACHED':
      return limit('the host limit');
    case 'MAGNET_TOO_MANY_ACTIVE':
      return limit('too many active magnets');
    case 'LINK_PASS_PROTECTED':
      return known('bad_password');
    case 'MUST_BE_PREMIUM':
    case 'MAGNET_MUST_BE_PREMIUM':
    case 'FREE_TRIAL_LIMIT_REACHED':
      return known('account_expired');
    default:
      return null;
  }
}

function envelope(body) {
  if (!body || typeof body !== 'object' || body.status !== 'error') return null;
  const err = body.error && typeof body.error === 'object' ? body.error : {};
  return { code: text(err.code) || 'error', text: text(err.message) };
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
    // The list needs the key, so it respects the cooldown like any other call.
    const api = makeApi(s);
    await api.guard();
    const body = await api.call('GET', '/v4.1/user/hosts', { timeoutMs: HOSTS_TIMEOUT_MS });
    const map = body && body.data && body.data.hosts && typeof body.data.hosts === 'object' ? body.data.hosts : {};
    const out = [];
    for (const name of Object.keys(map)) {
      const h = map[name];
      if (h && h.status !== false && Array.isArray(h.domains)) out.push(...h.domains);
    }
    return out;
  });
}

// A delayed link: poll link/delayed, the first time at once and then every 5 s, for up to 60 s. Status 1 is
// "working", 2 is "ready" (with the link).
async function waitDelayed(api, delayedId) {
  const deadline = Date.now() + READY_MS;
  for (;;) {
    const res = await api.call('POST', '/v4/link/delayed', { form: { id: delayedId } });
    const d = res && res.data;
    if (d && num(d.status) === 2 && typeof d.link === 'string' && d.link) return d.link;
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(POLL_MS, left));
  }
  throw api.fail('not_ready', 'the link is not ready yet, add it again in a minute');
}

// One link through link/unlock. It does not check the host list: the links of a magnet's files are on alldebrid.com.
async function unlock(api, link) {
  const res = await api.call('POST', '/v4/link/unlock', { form: { link } });
  const d = res && res.data ? res.data : {};
  const url = d.delayed ? await waitDelayed(api, d.delayed) : d.link;
  if (typeof url !== 'string' || !url) throw api.fail('bad_response', 'the service gave no download link');
  return { name: text(d.filename), size: num(d.filesize), url, headers: {} };
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const api = makeApi(s);
  await api.guard();
  return unlock(api, url);
}

// The links of a magnet's file tree: a file has `l`, a folder has `e` (its entries).
function fileLinks(entries, out) {
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    if (Array.isArray(e.e)) fileLinks(e.e, out);
    else if (typeof e.l === 'string' && e.l) out.push({ name: text(e.n), link: e.l });
  }
  return out;
}

async function removeQuietly(api, id) {
  try {
    await api.call('POST', '/v4/magnet/delete', { form: { id }, noTrip: true });
  } catch (e) {
    // The first error matters more than a failed clean-up.
  }
}

async function cachedMagnet(s, magnet) {
  if (!parseMagnet(magnet)) return null;
  const api = makeApi(s);
  await api.guard();
  const uploaded = await api.call('POST', '/v4/magnet/upload', { form: { 'magnets[]': magnet } });
  const entry = uploaded && uploaded.data && Array.isArray(uploaded.data.magnets) ? uploaded.data.magnets[0] : null;
  if (!entry) throw api.fail('bad_response', 'the service did not accept the magnet');
  if (entry.error) await api.check({ status: 'error', error: entry.error });
  const id = entry.id;
  if (id === undefined || id === null) throw api.fail('bad_response', 'the service gave no magnet id');

  // From here on the magnet exists on AllDebrid, so everything but a usable result removes it again.
  try {
    if (entry.ready !== true) {
      await removeQuietly(api, id);
      return null;
    }
    const listed = await api.call('POST', '/v4/magnet/files', { form: { 'id[]': id } });
    const m = listed && listed.data && Array.isArray(listed.data.magnets) ? listed.data.magnets[0] : null;
    const links = fileLinks(m && m.files, []);
    if (!links.length) {
      await removeQuietly(api, id);
      return null;
    }
    const files = [];
    for (const f of links) {
      const unlocked = await unlock(api, f.link);
      files.push({ name: unlocked.name || f.name, size: unlocked.size, url: unlocked.url, headers: {} });
    }
    return files;
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
