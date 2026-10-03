// Host names: what a link's host is, and whether a provider's domain list covers it.

function normalize(host) {
  let h = String(host || '').trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

// The lowercase host of a URL, without "www.", the port or a user; '' for anything that is not scheme://host.
export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url || '').trim());
  if (!m) return '';
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  let host;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    host = end < 0 ? authority : authority.slice(0, end + 1);
  } else {
    const colon = authority.indexOf(':');
    host = colon < 0 ? authority : authority.slice(0, colon);
  }
  return normalize(host);
}

// True when host is one of the domains or a subdomain of one: dl.rapidgator.net matches rapidgator.net,
// evilrapidgator.net does not.
export function hostMatches(host, domainList) {
  const h = normalize(host);
  if (!h || !Array.isArray(domainList)) return false;
  for (const d of domainList) {
    const domain = normalize(d);
    if (!domain) continue;
    if (h === domain || h.endsWith(`.${domain}`)) return true;
  }
  return false;
}
