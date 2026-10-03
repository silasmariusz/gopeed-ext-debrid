// 1fichier, with the user's own premium account. The API key goes in "Authorization: Bearer <key>".
//
// Hoster link: POST /v1/download/get_token.cgi {url} gives a download URL that "is valid for 5 minutes" (so
// linkTTLms is 5 minutes, and the link is refreshed before a queued task starts). The answer has no name or size, so
// POST /v1/file/info.cgi is asked once after a token was given. Its failure is not fatal: every 404 counts toward
// 1fichier's temporary ban, so it is never repeated.
// Host list: 1fichier's own domains (pyLoad's OneFichierCom.py), and the https://<id>.1fichier.com form. No call.
//
// "Repeated failing requests (401, 403, 404 or 410) lead to a temporary ban of the IP address and of the account".
// A 401 and a JSON 403 both start the 10-minute pause (a 403 is also how a key of a non-paying account is refused);
// a 403 block page that is not JSON is ip_not_allowed; 404 and 410 are a dead link and are not retried.
// Source: docs/notes/2026-10-02-hoster-apis.md, "1fichier", and https://1fichier.com/api.html.
import { createApi, claims, known, text, num, MIN } from './common.js';

const ID = 'onefichier';
const TITLE = '1fichier';
const BASE = 'https://api.1fichier.com';
const DOMAINS = ['1fichier.com', 'alterupload.com', 'cjoint.net', 'desfichiers.com', 'dfichiers.com', 'dl4free.com', 'megadl.fr',
  'mesfichiers.org', 'piecejointe.net', 'pjointe.com', 'tenvoi.com'];

function classify(body, status) {
  if (status === 401) return known('auth_invalid');
  if (status === 403) {
    // A JSON 403 is 1fichier refusing the key. Anything else is a block page in front of it (Cloudflare, a VPN or a
    // datacenter address), worded as in common.js, with no pause.
    if (body && typeof body === 'object') return known('auth_invalid', 'access refused (HTTP 403): the API key is wrong or the account is not premium');
    return known('ip_not_allowed', "blocked by the service's protection (HTTP 403); a VPN or datacenter address is often refused");
  }
  if (status === 404 || status === 410) return known('dead_link');
  return null;
}

// {status: "KO", message}: the request failed, and 1fichier says why.
function envelope(body) {
  if (!body || typeof body !== 'object' || body.status !== 'KO') return null;
  return { code: 'error', text: text(body.message) };
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

async function hosts() {
  return DOMAINS.slice();
}

async function info(api, url) {
  try {
    const body = await api.call('POST', '/v1/file/info.cgi', { json: { url }, noTrip: true });
    return body && typeof body === 'object' ? body : {};
  } catch (e) {
    return {};
  }
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const api = makeApi(s);
  await api.guard();
  const res = await api.call('POST', '/v1/download/get_token.cgi', { json: { url } });
  const link = res && typeof res.url === 'string' ? res.url : '';
  if (!link) throw api.fail('bad_response', 'the service gave no download link');
  const meta = await info(api, url);
  return { name: text(meta.filename), size: num(meta.size), url: link, headers: {} };
}

export default {
  id: ID,
  title: TITLE,
  kind: 'hoster',
  base: BASE,
  linkTTLms: 5 * MIN,
  enabled: (s) => !!s.enabled && !!s.apikey,
  hosts,
  unrestrict,
  cachedMagnet: async () => null,
};
