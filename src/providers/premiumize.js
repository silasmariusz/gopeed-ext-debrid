// Premiumize. The API key goes in "Authorization: Bearer <key>", which the API documentation recommends. It is
// never put in a query or a form, so no URL or body holds it.
//
// Hoster link: transfer/directdl with src=<link>; content[].link is the download URL.
// Magnet: cache/check with the info hash; on a hit, transfer/directdl with src=<magnet> lists every file.
// Host list: services/list, public; the services under `directdl` plus their aliases.
// Business errors come as HTTP 200 with { status: "error", message, code }.
// Source: docs/notes/2026-10-02-hoster-apis.md, the Premiumize section, and https://www.premiumize.me/api.
import { parseMagnet } from '../lib/magnet.js';
import { createApi, claims, hostList, known, limit, text, num, baseName, HOUR, HOSTS_TIMEOUT_MS } from './common.js';

const ID = 'premiumize';
const TITLE = 'Premiumize';
const BASE = 'https://www.premiumize.me';
const API = '/api';

function classify(body) {
  if (!body || typeof body !== 'object' || body.status !== 'error') return null;
  const code = text(body.code);
  switch (code) {
    case 'authentication_failed':
      return known('auth_invalid');
    case 'permission_denied':
      return known('account_expired', 'the account has expired, is restricted or is not premium');
    case 'service_unsupported':
      return known('not_supported');
    case 'not_found':
      return known('dead_link');
    case 'service_down':
    case 'link_generation_failed':
    case 'transient_error':
    case 'unknown_error':
      return known('service_down');
    case 'service_limit_reached':
      return limit('the limit of this host');
    case 'account_limit_reached':
      return limit('the fair-use points are used up');
    case 'rate_limit_reached':
      return known('rate_limited');
    default:
      // An answer without a code: "Not logged in." is the one that means a refused key.
      return !code && /not logged in|authentication|invalid (api )?key/i.test(text(body.message)) ? known('auth_invalid') : null;
  }
}

function envelope(body) {
  if (!body || typeof body !== 'object' || body.status !== 'error') return null;
  return { code: text(body.code) || 'error', text: text(body.message) };
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

// The services directdl can unlock (not those that only cache or queue), with the aliases of each.
async function hosts(s) {
  return hostList(ID, async () => {
    const body = await makeApi(s).call('GET', `${API}/services/list`, { auth: false, timeoutMs: HOSTS_TIMEOUT_MS });
    const out = [];
    const aliases = body && body.aliases && typeof body.aliases === 'object' ? body.aliases : {};
    for (const service of body && Array.isArray(body.directdl) ? body.directdl : []) {
      out.push(service);
      if (Array.isArray(aliases[service])) out.push(...aliases[service]);
    }
    return out;
  });
}

// transfer/directdl for a link or a magnet: one entry per file.
async function directdl(api, src) {
  const res = await api.call('POST', `${API}/transfer/directdl`, { form: { src } });
  const files = [];
  for (const c of res && Array.isArray(res.content) ? res.content : []) {
    if (c && typeof c.link === 'string' && c.link) files.push({ name: baseName(c.path), size: num(c.size), url: c.link, headers: {} });
  }
  return files;
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const api = makeApi(s);
  await api.guard();
  const files = await directdl(api, url);
  if (!files.length) throw api.fail('bad_response', 'the service gave no download link');
  return files[0];
}

async function cachedMagnet(s, magnet) {
  const parsed = parseMagnet(magnet);
  if (!parsed) return null;
  const api = makeApi(s);
  await api.guard();
  const check = await api.call('POST', `${API}/cache/check`, { form: { 'items[]': parsed.hash } });
  // The cache is "best-effort" in the docs, so a miss is not proof, and a miss means the magnet is left alone.
  if (!check || !Array.isArray(check.response) || check.response[0] !== true) return null;
  const files = await directdl(api, magnet);
  return files.length ? files : null;
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
