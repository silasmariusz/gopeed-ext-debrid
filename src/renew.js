// Renewal of the direct links the extension handed out. Their lifetime is short (5 minutes on 1fichier, 1 hour on
// TorBox, about 3 hours elsewhere), and Gopeed may start a task late (a queue) or resume it hours later.
//
// The source of a direct URL is the record resolve.js keeps under orig:<url> for 7 days: { original, provider, at },
// plus { file, index } for a file of a magnet. A renewal asks again with the current settings and order: a hoster
// link goes through the same claim chain as onResolve, a magnet asks the debrid providers again and takes the same
// file, which must match by name and size (never by position: a resumed download into another file would be
// corrupt, so with no match the error stands). The file list of a magnet is kept for MAGNET_FILES_MS under
// magnetfiles:<hash>, so the queued files of one pack share one resolve. The new URL is remembered the same way, so
// it can be renewed in its turn. Only the URL is replaced: a provider's headers from the fresh answer are not applied
// (every provider answers with no headers today).
//
// onStart: Gopeed runs it before every start of a task, and the task's request can be changed there (the hook gets
// the live request: ExtensionTaskRequest.SetUrl writes task.Meta.Req.URL, and the downloader copies task.Meta.Req
// into the fetcher after the hook, pkg/download/downloader.go). A remembered link older than half its provider's
// linkTTLms is replaced before the download starts. It never throws: a failed refresh starts with the old link, and
// onError has its turn if that one has expired.
//
// onError: on an HTTP 403, 404 or 410 (Gopeed's text is "http request fail, code:403") of a remembered link, the
// link is renewed, set with setUrl, and the task is continued. At most MAX_RENEWALS times per task, counted under
// renewed:<task id>, so a link that keeps failing cannot loop. The count must be read back from storage after it is
// written; storage that keeps no write (or throws) means no renewal. A count in memory backs it up for an engine that
// lives longer than one hook.
import { PROVIDERS } from './providers/index.js';
import { recall, remember } from './lib/cache.js';
import { parseMagnet } from './lib/magnet.js';
import { hostOf } from './lib/hosts.js';
import { unrestrictLink, findCachedMagnet, fileName, rememberOrigin, isMagnet, info, warn, housekeeping, ORIGIN_TTL_MS } from './resolve.js';

export const MAX_RENEWALS = 3;
export const MAGNET_FILES_MS = 5 * 60 * 1000;
const counted = {};
const EXPIRED = /(^|[^0-9])(403|404|410)([^0-9]|$)/;

// The text of the error onError gets. In goja it is the Go error value, whose Error() method may be exposed as
// error() by the field name mapper; in tests it may be a string or an Error.
export function errorText(err) {
  if (err === undefined || err === null) return '';
  if (typeof err === 'string') return err;
  for (const name of ['Error', 'error']) {
    try {
      if (typeof err[name] === 'function') return String(err[name]());
    } catch (e) {
      // try the next form
    }
  }
  if (typeof err.message === 'string') return err.message;
  try {
    return String(err);
  } catch (e) {
    return '';
  }
}

function whereFrom(record) {
  return isMagnet(record.original) ? 'a magnet' : hostOf(record.original);
}

function sizeOf(file) {
  const n = Number(file && file.size);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sameFile(file, record) {
  return fileName(file, '') === record.file && sizeOf(file) === sizeOf(record);
}

// The magnet's files from the 5-minute list, or from the providers (then kept). A list whose matching file is the
// URL that just failed is not used: the providers are asked again.
async function magnetFiles(record, failedUrl, providers) {
  const parsed = parseMagnet(record.original);
  const key = parsed ? `magnetfiles:${parsed.hash}` : '';
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
      // best effort: the next file of the pack resolves the magnet again
    }
  }
  return hit;
}

// { url, provider } with a fresh direct URL for the record, or null when no provider gives one any more. Throws the
// MessageError of the claim chain.
async function renewRecord(record, providers, failedUrl) {
  if (isMagnet(record.original)) {
    const hit = await magnetFiles(record, failedUrl, providers);
    if (!hit) return null;
    const file = hit.files.find((f) => sameFile(f, record));
    if (!file) {
      warn(`${hit.provider.title} no longer lists a file with the same name and size in the magnet; it is not renewed`);
      return null;
    }
    await rememberOrigin(file.url, { original: record.original, provider: hit.provider.id, file: record.file, size: sizeOf(record) });
    return { url: file.url, provider: hit.provider };
  }
  const hit = await unrestrictLink(record.original, { providers });
  if (!hit) return null;
  await rememberOrigin(hit.file.url, { original: record.original, provider: hit.provider.id });
  return { url: hit.file.url, provider: hit.provider };
}

async function recordOf(task) {
  const req = task && task.meta && task.meta.req;
  if (!req) return null;
  const record = await recall(`orig:${String(req.url || '')}`);
  return record && typeof record === 'object' && typeof record.original === 'string' ? { req, record } : null;
}

export async function onStart(ctx, { providers } = {}) {
  try {
    const found = await recordOf(ctx && ctx.task);
    if (!found) return;
    const { req, record } = found;
    const provider = (providers || PROVIDERS).find((p) => p.id === record.provider);
    const ttl = provider ? Number(provider.linkTTLms) : 0;
    if (!(ttl > 0) || Date.now() - Number(record.at) <= ttl / 2) return;
    const fresh = await renewRecord(record, providers, req.url);
    if (!fresh) {
      warn(`no provider renewed the link from ${whereFrom(record)} before the start; starting with the old link`);
      return;
    }
    await req.setUrl(fresh.url);
    info(`${fresh.provider.title} refreshed the link from ${whereFrom(record)} before the start`);
  } catch (e) {
    warn(`the link could not be refreshed before the start: ${errorText(e)}`);
  }
}

export async function onError(ctx, { providers } = {}) {
  try {
    if (!EXPIRED.test(errorText(ctx && ctx.error))) return;
    await housekeeping();
    const task = ctx.task;
    const found = await recordOf(task);
    if (!found) return;
    const { req, record } = found;
    const key = `renewed:${task.id}`;
    const count = Math.max(Number(await recall(key)) || 0, counted[key] || 0);
    if (count >= MAX_RENEWALS) {
      warn(`this task already had ${MAX_RENEWALS} renewals of its link from ${whereFrom(record)}; it is not renewed again`);
      return;
    }
    counted[key] = count + 1;
    await remember(key, count + 1, ORIGIN_TTL_MS);
    if (Number(await recall(key)) !== count + 1) {
      warn('the storage does not keep the renewal count, so the link is not renewed');
      return;
    }
    const fresh = await renewRecord(record, providers, req.url);
    if (!fresh) {
      warn(`no provider renewed the expired link from ${whereFrom(record)}`);
      return;
    }
    await req.setUrl(fresh.url);
    await task.continue();
    info(`${fresh.provider.title} renewed the expired link from ${whereFrom(record)}`);
  } catch (e) {
    warn(`the expired link could not be renewed: ${errorText(e)}`);
  }
}
