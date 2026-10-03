// The extension's settings, read from gopeed.settings on every call (the user can change them at any time).
// Strings are trimmed, because a token pasted from a web page often ends in a space or a newline. Numbers,
// booleans and null are returned as Gopeed gives them.

export function settings() {
  const src = (typeof gopeed !== 'undefined' && gopeed && gopeed.settings) || {};
  const out = {};
  for (const key of Object.keys(src)) {
    const value = src[key];
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

// The settings of one provider, without the prefix: providerSettings('torbox') turns torbox_enabled and
// torbox_apikey into { enabled, apikey }.
export function providerSettings(id) {
  const prefix = `${id}_`;
  const all = settings();
  const out = {};
  for (const key of Object.keys(all)) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = all[key];
  }
  return out;
}

// The values of the secret settings: those whose name is, or ends in, token, key, apikey, password or secret (the
// suffixes the shim masks; secret is for rapidgator_2fa_secret). It takes settings() or providerSettings(id), so both "torbox_apikey" and "apikey" count, and
// "monkey" does not. Empty and non-string values are skipped, and each value is listed once.
export function secretsOf(fields) {
  const out = [];
  for (const name of Object.keys(fields || {})) {
    const value = fields[name];
    if (!/(^|_)(token|key|apikey|password|secret)$/.test(name)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    if (out.indexOf(value) < 0) out.push(value);
  }
  return out;
}

// Where a provider's API lives. Normally defaultBase, the real service. When the setting advanced_api_base is filled
// in (a test mock), every provider sends its requests to `${advanced_api_base}/${id}` instead, so one mock server
// can answer for all of them. Trailing slashes of the setting are trimmed. Call it for every request, because the
// setting can change at any time.
export function apiBase(id, defaultBase) {
  const raw = settings().advanced_api_base;
  const custom = typeof raw === 'string' ? raw.replace(/\/+$/, '') : '';
  return custom ? `${custom}/${id}` : defaultBase;
}
