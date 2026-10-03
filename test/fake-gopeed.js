// A fake of the globals Gopeed's goja engine gives an extension: `gopeed`, `MessageError` and `fetch`.
// Each test calls installFakeGopeed() for a fresh fake; it replaces the previous one.
//
//   const fake = installFakeGopeed({ settings: { torbox_apikey: 'k' } });
//   fake.route('GET', 'https://api.torbox.app/v1/api/', (req) => ({ status: 200, json: { success: true } }));
//   fake.calls      every request: { method, url, headers (lowercase names), body, query, form, json }
//   fake.unmatched  requests no route answered (fetch rejects for them)
//   fake.settings   the object behind gopeed.settings (mutate it to change settings)
//   fake.storage    Map-backed async storage, the object behind gopeed.storage (its Map is fake.storage.map)
//   fake.logs       gopeed.logger lines: { level, msg }
//   fake.hooks      the functions registered with gopeed.events.on*
//
// A handler gets the recorded request and returns (or resolves to) { status, json | text, headers }.
// A handler that returns a promise that never settles makes fetch hang, the way a silent server does.
import { readFileSync } from 'node:fs';

// goja's MessageError is a Go constructor whose prototype is MessageError.prototype only: it is not an Error
// (pkg/download/engine/inject/error/module.go). The fake keeps that, so code that relies on instanceof Error fails here too.
class MessageError {
  constructor(message) {
    this.message = message === undefined ? '' : String(message);
  }
}

function parseParams(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq < 0 ? part : part.slice(0, eq);
    const rawVal = eq < 0 ? '' : part.slice(eq + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    const val = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    if (key in out) out[key] = [].concat(out[key], val);
    else out[key] = val;
  }
  return out;
}

function plainHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) {
    h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
    return out;
  }
  const entries = Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = String(v);
  return out;
}

function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}).map(([k, v]) => [k, String(v)]));
  return {
    map,
    // Gopeed's ContextStorage: Get returns null for a missing key, Set(key, value string) stores a string.
    async get(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    async set(key, value) { map.set(String(key), String(value)); },
    async remove(key) { map.delete(String(key)); },
    async keys() { return [...map.keys()]; },
    async clear() { map.clear(); },
  };
}

function makeResponse(url, r) {
  const status = r.status === undefined ? 200 : r.status;
  const headers = plainHeaders(r.headers);
  let text = '';
  if (r.json !== undefined) {
    text = JSON.stringify(r.json);
    if (!('content-type' in headers)) headers['content-type'] = 'application/json';
  } else if (r.text !== undefined) {
    text = String(r.text);
  }
  let used = false;
  const read = () => {
    if (used) throw new TypeError('fake-gopeed: the response body was already read');
    used = true;
    return text;
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: '',
    url,
    redirected: false,
    headers: {
      get(name) {
        const v = headers[String(name).toLowerCase()];
        return v === undefined ? null : v;
      },
      has(name) { return String(name).toLowerCase() in headers; },
    },
    async text() { return read(); },
    async json() { return JSON.parse(read()); },
  };
}

function readManifest() {
  return JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
}

export function installFakeGopeed({ settings = {}, storage = {} } = {}) {
  const routes = [];
  const manifest = readManifest();
  const fake = {
    settings: { ...settings },
    storage: makeStorage(storage),
    calls: [],
    unmatched: [],
    logs: [],
    hooks: {},
    route(method, urlPrefix, handler) {
      routes.push({ method: String(method).toUpperCase(), prefix: urlPrefix, handler });
      return fake;
    },
    callsTo(urlPrefix) {
      return fake.calls.filter((c) => c.url.startsWith(urlPrefix));
    },
  };

  const log = (level) => (...args) => { fake.logs.push({ level, msg: args.map(String).join(' ') }); };
  const register = (name) => (fn) => { fake.hooks[name] = fn; };

  globalThis.gopeed = {
    events: {
      onResolve: register('onResolve'),
      onStart: register('onStart'),
      onError: register('onError'),
      onDone: register('onDone'),
    },
    settings: fake.settings,
    storage: fake.storage,
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    info: {
      identity: `${manifest.author}@${manifest.name}`,
      name: manifest.name,
      author: manifest.author,
      title: manifest.title,
      version: manifest.version,
    },
  };
  globalThis.MessageError = MessageError;

  globalThis.fetch = async function fetch(input, init = {}) {
    const url = typeof input === 'string' ? input : String(input && input.url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = plainHeaders(init.headers);
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const qi = url.indexOf('?');
    const req = {
      method,
      url,
      headers,
      body,
      query: parseParams(qi < 0 ? '' : url.slice(qi + 1).split('#')[0]),
      form: undefined,
      json: undefined,
    };
    const type = headers['content-type'] || '';
    if (body !== undefined && type.startsWith('application/x-www-form-urlencoded')) req.form = parseParams(body);
    if (body !== undefined && type.startsWith('application/json')) req.json = JSON.parse(body);
    fake.calls.push(req);

    // The longest matching prefix wins; on a tie, the route registered last wins.
    let best = null;
    for (const r of routes) {
      if ((r.method === method || r.method === '*') && url.startsWith(r.prefix)) {
        if (!best || r.prefix.length >= best.prefix.length) best = r;
      }
    }
    if (!best) {
      fake.unmatched.push(req);
      process.stderr.write(`fake-gopeed: no route for ${method} ${url}\n`);
      throw new TypeError(`fake-gopeed: no route for ${method} ${url}`);
    }
    const answer = await best.handler(req);
    return makeResponse(url, answer || {});
  };

  return fake;
}
