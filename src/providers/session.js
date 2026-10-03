// The login session of a provider that signs in with a login and a password (the Polish multihosters, Rapidgator).
//
// The token a login returns is kept under `session:<id>` as {login, token} for ttlMs, and only for the login it
// belongs to: after the user switches accounts, the old account's token is not used. The password is never stored.
// The token is a secret: every value read or stored here is pushed into `runtime`, the list of secrets the API
// wrapper hides in every error.
import { recall, remember } from '../lib/cache.js';

export function sessionStore(id, ttlMs, runtime) {
  const key = `session:${id}`;
  const track = (token) => {
    if (typeof token === 'string' && token && runtime.indexOf(token) < 0) runtime.push(token);
  };
  return {
    // The stored token of this login, or '' when there is none.
    async get(login) {
      const s = await recall(key);
      if (!s || typeof s !== 'object' || s.login !== login || typeof s.token !== 'string' || !s.token) return '';
      track(s.token);
      return s.token;
    },
    async set(login, token) {
      track(token);
      await remember(key, { login, token }, ttlMs);
    },
    async drop() {
      await gopeed.storage.remove(key);
    },
    track,
  };
}

// One login at a time per account. While a login for `key` (the provider's credential) is on its way, every other
// caller gets the same promise instead of logging in again; once it settles, the next caller starts a new one.
// The map lives in the provider module, so it spans the concurrent resolves of one extension run.
export function sharedLogin(inflight, key, loginFn) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = Promise.resolve().then(loginFn);
  inflight.set(key, p);
  const clear = () => {
    if (inflight.get(key) === p) inflight.delete(key);
  };
  p.then(clear, clear);
  return p;
}

// True for a login error that is the service's own refusal (an error answer with a body), not a network fault, a
// timeout, a block page, a 5xx or a rate limit. Such a refusal starts the pause: a login is never retried by itself.
export function isRefusal(e) {
  if (!e || !e.body || typeof e.body !== 'object') return false;
  if (e.status >= 500) return false;
  return ['service_down', 'rate_limited', 'timeout', 'network', 'bad_response', 'cooldown'].indexOf(e.code) < 0;
}
