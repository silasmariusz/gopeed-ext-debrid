// Nitroflare, with the user's own premium key. The vendor's API page is behind a login, so everything here follows
// pyLoad's plugins (accounts/ and downloaders/NitroflareCom.py) and is UNVERIFIED against the vendor's text.
//
// The account e-mail (`user`) and the premium key (`premiumKey`) go in the query string of a GET, as pyLoad sends
// them. No error text is built from the request URL (requestJSON never puts it in a message), and the key is hidden
// in every error.
//
//   GET /api/v2/getKeyInfo?user&premiumKey      the sign-in check pyLoad makes: an error other than the captcha means
//                                               a wrong user or key (10-minute pause); `status` and `trafficLeft`
//                                               tell an expired account or a used-up quota.
//   GET /api/v2/getDownloadLink?file&user&premiumKey   -> result {name, size (may be a string), url}
//
// Code 12 asks for a reCAPTCHA. The extension cannot show one, so the user is asked to log in once in a browser.
// Host list: nitroflare.com and nitro.download; the file id is the path segment after /view/. No call.
// Source: docs/notes/2026-10-02-hoster-apis.md, "Nitroflare".
import { createApi, claims, text, num, HOUR } from './common.js';

const ID = 'nitroflare';
const TITLE = 'Nitroflare';
const BASE = 'https://nitroflare.com';
const API = '/api/v2';
const DOMAINS = ['nitroflare.com', 'nitro.download'];
const WRONG_KEY = 'wrong user or premium key';
const CAPTCHA = 'log in on nitroflare.com once in a browser to clear the captcha, then add the link again';

// {type: "error", code, message}.
function classify(body) {
  if (!body || typeof body !== 'object' || body.type !== 'error') return null;
  const code = num(body.code);
  if (code === 12) return { code: 'login_required', reason: CAPTCHA };
  return { code: String(code || 'error'), reason: text(body.message) || 'the service reported an error' };
}

function makeApi(s) {
  return createApi({
    id: ID,
    title: TITLE,
    base: BASE,
    settings: s,
    credential: () => `${s.user || ''}\u0000${s.premium_key || ''}`,
    authHeaders: () => ({}),
    classify,
  });
}

function fileId(url) {
  const m = /^[a-z]+:\/\/[^/]+\/view\/([^/?#]+)/i.exec(String(url || ''));
  return m ? m[1] : '';
}

async function hosts() {
  return DOMAINS.slice();
}

async function checkKey(api, s) {
  let body;
  try {
    body = await api.call('GET', `${API}/getKeyInfo`, { query: { user: s.user, premiumKey: s.premium_key }, auth: false, noTrip: true });
  } catch (e) {
    // A refused key is any error answer of the sign-in call but the captcha (pyLoad's signin), or an HTTP 401 or
    // 403. A network fault, a timeout or a 5xx is not.
    const answered = e && e.body && typeof e.body === 'object' && e.body.type === 'error';
    if (e && e.code !== 'login_required' && (answered || e.code === 'auth_invalid')) {
      await api.trip(WRONG_KEY);
      throw api.fail('auth_invalid', WRONG_KEY);
    }
    throw e;
  }
  const r = body && body.result && typeof body.result === 'object' ? body.result : {};
  if (typeof r.status === 'string' && r.status !== 'active') throw api.fail('account_expired', 'the account has expired or is not premium');
  const left = r.trafficLeft;
  if (left !== undefined && left !== null && left !== '' && Number.isFinite(Number(left)) && num(left) <= 0) {
    throw api.fail('limit_reached', 'limit reached (no traffic left on the account)');
  }
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const file = fileId(url);
  if (!file) return null;
  const api = makeApi(s);
  await api.guard();
  await checkKey(api, s);
  const body = await api.call('GET', `${API}/getDownloadLink`, { query: { file, user: s.user, premiumKey: s.premium_key }, auth: false });
  const r = body && body.result && typeof body.result === 'object' ? body.result : {};
  if (typeof r.url !== 'string' || !r.url) throw api.fail('bad_response', 'the service gave no download link');
  return { name: text(r.name), size: num(r.size), url: r.url, headers: {} };
}

export default {
  id: ID,
  title: TITLE,
  kind: 'hoster',
  base: BASE,
  // No source states a link lifetime, so the default of three hours.
  linkTTLms: 3 * HOUR,
  enabled: (s) => !!s.enabled && !!s.user && !!s.premium_key,
  hosts,
  unrestrict,
  cachedMagnet: async () => null,
};
