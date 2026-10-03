// Hides secrets in a text before it reaches a user or a log: every secret becomes "••••". Empty secrets are
// ignored, and each secret is also looked for trimmed.
//
// A secret is found as written and in any percent-encoding of it: each character may appear as itself or as its
// UTF-8 %XX bytes, in upper or lower case hex, and a space also as "+" or %20. That covers encodeURIComponent,
// encodeURI, form bodies (URLSearchParams, Go's url.QueryEscape and url.Values), Go's url.PathEscape and mixed-case
// escapes alike.

const MASK = '••••';

function escapeRegExp(ch) {
  return ch.replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&');
}

function percentPattern(ch) {
  let pct;
  const code = ch.charCodeAt(0);
  if (ch.length === 1 && code < 0x80) {
    pct = `%${code < 16 ? '0' : ''}${code.toString(16)}`;
  } else {
    try {
      pct = encodeURIComponent(ch);
    } catch (e) {
      return null; // a lone surrogate has no UTF-8 form
    }
  }
  return pct.replace(/[0-9a-f]/gi, (d) => (/[0-9]/.test(d) ? d : `[${d.toLowerCase()}${d.toUpperCase()}]`));
}

function patternOf(secret) {
  let re = '';
  for (const ch of secret) {
    if (ch === ' ') {
      re += '(?: |\\+|%20)';
      continue;
    }
    const pct = percentPattern(ch);
    re += pct ? `(?:${escapeRegExp(ch)}|${pct})` : escapeRegExp(ch);
  }
  return new RegExp(re, 'g');
}

export function redact(text, secrets) {
  let out = text === undefined || text === null ? '' : String(text);
  const all = [];
  for (const s of Array.isArray(secrets) ? secrets : []) {
    if (s === undefined || s === null) continue;
    const str = String(s);
    if (!str.trim()) continue;
    for (const f of [str, str.trim()]) {
      if (all.indexOf(f) < 0) all.push(f);
    }
  }
  // The longest secret first, so a secret that contains another one is hidden whole.
  all.sort((a, b) => b.length - a.length);
  for (const secret of all) out = out.replace(patternOf(secret), MASK);
  return out;
}
