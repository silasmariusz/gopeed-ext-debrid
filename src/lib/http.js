// JSON requests to a provider's API, with a timeout and errors a user can read.
//
// Everything that goes wrong becomes a ProviderError whose message is "<provider>: <reason>". A raw parse error or
// a fetch error never escapes, and no message carries the URL (a query can hold an API key).
//
// Error codes set here: 'timeout', 'network', 'bad_response' (the body is not JSON), or, for an answer of HTTP 400
// or more with a JSON body, the code the body gives ('bad_token', 'AUTH_BAD_APIKEY', ...) or else 'http'. Such an
// error also carries the parsed body as err.body, so a provider can map its own error codes.
//
// Secrets: a provider may echo the credential it was sent. requestJSON takes the call's credentials as `secrets`
// (see secretsOf in settings.js) and hands them to every ProviderError it makes. ProviderError hides them in its
// reason, its message, a string code and every string of its body, before anything is stored, and keeps no copy.
import { redact } from './redact.js';

function redactDeep(value, secrets, depth) {
  if (typeof value === 'string') return redact(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32) return '••••';
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) out[redact(key, secrets)] = redactDeep(value[key], secrets, depth + 1);
  return out;
}

export class ProviderError extends Error {
  constructor(provider, message, extra = {}) {
    // Redacted before super(), so the stack an engine captures from the message never holds a secret either.
    const secrets = Array.isArray(extra.secrets) ? extra.secrets : [];
    const reason = redact(message, secrets);
    super(provider ? `${provider}: ${reason}` : reason);
    this.name = 'ProviderError';
    this.provider = provider;
    this.reason = reason;
    this.status = extra.status;
    this.code = typeof extra.code === 'string' ? redact(extra.code, secrets) : extra.code;
    if (extra.body !== undefined) this.body = secrets.length ? redactDeep(extra.body, secrets, 0) : extra.body;
  }
}

function encodeParams(params) {
  const parts = [];
  for (const key of Object.keys(params || {})) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
}

function userAgent() {
  const info = typeof gopeed !== 'undefined' && gopeed && gopeed.info;
  return `gopeed-ext-debrid/${(info && info.version) || 'dev'}`;
}

// The provider's own error text, redacted before it is cut to 200 characters, so a secret across the cut cannot
// leave half of itself behind.
function errorText(body, secrets) {
  if (!body || typeof body !== 'object') return '';
  const err = body.error;
  const candidates = [err && typeof err === 'object' ? err.message : undefined, body.detail, body.message, err];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return redact(c.trim(), secrets).slice(0, 200);
  }
  return '';
}

function errorCode(body) {
  if (!body || typeof body !== 'object') return 'http';
  const err = body.error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object' && err.code !== undefined && err.code !== null) return String(err.code);
  if (body.error_code !== undefined && body.error_code !== null) return String(body.error_code);
  return 'http';
}

function seconds(ms) {
  return Math.round((ms / 1000) * 10) / 10;
}

export async function requestJSON(provider, method, url, { headers = {}, form, json, query, timeoutMs = 30000, secrets = [] } = {}) {
  let target = url;
  const qs = encodeParams(query);
  if (qs) target += (target.indexOf('?') < 0 ? '?' : '&') + qs;

  const init = { method: String(method || 'GET').toUpperCase(), headers: { 'User-Agent': userAgent(), Accept: 'application/json' } };
  if (form !== undefined) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encodeParams(form);
  } else if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  // A caller's header replaces ours whatever its case, so the request never carries two of one name.
  for (const name of Object.keys(headers || {})) {
    for (const own of Object.keys(init.headers)) {
      if (own.toLowerCase() === name.toLowerCase()) delete init.headers[own];
    }
    init.headers[name] = headers[name];
  }

  // goja's fetch cannot be relied on to abort, so the request races a timer, which is cleared afterwards
  // so that no 30 s timer outlives the call.
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderError(provider, `the service did not answer within ${seconds(timeoutMs)} s`, { code: 'timeout', secrets }));
    }, timeoutMs);
  });

  const exchange = (async () => {
    let res;
    try {
      res = await fetch(target, init);
    } catch (e) {
      throw new ProviderError(provider, 'the service could not be reached', { code: 'network', secrets });
    }
    const status = Number(res.status);
    let text;
    try {
      text = await res.text();
    } catch (e) {
      throw new ProviderError(provider, `the service did not answer properly (HTTP ${status})`, { status, code: 'bad_response', secrets });
    }
    const empty = typeof text !== 'string' || text.trim() === '';
    if (empty && status < 400) return null;
    let body;
    try {
      if (empty) throw new Error('empty');
      body = JSON.parse(text);
    } catch (e) {
      throw new ProviderError(provider, `the service did not answer properly (HTTP ${status})`, { status, code: 'bad_response', secrets });
    }
    if (status >= 400) {
      const detail = errorText(body, secrets);
      throw new ProviderError(provider, `the service answered HTTP ${status}${detail ? `: ${detail}` : ''}`, {
        status,
        code: errorCode(body),
        body,
        secrets,
      });
    }
    return body;
  })();

  try {
    return await Promise.race([exchange, timeout]);
  } finally {
    if (typeof clearTimeout === 'function') clearTimeout(timer);
  }
}
