// What every provider module shares: the API wrapper (auth, secrets, error mapping, the login cooldown), the host
// list cache, and a few small helpers. A provider describes its service (its error codes above all) and this file
// does the rest the same way for each of them.
//
// The error codes a provider throws (ProviderError.code). The message is "<Title>: <reason>" and names the cause:
//   auth_invalid     the service refused the key or login. It starts the 10-minute cooldown.
//   cooldown         a call was refused without being sent, because of that pause
//   account_expired  the account has expired, is locked or is not premium
//   limit_reached    a daily, monthly or per-host limit, or too many active downloads
//   not_supported    the service does not handle this host. The next provider may.
//   dead_link        the link is dead or the file was removed
//   service_down     a 5xx, or the host is in maintenance. Try again later.
//   rate_limited     too many requests
//   not_ready        the file is still being prepared (the polling gave up)
//   login_required   Real-Debrid's device login needs the user (the code is in the message)
//   ip_not_allowed   the service refuses this IP address (a VPN or a datacenter)
//   bad_password     the file needs a password, or the one given is wrong
//   timeout, network, bad_response   from requestJSON
// Any other code is the service's own error code, with its own text as the reason.
import { requestJSON, ProviderError } from '../lib/http.js';
import { secretsOf, apiBase } from '../lib/settings.js';
import { cached } from '../lib/cache.js';
import { cooldownLeft, startCooldown, COOLDOWN_MS } from '../lib/cooldown.js';
import { hostOf, hostMatches } from '../lib/hosts.js';

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const HOSTS_TTL_MS = 24 * HOUR;
// A host-list request waits at most this long: it runs before every link, ordinary ones included.
export const HOSTS_TIMEOUT_MS = 10 * 1000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The last path segment: "Show/E01.mkv" gives "E01.mkv".
export function baseName(path) {
  const parts = String(path === undefined || path === null ? '' : path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const REASON = {
  auth_invalid: 'invalid API key',
  account_expired: 'the account has expired or is not premium',
  not_supported: 'this host is not supported',
  dead_link: 'the link is dead or the file was removed',
  service_down: 'the host or the service is unavailable, try again later',
  rate_limited: 'too many requests, try again in a minute',
  ip_not_allowed: 'the service refuses this IP address (a VPN or a server address is not allowed)',
  bad_password: 'the file needs a password, or the password is wrong',
};

// A known failure: { code, reason }. The reason is the standard one unless the provider words it better.
export const known = (code, reason) => ({ code, reason: reason || REASON[code] });
export const limit = (detail) => ({ code: 'limit_reached', reason: detail ? `limit reached (${detail})` : 'limit reached' });

// Domain names from a provider's list: lowercase, no "www." or "*.", one entry each, only names with a dot.
function cleanDomains(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue;
    const d = raw.trim().toLowerCase().replace(/^(\*\.|www\.)/, '').replace(/\.$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && out.indexOf(d) < 0) out.push(d);
  }
  return out;
}

// The provider's domain list, loaded by loader() and kept for 24 h under `hosts:<id>`. An empty list is not kept.
export async function hostList(id, loader) {
  const list = await cached(`hosts:${id}`, HOSTS_TTL_MS, async () => {
    const domains = cleanDomains(await loader());
    return domains.length ? domains : undefined;
  });
  return Array.isArray(list) ? list : [];
}

// True when the link's host is one of the provider's domains. A magnet has no host, so it never matches.
export async function claims(hostsOf, s, url) {
  const host = hostOf(url);
  return !!host && hostMatches(host, await hostsOf(s));
}

function warn(message) {
  try {
    gopeed.logger.warn(message);
  } catch (e) {
    // no logger: nothing to say it to
  }
}

// The API wrapper of one provider for one operation.
//
//   id, title, base   the provider's id, its name in messages, and its default base URL (apiBase may replace it)
//   settings          providerSettings(id)
//   credential()      the credential the cooldown is keyed by (a changed credential ends the pause)
//   authHeaders()     the headers every authenticated call carries
//   classify(body, status)  a { code, reason } for an error code the provider knows, else null
//   envelope(body)    { code, text } for any other error envelope, else null (the status decides, or it is success)
//   runtime           secrets that are not settings (tokens from a login). A provider pushes into this array, and
//                     the wrapper reads it on every call.
//
//   call(method, path, { form, json, query, headers, auth = true, raw, noTrip, timeoutMs })
//     Sends the request to apiBase(id, base) + path with every secret handed to requestJSON, and returns the parsed
//     body. An error answer is mapped to a ProviderError with the codes above; auth_invalid also starts the cooldown
//     (unless noTrip). raw skips the mapping, for OAuth endpoints whose errors mean something else.
//   guard()           throws a "cooldown" error while the credential is paused
//   trip(reason)      starts the cooldown
//   fail(code, reason, extra)  a ProviderError of this provider that carries the secrets
//   check(body, status)        throws the mapped error when body is an error answer
export function createApi({ id, title, base, settings, credential, authHeaders, classify, envelope, runtime = [] }) {
  const secrets = () => [...secretsOf(settings), ...runtime];

  function fail(code, reason, extra = {}) {
    return new ProviderError(title, reason, Object.assign({}, extra, { code, secrets: secrets() }));
  }

  async function guard() {
    const left = await cooldownLeft(id, credential());
    if (left) {
      const unit = left.minutes === 1 ? 'minute' : 'minutes';
      throw fail('cooldown', `${left.reason}, not retrying for ${left.minutes} more ${unit} (changing the setting ends the pause)`);
    }
  }

  async function trip(reason) {
    await startCooldown(id, credential(), reason);
    warn(`${title}: ${reason}; no further calls for ${COOLDOWN_MS / MIN} minutes`);
  }

  // The mapping of an answer to a failure, or null when the answer is not an error.
  function translate(body, status) {
    const c = classify(body, status);
    if (c) return c;
    if (status === 401) return known('auth_invalid');
    if (status === 403) {
      // A JSON 403 is the service refusing the credential. Anything else (an HTML block page of Cloudflare or a
      // WAF) is a refusal of this address, not of the key, so it neither pauses the provider nor drops a login.
      if (body && typeof body === 'object') return known('auth_invalid', 'the service refused the request (HTTP 403), check the API key');
      return known('ip_not_allowed', "blocked by the service's protection (HTTP 403); a VPN or datacenter address is often refused");
    }
    if (status === 429) return known('rate_limited');
    if (status >= 500) return known('service_down', `the service is down (HTTP ${status})`);
    const env = envelope ? envelope(body) : null;
    return env ? { code: env.code, reason: env.text || 'the service reported an error' } : null;
  }

  async function raise(c, status, body, noTrip) {
    if (c.code === 'auth_invalid' && !noTrip) await trip(c.reason);
    throw fail(c.code, c.reason, { status, body });
  }

  async function check(body, status = 200, noTrip = false) {
    const c = translate(body, status);
    if (c) await raise(c, status, body, noTrip);
  }

  async function call(method, path, { form, json, query, headers, auth = true, raw = false, noTrip = false, timeoutMs } = {}) {
    const sent = Object.assign({}, auth ? authHeaders() : {}, headers || {});
    let body;
    try {
      body = await requestJSON(title, method, apiBase(id, base) + path, { headers: sent, form, json, query, timeoutMs, secrets: secrets() });
    } catch (e) {
      if (raw || !(e instanceof ProviderError) || !(e.status >= 400)) throw e;
      const c = translate(e.body, e.status);
      if (!c) throw e;
      return raise(c, e.status, e.body, noTrip);
    }
    if (!raw) await check(body, 200, noTrip);
    return body;
  }

  return { call, guard, trip, fail, check, secrets, title };
}
