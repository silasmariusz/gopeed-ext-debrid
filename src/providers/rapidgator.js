// Rapidgator, with the user's own premium account (API v2).
//
// Login: POST /api/v2/user/login with login and password in a form body (never in a URL), plus `code`, the current
// TOTP code, when `rapidgator_2fa_secret` is set. The code is computed here (lib/totp.js: HMAC-SHA1, 30 s, 6 digits;
// the docs show a six-digit code and name no algorithm, UNVERIFIED). The token is kept under `session:rapidgator`
// for 24 hours (the docs give no lifetime) and reused. A 401 on a later call drops it, logs in once more and repeats
// the call once. Concurrent resolves share one login, and a login in the 30 s window of the previous one waits for
// the next window, so no TOTP code is sent twice. Any refused login starts the 10-minute pause and is never retried
// by itself: the API blocks the IP after too many wrong passwords.
// Hoster link: POST /api/v2/file/download {token, file_id}; the file id is the path segment after /file/.
// The answer carries `status` in the JSON body (with HTTP 200), and `details` is text meant for the user.
// Host list: rapidgator.net, rapidgator.asia and rg.to (pyLoad's RapidgatorNet.py). No call.
// Source: docs/notes/2026-10-02-hoster-apis.md, "Rapidgator", and https://rapidgator.net/article/api.
import { base32Decode, totp } from '../lib/totp.js';
import { recall, remember } from '../lib/cache.js';
import { createApi, claims, known, text, num, sleep, HOUR } from './common.js';
import { sessionStore, sharedLogin, isRefusal } from './session.js';

const ID = 'rapidgator';
const TITLE = 'Rapidgator';
const BASE = 'https://rapidgator.net';
const API = '/api/v2';
const DOMAINS = ['rapidgator.net', 'rapidgator.asia', 'rg.to'];
const SESSION_TTL_MS = 24 * HOUR;
const WRONG_LOGIN = 'wrong login or password';
const WRONG_CODE = 'the 2FA code was refused (check the 2FA secret, and that the clock of this device is right)';
const TOTP_STEP_MS = 30 * 1000;
const TOTP_KEY = 'totp:rapidgator';
// Concurrent resolves of the same account share one login (session.js sharedLogin).
const inflight = new Map();

// A TOTP code that was not sent before. Many verifiers refuse a code that was already used, and a refused code counts
// as a failed login. So the last time step used is kept in storage, and a login in that same step first waits for the
// next one (less than 30 s).
async function freshCode(key) {
  const last = await recall(TOTP_KEY);
  let step = Math.floor(Date.now() / TOTP_STEP_MS);
  while (typeof last === 'number' && step <= last) {
    await sleep(Math.max(1, (last + 1) * TOTP_STEP_MS - Date.now()));
    step = Math.floor(Date.now() / TOTP_STEP_MS);
  }
  await remember(TOTP_KEY, step, 2 * TOTP_STEP_MS);
  return totp(key, step * TOTP_STEP_MS);
}

const details = (body) => text(body && body.details).replace(/^Error:\s*/i, '');

// The status in the body decides; an HTTP status is used when the body has none.
function classify(body, httpStatus) {
  const st = body && typeof body === 'object' && typeof body.status === 'number' ? body.status : httpStatus;
  if (!st || st === 200) return null;
  if (st === 401) return { code: 'token_invalid', reason: details(body) || 'the session is not valid' };
  if (st === 404) return known('dead_link');
  if (st === 429) return known('rate_limited');
  if (st >= 500) return known('service_down', details(body) || `the service is down (status ${st})`);
  return { code: String(st), reason: details(body) || `the service answered status ${st}` };
}

// The file id and the name in the link: https://rapidgator.net/file/<id>/<name>.html.
function parseLink(url) {
  const m = /^[a-z]+:\/\/[^/]+\/file\/([^/?#]+)(?:\/([^/?#]+))?/i.exec(String(url || ''));
  if (!m) return null;
  let name = m[2] ? m[2].replace(/\.html?$/i, '') : '';
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    // keep it as written
  }
  return { fileId: m[1], name };
}

function session(s) {
  const runtime = [];
  const credential = () => `${s.login || ''}\u0000${s.password || ''}\u0000${s['2fa_secret'] || ''}`;
  const api = createApi({
    id: ID,
    title: TITLE,
    base: BASE,
    settings: s,
    credential,
    authHeaders: () => ({}),
    classify,
    runtime,
  });
  const store = sessionStore(ID, SESSION_TTL_MS, runtime);
  const post = (path, form) => api.call('POST', API + path, { form, auth: false, noTrip: true });

  async function refuse(reason) {
    await store.drop();
    await api.trip(reason);
    throw api.fail('auth_invalid', reason);
  }

  async function doLogin() {
    const form = { login: s.login, password: s.password };
    if (s['2fa_secret']) {
      const key = base32Decode(s['2fa_secret']);
      // Nothing was sent, so nothing pauses: fixing the setting is enough.
      if (!key) throw api.fail('auth_invalid', 'the 2FA secret is not a base32 secret (letters A to Z and digits 2 to 7)');
      form.code = await freshCode(key);
    }
    let body;
    try {
      body = await post('/user/login', form);
    } catch (e) {
      // Any refusal pauses for 10 minutes: a 401 with its known texts, any other status with Rapidgator's own text.
      if (e && e.code === 'token_invalid') await refuse(/auth code/i.test(e.reason) ? WRONG_CODE : WRONG_LOGIN);
      if (isRefusal(e)) await refuse(e.reason);
      throw e;
    }
    const r = body && body.response && typeof body.response === 'object' ? body.response : {};
    const token = typeof r.token === 'string' ? r.token : '';
    if (!token) throw api.fail('bad_response', 'the service gave no session token');
    const user = r.user && typeof r.user === 'object' ? r.user : {};
    // The token of an account that cannot download is not kept: the next try logs in and checks again.
    if (user.is_premium === false) throw api.fail('account_expired', 'the account has expired or is not premium');
    const left = user.traffic && typeof user.traffic === 'object' ? user.traffic.left : undefined;
    if (left !== undefined && left !== null && left !== '' && Number.isFinite(Number(left)) && num(left) <= 0) {
      throw api.fail('limit_reached', 'limit reached (no traffic left on the account)');
    }
    await store.set(s.login, token);
    return token;
  }

  // A login shared with any login already on its way for this account.
  async function login() {
    const token = await sharedLogin(inflight, credential(), doLogin);
    store.track(token);
    return token;
  }

  const refused = (e) => !!e && (e.code === 'token_invalid' || e.code === 'auth_invalid');

  // A call with the session's token. A stored token that is refused is dropped and replaced by one new login, and
  // the call is repeated once. A refusal of a token that came from a login stops and pauses. unrestrict makes one
  // such call, so it never logs in twice.
  async function authed(path, form) {
    const stored = await store.get(s.login);
    const token = stored || (await login());
    try {
      return await post(path, Object.assign({ token }, form));
    } catch (e) {
      if (!refused(e)) throw e;
      if (!stored) await refuse('the service refused a new session');
    }
    await store.drop();
    const fresh = await login();
    try {
      return await post(path, Object.assign({ token: fresh }, form));
    } catch (e) {
      if (refused(e)) await refuse('the service refused a new session');
      throw e;
    }
  }

  return { api, authed };
}

async function hosts() {
  return DOMAINS.slice();
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const link = parseLink(url);
  if (!link) return null;
  const { api, authed } = session(s);
  await api.guard();
  const body = await authed('/file/download', { file_id: link.fileId });
  const r = body && body.response && typeof body.response === 'object' ? body.response : {};
  if (typeof r.download_url !== 'string' || !r.download_url) throw api.fail('bad_response', 'the service gave no download link');
  // The size is not in the answer; Gopeed reads it from the download.
  return { name: link.name, size: 0, url: r.download_url, headers: {} };
}

export default {
  id: ID,
  title: TITLE,
  kind: 'hoster',
  base: BASE,
  // The docs give no link lifetime, so the default of three hours.
  linkTTLms: 3 * HOUR,
  enabled: (s) => !!s.enabled && !!s.login && !!s.password,
  hosts,
  unrestrict,
  cachedMagnet: async () => null,
};
