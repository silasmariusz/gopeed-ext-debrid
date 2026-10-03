(() => {
  // src/lib/magnet.js
  var BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function base32ToHex(s) {
    let bits = 0;
    let value = 0;
    let hex = "";
    for (const ch of s.toUpperCase()) {
      const idx = BASE32.indexOf(ch);
      if (idx < 0) return null;
      value = value << 5 | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        hex += (value >>> bits & 255).toString(16).padStart(2, "0");
      }
    }
    return hex;
  }
  function decode(s) {
    const plus = s.replace(/\+/g, " ");
    try {
      return decodeURIComponent(plus);
    } catch (e) {
      return plus;
    }
  }
  function infoHash(xt) {
    const m = /^urn:btih:(.+)$/i.exec(xt);
    if (!m) return null;
    const h = m[1].trim();
    if (/^[0-9a-f]{40}$/i.test(h)) return h.toLowerCase();
    if (/^[a-z2-7]{32}$/i.test(h)) return base32ToHex(h);
    return null;
  }
  function parseMagnet(uri) {
    if (typeof uri !== "string" || !/^magnet:\?/i.test(uri)) return null;
    let hash = null;
    let name = "";
    const trackers = [];
    for (const part of uri.slice(8).split("#")[0].split("&")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const key = part.slice(0, eq).toLowerCase();
      const value = decode(part.slice(eq + 1));
      if (/^xt(\.\d+)?$/.test(key)) {
        if (!hash) hash = infoHash(value);
      } else if (key === "dn") {
        if (!name) name = value;
      } else if (/^tr(\.\d+)?$/.test(key)) {
        if (value && trackers.indexOf(value) < 0) trackers.push(value);
      }
    }
    if (!hash) return null;
    return { hash, name, trackers };
  }

  // src/lib/redact.js
  var MASK = "\u2022\u2022\u2022\u2022";
  function escapeRegExp(ch) {
    return ch.replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&");
  }
  function percentPattern(ch) {
    let pct;
    const code = ch.charCodeAt(0);
    if (ch.length === 1 && code < 128) {
      pct = `%${code < 16 ? "0" : ""}${code.toString(16)}`;
    } else {
      try {
        pct = encodeURIComponent(ch);
      } catch (e) {
        return null;
      }
    }
    return pct.replace(/[0-9a-f]/gi, (d) => /[0-9]/.test(d) ? d : `[${d.toLowerCase()}${d.toUpperCase()}]`);
  }
  function patternOf(secret) {
    let re = "";
    for (const ch of secret) {
      if (ch === " ") {
        re += "(?: |\\+|%20)";
        continue;
      }
      const pct = percentPattern(ch);
      re += pct ? `(?:${escapeRegExp(ch)}|${pct})` : escapeRegExp(ch);
    }
    return new RegExp(re, "g");
  }
  function redact(text2, secrets) {
    let out = text2 === void 0 || text2 === null ? "" : String(text2);
    const all = [];
    for (const s of Array.isArray(secrets) ? secrets : []) {
      if (s === void 0 || s === null) continue;
      const str = String(s);
      if (!str.trim()) continue;
      for (const f of [str, str.trim()]) {
        if (all.indexOf(f) < 0) all.push(f);
      }
    }
    all.sort((a, b) => b.length - a.length);
    for (const secret of all) out = out.replace(patternOf(secret), MASK);
    return out;
  }

  // src/lib/http.js
  function redactDeep(value, secrets, depth) {
    if (typeof value === "string") return redact(value, secrets);
    if (value === null || typeof value !== "object") return value;
    if (depth > 32) return "\u2022\u2022\u2022\u2022";
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) out[redact(key, secrets)] = redactDeep(value[key], secrets, depth + 1);
    return out;
  }
  var ProviderError = class extends Error {
    constructor(provider, message, extra = {}) {
      const secrets = Array.isArray(extra.secrets) ? extra.secrets : [];
      const reason = redact(message, secrets);
      super(provider ? `${provider}: ${reason}` : reason);
      this.name = "ProviderError";
      this.provider = provider;
      this.reason = reason;
      this.status = extra.status;
      this.code = typeof extra.code === "string" ? redact(extra.code, secrets) : extra.code;
      if (extra.body !== void 0) this.body = secrets.length ? redactDeep(extra.body, secrets, 0) : extra.body;
    }
  };
  function encodeParams(params) {
    const parts = [];
    for (const key of Object.keys(params || {})) {
      const value = params[key];
      if (value === void 0 || value === null) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (v === void 0 || v === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
      }
    }
    return parts.join("&");
  }
  function userAgent() {
    const info3 = typeof gopeed !== "undefined" && gopeed && gopeed.info;
    return `gopeed-ext-debrid/${info3 && info3.version || "dev"}`;
  }
  function errorText(body, secrets) {
    if (!body || typeof body !== "object") return "";
    const err = body.error;
    const candidates = [err && typeof err === "object" ? err.message : void 0, body.detail, body.message, err];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return redact(c.trim(), secrets).slice(0, 200);
    }
    return "";
  }
  function errorCode(body) {
    if (!body || typeof body !== "object") return "http";
    const err = body.error;
    if (typeof err === "string" && err) return err;
    if (err && typeof err === "object" && err.code !== void 0 && err.code !== null) return String(err.code);
    if (body.error_code !== void 0 && body.error_code !== null) return String(body.error_code);
    return "http";
  }
  function seconds(ms) {
    return Math.round(ms / 1e3 * 10) / 10;
  }
  async function requestJSON(provider, method, url, { headers = {}, form, json, query, timeoutMs = 3e4, secrets = [] } = {}) {
    let target = url;
    const qs = encodeParams(query);
    if (qs) target += (target.indexOf("?") < 0 ? "?" : "&") + qs;
    const init = { method: String(method || "GET").toUpperCase(), headers: { "User-Agent": userAgent(), Accept: "application/json" } };
    if (form !== void 0) {
      init.headers["Content-Type"] = "application/x-www-form-urlencoded";
      init.body = encodeParams(form);
    } else if (json !== void 0) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    for (const name of Object.keys(headers || {})) {
      for (const own of Object.keys(init.headers)) {
        if (own.toLowerCase() === name.toLowerCase()) delete init.headers[own];
      }
      init.headers[name] = headers[name];
    }
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ProviderError(provider, `the service did not answer within ${seconds(timeoutMs)} s`, { code: "timeout", secrets }));
      }, timeoutMs);
    });
    const exchange = (async () => {
      let res;
      try {
        res = await fetch(target, init);
      } catch (e) {
        throw new ProviderError(provider, "the service could not be reached", { code: "network", secrets });
      }
      const status = Number(res.status);
      let text2;
      try {
        text2 = await res.text();
      } catch (e) {
        throw new ProviderError(provider, `the service did not answer properly (HTTP ${status})`, { status, code: "bad_response", secrets });
      }
      const empty = typeof text2 !== "string" || text2.trim() === "";
      if (empty && status < 400) return null;
      let body;
      try {
        if (empty) throw new Error("empty");
        body = JSON.parse(text2);
      } catch (e) {
        throw new ProviderError(provider, `the service did not answer properly (HTTP ${status})`, { status, code: "bad_response", secrets });
      }
      if (status >= 400) {
        const detail = errorText(body, secrets);
        throw new ProviderError(provider, `the service answered HTTP ${status}${detail ? `: ${detail}` : ""}`, {
          status,
          code: errorCode(body),
          body,
          secrets
        });
      }
      return body;
    })();
    try {
      return await Promise.race([exchange, timeout]);
    } finally {
      if (typeof clearTimeout === "function") clearTimeout(timer);
    }
  }

  // src/lib/settings.js
  function settings() {
    const src = typeof gopeed !== "undefined" && gopeed && gopeed.settings || {};
    const out = {};
    for (const key of Object.keys(src)) {
      const value = src[key];
      out[key] = typeof value === "string" ? value.trim() : value;
    }
    return out;
  }
  function providerSettings(id) {
    const prefix = `${id}_`;
    const all = settings();
    const out = {};
    for (const key of Object.keys(all)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = all[key];
    }
    return out;
  }
  function secretsOf(fields) {
    const out = [];
    for (const name of Object.keys(fields || {})) {
      const value = fields[name];
      if (!/(^|_)(token|key|apikey|password|secret)$/.test(name)) continue;
      if (typeof value !== "string" || !value.trim()) continue;
      if (out.indexOf(value) < 0) out.push(value);
    }
    return out;
  }
  function apiBase(id, defaultBase) {
    const raw = settings().advanced_api_base;
    const custom = typeof raw === "string" ? raw.replace(/\/+$/, "") : "";
    return custom ? `${custom}/${id}` : defaultBase;
  }

  // src/lib/cache.js
  function store() {
    return gopeed.storage;
  }
  async function entry(key) {
    const raw = await store().get(key);
    if (raw === null || raw === void 0) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.exp !== "number" || !("v" in parsed)) return null;
    if (Date.now() >= parsed.exp) {
      await store().remove(key);
      return null;
    }
    return parsed;
  }
  async function remember(key, value, ttlMs) {
    await store().set(key, JSON.stringify({ v: value, exp: Date.now() + ttlMs }));
  }
  async function recall(key) {
    const hit = await entry(key);
    return hit ? hit.v : null;
  }
  async function cached(key, ttlMs, loader) {
    const hit = await entry(key);
    if (hit) return hit.v;
    const value = await loader();
    if (value !== void 0) {
      try {
        await remember(key, value, ttlMs);
      } catch (e) {
        try {
          gopeed.logger.warn(`debrid: ${key} could not be stored: ${e && e.message !== void 0 ? e.message : e}`);
        } catch (e2) {
        }
      }
    }
    return value;
  }
  async function sweep(prefixes, everyMs) {
    if (await recall("sweep:at")) return 0;
    await remember("sweep:at", Date.now(), everyMs);
    const keys = await store().keys();
    let removed = 0;
    for (let i = 0; keys && i < keys.length; i++) {
      const key = String(keys[i]);
      if (!prefixes.some((p) => key.startsWith(p))) continue;
      const raw = await store().get(key);
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.exp !== "number" || Date.now() >= parsed.exp) {
        await store().remove(key);
        removed++;
      }
    }
    return removed;
  }

  // src/lib/cooldown.js
  var COOLDOWN_MS = 10 * 60 * 1e3;
  function hashOf(text2) {
    let h1 = 3735928559;
    let h2 = 1103547991;
    for (let i = 0; i < text2.length; i++) {
      const ch = text2.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  var keyOf = (id) => `cooldown:${id}`;
  var credentialHash = (id, credential) => hashOf(`${id}\0${credential === void 0 || credential === null ? "" : credential}`);
  function settingsHash(id, fields, apiBase2 = "") {
    const parts = Object.keys(fields || {}).filter((k) => k !== "enabled").sort().map((k) => `${k}=${fields[k] === void 0 || fields[k] === null ? "" : fields[k]}`);
    return hashOf(`${id}\0${apiBase2 || ""}\0${parts.join("\0")}`);
  }
  async function cooldownLeft(id, credential) {
    const record = await recall(keyOf(id));
    if (!record || typeof record !== "object" || record.h !== credentialHash(id, credential)) return null;
    const ms = Number(record.until) - Date.now();
    if (!(ms > 0)) return null;
    return { ms, minutes: Math.max(1, Math.ceil(ms / 6e4)), reason: typeof record.reason === "string" ? record.reason : "" };
  }
  async function startCooldown(id, credential, reason, ms = COOLDOWN_MS) {
    await remember(keyOf(id), { h: credentialHash(id, credential), until: Date.now() + ms, reason: String(reason || "") }, ms);
  }

  // src/lib/hosts.js
  function normalize(host) {
    let h = String(host || "").trim().toLowerCase();
    if (h.endsWith(".")) h = h.slice(0, -1);
    if (h.startsWith("www.")) h = h.slice(4);
    return h;
  }
  function hostOf(url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url || "").trim());
    if (!m) return "";
    let authority = m[1];
    const at = authority.lastIndexOf("@");
    if (at >= 0) authority = authority.slice(at + 1);
    let host;
    if (authority.startsWith("[")) {
      const end = authority.indexOf("]");
      host = end < 0 ? authority : authority.slice(0, end + 1);
    } else {
      const colon = authority.indexOf(":");
      host = colon < 0 ? authority : authority.slice(0, colon);
    }
    return normalize(host);
  }
  function hostMatches(host, domainList) {
    const h = normalize(host);
    if (!h || !Array.isArray(domainList)) return false;
    for (const d of domainList) {
      const domain = normalize(d);
      if (!domain) continue;
      if (h === domain || h.endsWith(`.${domain}`)) return true;
    }
    return false;
  }

  // src/providers/common.js
  var MIN = 60 * 1e3;
  var HOUR = 60 * MIN;
  var HOSTS_TTL_MS = 24 * HOUR;
  var HOSTS_TIMEOUT_MS = 10 * 1e3;
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  function baseName(path) {
    const parts = String(path === void 0 || path === null ? "" : path).split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }
  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  var REASON = {
    auth_invalid: "invalid API key",
    account_expired: "the account has expired or is not premium",
    not_supported: "this host is not supported",
    dead_link: "the link is dead or the file was removed",
    service_down: "the host or the service is unavailable, try again later",
    rate_limited: "too many requests, try again in a minute",
    ip_not_allowed: "the service refuses this IP address (a VPN or a server address is not allowed)",
    bad_password: "the file needs a password, or the password is wrong"
  };
  var known = (code, reason) => ({ code, reason: reason || REASON[code] });
  var limit = (detail) => ({ code: "limit_reached", reason: detail ? `limit reached (${detail})` : "limit reached" });
  function cleanDomains(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (typeof raw !== "string") continue;
      const d = raw.trim().toLowerCase().replace(/^(\*\.|www\.)/, "").replace(/\.$/, "");
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && out.indexOf(d) < 0) out.push(d);
    }
    return out;
  }
  async function hostList(id, loader) {
    const list = await cached(`hosts:${id}`, HOSTS_TTL_MS, async () => {
      const domains = cleanDomains(await loader());
      return domains.length ? domains : void 0;
    });
    return Array.isArray(list) ? list : [];
  }
  async function claims(hostsOf, s, url) {
    const host = hostOf(url);
    return !!host && hostMatches(host, await hostsOf(s));
  }
  function warn(message) {
    try {
      gopeed.logger.warn(message);
    } catch (e) {
    }
  }
  function createApi({ id, title, base, settings: settings2, credential, authHeaders, classify: classify9, envelope: envelope6, runtime = [] }) {
    const secrets = () => [...secretsOf(settings2), ...runtime];
    function fail(code, reason, extra = {}) {
      return new ProviderError(title, reason, Object.assign({}, extra, { code, secrets: secrets() }));
    }
    async function guard() {
      const left = await cooldownLeft(id, credential());
      if (left) {
        const unit = left.minutes === 1 ? "minute" : "minutes";
        throw fail("cooldown", `${left.reason}, not retrying for ${left.minutes} more ${unit} (changing the setting ends the pause)`);
      }
    }
    async function trip(reason) {
      await startCooldown(id, credential(), reason);
      warn(`${title}: ${reason}; no further calls for ${COOLDOWN_MS / MIN} minutes`);
    }
    function translate(body, status) {
      const c = classify9(body, status);
      if (c) return c;
      if (status === 401) return known("auth_invalid");
      if (status === 403) {
        if (body && typeof body === "object") return known("auth_invalid", "the service refused the request (HTTP 403), check the API key");
        return known("ip_not_allowed", "blocked by the service's protection (HTTP 403); a VPN or datacenter address is often refused");
      }
      if (status === 429) return known("rate_limited");
      if (status >= 500) return known("service_down", `the service is down (HTTP ${status})`);
      const env = envelope6 ? envelope6(body) : null;
      return env ? { code: env.code, reason: env.text || "the service reported an error" } : null;
    }
    async function raise(c, status, body, noTrip) {
      if (c.code === "auth_invalid" && !noTrip) await trip(c.reason);
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

  // src/providers/torbox.js
  var ID = "torbox";
  var TITLE = "TorBox";
  var BASE = "https://api.torbox.app";
  var API = "/v1/api";
  var POLL_MS = 5e3;
  var READY_MS = 60 * 1e3;
  var FILES_POLL_MS = 2e3;
  var FILES_MS = 10 * 1e3;
  var AUTH_CODES = ["BAD_TOKEN", "NO_AUTH", "AUTH_ERROR"];
  function classify(body, status) {
    if (!body || typeof body !== "object" || typeof body.error !== "string" || !body.error) return null;
    const code = body.error;
    if (AUTH_CODES.indexOf(code) >= 0) return known("auth_invalid");
    switch (code) {
      case "PLAN_RESTRICTED_FEATURE":
        return known("account_expired", "the account has expired or its plan does not include this");
      case "MONTHLY_LIMIT":
        return limit("monthly data limit of the plan");
      case "COOLDOWN_LIMIT":
        return limit("cooldown, try again later");
      case "ACTIVE_LIMIT":
        return limit("too many active downloads");
      case "DOWNLOAD_TOO_LARGE":
        return limit("the file is larger than the plan allows");
      case "UNSUPPORTED_SITE":
        return known("not_supported");
      case "LINK_OFFLINE":
        return known("dead_link");
      default:
        return /ERROR$/.test(code) ? known("service_down") : null;
    }
  }
  function envelope(body) {
    if (!body || typeof body !== "object" || body.success !== false) return null;
    const code = typeof body.error === "string" && body.error ? body.error.toLowerCase() : "error";
    return { code, text: text(body.detail) };
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
      envelope
    });
  }
  async function hosts(s) {
    return hostList(ID, async () => {
      const body = await makeApi(s).call("GET", `${API}/webdl/hosters`, { auth: false, timeoutMs: HOSTS_TIMEOUT_MS });
      const out = [];
      for (const h of body && Array.isArray(body.data) ? body.data : []) {
        if (h && h.status !== false && Array.isArray(h.domains)) out.push(...h.domains);
      }
      return out;
    });
  }
  async function requestDownload(api, s, kind, query) {
    const res = await api.call("GET", `${API}/${kind}/requestdl`, { query: Object.assign({ token: s.apikey }, query) });
    const url = res && typeof res.data === "string" ? res.data : "";
    if (!url) throw api.fail("bad_response", "the service gave no download link");
    if (redact(url, [s.apikey]) !== url) throw api.fail("bad_response", "the service returned a link that holds the API key");
    return url;
  }
  async function unrestrict(s, url) {
    if (!await claims(hosts, s, url)) return null;
    const api = makeApi(s);
    await api.guard();
    const created = await api.call("POST", `${API}/webdl/createwebdownload`, { form: { link: url } });
    const webId = created && created.data ? created.data.webdownload_id : void 0;
    if (webId === void 0 || webId === null) throw api.fail("bad_response", "the service gave no download id");
    const deadline = Date.now() + READY_MS;
    let item = null;
    for (; ; ) {
      const res = await api.call("GET", `${API}/webdl/mylist`, { query: { id: webId, bypass_cache: "true" } });
      const found = res && Array.isArray(res.data) ? res.data[0] : res && res.data;
      if (found && Array.isArray(found.files) && found.files.length && num(found.progress) >= 1) {
        item = found;
        break;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(POLL_MS, left));
    }
    if (!item) throw api.fail("not_ready", "the file is not ready yet, add the link again in a minute");
    const file = item.files[0];
    const direct = await requestDownload(api, s, "webdl", { web_id: webId, file_id: file.id });
    return { name: text(file.short_name) || baseName(file.name) || text(item.name), size: num(file.size) || num(item.size), url: direct, headers: {} };
  }
  function cachedEntry(res, hash) {
    const data = res ? res.data : null;
    const entries = Array.isArray(data) ? data : data && typeof data === "object" ? Object.keys(data).map((k) => data[k]) : [];
    return entries.find((e) => e && typeof e === "object" && String(e.hash || "").toLowerCase() === hash) || null;
  }
  async function removeQuietly(api, torrentId) {
    try {
      await api.call("POST", `${API}/torrents/controltorrent`, { json: { operation: "delete", torrent_id: torrentId }, noTrip: true });
    } catch (e) {
    }
  }
  async function cachedMagnet(s, magnet) {
    const parsed = parseMagnet(magnet);
    if (!parsed) return null;
    const api = makeApi(s);
    await api.guard();
    const check = await api.call("GET", `${API}/torrents/checkcached`, { query: { hash: parsed.hash, format: "list", list_files: "true" } });
    if (!cachedEntry(check, parsed.hash)) return null;
    const created = await api.call("POST", `${API}/torrents/createtorrent`, {
      form: { magnet, add_only_if_cached: "true", seed: "3", allow_zip: "false" }
    });
    const torrentId = created && created.data ? created.data.torrent_id : void 0;
    if (torrentId === void 0 || torrentId === null) throw api.fail("bad_response", "the service gave no torrent id");
    try {
      const deadline = Date.now() + FILES_MS;
      let entries = [];
      for (; ; ) {
        const list = await api.call("GET", `${API}/torrents/mylist`, { query: { id: torrentId, bypass_cache: "true" } });
        const torrent = list && Array.isArray(list.data) ? list.data[0] : list && list.data;
        entries = torrent && Array.isArray(torrent.files) ? torrent.files : [];
        const left = deadline - Date.now();
        if (entries.length || left <= 0) break;
        await sleep(Math.min(FILES_POLL_MS, left));
      }
      if (!entries.length) throw api.fail("not_ready", "the torrent is on TorBox but lists no files yet, add the magnet again in a minute");
      const files = [];
      for (const f of entries) {
        const direct = await requestDownload(api, s, "torrents", { torrent_id: torrentId, file_id: f.id });
        files.push({ name: text(f.short_name) || baseName(f.name), size: num(f.size), url: direct, headers: {} });
      }
      return files;
    } catch (e) {
      if (!e || e.code !== "auth_invalid") await removeQuietly(api, torrentId);
      throw e;
    }
  }
  var torbox_default = {
    id: ID,
    title: TITLE,
    kind: "debrid",
    base: BASE,
    // requestdl "opens the link for 3 hours" and says elsewhere "1 hour": the shorter value is used.
    linkTTLms: HOUR,
    enabled: (s) => !!s.enabled && !!s.apikey,
    hosts,
    unrestrict,
    cachedMagnet
  };

  // src/providers/alldebrid.js
  var ID2 = "alldebrid";
  var TITLE2 = "AllDebrid";
  var BASE2 = "https://api.alldebrid.com";
  var POLL_MS2 = 5e3;
  var READY_MS2 = 60 * 1e3;
  function classify2(body) {
    if (!body || typeof body !== "object" || body.status !== "error" || !body.error) return null;
    switch (body.error.code) {
      case "AUTH_MISSING_APIKEY":
      case "AUTH_BAD_APIKEY":
        return known("auth_invalid");
      case "AUTH_BLOCKED":
        return known("auth_invalid", "the key is blocked for this location (confirm it by e-mail on alldebrid.com)");
      case "AUTH_USER_BANNED":
        return known("auth_invalid", "the account is banned");
      case "NO_SERVER":
      case "MAGNET_NO_SERVER":
        return known("ip_not_allowed");
      case "LINK_HOST_NOT_SUPPORTED":
      case "LINK_NOT_SUPPORTED":
        return known("not_supported");
      case "LINK_DOWN":
        return known("dead_link");
      case "LINK_TEMPORARY_UNAVAILABLE":
      case "LINK_HOST_UNAVAILABLE":
      case "LINK_HOST_FULL":
      case "LINK_TOO_MANY_DOWNLOADS":
        return known("service_down");
      case "LINK_HOST_LIMIT_REACHED":
        return limit("the host limit");
      case "MAGNET_TOO_MANY_ACTIVE":
        return limit("too many active magnets");
      case "LINK_PASS_PROTECTED":
        return known("bad_password");
      case "MUST_BE_PREMIUM":
      case "MAGNET_MUST_BE_PREMIUM":
      case "FREE_TRIAL_LIMIT_REACHED":
        return known("account_expired");
      default:
        return null;
    }
  }
  function envelope2(body) {
    if (!body || typeof body !== "object" || body.status !== "error") return null;
    const err = body.error && typeof body.error === "object" ? body.error : {};
    return { code: text(err.code) || "error", text: text(err.message) };
  }
  function makeApi2(s) {
    return createApi({
      id: ID2,
      title: TITLE2,
      base: BASE2,
      settings: s,
      credential: () => s.apikey,
      authHeaders: () => ({ Authorization: `Bearer ${s.apikey}` }),
      classify: classify2,
      envelope: envelope2
    });
  }
  async function hosts2(s) {
    return hostList(ID2, async () => {
      const api = makeApi2(s);
      await api.guard();
      const body = await api.call("GET", "/v4.1/user/hosts", { timeoutMs: HOSTS_TIMEOUT_MS });
      const map = body && body.data && body.data.hosts && typeof body.data.hosts === "object" ? body.data.hosts : {};
      const out = [];
      for (const name of Object.keys(map)) {
        const h = map[name];
        if (h && h.status !== false && Array.isArray(h.domains)) out.push(...h.domains);
      }
      return out;
    });
  }
  async function waitDelayed(api, delayedId) {
    const deadline = Date.now() + READY_MS2;
    for (; ; ) {
      const res = await api.call("POST", "/v4/link/delayed", { form: { id: delayedId } });
      const d = res && res.data;
      if (d && num(d.status) === 2 && typeof d.link === "string" && d.link) return d.link;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await sleep(Math.min(POLL_MS2, left));
    }
    throw api.fail("not_ready", "the link is not ready yet, add it again in a minute");
  }
  async function unlock(api, link) {
    const res = await api.call("POST", "/v4/link/unlock", { form: { link } });
    const d = res && res.data ? res.data : {};
    const url = d.delayed ? await waitDelayed(api, d.delayed) : d.link;
    if (typeof url !== "string" || !url) throw api.fail("bad_response", "the service gave no download link");
    return { name: text(d.filename), size: num(d.filesize), url, headers: {} };
  }
  async function unrestrict2(s, url) {
    if (!await claims(hosts2, s, url)) return null;
    const api = makeApi2(s);
    await api.guard();
    return unlock(api, url);
  }
  function fileLinks(entries, out) {
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e !== "object") continue;
      if (Array.isArray(e.e)) fileLinks(e.e, out);
      else if (typeof e.l === "string" && e.l) out.push({ name: text(e.n), link: e.l });
    }
    return out;
  }
  async function removeQuietly2(api, id) {
    try {
      await api.call("POST", "/v4/magnet/delete", { form: { id }, noTrip: true });
    } catch (e) {
    }
  }
  async function cachedMagnet2(s, magnet) {
    if (!parseMagnet(magnet)) return null;
    const api = makeApi2(s);
    await api.guard();
    const uploaded = await api.call("POST", "/v4/magnet/upload", { form: { "magnets[]": magnet } });
    const entry2 = uploaded && uploaded.data && Array.isArray(uploaded.data.magnets) ? uploaded.data.magnets[0] : null;
    if (!entry2) throw api.fail("bad_response", "the service did not accept the magnet");
    if (entry2.error) await api.check({ status: "error", error: entry2.error });
    const id = entry2.id;
    if (id === void 0 || id === null) throw api.fail("bad_response", "the service gave no magnet id");
    try {
      if (entry2.ready !== true) {
        await removeQuietly2(api, id);
        return null;
      }
      const listed = await api.call("POST", "/v4/magnet/files", { form: { "id[]": id } });
      const m = listed && listed.data && Array.isArray(listed.data.magnets) ? listed.data.magnets[0] : null;
      const links = fileLinks(m && m.files, []);
      if (!links.length) {
        await removeQuietly2(api, id);
        return null;
      }
      const files = [];
      for (const f of links) {
        const unlocked = await unlock(api, f.link);
        files.push({ name: unlocked.name || f.name, size: unlocked.size, url: unlocked.url, headers: {} });
      }
      return files;
    } catch (e) {
      if (!e || e.code !== "auth_invalid") await removeQuietly2(api, id);
      throw e;
    }
  }
  var alldebrid_default = {
    id: ID2,
    title: TITLE2,
    kind: "debrid",
    base: BASE2,
    linkTTLms: 3 * HOUR,
    enabled: (s) => !!s.enabled && !!s.apikey,
    hosts: hosts2,
    unrestrict: unrestrict2,
    cachedMagnet: cachedMagnet2
  };

  // src/providers/premiumize.js
  var ID3 = "premiumize";
  var TITLE3 = "Premiumize";
  var BASE3 = "https://www.premiumize.me";
  var API2 = "/api";
  function classify3(body) {
    if (!body || typeof body !== "object" || body.status !== "error") return null;
    const code = text(body.code);
    switch (code) {
      case "authentication_failed":
        return known("auth_invalid");
      case "permission_denied":
        return known("account_expired", "the account has expired, is restricted or is not premium");
      case "service_unsupported":
        return known("not_supported");
      case "not_found":
        return known("dead_link");
      case "service_down":
      case "link_generation_failed":
      case "transient_error":
      case "unknown_error":
        return known("service_down");
      case "service_limit_reached":
        return limit("the limit of this host");
      case "account_limit_reached":
        return limit("the fair-use points are used up");
      case "rate_limit_reached":
        return known("rate_limited");
      default:
        return !code && /not logged in|authentication|invalid (api )?key/i.test(text(body.message)) ? known("auth_invalid") : null;
    }
  }
  function envelope3(body) {
    if (!body || typeof body !== "object" || body.status !== "error") return null;
    return { code: text(body.code) || "error", text: text(body.message) };
  }
  function makeApi3(s) {
    return createApi({
      id: ID3,
      title: TITLE3,
      base: BASE3,
      settings: s,
      credential: () => s.apikey,
      authHeaders: () => ({ Authorization: `Bearer ${s.apikey}` }),
      classify: classify3,
      envelope: envelope3
    });
  }
  async function hosts3(s) {
    return hostList(ID3, async () => {
      const body = await makeApi3(s).call("GET", `${API2}/services/list`, { auth: false, timeoutMs: HOSTS_TIMEOUT_MS });
      const out = [];
      const aliases = body && body.aliases && typeof body.aliases === "object" ? body.aliases : {};
      for (const service of body && Array.isArray(body.directdl) ? body.directdl : []) {
        out.push(service);
        if (Array.isArray(aliases[service])) out.push(...aliases[service]);
      }
      return out;
    });
  }
  async function directdl(api, src) {
    const res = await api.call("POST", `${API2}/transfer/directdl`, { form: { src } });
    const files = [];
    for (const c of res && Array.isArray(res.content) ? res.content : []) {
      if (c && typeof c.link === "string" && c.link) files.push({ name: baseName(c.path), size: num(c.size), url: c.link, headers: {} });
    }
    return files;
  }
  async function unrestrict3(s, url) {
    if (!await claims(hosts3, s, url)) return null;
    const api = makeApi3(s);
    await api.guard();
    const files = await directdl(api, url);
    if (!files.length) throw api.fail("bad_response", "the service gave no download link");
    return files[0];
  }
  async function cachedMagnet3(s, magnet) {
    const parsed = parseMagnet(magnet);
    if (!parsed) return null;
    const api = makeApi3(s);
    await api.guard();
    const check = await api.call("POST", `${API2}/cache/check`, { form: { "items[]": parsed.hash } });
    if (!check || !Array.isArray(check.response) || check.response[0] !== true) return null;
    const files = await directdl(api, magnet);
    return files.length ? files : null;
  }
  var premiumize_default = {
    id: ID3,
    title: TITLE3,
    kind: "debrid",
    base: BASE3,
    linkTTLms: 3 * HOUR,
    enabled: (s) => !!s.enabled && !!s.apikey,
    hosts: hosts3,
    unrestrict: unrestrict3,
    cachedMagnet: cachedMagnet3
  };

  // src/providers/realdebrid.js
  var ID4 = "realdebrid";
  var TITLE4 = "Real-Debrid";
  var BASE4 = "https://api.real-debrid.com";
  var REST = "/rest/1.0";
  var OAUTH = "/oauth/v2";
  var OPEN_SOURCE_CLIENT_ID = "X245A4XAIBGVM";
  var DEVICE_GRANT = "http://oauth.net/grant_type/device/1.0";
  var DEVICE_PAGE = "https://real-debrid.com/device";
  var AUTH_KEY = "rd:auth";
  var DEVICE_KEY = "rd:device";
  var AUTH_TTL_MS = 365 * 24 * HOUR;
  var EXPIRY_SKEW_MS = 60 * 1e3;
  var PROBE_MS = 10 * 1e3;
  var PROBE_POLL_MS = 2e3;
  var DEAD_TORRENT = ["magnet_error", "error", "virus", "dead"];
  function makeClassify(s) {
    return function classify9(body, status) {
      const code = status === 401 ? 8 : body && typeof body === "object" ? num(body.error_code) : 0;
      switch (code) {
        case 8:
          return known("auth_invalid", s.token ? "invalid private API token" : "the login expired or was revoked");
        case 9:
        case 14:
          return known("account_expired", "the account is locked or not premium");
        case 16:
          return known("not_supported");
        case 17:
        case 19:
          return known("service_down", "the host is in maintenance or unavailable, try again later");
        case 18:
          return limit("the host limit");
        case 20:
          return known("account_expired");
        case 21:
          return limit("too many active downloads");
        case 22:
          return known("ip_not_allowed");
        case 23:
        case 36:
          return limit("traffic exhausted or fair-use limit");
        case 24:
        case 35:
          return known("dead_link");
        case 25:
          return known("service_down");
        case 34:
          return known("rate_limited");
        case 37:
          return known("service_down", "Real-Debrid has disabled this endpoint");
        default:
          return null;
      }
    };
  }
  function session(s) {
    const runtime = [];
    const api = createApi({
      id: ID4,
      title: TITLE4,
      base: BASE4,
      settings: s,
      // A changed private token is a different credential. The device login is one credential, and the pause outlives
      // the stored login, which is dropped when it is refused.
      credential: () => s.token ? `token:${s.token}` : "device-login",
      authHeaders: () => ({}),
      classify: makeClassify(s),
      runtime
    });
    const track = (...values) => {
      for (const v of values) if (typeof v === "string" && v && runtime.indexOf(v) < 0) runtime.push(v);
    };
    const trackAuth = (a) => track(a && a.access_token, a && a.refresh_token, a && a.client_secret, a && a.client_id);
    const forget = (key) => gopeed.storage.remove(key);
    function waiting(dev) {
      const minutes = Math.max(1, Math.round((num(dev.expires_at) - Date.now()) / MIN));
      return api.fail("login_required", `open ${DEVICE_PAGE} and enter ${dev.user_code}, then add the link again (the code is valid for ${minutes} minutes)`);
    }
    const isClientError = (e) => e instanceof ProviderError && e.status >= 400 && e.status < 500 && e.status !== 429;
    const oauth = (method, path, opts) => api.call(method, OAUTH + path, Object.assign({ auth: false, raw: true }, opts));
    async function storeTokens(prev, tokens) {
      const auth = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || prev.refresh_token,
        client_id: prev.client_id,
        client_secret: prev.client_secret,
        expires_at: Date.now() + num(tokens.expires_in) * 1e3
      };
      trackAuth(auth);
      await remember(AUTH_KEY, auth, AUTH_TTL_MS);
      return auth.access_token;
    }
    async function exchange(client, code) {
      const tokens = await oauth("POST", "/token", {
        form: { client_id: client.client_id, client_secret: client.client_secret, code, grant_type: DEVICE_GRANT }
      });
      if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) throw api.fail("bad_response", "the service gave no access token");
      return tokens;
    }
    async function loginRefused(reason) {
      await forget(AUTH_KEY);
      await api.trip(reason);
      throw api.fail("auth_invalid", reason);
    }
    async function refresh(auth) {
      try {
        const tokens = await exchange(auth, auth.refresh_token);
        return await storeTokens(auth, tokens);
      } catch (e) {
        if (isClientError(e)) await loginRefused("the login expired or was revoked");
        throw e;
      }
    }
    async function deviceLogin() {
      const dev = await recall(DEVICE_KEY);
      if (dev && typeof dev === "object" && num(dev.expires_at) > Date.now()) {
        track(dev.device_code);
        let client;
        try {
          client = await oauth("GET", "/device/credentials", { query: { client_id: OPEN_SOURCE_CLIENT_ID, code: dev.device_code } });
        } catch (e) {
          if (isClientError(e)) throw waiting(dev);
          throw e;
        }
        if (!client || !client.client_id || !client.client_secret) throw waiting(dev);
        track(client.client_id, client.client_secret);
        let tokens;
        try {
          tokens = await exchange(client, dev.device_code);
        } catch (e) {
          if (isClientError(e)) {
            await forget(DEVICE_KEY);
            throw api.fail("login_required", "the device login was not accepted; add the link again to get a new code", { status: e.status, body: e.body });
          }
          throw e;
        }
        const token = await storeTokens(client, tokens);
        await forget(DEVICE_KEY);
        return token;
      }
      const code = await oauth("GET", "/device/code", { query: { client_id: OPEN_SOURCE_CLIENT_ID, new_credentials: "yes" } });
      if (!code || !code.device_code || !code.user_code) throw api.fail("bad_response", "the service gave no device code");
      const expiresIn = num(code.expires_in) > 0 ? num(code.expires_in) : 1800;
      const stored = { device_code: code.device_code, user_code: code.user_code, expires_at: Date.now() + expiresIn * 1e3 };
      track(code.device_code);
      await remember(DEVICE_KEY, stored, expiresIn * 1e3);
      throw waiting(stored);
    }
    async function accessToken(force) {
      const auth = await recall(AUTH_KEY);
      if (!auth || typeof auth !== "object" || !auth.access_token) return deviceLogin();
      trackAuth(auth);
      if (!force && num(auth.expires_at) > Date.now() + EXPIRY_SKEW_MS) return auth.access_token;
      return refresh(auth);
    }
    async function rest(method, path, opts = {}) {
      const url = REST + path;
      if (s.token) return api.call(method, url, Object.assign({}, opts, { headers: { Authorization: `Bearer ${s.token}` } }));
      const token = await accessToken(false);
      try {
        return await api.call(method, url, Object.assign({}, opts, { headers: { Authorization: `Bearer ${token}` }, noTrip: true }));
      } catch (e) {
        if (!(e instanceof ProviderError) || e.code !== "auth_invalid") throw e;
      }
      const fresh = await accessToken(true);
      try {
        return await api.call(method, url, Object.assign({}, opts, { headers: { Authorization: `Bearer ${fresh}` } }));
      } catch (e) {
        if (e instanceof ProviderError && e.code === "auth_invalid") await forget(AUTH_KEY);
        throw e;
      }
    }
    return { api, rest };
  }
  async function hosts4(s) {
    return hostList(ID4, async () => {
      const body = await session(s).api.call("GET", `${REST}/hosts/domains`, { auth: false, timeoutMs: HOSTS_TIMEOUT_MS });
      return Array.isArray(body) ? body : [];
    });
  }
  async function unrestrictLink(rest, api, link) {
    const res = await rest("POST", "/unrestrict/link", { form: { link } });
    const d = Array.isArray(res) ? res[0] : res;
    if (!d || typeof d.download !== "string" || !d.download) throw api.fail("bad_response", "the service gave no download link");
    return { name: text(d.filename), size: num(d.filesize), url: d.download, headers: {} };
  }
  async function unrestrict4(s, url) {
    if (!await claims(hosts4, s, url)) return null;
    const { api, rest } = session(s);
    await api.guard();
    return unrestrictLink(rest, api, url);
  }
  async function deleteQuietly(rest, id) {
    try {
      await rest("DELETE", `/torrents/delete/${encodeURIComponent(id)}`);
    } catch (e) {
    }
  }
  async function cachedMagnet4(s, magnet) {
    if (!parseMagnet(magnet)) return null;
    const { api, rest } = session(s);
    await api.guard();
    const added = await rest("POST", "/torrents/addMagnet", { form: { magnet } });
    const id = added && typeof added.id === "string" ? added.id : "";
    if (!id) throw api.fail("bad_response", "the service did not accept the magnet");
    try {
      const deadline = Date.now() + PROBE_MS;
      let selected = false;
      let info3 = null;
      for (; ; ) {
        info3 = await rest("GET", `/torrents/info/${encodeURIComponent(id)}`);
        const state = info3 ? info3.status : "";
        if (state === "downloaded") break;
        if (DEAD_TORRENT.indexOf(state) >= 0) {
          info3 = null;
          break;
        }
        if (state === "waiting_files_selection" && !selected) {
          await rest("POST", `/torrents/selectFiles/${encodeURIComponent(id)}`, { form: { files: "all" } });
          selected = true;
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          info3 = null;
          break;
        }
        await sleep(Math.min(PROBE_POLL_MS, left));
      }
      const links = info3 && Array.isArray(info3.links) ? info3.links.filter((l) => typeof l === "string" && l) : [];
      if (!links.length) {
        await deleteQuietly(rest, id);
        return null;
      }
      const files = [];
      for (const link of links) files.push(await unrestrictLink(rest, api, link));
      return files;
    } catch (e) {
      if (!e || e.code !== "auth_invalid") await deleteQuietly(rest, id);
      throw e;
    }
  }
  var realdebrid_default = {
    id: ID4,
    title: TITLE4,
    kind: "debrid",
    base: BASE4,
    linkTTLms: 3 * HOUR,
    // The device login needs no setting, so the switch is enough.
    enabled: (s) => !!s.enabled,
    hosts: hosts4,
    unrestrict: unrestrict4,
    cachedMagnet: cachedMagnet4
  };

  // src/providers/debridlink.js
  var ID5 = "debridlink";
  var TITLE5 = "Debrid-Link";
  var BASE5 = "https://debrid-link.com";
  var API3 = "/api/v2";
  function classify4(body) {
    if (!body || typeof body !== "object" || body.success !== false) return null;
    switch (body.error) {
      case "badToken":
        return known("auth_invalid");
      case "floodDetected":
        return known("rate_limited");
      case "hostNotValid":
      case "notDebrid":
        return known("not_supported");
      case "fileNotFound":
      case "fileNotAvailable":
      case "badFileUrl":
      case "infringingFile":
        return known("dead_link");
      case "badFilePassword":
        return known("bad_password");
      case "maintenanceHost":
      case "freeServerOverload":
        return known("service_down");
      case "maxLink":
      case "maxData":
        return limit("the daily limit");
      case "maxLinkHost":
      case "maxDataHost":
        return limit("the daily limit of this host");
      case "maxTorrent":
      case "maxTransfer":
      case "torrentTooBig":
        return limit("the seedbox limit");
      case "unverifiedEmail":
      case "notFreeHost":
        return known("account_expired");
      case "notAddTorrent":
        return { code: "not_added", reason: "the torrent is not cached" };
      default:
        return null;
    }
  }
  function envelope4(body) {
    if (!body || typeof body !== "object" || body.success !== false) return null;
    return { code: text(body.error) || "error", text: text(body.error_description) };
  }
  function makeApi4(s) {
    return createApi({
      id: ID5,
      title: TITLE5,
      base: BASE5,
      settings: s,
      credential: () => s.apikey,
      authHeaders: () => ({ Authorization: `Bearer ${s.apikey}` }),
      classify: classify4,
      envelope: envelope4
    });
  }
  async function hosts5(s) {
    return hostList(ID5, async () => {
      const body = await makeApi4(s).call("GET", `${API3}/downloader/hosts`, { auth: false, query: { types: "host" }, timeoutMs: HOSTS_TIMEOUT_MS });
      const out = [];
      for (const h of body && Array.isArray(body.value) ? body.value : []) {
        if (h && num(h.status) >= 1 && Array.isArray(h.domains)) out.push(...h.domains);
      }
      return out;
    });
  }
  async function unrestrict5(s, url) {
    if (!await claims(hosts5, s, url)) return null;
    const api = makeApi4(s);
    await api.guard();
    const res = await api.call("POST", `${API3}/downloader/add`, { form: { url } });
    const value = res ? res.value : null;
    const link = Array.isArray(value) ? value.find((v) => v && v.downloadUrl) : value;
    if (!link || typeof link.downloadUrl !== "string" || !link.downloadUrl) throw api.fail("bad_response", "the service gave no download link");
    return { name: text(link.name), size: num(link.size), url: link.downloadUrl, headers: {} };
  }
  async function removeQuietly3(api, id) {
    try {
      await api.call("DELETE", `${API3}/seedbox/${encodeURIComponent(id)}/remove`, { noTrip: true });
    } catch (e) {
    }
  }
  async function cachedMagnet5(s, magnet) {
    const parsed = parseMagnet(magnet);
    if (!parsed) return null;
    const api = makeApi4(s);
    await api.guard();
    let added;
    try {
      added = await api.call("POST", `${API3}/seedbox/add`, { form: { url: parsed.hash } });
    } catch (e) {
      if (e && e.code === "not_added") return null;
      throw e;
    }
    let torrent = added ? added.value : null;
    if (!torrent || typeof torrent !== "object" || !torrent.id) throw api.fail("bad_response", "the service did not accept the torrent");
    const id = torrent.id;
    try {
      if (torrent.isZip === true || !Array.isArray(torrent.files) || !torrent.files.length) {
        const listed = await api.call("GET", `${API3}/seedbox/list`, { query: { ids: id } });
        const full = listed && Array.isArray(listed.value) ? listed.value.find((t) => t && t.id === id) || listed.value[0] : null;
        if (full) torrent = full;
      }
      const files = (Array.isArray(torrent.files) ? torrent.files : []).filter((f) => f && typeof f.downloadUrl === "string" && f.downloadUrl && num(f.downloadPercent) === 100).map((f) => ({ name: text(f.name), size: num(f.size), url: f.downloadUrl, headers: {} }));
      if (num(torrent.downloadPercent) === 100 && files.length) return files;
      await removeQuietly3(api, id);
      return null;
    } catch (e) {
      if (!e || e.code !== "auth_invalid") await removeQuietly3(api, id);
      throw e;
    }
  }
  var debridlink_default = {
    id: ID5,
    title: TITLE5,
    kind: "debrid",
    base: BASE5,
    linkTTLms: 3 * HOUR,
    enabled: (s) => !!s.enabled && !!s.apikey,
    hosts: hosts5,
    unrestrict: unrestrict5,
    cachedMagnet: cachedMagnet5
  };

  // src/providers/session.js
  function sessionStore(id, ttlMs, runtime) {
    const key = `session:${id}`;
    const track = (token) => {
      if (typeof token === "string" && token && runtime.indexOf(token) < 0) runtime.push(token);
    };
    return {
      // The stored token of this login, or '' when there is none.
      async get(login) {
        const s = await recall(key);
        if (!s || typeof s !== "object" || s.login !== login || typeof s.token !== "string" || !s.token) return "";
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
      track
    };
  }
  function sharedLogin(inflight2, key, loginFn) {
    const pending = inflight2.get(key);
    if (pending) return pending;
    const p = Promise.resolve().then(loginFn);
    inflight2.set(key, p);
    const clear = () => {
      if (inflight2.get(key) === p) inflight2.delete(key);
    };
    p.then(clear, clear);
    return p;
  }
  function isRefusal(e) {
    if (!e || !e.body || typeof e.body !== "object") return false;
    if (e.status >= 500) return false;
    return ["service_down", "rate_limited", "timeout", "network", "bad_response", "cooldown"].indexOf(e.code) < 0;
  }

  // src/providers/polishrest.js
  var DEVICE = "gopeed-ext-debrid";
  var VERSION = 1;
  var REST2 = "/api/rest";
  var LOCK_MS = 60 * MIN;
  var SESSION_TTL_MS = 30 * 24 * HOUR;
  var WRONG_LOGIN = "wrong login or password";
  var LOCKED = "the login is locked for 60 minutes after failed logins";
  function errNo(value) {
    return num(value) > 0 ? num(value) : 0;
  }
  function classify5(body, status) {
    if (!body || typeof body !== "object") return status === 401 ? known("auth_invalid", WRONG_LOGIN) : null;
    const top = errNo(body.error);
    if (top === 1) return { code: "token_invalid", reason: "the session expired" };
    if (top === 3) return known("auth_invalid", WRONG_LOGIN);
    if (top === 4) return known("auth_invalid", LOCKED);
    if (top) return { code: String(top), reason: text(body.message) || `the service reported error ${top}` };
    const f = body.file && typeof body.file === "object" ? body.file : null;
    const fileErr = f ? errNo(f.error) : 0;
    if (fileErr === 15) return known("not_supported");
    if (fileErr) return { code: String(fileErr), reason: text(f.message) || `the service reported error ${fileErr}` };
    return status === 401 ? known("auth_invalid", WRONG_LOGIN) : null;
  }
  function polishProvider({ id, title, base }) {
    const credential = (s) => `${s.login || ""}\0${s.password || ""}`;
    const inflight2 = /* @__PURE__ */ new Map();
    function session3(s) {
      const runtime = [];
      const api = createApi({ id, title, base, settings: s, credential: () => credential(s), authHeaders: () => ({}), classify: classify5, runtime });
      const store2 = sessionStore(id, SESSION_TTL_MS, runtime);
      const post = (path, json) => api.call("POST", REST2 + path, { json: Object.assign({}, json, { device: DEVICE, version: VERSION }), auth: false, noTrip: true });
      async function refuse(reason, ms = COOLDOWN_MS) {
        await store2.drop();
        await startCooldown(id, credential(s), reason, ms);
        try {
          gopeed.logger.warn(`${title}: ${reason}; no further calls for ${Math.round(ms / MIN)} minutes`);
        } catch (e) {
        }
        throw api.fail("auth_invalid", reason);
      }
      async function doLogin() {
        let body;
        try {
          body = await post("/login", { login: s.login, password: s.password });
        } catch (e) {
          if (e && e.code === "auth_invalid") await refuse(e.reason, e.reason === LOCKED ? LOCK_MS : COOLDOWN_MS);
          if (isRefusal(e)) await refuse(e.reason);
          throw e;
        }
        const token = body && typeof body.authtoken === "string" ? body.authtoken : "";
        if (body && body.logged === false && !token) await refuse(WRONG_LOGIN);
        if (!token) throw api.fail("bad_response", "the service gave no authtoken");
        await store2.set(s.login, token);
        return token;
      }
      let loggedIn = false;
      async function login() {
        const token = await sharedLogin(inflight2, credential(s), doLogin);
        store2.track(token);
        loggedIn = true;
        return token;
      }
      const refused = (e) => !!e && (e.code === "token_invalid" || e.code === "auth_invalid");
      async function authed(path, json) {
        const stored = await store2.get(s.login);
        const token = stored || await login();
        try {
          return await post(path, Object.assign({ authtoken: token }, json));
        } catch (e) {
          if (!refused(e)) throw e;
          if (!stored || loggedIn) await refuse("the service refused a new session");
        }
        await store2.drop();
        const fresh = await login();
        try {
          return await post(path, Object.assign({ authtoken: fresh }, json));
        } catch (e) {
          if (refused(e)) await refuse("the service refused a new session");
          throw e;
        }
      }
      return { api, authed };
    }
    async function hosts9(s) {
      return hostList(id, async () => {
        const body = await session3(s).api.call("GET", "/clipboard.php", { query: { json: 3 }, auth: false, noTrip: true, timeoutMs: HOSTS_TIMEOUT_MS });
        const out = [];
        for (const h of Array.isArray(body) ? body : []) {
          if (h && Array.isArray(h.domains)) out.push(...h.domains);
        }
        return out;
      });
    }
    async function unrestrict9(s, url) {
      if (!await claims(hosts9, s, url)) return null;
      const { api, authed } = session3(s);
      await api.guard();
      const checked = await authed("/files/check", { url });
      const file = checked && checked.file && typeof checked.file === "object" ? checked.file : {};
      if (typeof file.hash !== "string" || !file.hash) throw api.fail("bad_response", "the service gave no file hash");
      const got = await authed("/files/download", { hash: file.hash, mode: "qnap" });
      const link = got && got.file && typeof got.file.url === "string" ? got.file.url : "";
      if (!link) throw api.fail("bad_response", "the service gave no download link");
      return { name: text(file.filename_full) || text(file.filename), size: num(file.filesize), url: link, headers: {} };
    }
    return {
      id,
      title,
      kind: "multihoster",
      base,
      linkTTLms: 3 * HOUR,
      enabled: (s) => !!s.enabled && !!s.login && !!s.password,
      hosts: hosts9,
      unrestrict: unrestrict9,
      cachedMagnet: async () => null
    };
  }

  // src/providers/rapideo.js
  var rapideo_default = polishProvider({ id: "rapideo", title: "Rapideo", base: "https://www.rapideo.pl" });

  // src/providers/nopremium.js
  var nopremium_default = polishProvider({ id: "nopremium", title: "NoPremium", base: "https://www.nopremium.pl" });

  // src/providers/twojlimit.js
  var twojlimit_default = polishProvider({ id: "twojlimit", title: "Twojlimit", base: "https://www.twojlimit.pl" });

  // src/providers/onefichier.js
  var ID6 = "onefichier";
  var TITLE6 = "1fichier";
  var BASE6 = "https://api.1fichier.com";
  var DOMAINS = [
    "1fichier.com",
    "alterupload.com",
    "cjoint.net",
    "desfichiers.com",
    "dfichiers.com",
    "dl4free.com",
    "megadl.fr",
    "mesfichiers.org",
    "piecejointe.net",
    "pjointe.com",
    "tenvoi.com"
  ];
  function classify6(body, status) {
    if (status === 401) return known("auth_invalid");
    if (status === 403) {
      if (body && typeof body === "object") return known("auth_invalid", "access refused (HTTP 403): the API key is wrong or the account is not premium");
      return known("ip_not_allowed", "blocked by the service's protection (HTTP 403); a VPN or datacenter address is often refused");
    }
    if (status === 404 || status === 410) return known("dead_link");
    return null;
  }
  function envelope5(body) {
    if (!body || typeof body !== "object" || body.status !== "KO") return null;
    return { code: "error", text: text(body.message) };
  }
  function makeApi5(s) {
    return createApi({
      id: ID6,
      title: TITLE6,
      base: BASE6,
      settings: s,
      credential: () => s.apikey,
      authHeaders: () => ({ Authorization: `Bearer ${s.apikey}` }),
      classify: classify6,
      envelope: envelope5
    });
  }
  async function hosts6() {
    return DOMAINS.slice();
  }
  async function info(api, url) {
    try {
      const body = await api.call("POST", "/v1/file/info.cgi", { json: { url }, noTrip: true });
      return body && typeof body === "object" ? body : {};
    } catch (e) {
      return {};
    }
  }
  async function unrestrict6(s, url) {
    if (!await claims(hosts6, s, url)) return null;
    const api = makeApi5(s);
    await api.guard();
    const res = await api.call("POST", "/v1/download/get_token.cgi", { json: { url } });
    const link = res && typeof res.url === "string" ? res.url : "";
    if (!link) throw api.fail("bad_response", "the service gave no download link");
    const meta = await info(api, url);
    return { name: text(meta.filename), size: num(meta.size), url: link, headers: {} };
  }
  var onefichier_default = {
    id: ID6,
    title: TITLE6,
    kind: "hoster",
    base: BASE6,
    linkTTLms: 5 * MIN,
    enabled: (s) => !!s.enabled && !!s.apikey,
    hosts: hosts6,
    unrestrict: unrestrict6,
    cachedMagnet: async () => null
  };

  // src/lib/totp.js
  var BASE322 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  function rotl(x, n) {
    return x << n | x >>> 32 - n;
  }
  function sha1(bytes) {
    const msg = bytes.slice();
    const bitLength = bytes.length * 8;
    msg.push(128);
    while (msg.length % 64 !== 56) msg.push(0);
    const hi = Math.floor(bitLength / 4294967296);
    const lo = bitLength >>> 0;
    msg.push(hi >>> 24 & 255, hi >>> 16 & 255, hi >>> 8 & 255, hi & 255);
    msg.push(lo >>> 24 & 255, lo >>> 16 & 255, lo >>> 8 & 255, lo & 255);
    let h0 = 1732584193;
    let h1 = 4023233417;
    let h2 = 2562383102;
    let h3 = 271733878;
    let h4 = 3285377520;
    const w = new Array(80);
    for (let off = 0; off < msg.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = msg[j] << 24 | msg[j + 1] << 16 | msg[j + 2] << 8 | msg[j + 3];
      }
      for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      for (let i = 0; i < 80; i++) {
        let f;
        let k;
        if (i < 20) {
          f = b & c | ~b & d;
          k = 1518500249;
        } else if (i < 40) {
          f = b ^ c ^ d;
          k = 1859775393;
        } else if (i < 60) {
          f = b & c | b & d | c & d;
          k = 2400959708;
        } else {
          f = b ^ c ^ d;
          k = 3395469782;
        }
        const t = rotl(a, 5) + f + e + k + w[i] | 0;
        e = d;
        d = c;
        c = rotl(b, 30);
        b = a;
        a = t;
      }
      h0 = h0 + a | 0;
      h1 = h1 + b | 0;
      h2 = h2 + c | 0;
      h3 = h3 + d | 0;
      h4 = h4 + e | 0;
    }
    const out = [];
    for (const h of [h0, h1, h2, h3, h4]) out.push(h >>> 24 & 255, h >>> 16 & 255, h >>> 8 & 255, h & 255);
    return out;
  }
  function hmacSha1(key, message) {
    let k = key.length > 64 ? sha1(key) : key.slice();
    while (k.length < 64) k.push(0);
    const inner = sha1(k.map((b) => b ^ 54).concat(message));
    return sha1(k.map((b) => b ^ 92).concat(inner));
  }
  function base32Decode(text2) {
    const clean2 = String(text2 === void 0 || text2 === null ? "" : text2).replace(/[\s=]+/g, "").toUpperCase();
    if (!clean2) return null;
    const out = [];
    let bits = 0;
    let value = 0;
    for (const ch of clean2) {
      const idx = BASE322.indexOf(ch);
      if (idx < 0) return null;
      value = (value << 5 | idx) & 65535;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push(value >>> bits & 255);
      }
    }
    return out.length ? out : null;
  }
  function totp(keyBytes, timeMs, { step = 30, digits = 6 } = {}) {
    const counter = Math.floor(timeMs / 1e3 / step);
    const hi = Math.floor(counter / 4294967296);
    const lo = counter >>> 0;
    const msg = [hi >>> 24 & 255, hi >>> 16 & 255, hi >>> 8 & 255, hi & 255, lo >>> 24 & 255, lo >>> 16 & 255, lo >>> 8 & 255, lo & 255];
    const h = hmacSha1(keyBytes, msg);
    const o = h[19] & 15;
    const bin = (h[o] & 127) * 16777216 + (h[o + 1] << 16) + (h[o + 2] << 8) + h[o + 3];
    const code = String(bin % Math.pow(10, digits));
    return code.length < digits ? "0".repeat(digits - code.length) + code : code;
  }

  // src/providers/rapidgator.js
  var ID7 = "rapidgator";
  var TITLE7 = "Rapidgator";
  var BASE7 = "https://rapidgator.net";
  var API4 = "/api/v2";
  var DOMAINS2 = ["rapidgator.net", "rapidgator.asia", "rg.to"];
  var SESSION_TTL_MS2 = 24 * HOUR;
  var WRONG_LOGIN2 = "wrong login or password";
  var WRONG_CODE = "the 2FA code was refused (check the 2FA secret, and that the clock of this device is right)";
  var TOTP_STEP_MS = 30 * 1e3;
  var TOTP_KEY = "totp:rapidgator";
  var inflight = /* @__PURE__ */ new Map();
  async function freshCode(key) {
    const last = await recall(TOTP_KEY);
    let step = Math.floor(Date.now() / TOTP_STEP_MS);
    while (typeof last === "number" && step <= last) {
      await sleep(Math.max(1, (last + 1) * TOTP_STEP_MS - Date.now()));
      step = Math.floor(Date.now() / TOTP_STEP_MS);
    }
    await remember(TOTP_KEY, step, 2 * TOTP_STEP_MS);
    return totp(key, step * TOTP_STEP_MS);
  }
  var details = (body) => text(body && body.details).replace(/^Error:\s*/i, "");
  function classify7(body, httpStatus) {
    const st = body && typeof body === "object" && typeof body.status === "number" ? body.status : httpStatus;
    if (!st || st === 200) return null;
    if (st === 401) return { code: "token_invalid", reason: details(body) || "the session is not valid" };
    if (st === 404) return known("dead_link");
    if (st === 429) return known("rate_limited");
    if (st >= 500) return known("service_down", details(body) || `the service is down (status ${st})`);
    return { code: String(st), reason: details(body) || `the service answered status ${st}` };
  }
  function parseLink(url) {
    const m = /^[a-z]+:\/\/[^/]+\/file\/([^/?#]+)(?:\/([^/?#]+))?/i.exec(String(url || ""));
    if (!m) return null;
    let name = m[2] ? m[2].replace(/\.html?$/i, "") : "";
    try {
      name = decodeURIComponent(name);
    } catch (e) {
    }
    return { fileId: m[1], name };
  }
  function session2(s) {
    const runtime = [];
    const credential = () => `${s.login || ""}\0${s.password || ""}\0${s["2fa_secret"] || ""}`;
    const api = createApi({
      id: ID7,
      title: TITLE7,
      base: BASE7,
      settings: s,
      credential,
      authHeaders: () => ({}),
      classify: classify7,
      runtime
    });
    const store2 = sessionStore(ID7, SESSION_TTL_MS2, runtime);
    const post = (path, form) => api.call("POST", API4 + path, { form, auth: false, noTrip: true });
    async function refuse(reason) {
      await store2.drop();
      await api.trip(reason);
      throw api.fail("auth_invalid", reason);
    }
    async function doLogin() {
      const form = { login: s.login, password: s.password };
      if (s["2fa_secret"]) {
        const key = base32Decode(s["2fa_secret"]);
        if (!key) throw api.fail("auth_invalid", "the 2FA secret is not a base32 secret (letters A to Z and digits 2 to 7)");
        form.code = await freshCode(key);
      }
      let body;
      try {
        body = await post("/user/login", form);
      } catch (e) {
        if (e && e.code === "token_invalid") await refuse(/auth code/i.test(e.reason) ? WRONG_CODE : WRONG_LOGIN2);
        if (isRefusal(e)) await refuse(e.reason);
        throw e;
      }
      const r = body && body.response && typeof body.response === "object" ? body.response : {};
      const token = typeof r.token === "string" ? r.token : "";
      if (!token) throw api.fail("bad_response", "the service gave no session token");
      const user = r.user && typeof r.user === "object" ? r.user : {};
      if (user.is_premium === false) throw api.fail("account_expired", "the account has expired or is not premium");
      const left = user.traffic && typeof user.traffic === "object" ? user.traffic.left : void 0;
      if (left !== void 0 && left !== null && left !== "" && Number.isFinite(Number(left)) && num(left) <= 0) {
        throw api.fail("limit_reached", "limit reached (no traffic left on the account)");
      }
      await store2.set(s.login, token);
      return token;
    }
    async function login() {
      const token = await sharedLogin(inflight, credential(), doLogin);
      store2.track(token);
      return token;
    }
    const refused = (e) => !!e && (e.code === "token_invalid" || e.code === "auth_invalid");
    async function authed(path, form) {
      const stored = await store2.get(s.login);
      const token = stored || await login();
      try {
        return await post(path, Object.assign({ token }, form));
      } catch (e) {
        if (!refused(e)) throw e;
        if (!stored) await refuse("the service refused a new session");
      }
      await store2.drop();
      const fresh = await login();
      try {
        return await post(path, Object.assign({ token: fresh }, form));
      } catch (e) {
        if (refused(e)) await refuse("the service refused a new session");
        throw e;
      }
    }
    return { api, authed };
  }
  async function hosts7() {
    return DOMAINS2.slice();
  }
  async function unrestrict7(s, url) {
    if (!await claims(hosts7, s, url)) return null;
    const link = parseLink(url);
    if (!link) return null;
    const { api, authed } = session2(s);
    await api.guard();
    const body = await authed("/file/download", { file_id: link.fileId });
    const r = body && body.response && typeof body.response === "object" ? body.response : {};
    if (typeof r.download_url !== "string" || !r.download_url) throw api.fail("bad_response", "the service gave no download link");
    return { name: link.name, size: 0, url: r.download_url, headers: {} };
  }
  var rapidgator_default = {
    id: ID7,
    title: TITLE7,
    kind: "hoster",
    base: BASE7,
    // The docs give no link lifetime, so the default of three hours.
    linkTTLms: 3 * HOUR,
    enabled: (s) => !!s.enabled && !!s.login && !!s.password,
    hosts: hosts7,
    unrestrict: unrestrict7,
    cachedMagnet: async () => null
  };

  // src/providers/nitroflare.js
  var ID8 = "nitroflare";
  var TITLE8 = "Nitroflare";
  var BASE8 = "https://nitroflare.com";
  var API5 = "/api/v2";
  var DOMAINS3 = ["nitroflare.com", "nitro.download"];
  var WRONG_KEY = "wrong user or premium key";
  var CAPTCHA = "log in on nitroflare.com once in a browser to clear the captcha, then add the link again";
  function classify8(body) {
    if (!body || typeof body !== "object" || body.type !== "error") return null;
    const code = num(body.code);
    if (code === 12) return { code: "login_required", reason: CAPTCHA };
    return { code: String(code || "error"), reason: text(body.message) || "the service reported an error" };
  }
  function makeApi6(s) {
    return createApi({
      id: ID8,
      title: TITLE8,
      base: BASE8,
      settings: s,
      credential: () => `${s.user || ""}\0${s.premium_key || ""}`,
      authHeaders: () => ({}),
      classify: classify8
    });
  }
  function fileId(url) {
    const m = /^[a-z]+:\/\/[^/]+\/view\/([^/?#]+)/i.exec(String(url || ""));
    return m ? m[1] : "";
  }
  async function hosts8() {
    return DOMAINS3.slice();
  }
  async function checkKey(api, s) {
    let body;
    try {
      body = await api.call("GET", `${API5}/getKeyInfo`, { query: { user: s.user, premiumKey: s.premium_key }, auth: false, noTrip: true });
    } catch (e) {
      const answered = e && e.body && typeof e.body === "object" && e.body.type === "error";
      if (e && e.code !== "login_required" && (answered || e.code === "auth_invalid")) {
        await api.trip(WRONG_KEY);
        throw api.fail("auth_invalid", WRONG_KEY);
      }
      throw e;
    }
    const r = body && body.result && typeof body.result === "object" ? body.result : {};
    if (typeof r.status === "string" && r.status !== "active") throw api.fail("account_expired", "the account has expired or is not premium");
    const left = r.trafficLeft;
    if (left !== void 0 && left !== null && left !== "" && Number.isFinite(Number(left)) && num(left) <= 0) {
      throw api.fail("limit_reached", "limit reached (no traffic left on the account)");
    }
  }
  async function unrestrict8(s, url) {
    if (!await claims(hosts8, s, url)) return null;
    const file = fileId(url);
    if (!file) return null;
    const api = makeApi6(s);
    await api.guard();
    await checkKey(api, s);
    const body = await api.call("GET", `${API5}/getDownloadLink`, { query: { file, user: s.user, premiumKey: s.premium_key }, auth: false });
    const r = body && body.result && typeof body.result === "object" ? body.result : {};
    if (typeof r.url !== "string" || !r.url) throw api.fail("bad_response", "the service gave no download link");
    return { name: text(r.name), size: num(r.size), url: r.url, headers: {} };
  }
  var nitroflare_default = {
    id: ID8,
    title: TITLE8,
    kind: "hoster",
    base: BASE8,
    // No source states a link lifetime, so the default of three hours.
    linkTTLms: 3 * HOUR,
    enabled: (s) => !!s.enabled && !!s.user && !!s.premium_key,
    hosts: hosts8,
    unrestrict: unrestrict8,
    cachedMagnet: async () => null
  };

  // src/providers/index.js
  var PROVIDERS = [
    torbox_default,
    alldebrid_default,
    premiumize_default,
    realdebrid_default,
    debridlink_default,
    rapideo_default,
    nopremium_default,
    twojlimit_default,
    onefichier_default,
    rapidgator_default,
    nitroflare_default
  ];

  // src/resolve.js
  var ORIGIN_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  var HOSTS_ROUND_MS = 10 * 1e3;
  var HOSTS_FAIL_MS = 10 * 60 * 1e3;
  var SWEEP_PREFIXES = ["orig:", "renewed:", "magnetfiles:", "hostsfail:"];
  var SWEEP_EVERY_MS = 24 * 60 * 60 * 1e3;
  var LABEL = "rt16.debrid";
  var NOT_CACHED = "RT16_NOT_CACHED";
  var MEGA_TEXT = "Mega links are not supported: Mega encrypts files in the browser with a key that never leaves the link, so a download would only save encrypted data";
  var MEGA_DOMAINS = ["mega.nz", "mega.co.nz"];
  var LINK_STOP = ["auth_invalid", "cooldown", "login_required", "token_invalid", "dead_link", "bad_password"];
  var MAGNET_STOP = ["auth_invalid", "cooldown", "login_required", "token_invalid"];
  function clean(text2) {
    return redact(text2, secretsOf(settings()));
  }
  function userError(text2) {
    return new MessageError(clean(text2));
  }
  function log(level, text2) {
    try {
      gopeed.logger[level](`debrid: ${clean(text2)}`);
    } catch (e) {
    }
  }
  var info2 = (text2) => log("info", text2);
  var warn2 = (text2) => log("warn", text2);
  function messageOf(provider, err) {
    if (err instanceof ProviderError) return err.message;
    const reason = err && err.message !== void 0 ? String(err.message) : String(err);
    return `${provider.title}: ${reason}`;
  }
  function isMagnet(url) {
    return /^magnet:/i.test(String(url || "").trim());
  }
  function orderedProviders(list = PROVIDERS) {
    const raw = settings().order;
    const ids = typeof raw === "string" ? raw.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean) : [];
    const out = [];
    for (const id of ids) {
      const p = list.find((x) => x.id === id);
      if (p && out.indexOf(p) < 0) out.push(p);
    }
    for (const p of list) if (out.indexOf(p) < 0) out.push(p);
    return out;
  }
  function enabledProviders(list) {
    const out = [];
    for (const p of orderedProviders(list)) {
      const s = providerSettings(p.id);
      let on = false;
      try {
        on = !!p.enabled(s);
      } catch (e) {
        on = false;
      }
      if (on) out.push({ p, s });
    }
    return out;
  }
  function textOf(err) {
    return err && err.message !== void 0 ? String(err.message) : String(err);
  }
  async function within(promise, ms) {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1e3} s`)), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function loadHosts(p, s) {
    const failKey = `hostsfail:${p.id}`;
    const h = settingsHash(p.id, s, settings().advanced_api_base);
    let failed = false;
    try {
      const record = await recall(failKey);
      failed = !!record && typeof record === "object" && record.h === h;
    } catch (e) {
      failed = false;
    }
    if (failed && p.kind !== "hoster") return [];
    let list;
    try {
      list = await within(Promise.resolve().then(() => p.hosts(s)), HOSTS_ROUND_MS);
    } catch (e) {
      warn2(`${messageOf(p, e)} (its host list could not be loaded, so it claims no link for 10 minutes)`);
      list = null;
    }
    if (Array.isArray(list) && list.length) return list;
    if (!failed) {
      try {
        await remember(failKey, { h }, HOSTS_FAIL_MS);
      } catch (e) {
      }
    }
    return [];
  }
  async function unrestrictLink2(url, { providers } = {}) {
    const host = hostOf(url);
    if (!host) return null;
    const enabled = enabledProviders(providers);
    const lists = await Promise.all(enabled.map(({ p, s }) => loadHosts(p, s)));
    const failures = [];
    for (let i = 0; i < enabled.length; i++) {
      const { p, s } = enabled[i];
      if (!hostMatches(host, lists[i])) continue;
      let file;
      try {
        file = await p.unrestrict(s, url);
      } catch (e) {
        const text2 = messageOf(p, e);
        if (!(e instanceof ProviderError) || LINK_STOP.indexOf(e.code) >= 0) throw userError(text2);
        warn2(`${text2}; asking the next provider`);
        failures.push(text2);
        continue;
      }
      if (file && typeof file.url === "string" && file.url) return { provider: p, file };
    }
    if (failures.length) throw userError(failures.join("; "));
    return null;
  }
  async function findCachedMagnet(magnet, { providers } = {}) {
    for (const { p, s } of enabledProviders(providers)) {
      if (p.kind !== "debrid") continue;
      let files;
      try {
        files = await p.cachedMagnet(s, magnet);
      } catch (e) {
        const text2 = messageOf(p, e);
        if (e instanceof ProviderError && MAGNET_STOP.indexOf(e.code) >= 0) throw userError(text2);
        warn2(`${text2}; the magnet counts as not cached there`);
        continue;
      }
      if (Array.isArray(files) && files.length) return { provider: p, files };
    }
    return null;
  }
  function lastSegment(url) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(String(url || ""));
    const parts = (m ? m[1] : "").split("/").filter(Boolean);
    if (!parts.length) return "";
    try {
      return decodeURIComponent(parts[parts.length - 1]);
    } catch (e) {
      return parts[parts.length - 1];
    }
  }
  function fileName(file, original) {
    const own = typeof file.name === "string" ? file.name.trim() : "";
    return own || lastSegment(file.url) || lastSegment(original) || "download";
  }
  function toFile(file, original) {
    const size = Number(file.size);
    return {
      name: fileName(file, original),
      size: Number.isFinite(size) && size > 0 ? size : 0,
      req: { url: file.url, extra: { header: Object.assign({}, file.headers || {}) } }
    };
  }
  async function rememberOrigin(url, record) {
    try {
      await remember(`orig:${url}`, Object.assign({}, record, { at: Date.now() }), ORIGIN_TTL_MS);
    } catch (e) {
      warn2(`the origin of a direct link could not be stored, so it cannot be renewed: ${textOf(e)}`);
    }
  }
  async function housekeeping() {
    try {
      await sweep(SWEEP_PREFIXES, SWEEP_EVERY_MS);
    } catch (e) {
      warn2(`the storage clean-up failed: ${textOf(e)}`);
    }
  }
  function magnetsAllowed() {
    const v = settings().magnets_via_debrid;
    return !(v === false || v === "false");
  }
  function torrentName(magnet) {
    const parsed = parseMagnet(magnet);
    if (!parsed) return "magnet";
    return parsed.name.trim() || parsed.hash;
  }
  async function resolveMagnet(ctx, magnet, refuse, providers) {
    const hit = magnetsAllowed() ? await findCachedMagnet(magnet, { providers }) : null;
    if (!hit) {
      if (refuse) throw userError(NOT_CACHED);
      return;
    }
    const files = hit.files.map((f) => toFile(f, ""));
    for (let i = 0; i < files.length; i++) {
      await rememberOrigin(files[i].req.url, { original: magnet, provider: hit.provider.id, file: files[i].name, size: files[i].size });
    }
    ctx.res = { name: torrentName(magnet), files };
    info2(`${hit.provider.title} has the magnet cached: ${files.length} file${files.length === 1 ? "" : "s"}`);
  }
  async function onResolve(ctx, { providers } = {}) {
    const req = ctx && ctx.req || {};
    const url = String(req.url || "").trim();
    const labels = req.labels && typeof req.labels === "object" ? req.labels : {};
    await housekeeping();
    if (isMagnet(url)) return resolveMagnet(ctx, url, labels[LABEL] === "cached-or-refuse", providers);
    const hit = await unrestrictLink2(url, { providers });
    if (!hit) {
      if (hostMatches(hostOf(url), MEGA_DOMAINS)) throw userError(MEGA_TEXT);
      return;
    }
    const file = toFile(hit.file, url);
    await rememberOrigin(file.req.url, { original: url, provider: hit.provider.id });
    ctx.res = { name: file.name, files: [file] };
    info2(`${hit.provider.title} resolved a link from ${hostOf(url)}`);
  }

  // src/renew.js
  var MAX_RENEWALS = 3;
  var MAGNET_FILES_MS = 5 * 60 * 1e3;
  var counted = {};
  var EXPIRED = /(^|[^0-9])(403|404|410)([^0-9]|$)/;
  function errorText2(err) {
    if (err === void 0 || err === null) return "";
    if (typeof err === "string") return err;
    for (const name of ["Error", "error"]) {
      try {
        if (typeof err[name] === "function") return String(err[name]());
      } catch (e) {
      }
    }
    if (typeof err.message === "string") return err.message;
    try {
      return String(err);
    } catch (e) {
      return "";
    }
  }
  function whereFrom(record) {
    return isMagnet(record.original) ? "a magnet" : hostOf(record.original);
  }
  function sizeOf(file) {
    const n = Number(file && file.size);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  function sameFile(file, record) {
    return fileName(file, "") === record.file && sizeOf(file) === sizeOf(record);
  }
  async function magnetFiles(record, failedUrl, providers) {
    const parsed = parseMagnet(record.original);
    const key = parsed ? `magnetfiles:${parsed.hash}` : "";
    if (key) {
      let kept = null;
      try {
        kept = await recall(key);
      } catch (e) {
        kept = null;
      }
      if (kept && Array.isArray(kept.files)) {
        const file = kept.files.find((f) => sameFile(f, record));
        const provider = (providers || PROVIDERS).find((p) => p.id === kept.provider);
        if (file && provider && file.url !== failedUrl) return { provider, files: kept.files };
      }
    }
    const hit = await findCachedMagnet(record.original, { providers });
    if (hit && key) {
      try {
        await remember(key, { provider: hit.provider.id, files: hit.files }, MAGNET_FILES_MS);
      } catch (e) {
      }
    }
    return hit;
  }
  async function renewRecord(record, providers, failedUrl) {
    if (isMagnet(record.original)) {
      const hit2 = await magnetFiles(record, failedUrl, providers);
      if (!hit2) return null;
      const file = hit2.files.find((f) => sameFile(f, record));
      if (!file) {
        warn2(`${hit2.provider.title} no longer lists a file with the same name and size in the magnet; it is not renewed`);
        return null;
      }
      await rememberOrigin(file.url, { original: record.original, provider: hit2.provider.id, file: record.file, size: sizeOf(record) });
      return { url: file.url, provider: hit2.provider };
    }
    const hit = await unrestrictLink2(record.original, { providers });
    if (!hit) return null;
    await rememberOrigin(hit.file.url, { original: record.original, provider: hit.provider.id });
    return { url: hit.file.url, provider: hit.provider };
  }
  async function recordOf(task) {
    const req = task && task.meta && task.meta.req;
    if (!req) return null;
    const record = await recall(`orig:${String(req.url || "")}`);
    return record && typeof record === "object" && typeof record.original === "string" ? { req, record } : null;
  }
  async function onStart(ctx, { providers } = {}) {
    try {
      const found = await recordOf(ctx && ctx.task);
      if (!found) return;
      const { req, record } = found;
      const provider = (providers || PROVIDERS).find((p) => p.id === record.provider);
      const ttl = provider ? Number(provider.linkTTLms) : 0;
      if (!(ttl > 0) || Date.now() - Number(record.at) <= ttl / 2) return;
      const fresh = await renewRecord(record, providers, req.url);
      if (!fresh) {
        warn2(`no provider renewed the link from ${whereFrom(record)} before the start; starting with the old link`);
        return;
      }
      await req.setUrl(fresh.url);
      info2(`${fresh.provider.title} refreshed the link from ${whereFrom(record)} before the start`);
    } catch (e) {
      warn2(`the link could not be refreshed before the start: ${errorText2(e)}`);
    }
  }
  async function onError(ctx, { providers } = {}) {
    try {
      if (!EXPIRED.test(errorText2(ctx && ctx.error))) return;
      await housekeeping();
      const task = ctx.task;
      const found = await recordOf(task);
      if (!found) return;
      const { req, record } = found;
      const key = `renewed:${task.id}`;
      const count = Math.max(Number(await recall(key)) || 0, counted[key] || 0);
      if (count >= MAX_RENEWALS) {
        warn2(`this task already had ${MAX_RENEWALS} renewals of its link from ${whereFrom(record)}; it is not renewed again`);
        return;
      }
      counted[key] = count + 1;
      await remember(key, count + 1, ORIGIN_TTL_MS);
      if (Number(await recall(key)) !== count + 1) {
        warn2("the storage does not keep the renewal count, so the link is not renewed");
        return;
      }
      const fresh = await renewRecord(record, providers, req.url);
      if (!fresh) {
        warn2(`no provider renewed the expired link from ${whereFrom(record)}`);
        return;
      }
      await req.setUrl(fresh.url);
      await task.continue();
      info2(`${fresh.provider.title} renewed the expired link from ${whereFrom(record)}`);
    } catch (e) {
      warn2(`the expired link could not be renewed: ${errorText2(e)}`);
    }
  }

  // src/index.js
  gopeed.events.onResolve((ctx) => onResolve(ctx));
  gopeed.events.onStart((ctx) => onStart(ctx));
  gopeed.events.onError((ctx) => onError(ctx));
})();
