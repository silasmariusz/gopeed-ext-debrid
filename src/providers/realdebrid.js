// Real-Debrid. Two ways to sign in, both sent as "Authorization: Bearer <token>":
//
//   1. The device flow for open-source apps (client_id X245A4XAIBGVM, published in the API documentation). It is
//      used when `realdebrid_token` is empty. Gopeed settings cannot show a code and an extension has no loop between
//      hooks, so the first resolve gets a device code and fails with "open https://real-debrid.com/device and enter
//      <code>"; the next resolve asks /device/credentials once and, when the user has entered the code, trades it for
//      tokens and keeps them in storage under `rd:auth`. An expired access token, or a 401, is refreshed once with
//      the same grant and the refresh token.
//   2. The private API token in `realdebrid_token`, used as it is. It is the fallback, and it is never used by an
//      app that other people use.
//
// Hoster link: POST /rest/1.0/unrestrict/link.
// Magnet: addMagnet, selectFiles (all), info for up to 10 s. A torrent that is `downloaded` in that time is cached:
// every link is unrestricted. Any other torrent, or any error after the add, is removed with DELETE torrents/delete.
// Host list: GET /rest/1.0/hosts/domains, public.
// Source: docs/notes/2026-10-02-hoster-apis.md, the Real-Debrid section, and https://api.real-debrid.com/.
import { parseMagnet } from '../lib/magnet.js';
import { ProviderError } from '../lib/http.js';
import { recall, remember } from '../lib/cache.js';
import { createApi, claims, hostList, known, limit, text, num, sleep, MIN, HOUR, HOSTS_TIMEOUT_MS } from './common.js';

const ID = 'realdebrid';
const TITLE = 'Real-Debrid';
const BASE = 'https://api.real-debrid.com';
const REST = '/rest/1.0';
const OAUTH = '/oauth/v2';
const OPEN_SOURCE_CLIENT_ID = 'X245A4XAIBGVM';
const DEVICE_GRANT = 'http://oauth.net/grant_type/device/1.0';
const DEVICE_PAGE = 'https://real-debrid.com/device';
const AUTH_KEY = 'rd:auth';
const DEVICE_KEY = 'rd:device';
const AUTH_TTL_MS = 365 * 24 * HOUR; // a refresh token lives until it is revoked
const EXPIRY_SKEW_MS = 60 * 1000;
const PROBE_MS = 10 * 1000;
const PROBE_POLL_MS = 2000;
// Torrent states that will not become `downloaded` by waiting.
const DEAD_TORRENT = ['magnet_error', 'error', 'virus', 'dead'];

// error_code decides, not the HTTP status (the docs tie only 401, 403, 429 and 503 to a cause).
function makeClassify(s) {
  return function classify(body, status) {
    // HTTP 401 is a bad token whatever the body says (error_code 8).
    const code = status === 401 ? 8 : body && typeof body === 'object' ? num(body.error_code) : 0;
    switch (code) {
      case 8:
        return known('auth_invalid', s.token ? 'invalid private API token' : 'the login expired or was revoked');
      case 9:
      case 14:
        return known('account_expired', 'the account is locked or not premium');
      case 16:
        return known('not_supported');
      case 17:
      case 19:
        return known('service_down', 'the host is in maintenance or unavailable, try again later');
      case 18:
        return limit('the host limit');
      case 20:
        return known('account_expired');
      case 21:
        return limit('too many active downloads');
      case 22:
        return known('ip_not_allowed');
      case 23:
      case 36:
        return limit('traffic exhausted or fair-use limit');
      case 24:
      case 35:
        return known('dead_link');
      case 25:
        return known('service_down');
      case 34:
        return known('rate_limited');
      case 37:
        return known('service_down', 'Real-Debrid has disabled this endpoint');
      default:
        return null;
    }
  };
}

// The calls of one operation: the API wrapper, the credentials in use, and the secrets they bring.
function session(s) {
  const runtime = [];
  const api = createApi({
    id: ID,
    title: TITLE,
    base: BASE,
    settings: s,
    // A changed private token is a different credential. The device login is one credential, and the pause outlives
    // the stored login, which is dropped when it is refused.
    credential: () => (s.token ? `token:${s.token}` : 'device-login'),
    authHeaders: () => ({}),
    classify: makeClassify(s),
    runtime,
  });

  // The values a login brings are secrets: they are hidden in every error from here on.
  const track = (...values) => {
    for (const v of values) if (typeof v === 'string' && v && runtime.indexOf(v) < 0) runtime.push(v);
  };
  const trackAuth = (a) => track(a && a.access_token, a && a.refresh_token, a && a.client_secret, a && a.client_id);
  const forget = (key) => gopeed.storage.remove(key);

  function waiting(dev) {
    const minutes = Math.max(1, Math.round((num(dev.expires_at) - Date.now()) / MIN));
    return api.fail('login_required', `open ${DEVICE_PAGE} and enter ${dev.user_code}, then add the link again (the code is valid for ${minutes} minutes)`);
  }

  const isClientError = (e) => e instanceof ProviderError && e.status >= 400 && e.status < 500 && e.status !== 429;

  // The OAuth endpoints are called raw: their errors do not follow the REST error codes.
  const oauth = (method, path, opts) => api.call(method, OAUTH + path, Object.assign({ auth: false, raw: true }, opts));

  async function storeTokens(prev, tokens) {
    const auth = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || prev.refresh_token,
      client_id: prev.client_id,
      client_secret: prev.client_secret,
      expires_at: Date.now() + num(tokens.expires_in) * 1000,
    };
    trackAuth(auth);
    await remember(AUTH_KEY, auth, AUTH_TTL_MS);
    return auth.access_token;
  }

  async function exchange(client, code) {
    const tokens = await oauth('POST', '/token', {
      form: { client_id: client.client_id, client_secret: client.client_secret, code, grant_type: DEVICE_GRANT },
    });
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) throw api.fail('bad_response', 'the service gave no access token');
    return tokens;
  }

  // The stored login is refused: drop it, pause, and say so once. The next try after the pause starts a new device login.
  async function loginRefused(reason) {
    await forget(AUTH_KEY);
    await api.trip(reason);
    throw api.fail('auth_invalid', reason);
  }

  async function refresh(auth) {
    try {
      const tokens = await exchange(auth, auth.refresh_token);
      return await storeTokens(auth, tokens);
    } catch (e) {
      if (isClientError(e)) await loginRefused('the login expired or was revoked');
      throw e;
    }
  }

  async function deviceLogin() {
    const dev = await recall(DEVICE_KEY);
    if (dev && typeof dev === 'object' && num(dev.expires_at) > Date.now()) {
      track(dev.device_code);
      let client;
      try {
        client = await oauth('GET', '/device/credentials', { query: { client_id: OPEN_SOURCE_CLIENT_ID, code: dev.device_code } });
      } catch (e) {
        // Until the user has entered the code, the answer is an error (its shape is not documented): keep waiting.
        if (isClientError(e)) throw waiting(dev);
        throw e;
      }
      if (!client || !client.client_id || !client.client_secret) throw waiting(dev);
      track(client.client_id, client.client_secret);
      let tokens;
      try {
        tokens = await exchange(client, dev.device_code);
      } catch (e) {
        // A code that was already used, or one the service no longer accepts, is spent: drop it, so no later resolve
        // asks again with it, and say how to get a new one. No pause: this is not a refused key.
        if (isClientError(e)) {
          await forget(DEVICE_KEY);
          throw api.fail('login_required', 'the device login was not accepted; add the link again to get a new code', { status: e.status, body: e.body });
        }
        throw e;
      }
      const token = await storeTokens(client, tokens);
      await forget(DEVICE_KEY);
      return token;
    }
    const code = await oauth('GET', '/device/code', { query: { client_id: OPEN_SOURCE_CLIENT_ID, new_credentials: 'yes' } });
    if (!code || !code.device_code || !code.user_code) throw api.fail('bad_response', 'the service gave no device code');
    const expiresIn = num(code.expires_in) > 0 ? num(code.expires_in) : 1800;
    const stored = { device_code: code.device_code, user_code: code.user_code, expires_at: Date.now() + expiresIn * 1000 };
    track(code.device_code);
    await remember(DEVICE_KEY, stored, expiresIn * 1000);
    throw waiting(stored);
  }

  // The access token of the device login. force skips the expiry check (after a 401).
  async function accessToken(force) {
    const auth = await recall(AUTH_KEY);
    if (!auth || typeof auth !== 'object' || !auth.access_token) return deviceLogin();
    trackAuth(auth);
    if (!force && num(auth.expires_at) > Date.now() + EXPIRY_SKEW_MS) return auth.access_token;
    return refresh(auth);
  }

  // A REST call with the right token. A 401 on a device login refreshes the token once and repeats the call once.
  async function rest(method, path, opts = {}) {
    const url = REST + path;
    if (s.token) return api.call(method, url, Object.assign({}, opts, { headers: { Authorization: `Bearer ${s.token}` } }));
    const token = await accessToken(false);
    try {
      return await api.call(method, url, Object.assign({}, opts, { headers: { Authorization: `Bearer ${token}` }, noTrip: true }));
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== 'auth_invalid') throw e;
    }
    const fresh = await accessToken(true);
    try {
      return await api.call(method, url, Object.assign({}, opts, { headers: { Authorization: `Bearer ${fresh}` } }));
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'auth_invalid') await forget(AUTH_KEY);
      throw e;
    }
  }

  return { api, rest };
}

async function hosts(s) {
  return hostList(ID, async () => {
    const body = await session(s).api.call('GET', `${REST}/hosts/domains`, { auth: false, timeoutMs: HOSTS_TIMEOUT_MS });
    return Array.isArray(body) ? body : [];
  });
}

async function unrestrictLink(rest, api, link) {
  const res = await rest('POST', '/unrestrict/link', { form: { link } });
  // A video site can answer with an array. The first entry is used.
  const d = Array.isArray(res) ? res[0] : res;
  if (!d || typeof d.download !== 'string' || !d.download) throw api.fail('bad_response', 'the service gave no download link');
  return { name: text(d.filename), size: num(d.filesize), url: d.download, headers: {} };
}

async function unrestrict(s, url) {
  if (!(await claims(hosts, s, url))) return null;
  const { api, rest } = session(s);
  await api.guard();
  return unrestrictLink(rest, api, url);
}

async function deleteQuietly(rest, id) {
  try {
    await rest('DELETE', `/torrents/delete/${encodeURIComponent(id)}`);
  } catch (e) {
    // The first error matters more than a failed clean-up.
  }
}

async function cachedMagnet(s, magnet) {
  if (!parseMagnet(magnet)) return null;
  const { api, rest } = session(s);
  await api.guard();
  const added = await rest('POST', '/torrents/addMagnet', { form: { magnet } });
  const id = added && typeof added.id === 'string' ? added.id : '';
  if (!id) throw api.fail('bad_response', 'the service did not accept the magnet');

  // The torrent exists from here on. Only a cached torrent whose links were all unrestricted stays; anything else
  // (not cached in 10 s, a dead torrent, an error) is deleted again.
  try {
    const deadline = Date.now() + PROBE_MS;
    let selected = false;
    let info = null;
    for (;;) {
      info = await rest('GET', `/torrents/info/${encodeURIComponent(id)}`);
      const state = info ? info.status : '';
      if (state === 'downloaded') break;
      if (DEAD_TORRENT.indexOf(state) >= 0) {
        info = null;
        break;
      }
      if (state === 'waiting_files_selection' && !selected) {
        await rest('POST', `/torrents/selectFiles/${encodeURIComponent(id)}`, { form: { files: 'all' } });
        selected = true;
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        info = null;
        break;
      }
      await sleep(Math.min(PROBE_POLL_MS, left));
    }
    const links = info && Array.isArray(info.links) ? info.links.filter((l) => typeof l === 'string' && l) : [];
    if (!links.length) {
      await deleteQuietly(rest, id);
      return null;
    }
    // The torrent's own links are on real-debrid.com, which is not in the host list, so they skip the claim.
    const files = [];
    for (const link of links) files.push(await unrestrictLink(rest, api, link));
    return files;
  } catch (e) {
    // A refused login cannot delete anything, and the pause it started forbids another call (a clean-up would also
    // start a new device login).
    if (!e || e.code !== 'auth_invalid') await deleteQuietly(rest, id);
    throw e;
  }
}

export default {
  id: ID,
  title: TITLE,
  kind: 'debrid',
  base: BASE,
  linkTTLms: 3 * HOUR,
  // The device login needs no setting, so the switch is enough.
  enabled: (s) => !!s.enabled,
  hosts,
  unrestrict,
  cachedMagnet,
};
