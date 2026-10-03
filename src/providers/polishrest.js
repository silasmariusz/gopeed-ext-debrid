// The REST API that Rapideo, NoPremium and Twojlimit share (`https://www.<domain>/api/rest`). It has no public
// documentation: the calls come from Rapideo's own QNAP addon and JDownloader's RapideoCore.java, as recorded in
// docs/notes/2026-10-02-hoster-apis.md ("Rapideo, NoPremium and Twojlimit: the shared REST API").
//
// Every call is a JSON POST that carries `device: "gopeed-ext-debrid"` and `version: 1`. The extension never sends
// `device: "qnap"`, which would present it as the vendor's addon. `files/download` carries `mode: "qnap"`, the
// download-mode value without which the answer has no `file.url` (JD's comment; ruling of 2026-10-02).
//
//   login           {login, password}   -> {logged, authtoken}
//   files/check     {authtoken, url}    -> {file: {filename, filename_full, filesize, hash}}
//   files/download  {authtoken, hash, mode} -> {file: {url}}
//
// The authtoken is kept under `session:<id>` and reused (JD: it "looks to be valid forever"). Error 1 (bad token)
// drops it, logs in once and repeats the call once. Error 3 (wrong login or password) starts the 10-minute pause, and
// error 4 ("Login locked for 60 minutes", quoted at JD RapideoCore.java:557) a 60-minute one. No login is ever retried
// by itself.
//
// Host list: `GET /clipboard.php?json=3`, public, kept 24 h. Every entry with a domain counts, whatever its
// `sdownload` flag says (its meaning is UNVERIFIED), and the API's answer decides: per-file error 15 is
// not_supported, so the next provider is asked. No magnets: the services take none through this API.
import { startCooldown, COOLDOWN_MS } from '../lib/cooldown.js';
import { createApi, claims, hostList, known, text, num, MIN, HOUR, HOSTS_TIMEOUT_MS } from './common.js';
import { sessionStore, sharedLogin, isRefusal } from './session.js';

const DEVICE = 'gopeed-ext-debrid';
const VERSION = 1;
const REST = '/api/rest';
const LOCK_MS = 60 * MIN;
const SESSION_TTL_MS = 30 * 24 * HOUR;
const WRONG_LOGIN = 'wrong login or password';
const LOCKED = 'the login is locked for 60 minutes after failed logins';

function errNo(value) {
  return num(value) > 0 ? num(value) : 0;
}

// Account-level errors are top-level {error, message}; a per-file error sits inside `file` (JD RapideoCore.java:514).
// The HTTP status of an error answer is not documented, so the body decides; a 401 without a known body is a refused
// login (or, on a later call, a refused session).
function classify(body, status) {
  if (!body || typeof body !== 'object') return status === 401 ? known('auth_invalid', WRONG_LOGIN) : null;
  const top = errNo(body.error);
  if (top === 1) return { code: 'token_invalid', reason: 'the session expired' };
  if (top === 3) return known('auth_invalid', WRONG_LOGIN);
  if (top === 4) return known('auth_invalid', LOCKED);
  if (top) return { code: String(top), reason: text(body.message) || `the service reported error ${top}` };
  const f = body.file && typeof body.file === 'object' ? body.file : null;
  const fileErr = f ? errNo(f.error) : 0;
  if (fileErr === 15) return known('not_supported');
  if (fileErr) return { code: String(fileErr), reason: text(f.message) || `the service reported error ${fileErr}` };
  return status === 401 ? known('auth_invalid', WRONG_LOGIN) : null;
}

// One provider module for the service at `base` (the host root, e.g. https://www.rapideo.pl).
export function polishProvider({ id, title, base }) {
  const credential = (s) => `${s.login || ''}\u0000${s.password || ''}`;
  const inflight = new Map();

  function session(s) {
    const runtime = [];
    // Any 4xx without a known error number (a 401 with another body) would start the pause in the wrapper. The
    // login reads the classification itself, so every call here is sent with noTrip and trips in one place.
    const api = createApi({ id, title, base, settings: s, credential: () => credential(s), authHeaders: () => ({}), classify, runtime });
    const store = sessionStore(id, SESSION_TTL_MS, runtime);
    const post = (path, json) => api.call('POST', REST + path, { json: Object.assign({}, json, { device: DEVICE, version: VERSION }), auth: false, noTrip: true });

    // A refused login or session: drop the token, pause (60 minutes for a locked login, else 10), and say why.
    async function refuse(reason, ms = COOLDOWN_MS) {
      await store.drop();
      await startCooldown(id, credential(s), reason, ms);
      try {
        gopeed.logger.warn(`${title}: ${reason}; no further calls for ${Math.round(ms / MIN)} minutes`);
      } catch (e) {
        // no logger
      }
      throw api.fail('auth_invalid', reason);
    }

    // Any refusal of the login pauses: error 3 and a bare 401 for 10 minutes, error 4 for 60, and an error number no
    // source documents for 10, with the service's own text.
    async function doLogin() {
      let body;
      try {
        body = await post('/login', { login: s.login, password: s.password });
      } catch (e) {
        if (e && e.code === 'auth_invalid') await refuse(e.reason, e.reason === LOCKED ? LOCK_MS : COOLDOWN_MS);
        if (isRefusal(e)) await refuse(e.reason);
        throw e;
      }
      const token = body && typeof body.authtoken === 'string' ? body.authtoken : '';
      if (body && body.logged === false && !token) await refuse(WRONG_LOGIN);
      if (!token) throw api.fail('bad_response', 'the service gave no authtoken');
      await store.set(s.login, token);
      return token;
    }

    // At most one login per session (one unrestrict), shared with any login already on its way for this account.
    let loggedIn = false;
    async function login() {
      const token = await sharedLogin(inflight, credential(s), doLogin);
      store.track(token);
      loggedIn = true;
      return token;
    }

    const refused = (e) => !!e && (e.code === 'token_invalid' || e.code === 'auth_invalid');

    // A call with the session's token. A stored token that is refused (error 1, or a 401) is dropped and replaced by
    // one new login, and the call is repeated once. A refusal of a token that came from a login in this session stops
    // and pauses, so one unrestrict never logs in twice.
    async function authed(path, json) {
      const stored = await store.get(s.login);
      const token = stored || (await login());
      try {
        return await post(path, Object.assign({ authtoken: token }, json));
      } catch (e) {
        if (!refused(e)) throw e;
        if (!stored || loggedIn) await refuse('the service refused a new session');
      }
      await store.drop();
      const fresh = await login();
      try {
        return await post(path, Object.assign({ authtoken: fresh }, json));
      } catch (e) {
        if (refused(e)) await refuse('the service refused a new session');
        throw e;
      }
    }

    return { api, authed };
  }

  async function hosts(s) {
    return hostList(id, async () => {
      const body = await session(s).api.call('GET', '/clipboard.php', { query: { json: 3 }, auth: false, noTrip: true, timeoutMs: HOSTS_TIMEOUT_MS });
      const out = [];
      for (const h of Array.isArray(body) ? body : []) {
        if (h && Array.isArray(h.domains)) out.push(...h.domains);
      }
      return out;
    });
  }

  async function unrestrict(s, url) {
    if (!(await claims(hosts, s, url))) return null;
    const { api, authed } = session(s);
    await api.guard();
    const checked = await authed('/files/check', { url });
    const file = checked && checked.file && typeof checked.file === 'object' ? checked.file : {};
    if (typeof file.hash !== 'string' || !file.hash) throw api.fail('bad_response', 'the service gave no file hash');
    const got = await authed('/files/download', { hash: file.hash, mode: 'qnap' });
    const link = got && got.file && typeof got.file.url === 'string' ? got.file.url : '';
    if (!link) throw api.fail('bad_response', 'the service gave no download link');
    // filesize has no unit in any source; it is taken as bytes (UNVERIFIED).
    return { name: text(file.filename_full) || text(file.filename), size: num(file.filesize), url: link, headers: {} };
  }

  return {
    id,
    title,
    kind: 'multihoster',
    base,
    linkTTLms: 3 * HOUR,
    enabled: (s) => !!s.enabled && !!s.login && !!s.password,
    hosts,
    unrestrict,
    cachedMagnet: async () => null,
  };
}
