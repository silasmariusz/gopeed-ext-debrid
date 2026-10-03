// The hooks: which provider claims a link (the order setting, the codes that try the next one or stop), magnets and
// the rt16.debrid label, Mega, and the renewal of expired links in onStart and onError.
//
// Most tests inject stub providers (the `providers` option of the handlers), so the order and error rules are tested
// without HTTP. The end-to-end tests at the bottom use the real Real-Debrid provider against its fixtures.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeGopeed } from './fake-gopeed.js';
import { ProviderError } from '../src/lib/http.js';
import { redact } from '../src/lib/redact.js';
import { recall, remember } from '../src/lib/cache.js';
import { onResolve, orderedProviders, HOSTS_ROUND_MS, HOSTS_FAIL_MS, SWEEP_EVERY_MS } from '../src/resolve.js';
import { providerSettings } from '../src/lib/settings.js';
import { PROVIDERS } from '../src/providers/index.js';
import { onStart, onError, MAX_RENEWALS } from '../src/renew.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RG = 'https://rapidgator.net/file/abc123/Some.File.mkv.html';
const FICHIER = 'https://1fichier.com/?abc123def456';
const PLAIN = 'https://example.com/files/plain.bin';
const HASH = 'c0ffee1234567890abcdef1234567890abcdef12';
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Cached.Show.S01&tr=udp%3A%2F%2Ftracker.example%3A1337`;
const KEYS = { torbox: 'FAKE-TORBOX-KEY-0001', realdebrid: 'FAKE-RD-TOKEN-0001', onefichier: 'FAKE-1F-KEY-0001' };
const TITLES = { torbox: 'TorBox', realdebrid: 'Real-Debrid', alldebrid: 'AllDebrid', onefichier: '1fichier', rapideo: 'Rapideo' };
const LABEL = 'rt16.debrid';

const fail = (id, code, reason, secrets = []) => new ProviderError(TITLES[id], reason, { code, secrets });

// A provider with the real interface. `link` and `magnet` decide what unrestrict and cachedMagnet do; every call is
// recorded in `calls`.
function stub(id, { kind = 'debrid', hosts = ['rapidgator.net', '1fichier.com'], link, magnet, ttl = 3 * HOUR } = {}) {
  const p = {
    id,
    title: TITLES[id],
    kind,
    linkTTLms: ttl,
    calls: [],
    enabled: (s) => !!s.enabled,
    hosts: async () => (typeof hosts === 'function' ? hosts() : hosts),
    async unrestrict(s, url) {
      p.calls.push(['unrestrict', url]);
      if (typeof link === 'function') return link(url, p.calls.length);
      return link === undefined ? { name: 'Some.File.mkv', size: 10, url: `https://dl.${id}.example/${p.calls.length}/Some.File.mkv`, headers: {} } : link;
    },
    async cachedMagnet(s, m) {
      p.calls.push(['cachedMagnet', m]);
      if (typeof magnet === 'function') return magnet(m, p.calls.length);
      return magnet === undefined ? null : magnet;
    },
  };
  return p;
}

function setup(settings = {}) {
  return installFakeGopeed({
    settings: {
      torbox_enabled: true, torbox_apikey: KEYS.torbox,
      realdebrid_enabled: true, realdebrid_token: KEYS.realdebrid,
      ...settings,
    },
  });
}

const ctxOf = (url, labels) => ({ req: labels === undefined ? { url } : { url, labels } });

// Every MessageError must be free of the configured secrets.
function assertClean(fake, err) {
  const secrets = Object.keys(fake.settings).filter((k) => /(^|_)(token|key|apikey|password|secret)$/.test(k)).map((k) => fake.settings[k]);
  assert.equal(redact(err.message, secrets), err.message, `a secret is in: ${err.message}`);
}

async function rejectsMessage(fake, promise, check) {
  let caught;
  try {
    await promise;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'expected a throw');
  assert.ok(caught instanceof globalThis.MessageError, `expected a MessageError, got ${caught && caught.constructor && caught.constructor.name}: ${caught && caught.message}`);
  assertClean(fake, caught);
  if (typeof check === 'string') assert.equal(caught.message, check);
  else if (check instanceof RegExp) assert.match(caught.message, check);
  return caught;
}

// A fake onError/onStart task.
let taskSeq = 0;
function taskOf(url, id = `task-${++taskSeq}`) {
  const task = {
    id,
    setUrls: [],
    continued: 0,
    meta: { req: { url, labels: {} } },
    async continue() { task.continued++; },
  };
  task.meta.req.setUrl = async (u) => { task.setUrls.push(u); task.meta.req.url = u; };
  return task;
}

describe('order', () => {
  test('follows the order setting, ignores unknown ids and appends the missing ones', () => {
    setup({ order: 'realdebrid, bogus,torbox' });
    const list = [stub('torbox'), stub('alldebrid'), stub('realdebrid')];
    assert.deepEqual(orderedProviders(list).map((p) => p.id), ['realdebrid', 'torbox', 'alldebrid']);
  });

  test('an empty or missing order is the registry order', () => {
    setup({ order: '' });
    const list = [stub('torbox'), stub('realdebrid')];
    assert.deepEqual(orderedProviders(list).map((p) => p.id), ['torbox', 'realdebrid']);
    setup();
    assert.deepEqual(orderedProviders(list).map((p) => p.id), ['torbox', 'realdebrid']);
  });

  test('the real registry has all eleven ids', () => {
    setup({ order: 'nitroflare' });
    const ids = orderedProviders().map((p) => p.id);
    assert.equal(ids.length, 11);
    assert.equal(ids[0], 'nitroflare');
  });
});

describe('onResolve: hoster links', () => {
  test('a link no provider claims leaves ctx.res unset and calls no unrestrict', async () => {
    setup();
    const tb = stub('torbox');
    const rd = stub('realdebrid');
    const ctx = ctxOf(PLAIN);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(ctx.res, undefined);
    assert.equal(tb.calls.length + rd.calls.length, 0);
  });

  test('order torbox,realdebrid with both claiming uses TorBox', async () => {
    const fake = setup({ order: 'torbox,realdebrid' });
    const tb = stub('torbox');
    const rd = stub('realdebrid');
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(rd.calls.length, 0);
    assert.deepEqual(ctx.res, {
      name: 'Some.File.mkv',
      files: [{ name: 'Some.File.mkv', size: 10, req: { url: 'https://dl.torbox.example/1/Some.File.mkv', extra: { header: {} } } }],
    });
    // one log line, provider and host only
    const info = fake.logs.filter((l) => l.level === 'info');
    assert.equal(info.length, 1);
    assert.match(info[0].msg, /TorBox/);
    assert.match(info[0].msg, /rapidgator\.net/);
    assert.doesNotMatch(info[0].msg, /https?:|abc123|dl\.torbox/);
  });

  test('order realdebrid,torbox uses Real-Debrid', async () => {
    setup({ order: 'realdebrid,torbox' });
    const tb = stub('torbox');
    const rd = stub('realdebrid');
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(tb.calls.length, 0);
    assert.equal(ctx.res.files[0].req.url, 'https://dl.realdebrid.example/1/Some.File.mkv');
  });

  test('a disabled provider is skipped, and so is one that does not list the host', async () => {
    setup({ torbox_enabled: false });
    const tb = stub('torbox');
    const ad = stub('alldebrid', { hosts: ['other.example'] });
    const rd = stub('realdebrid');
    const fake = globalThis.gopeed;
    fake.settings.alldebrid_enabled = true;
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb, ad, rd] });
    assert.equal(tb.calls.length, 0);
    assert.equal(ad.calls.length, 0);
    assert.equal(ctx.res.files[0].req.url, 'https://dl.realdebrid.example/1/Some.File.mkv');
  });

  test('a host list that fails to load skips that provider and does not stop an ordinary link', async () => {
    const fake = setup();
    const tb = stub('torbox', { hosts: () => { throw fail('torbox', 'network', 'the service could not be reached'); } });
    const rd = stub('realdebrid', { hosts: ['other.example'] });
    const ctx = ctxOf(PLAIN);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(ctx.res, undefined);
    assert.ok(fake.logs.some((l) => l.level === 'warn' && /TorBox/.test(l.msg)));
  });

  test('"limit reached" on TorBox tries Real-Debrid', async () => {
    setup();
    const tb = stub('torbox', { link: () => { throw fail('torbox', 'limit_reached', 'limit reached (monthly data limit of the plan)'); } });
    const rd = stub('realdebrid');
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(tb.calls.length, 1);
    assert.equal(ctx.res.files[0].req.url, 'https://dl.realdebrid.example/1/Some.File.mkv');
  });

  for (const code of ['not_supported', 'not_ready', 'ip_not_allowed', 'account_expired', 'service_down', 'rate_limited', 'timeout', 'network', 'bad_response', 'SOME_SERVICE_CODE']) {
    test(`${code} tries the next provider`, async () => {
      setup();
      const tb = stub('torbox', { link: () => { throw fail('torbox', code, `reason for ${code}`); } });
      const rd = stub('realdebrid');
      const ctx = ctxOf(RG);
      await onResolve(ctx, { providers: [tb, rd] });
      assert.equal(ctx.res.files[0].req.url, 'https://dl.realdebrid.example/1/Some.File.mkv');
    });
  }

  test('"invalid token" on TorBox is shown and Real-Debrid is not tried', async () => {
    const fake = setup();
    const tb = stub('torbox', { link: () => { throw fail('torbox', 'auth_invalid', 'invalid API key'); } });
    const rd = stub('realdebrid');
    const ctx = ctxOf(RG);
    await rejectsMessage(fake, onResolve(ctx, { providers: [tb, rd] }), 'TorBox: invalid API key');
    assert.equal(rd.calls.length, 0);
    assert.equal(ctx.res, undefined);
  });

  for (const [code, reason] of [['cooldown', 'invalid API key, not retrying for 9 more minutes'], ['dead_link', 'the link is dead or the file was removed'], ['bad_password', 'the file needs a password'], ['token_invalid', 'session refused']]) {
    test(`${code} is shown and the next provider is not tried`, async () => {
      const fake = setup();
      const tb = stub('torbox', { link: () => { throw fail('torbox', code, reason); } });
      const rd = stub('realdebrid');
      await rejectsMessage(fake, onResolve(ctxOf(RG), { providers: [tb, rd] }), `TorBox: ${reason}`);
      assert.equal(rd.calls.length, 0);
    });
  }

  test("Real-Debrid's device-login prompt reaches the user unchanged", async () => {
    const fake = setup({ order: 'realdebrid,torbox', realdebrid_token: '' });
    const text = 'open https://real-debrid.com/device and enter ABCD1234, then add the link again (the code is valid for 10 minutes)';
    const rd = stub('realdebrid', { link: () => { throw fail('realdebrid', 'login_required', text); } });
    const tb = stub('torbox');
    await rejectsMessage(fake, onResolve(ctxOf(RG), { providers: [tb, rd] }), `Real-Debrid: ${text}`);
    assert.equal(tb.calls.length, 0);
  });

  test('when every claiming provider fails with a try-next code, the user sees all the reasons', async () => {
    const fake = setup();
    const tb = stub('torbox', { link: () => { throw fail('torbox', 'limit_reached', 'limit reached'); } });
    const rd = stub('realdebrid', { link: () => { throw fail('realdebrid', 'not_supported', 'this host is not supported'); } });
    const ctx = ctxOf(RG);
    await rejectsMessage(fake, onResolve(ctx, { providers: [tb, rd] }), 'TorBox: limit reached; Real-Debrid: this host is not supported');
    assert.equal(ctx.res, undefined);
  });

  test('an error that is not a ProviderError is shown, redacted, and stops', async () => {
    const fake = setup();
    const tb = stub('torbox', { link: () => { throw new TypeError(`boom with ${KEYS.torbox} and ${encodeURIComponent(KEYS.realdebrid)}`); } });
    const rd = stub('realdebrid');
    const err = await rejectsMessage(fake, onResolve(ctxOf(RG), { providers: [tb, rd] }), /^TorBox: boom with •••• and ••••$/);
    assert.ok(!err.message.includes('FAKE'));
    assert.equal(rd.calls.length, 0);
  });

  test('a provider that answers null after all is passed over', async () => {
    setup();
    const tb = stub('torbox', { link: null });
    const rd = stub('realdebrid');
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(ctx.res.files[0].req.url, 'https://dl.realdebrid.example/1/Some.File.mkv');
  });

  test('the headers of the provider go to extra.header', async () => {
    setup();
    const tb = stub('torbox', { link: { name: 'a.bin', size: 1, url: 'https://dl.example/a.bin', headers: { Referer: 'https://torbox.app/' } } });
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb] });
    assert.deepEqual(ctx.res.files[0].req, { url: 'https://dl.example/a.bin', extra: { header: { Referer: 'https://torbox.app/' } } });
  });

  test('an empty file name falls back to the last path segment of the direct link, then of the original', async () => {
    setup();
    const tb = stub('torbox', { link: { name: '', size: 0, url: 'https://dl.example/x/Movie%20One.mkv?sig=1', headers: {} } });
    let ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb] });
    assert.equal(ctx.res.files[0].name, 'Movie One.mkv');
    assert.equal(ctx.res.name, 'Movie One.mkv');
    const tb2 = stub('torbox', { link: { name: '', size: 0, url: 'https://dl.example/', headers: {} } });
    ctx = ctxOf(FICHIER);
    await onResolve(ctx, { providers: [tb2] });
    assert.ok(ctx.res.files[0].name, 'a name is always set');
  });

  test('every direct URL is remembered for 7 days with its original and provider', async () => {
    const fake = setup();
    const t0 = Date.now();
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [stub('torbox')] });
    const rec = await recall(`orig:${ctx.res.files[0].req.url}`);
    assert.equal(rec.original, RG);
    assert.equal(rec.provider, 'torbox');
    assert.ok(rec.at >= t0 && rec.at <= Date.now());
    const raw = JSON.parse(fake.storage.map.get(`orig:${ctx.res.files[0].req.url}`));
    assert.ok(Math.abs(raw.exp - (rec.at + 7 * DAY)) < 1000);
  });
});

describe('onResolve: Mega', () => {
  for (const url of ['https://mega.nz/file/AbCdEf#key', 'https://mega.co.nz/#!AbCdEf!key', 'https://www.mega.nz/folder/x']) {
    test(`${url} gives the Mega message when no provider claims it`, async () => {
      const fake = setup();
      await rejectsMessage(fake, onResolve(ctxOf(url), { providers: [stub('torbox')] }), /^Mega links are not supported: Mega encrypts files in the browser/);
    });
  }

  test('a provider that lists mega.nz takes the link', async () => {
    setup();
    const tb = stub('torbox', { hosts: ['mega.nz'] });
    const ctx = ctxOf('https://mega.nz/file/AbCdEf#key');
    await onResolve(ctx, { providers: [tb] });
    assert.equal(ctx.res.files[0].req.url, 'https://dl.torbox.example/1/Some.File.mkv');
  });
});

describe('onResolve: magnets', () => {
  const FILES = [
    { name: 'E01.mkv', size: 100, url: 'https://dl.torbox.example/t/E01.mkv', headers: {} },
    { name: 'E02.mkv', size: 200, url: 'https://dl.torbox.example/t/E02.mkv', headers: {} },
  ];

  test('a cached magnet becomes a multi-file ctx.res named after the torrent', async () => {
    const fake = setup();
    const tb = stub('torbox', { magnet: FILES });
    const rd = stub('realdebrid', { magnet: [FILES[0]] });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(rd.calls.length, 0);
    assert.deepEqual(tb.calls, [['cachedMagnet', MAGNET]]);
    assert.deepEqual(ctx.res, {
      name: 'Cached.Show.S01',
      files: FILES.map((f) => ({ name: f.name, size: f.size, req: { url: f.url, extra: { header: {} } } })),
    });
    const rec = await recall('orig:https://dl.torbox.example/t/E02.mkv');
    assert.equal(rec.original, MAGNET);
    assert.equal(rec.provider, 'torbox');
    assert.equal(rec.file, 'E02.mkv');
    assert.equal(rec.size, 200);
    const info = fake.logs.filter((l) => l.level === 'info');
    assert.equal(info.length, 1);
    assert.doesNotMatch(info[0].msg, new RegExp(HASH));
  });

  test('without dn the torrent is named by its hash', async () => {
    setup();
    const ctx = ctxOf(`magnet:?xt=urn:btih:${HASH}`);
    await onResolve(ctx, { providers: [stub('torbox', { magnet: FILES })] });
    assert.equal(ctx.res.name, HASH);
  });

  test('the first non-null answer wins, in order, and only debrid providers are asked', async () => {
    setup({ order: 'rapideo,onefichier,torbox,realdebrid', rapideo_enabled: true, onefichier_enabled: true });
    const rp = stub('rapideo', { kind: 'multihoster', magnet: FILES });
    const of = stub('onefichier', { kind: 'hoster', magnet: FILES });
    const tb = stub('torbox');
    const rd = stub('realdebrid', { magnet: [FILES[1]] });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb, rd, rp, of] });
    assert.equal(rp.calls.length + of.calls.length, 0);
    assert.equal(tb.calls.length, 1);
    assert.equal(ctx.res.files.length, 1);
    assert.equal(ctx.res.files[0].name, 'E02.mkv');
  });

  test('an uncached magnet with the label cached-or-refuse throws RT16_NOT_CACHED', async () => {
    const fake = setup();
    const tb = stub('torbox');
    const rd = stub('realdebrid');
    const ctx = ctxOf(MAGNET, { [LABEL]: 'cached-or-refuse' });
    await rejectsMessage(fake, onResolve(ctx, { providers: [tb, rd] }), 'RT16_NOT_CACHED');
    assert.equal(tb.calls.length, 1);
    assert.equal(rd.calls.length, 1);
  });

  test('an uncached magnet without the label leaves ctx.res unset', async () => {
    setup();
    for (const labels of [undefined, {}, { [LABEL]: 'something-else' }]) {
      const ctx = ctxOf(MAGNET, labels);
      await onResolve(ctx, { providers: [stub('torbox'), stub('realdebrid')] });
      assert.equal(ctx.res, undefined);
    }
  });

  test('magnets_via_debrid=false: magnets are never tried', async () => {
    const fake = setup({ magnets_via_debrid: false });
    const tb = stub('torbox', { magnet: FILES });
    let ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    assert.equal(ctx.res, undefined);
    // with the label, nothing was tried, so nothing is cached: the shim keeps the magnet on rtorrent
    ctx = ctxOf(MAGNET, { [LABEL]: 'cached-or-refuse' });
    await rejectsMessage(fake, onResolve(ctx, { providers: [tb] }), 'RT16_NOT_CACHED');
    assert.equal(tb.calls.length, 0);
  });

  test('a .torrent URL is not a magnet: it goes through the link path', async () => {
    setup();
    const tb = stub('torbox', { magnet: FILES });
    const ctx = ctxOf('https://tracker.example/file.torrent', { [LABEL]: 'cached-or-refuse' });
    await onResolve(ctx, { providers: [tb] });
    assert.equal(ctx.res, undefined);
    assert.equal(tb.calls.length, 0);
  });

  test('an auth error on a magnet is shown and stops; the device prompt reaches the user', async () => {
    const fake = setup({ order: 'realdebrid,torbox', realdebrid_token: '' });
    const text = 'open https://real-debrid.com/device and enter ABCD1234, then add the link again (the code is valid for 10 minutes)';
    const rd = stub('realdebrid', { magnet: () => { throw fail('realdebrid', 'login_required', text); } });
    const tb = stub('torbox', { magnet: FILES });
    await rejectsMessage(fake, onResolve(ctxOf(MAGNET, { [LABEL]: 'cached-or-refuse' }), { providers: [tb, rd] }), `Real-Debrid: ${text}`);
    assert.equal(tb.calls.length, 0);
  });

  test('any other error on a magnet tries the next provider, and counts as not cached at the end', async () => {
    const fake = setup();
    const tb = stub('torbox', { magnet: () => { throw fail('torbox', 'service_down', 'the service is down (HTTP 502)'); } });
    const rd = stub('realdebrid', { magnet: FILES });
    let ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb, rd] });
    assert.equal(ctx.res.files.length, 2);
    const rd2 = stub('realdebrid', { magnet: () => { throw fail('realdebrid', 'not_ready', 'not ready'); } });
    ctx = ctxOf(MAGNET, { [LABEL]: 'cached-or-refuse' });
    await rejectsMessage(fake, onResolve(ctx, { providers: [tb, rd2] }), 'RT16_NOT_CACHED');
    ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb, rd2] });
    assert.equal(ctx.res, undefined);
    assert.ok(fake.logs.some((l) => l.level === 'warn' && /TorBox: the service is down/.test(l.msg)));
  });
});

describe('onError: renewal of an expired link', () => {
  async function resolved(providers) {
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers });
    return ctx.res.files[0].req.url;
  }

  for (const [label, error] of [
    ['a Go error object', { Error: () => 'http request fail, code:403' }],
    ['a string', 'http request fail, code:404'],
    ['an object with message', { message: 'http request fail, code:410' }],
  ]) {
    test(`a 403/404/410 (${label}) on a remembered URL sets a fresh one, then continues`, async () => {
      setup();
      const tb = stub('torbox');
      const url = await resolved([tb]);
      const task = taskOf(url);
      await onError({ task, error }, { providers: [tb] });
      assert.deepEqual(task.setUrls, ['https://dl.torbox.example/2/Some.File.mkv']);
      assert.equal(task.continued, 1);
      assert.deepEqual(tb.calls.map((c) => c[1]), [RG, RG]);
      // the fresh URL is remembered too, for the next expiry
      const rec = await recall('orig:https://dl.torbox.example/2/Some.File.mkv');
      assert.equal(rec.original, RG);
    });
  }

  test('the renewal uses the current order and settings', async () => {
    const fake = setup();
    const tb = stub('torbox');
    const rd = stub('realdebrid');
    const url = await resolved([tb, rd]);
    fake.settings.torbox_enabled = false;
    const task = taskOf(url);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb, rd] });
    assert.deepEqual(task.setUrls, ['https://dl.realdebrid.example/1/Some.File.mkv']);
  });

  test('a URL the extension did not hand out is left alone', async () => {
    setup();
    const tb = stub('torbox');
    const task = taskOf(PLAIN);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(tb.calls.length, 0);
    assert.equal(task.continued, 0);
  });

  for (const error of ['http request fail, code:500', 'http request fail, code:4030', 'connection reset', undefined]) {
    test(`an error without 403/404/410 (${error}) is left alone`, async () => {
      setup();
      const tb = stub('torbox');
      const url = await resolved([tb]);
      const task = taskOf(url);
      await onError({ task, error }, { providers: [tb] });
      assert.equal(tb.calls.length, 1);
      assert.equal(task.setUrls.length + task.continued, 0);
    });
  }

  test(`at most ${3} renewals per task: the fourth is refused`, async () => {
    const fake = setup();
    assert.equal(MAX_RENEWALS, 3);
    const tb = stub('torbox');
    const task = taskOf(await resolved([tb]), 'task-42');
    for (let i = 0; i < 3; i++) await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length, 3);
    assert.equal(task.continued, 3);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length, 3);
    assert.equal(task.continued, 3);
    assert.equal(tb.calls.length, 4);
    assert.equal(await recall('renewed:task-42'), 3);
    assert.ok(fake.logs.some((l) => /3 renewals/.test(l.msg)));
    // another task has its own count
    const other = taskOf(task.meta.req.url, 'task-43');
    await onError({ task: other, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(other.continued, 1);
  });

  test('a renewal that fails is logged, redacted, and neither sets a URL nor continues', async () => {
    const fake = setup();
    let n = 0;
    const tb = stub('torbox', { link: () => { n++; if (n > 1) throw fail('torbox', 'dead_link', `gone ${KEYS.torbox}`, []); return { name: 'a', size: 1, url: 'https://dl.example/a', headers: {} }; } });
    const task = taskOf(await resolved([tb]));
    await onError({ task, error: 'http request fail, code:410' }, { providers: [tb] });
    assert.equal(task.setUrls.length + task.continued, 0);
    const warn = fake.logs.filter((l) => l.level === 'warn').map((l) => l.msg).join('\n');
    assert.match(warn, /TorBox: gone ••••/);
    assert.ok(!warn.includes(KEYS.torbox));
  });

  test('a renewal that finds no provider any more changes nothing', async () => {
    const fake = setup();
    const tb = stub('torbox');
    const task = taskOf(await resolved([tb]));
    fake.settings.torbox_enabled = false;
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length + task.continued, 0);
  });

  test('a file of a magnet is renewed by asking for the magnet again and taking the same file', async () => {
    setup();
    let round = 0;
    const tb = stub('torbox', {
      magnet: () => {
        round++;
        return [
          { name: 'E01.mkv', size: 1, url: `https://dl.torbox.example/${round}/E01.mkv`, headers: {} },
          { name: 'E02.mkv', size: 2, url: `https://dl.torbox.example/${round}/E02.mkv`, headers: {} },
        ];
      },
    });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    const task = taskOf(ctx.res.files[1].req.url);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.deepEqual(task.setUrls, ['https://dl.torbox.example/2/E02.mkv']);
    assert.equal(task.continued, 1);
    const rec = await recall('orig:https://dl.torbox.example/2/E02.mkv');
    assert.equal(rec.original, MAGNET);
    assert.equal(rec.file, 'E02.mkv');
  });

  test('the name wins over the position when the provider lists the files in another order', async () => {
    setup();
    let round = 0;
    const tb = stub('torbox', {
      magnet: () => {
        round++;
        const files = [
          { name: 'E01.mkv', size: 1, url: `https://dl.torbox.example/${round}/E01.mkv`, headers: {} },
          { name: 'E02.mkv', size: 2, url: `https://dl.torbox.example/${round}/E02.mkv`, headers: {} },
        ];
        return round === 1 ? files : files.reverse();
      },
    });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    const task = taskOf(ctx.res.files[1].req.url);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.deepEqual(task.setUrls, ['https://dl.torbox.example/2/E02.mkv']);
    assert.equal((await recall('orig:https://dl.torbox.example/2/E02.mkv')).size, 2);
  });

  test('a magnet file with no match by name and size is never renewed by its position', async () => {
    setup();
    let round = 0;
    const tb = stub('torbox', {
      magnet: () => {
        round++;
        return [{ name: `a${round}`, size: 1, url: `https://dl.example/${round}/a`, headers: {} }, { name: `b${round}`, size: 1, url: `https://dl.example/${round}/b`, headers: {} }];
      },
    });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    const task = taskOf(ctx.res.files[1].req.url);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length + task.continued, 0);
  });

  test('the same name with another size is a different file: not renewed', async () => {
    const fake = setup();
    let round = 0;
    const tb = stub('torbox', { magnet: () => [{ name: 'E01.mkv', size: ++round === 1 ? 100 : 101, url: `https://dl.example/${round}/E01.mkv`, headers: {} }] });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    const task = taskOf(ctx.res.files[0].req.url);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length + task.continued, 0);
    assert.ok(fake.logs.some((l) => /same name and size/.test(l.msg)));
  });

  test('the files of one pack share one resolve for 5 minutes', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 2, 18) });
    setup();
    let round = 0;
    const tb = stub('torbox', {
      magnet: () => {
        round++;
        return ['E01.mkv', 'E02.mkv', 'E03.mkv'].map((n, i) => ({ name: n, size: i + 1, url: `https://dl.torbox.example/${round}/${n}`, headers: {} }));
      },
    });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    const tasks = ctx.res.files.map((f) => taskOf(f.req.url));
    for (const task of tasks) await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.deepEqual(tasks.map((task) => task.setUrls[0]), ['E01.mkv', 'E02.mkv', 'E03.mkv'].map((n) => `https://dl.torbox.example/2/${n}`));
    assert.equal(tb.calls.length, 2, 'one resolve for onResolve, one for the three renewals');
    // the kept link of E02 fails again: the providers are asked again, not the 5-minute list
    await onError({ task: tasks[1], error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(tasks[1].setUrls[1], 'https://dl.torbox.example/3/E02.mkv');
    assert.equal(tb.calls.length, 3);
    // after 5 minutes the list is gone
    t.mock.timers.tick(5 * MIN + 1);
    await onError({ task: tasks[0], error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(tb.calls.length, 4);
  });

  test('a magnet that is no longer cached is not renewed', async () => {
    setup();
    let round = 0;
    const tb = stub('torbox', { magnet: () => (++round === 1 ? [{ name: 'a', size: 1, url: 'https://dl.example/a', headers: {} }] : null) });
    const ctx = ctxOf(MAGNET);
    await onResolve(ctx, { providers: [tb] });
    const task = taskOf(ctx.res.files[0].req.url);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length + task.continued, 0);
  });
});

describe('onStart: refresh before the download starts', () => {
  test('a link older than half its lifetime is unrestricted again before the start', async () => {
    const fake = setup();
    const tb = stub('torbox', { ttl: HOUR });
    const old = 'https://dl.torbox.example/old/Some.File.mkv';
    await remember(`orig:${old}`, { original: RG, provider: 'torbox', at: Date.now() - 31 * MIN }, 7 * DAY);
    const task = taskOf(old);
    await onStart({ task }, { providers: [tb] });
    assert.deepEqual(task.setUrls, ['https://dl.torbox.example/1/Some.File.mkv']);
    assert.equal(task.continued, 0);
    assert.ok(await recall('orig:https://dl.torbox.example/1/Some.File.mkv'));
    assert.ok(fake.logs.some((l) => l.level === 'info' && /TorBox/.test(l.msg)));
  });

  test('a fresh link is left alone', async () => {
    setup();
    const tb = stub('torbox', { ttl: HOUR });
    const url = 'https://dl.torbox.example/new/Some.File.mkv';
    await remember(`orig:${url}`, { original: RG, provider: 'torbox', at: Date.now() - 29 * MIN }, 7 * DAY);
    const task = taskOf(url);
    await onStart({ task }, { providers: [tb] });
    assert.equal(task.setUrls.length, 0);
    assert.equal(tb.calls.length, 0);
  });

  test("the provider's own lifetime decides: 1fichier after 2.5 minutes", async () => {
    setup({ onefichier_enabled: true });
    const of = stub('onefichier', { kind: 'hoster', hosts: ['1fichier.com'], ttl: 5 * MIN });
    const url = 'https://a-1.1fichier.com/c123';
    await remember(`orig:${url}`, { original: FICHIER, provider: 'onefichier', at: Date.now() - 3 * MIN }, 7 * DAY);
    const task = taskOf(url);
    await onStart({ task }, { providers: [of] });
    assert.equal(task.setUrls.length, 1);
  });

  test('an unknown URL costs one storage read and nothing else', async () => {
    const fake = setup();
    const tb = stub('torbox');
    const io = [];
    for (const op of ['get', 'set', 'remove', 'keys']) {
      const real = fake.storage[op];
      fake.storage[op] = (...a) => { io.push(op); return real(...a); };
    }
    const task = taskOf(PLAIN);
    await onStart({ task }, { providers: [tb] });
    assert.deepEqual(io, ['get']);
    assert.equal(tb.calls.length, 0);
    assert.equal(task.setUrls.length, 0);
  });

  test('a failed refresh never throws: the download starts with the old link', async () => {
    const fake = setup();
    const tb = stub('torbox', { ttl: HOUR, link: () => { throw fail('torbox', 'auth_invalid', 'invalid API key'); } });
    const old = 'https://dl.torbox.example/old/x';
    await remember(`orig:${old}`, { original: RG, provider: 'torbox', at: Date.now() - 2 * HOUR }, 7 * DAY);
    const task = taskOf(old);
    await onStart({ task }, { providers: [tb] });
    assert.equal(task.setUrls.length, 0);
    assert.ok(fake.logs.some((l) => l.level === 'warn' && /TorBox: invalid API key/.test(l.msg)));
  });
});

describe('secrets', () => {
  test('no thrown message holds a configured secret, whatever the provider puts in its error', async () => {
    const fake = setup({ onefichier_enabled: true, onefichier_apikey: KEYS.onefichier, rapideo_enabled: true, rapideo_password: 'FAKE-PASS word' });
    const echo = `${KEYS.torbox} ${encodeURIComponent(KEYS.realdebrid)} ${KEYS.onefichier} FAKE-PASS+word`;
    for (const code of ['auth_invalid', 'dead_link', 'login_required', 'limit_reached']) {
      const tb = stub('torbox', { link: () => { throw fail('torbox', code, `refused ${echo}`); }, magnet: () => { throw fail('torbox', code, `refused ${echo}`); } });
      const err = await rejectsMessage(fake, onResolve(ctxOf(RG), { providers: [tb] }));
      assert.ok(!/FAKE/.test(err.message), err.message);
      if (code === 'auth_invalid' || code === 'login_required') {
        const m = await rejectsMessage(fake, onResolve(ctxOf(MAGNET), { providers: [tb] }));
        assert.ok(!/FAKE/.test(m.message), m.message);
      } else {
        // on a magnet these are logged, not thrown: the log lines are checked below
        await onResolve(ctxOf(MAGNET), { providers: [tb] });
      }
    }
    for (const l of fake.logs) assert.ok(!/FAKE/.test(l.msg), l.msg);
  });
});

describe('index.js', () => {
  test('registers onResolve, onStart and onError', async () => {
    const fake = setup();
    await import(`../src/index.js?fresh=${Date.now()}`);
    assert.equal(typeof fake.hooks.onResolve, 'function');
    assert.equal(typeof fake.hooks.onStart, 'function');
    assert.equal(typeof fake.hooks.onError, 'function');
  });

  test('the manifest runs dist/index.js for onResolve, onStart and onError on every http(s) URL', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    for (const event of ['onResolve', 'onStart', 'onError']) {
      const script = manifest.scripts.find((s) => s.event === event);
      assert.ok(script, event);
      assert.equal(script.entry, 'dist/index.js');
      assert.ok(script.match.urls.includes('*://*/*'), event);
    }
  });
});

describe('end to end with the real Real-Debrid provider', () => {
  const RD = 'https://api.real-debrid.com';
  const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/realdebrid/${name}.json`, import.meta.url), 'utf8'));

  function rdSetup() {
    const fake = installFakeGopeed({ settings: { order: 'realdebrid', realdebrid_enabled: true, realdebrid_token: KEYS.realdebrid } });
    let n = 0;
    fake.route('GET', `${RD}/rest/1.0/hosts/domains`, () => ({ status: 200, json: fx('hosts-domains') }));
    fake.route('POST', `${RD}/rest/1.0/unrestrict/link`, () => {
      n++;
      const body = fx('unrestrict-link');
      body.download = body.download.replace('RDLINK0001', `RDLINK000${n}`);
      return { status: 200, json: body };
    });
    return fake;
  }

  test('a Rapidgator link resolves through Real-Debrid, and a 403 later renews it', async () => {
    const fake = rdSetup();
    const ctx = ctxOf(RG);
    await onResolve(ctx);
    assert.equal(ctx.res.name, 'Some.File.mkv');
    assert.equal(ctx.res.files[0].size, 734003200);
    assert.equal(ctx.res.files[0].req.url, 'https://fake-dl.real-debrid.com/d/RDLINK0001/Some.File.mkv');
    assert.equal(fake.callsTo(`${RD}/rest/1.0/unrestrict/link`)[0].form.link, RG);

    const task = taskOf(ctx.res.files[0].req.url);
    await onError({ task, error: { Error: () => 'http request fail, code:403' } });
    assert.deepEqual(task.setUrls, ['https://fake-dl.real-debrid.com/d/RDLINK0002/Some.File.mkv']);
    assert.equal(task.continued, 1);
    assert.equal(fake.callsTo(`${RD}/rest/1.0/unrestrict/link`).length, 2);
  });

  test('a refused Real-Debrid token is shown without the token', async () => {
    const fake = installFakeGopeed({ settings: { order: 'realdebrid', realdebrid_enabled: true, realdebrid_token: KEYS.realdebrid } });
    fake.route('GET', `${RD}/rest/1.0/hosts/domains`, () => ({ status: 200, json: fx('hosts-domains') }));
    fake.route('POST', `${RD}/rest/1.0/unrestrict/link`, () => ({ status: 401, json: { error: `bad_token ${KEYS.realdebrid}`, error_code: 8 } }));
    const err = await rejectsMessage(fake, onResolve(ctxOf(RG)), /^Real-Debrid: /);
    assert.ok(!err.message.includes(KEYS.realdebrid));
  });
});

// Lets pending promises run, then moves the mocked clock, until the promise settles.
async function drive(t, promise, step = 500, limit = 400) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < limit && !settled; i++) {
    for (let j = 0; j < 5; j++) await new Promise((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(step);
  }
  return promise;
}

describe('host lists: an ordinary link waits for one round at most', () => {
  const T0 = Date.UTC(2026, 9, 2, 18);
  const IDS = ['torbox', 'alldebrid', 'premiumize', 'realdebrid'];

  function hanging() {
    const asked = {};
    const providers = IDS.map((id) => stub(id, { hosts: () => { asked[id] = (asked[id] || 0) + 1; return new Promise(() => {}); } }));
    return { asked, providers };
  }

  test('four providers whose lists never answer cost one 10 s round, then nothing for 10 minutes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = setup({ alldebrid_enabled: true, premiumize_enabled: true });
    const { asked, providers } = hanging();
    let ctx = ctxOf(PLAIN);
    await drive(t, onResolve(ctx, { providers }));
    assert.equal(ctx.res, undefined);
    assert.ok(Date.now() - T0 <= HOSTS_ROUND_MS, `waited ${Date.now() - T0} ms`);
    assert.equal(HOSTS_ROUND_MS, 10 * 1000);
    assert.deepEqual(asked, { torbox: 1, alldebrid: 1, premiumize: 1, realdebrid: 1 });
    assert.equal(fake.logs.filter((l) => l.level === 'warn' && /claims no link for 10 minutes/.test(l.msg)).length, 4);

    // the next ordinary link asks no list and waits for nothing
    const t1 = Date.now();
    ctx = ctxOf('https://example.org/other.iso');
    await drive(t, onResolve(ctx, { providers }));
    assert.equal(Date.now(), t1);
    assert.deepEqual(asked, { torbox: 1, alldebrid: 1, premiumize: 1, realdebrid: 1 });

    // a hoster link is not claimed by them either during the pause
    ctx = ctxOf(RG);
    await drive(t, onResolve(ctx, { providers }));
    assert.equal(ctx.res, undefined);
    assert.equal(providers.reduce((n, p) => n + p.calls.length, 0), 0);

    // after 10 minutes they are asked again, not before
    assert.equal(HOSTS_FAIL_MS, 10 * MIN);
    t.mock.timers.tick(HOSTS_FAIL_MS - 1);
    await drive(t, onResolve(ctxOf(PLAIN), { providers }));
    assert.deepEqual(asked, { torbox: 1, alldebrid: 1, premiumize: 1, realdebrid: 1 });
    t.mock.timers.tick(1);
    await drive(t, onResolve(ctxOf(PLAIN), { providers }));
    assert.deepEqual(asked, { torbox: 2, alldebrid: 2, premiumize: 2, realdebrid: 2 });
  });

  test('a list that throws or loads empty is paused too', async () => {
    setup();
    let n = 0;
    const tb = stub('torbox', { hosts: () => { n++; throw new Error('boom'); } });
    let m = 0;
    const rd = stub('realdebrid', { hosts: () => { m++; return []; } });
    await onResolve(ctxOf(PLAIN), { providers: [tb, rd] });
    await onResolve(ctxOf(PLAIN), { providers: [tb, rd] });
    assert.equal(n, 1);
    assert.equal(m, 1);
    assert.equal(typeof (await recall('hostsfail:torbox')).h, 'string');
    assert.equal(typeof (await recall('hostsfail:realdebrid')).h, 'string');
    assert.ok(!JSON.stringify([...globalThis.gopeed.storage.map.values()]).includes(KEYS.torbox), 'the key is not stored');
  });

  test('during the pause a hoster account still claims its own domains', async () => {
    setup({ onefichier_enabled: true, onefichier_apikey: KEYS.onefichier });
    let n = 0;
    const of = stub('onefichier', { kind: 'hoster', hosts: () => (++n === 1 ? [] : ['1fichier.com']) });
    await onResolve(ctxOf(PLAIN), { providers: [of] });
    assert.ok(await recall('hostsfail:onefichier'), 'the empty list started the pause');
    const ctx = ctxOf(FICHIER);
    await onResolve(ctx, { providers: [of] });
    assert.equal(n, 2);
    assert.equal(ctx.res.files[0].req.url, 'https://dl.onefichier.example/1/Some.File.mkv');
  });

  test('a changed key, login or API base ends the pause at once', async () => {
    const fake = setup({ alldebrid_enabled: true, alldebrid_apikey: 'FAKE-WRONG-KEY-0001' });
    let n = 0;
    const ad = stub('alldebrid', { hosts: () => { n++; if (globalThis.gopeed.settings.alldebrid_apikey.includes('WRONG')) throw fail('alldebrid', 'cooldown', 'invalid API key'); return ['rapidgator.net']; } });
    await onResolve(ctxOf(PLAIN), { providers: [ad] });
    await onResolve(ctxOf(PLAIN), { providers: [ad] });
    assert.equal(n, 1, 'paused with the wrong key');
    fake.settings.alldebrid_apikey = 'FAKE-RIGHT-KEY-0002';
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [ad] });
    assert.equal(n, 2, 'the host list is asked at once after the key changed');
    assert.equal(ctx.res.files[0].req.url, 'https://dl.alldebrid.example/1/Some.File.mkv');
    // a login or the API base counts too; the switch does not
    for (const [k, v] of [['alldebrid_login', 'x'], ['advanced_api_base', 'http://mock.invalid']]) {
      ad.hosts = async () => { n++; throw new Error('down'); };
      await onResolve(ctxOf(PLAIN), { providers: [ad] });
      const paused = n;
      await onResolve(ctxOf(PLAIN), { providers: [ad] });
      assert.equal(n, paused, 'paused');
      fake.settings[k] = v;
      await onResolve(ctxOf(PLAIN), { providers: [ad] });
      assert.equal(n, paused + 1, `${k} ends the pause`);
    }
    // the on/off switch is not part of the hash
    fake.settings.alldebrid_enabled = 'yes';
    const still = n;
    await onResolve(ctxOf(PLAIN), { providers: [ad] });
    assert.equal(n, still);
  });

  test('a host list that cannot be stored is still used (real provider, storage writes throw)', async () => {
    const fake = installFakeGopeed({ settings: { order: 'realdebrid', realdebrid_enabled: true, realdebrid_token: KEYS.realdebrid } });
    const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/realdebrid/${name}.json`, import.meta.url), 'utf8'));
    fake.route('GET', 'https://api.real-debrid.com/rest/1.0/hosts/domains', () => ({ status: 200, json: fx('hosts-domains') }));
    fake.route('POST', 'https://api.real-debrid.com/rest/1.0/unrestrict/link', () => ({ status: 200, json: fx('unrestrict-link') }));
    fake.storage.set = async () => { throw new Error('disk full'); };
    const ctx = ctxOf(RG);
    await onResolve(ctx);
    assert.equal(ctx.res.files[0].req.url, 'https://fake-dl.real-debrid.com/d/RDLINK0001/Some.File.mkv');
    assert.ok(fake.logs.some((l) => l.level === 'warn' && /hosts:realdebrid could not be stored: disk full/.test(l.msg)));
  });

  test('the lists load at the same time: one slow list does not delay the others', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    setup();
    const started = [];
    const slow = (id) => () => { started.push([id, Date.now() - T0]); return new Promise((resolve) => setTimeout(() => resolve(['rapidgator.net']), 3000)); };
    const tb = stub('torbox', { hosts: slow('torbox') });
    const rd = stub('realdebrid', { hosts: slow('realdebrid') });
    const ctx = ctxOf(RG);
    await drive(t, onResolve(ctx, { providers: [tb, rd] }));
    assert.deepEqual(started, [['torbox', 0], ['realdebrid', 0]]);
    assert.ok(Date.now() - T0 <= 3500, `waited ${Date.now() - T0} ms`);
    assert.equal(ctx.res.files[0].req.url, 'https://dl.torbox.example/1/Some.File.mkv');
  });

  test('every provider that loads a list over the network gives up after 10 s', async (t) => {
    const creds = {
      torbox_apikey: 'K1', alldebrid_apikey: 'K2', premiumize_apikey: 'K3', realdebrid_token: 'K4', debridlink_apikey: 'K5',
      rapideo_login: 'u', rapideo_password: 'p', nopremium_login: 'u', nopremium_password: 'p', twojlimit_login: 'u', twojlimit_password: 'p',
    };
    const networked = PROVIDERS.filter((p) => p.kind !== 'hoster');
    assert.equal(networked.length, 8);
    for (const p of networked) {
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
      const fake = installFakeGopeed({ settings: { ...creds, [`${p.id}_enabled`]: true } });
      fake.route('*', 'https://', () => new Promise(() => {}));
      let outcome = null;
      p.hosts(providerSettings(p.id)).then(() => { outcome = 'resolved'; }, (e) => { outcome = e; });
      for (let j = 0; j < 10; j++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fake.calls.length, 1, p.id);
      t.mock.timers.tick(9999);
      for (let j = 0; j < 10; j++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(outcome, null, `${p.id} gave up before 10 s`);
      t.mock.timers.tick(1);
      for (let j = 0; j < 10; j++) await new Promise((resolve) => setImmediate(resolve));
      assert.ok(outcome && outcome.code === 'timeout', `${p.id}: ${outcome && outcome.message}`);
    }
  });
});

describe('storage', () => {
  const T0 = Date.UTC(2026, 9, 2, 18);
  const put = (fake, key, exp) => fake.storage.map.set(key, JSON.stringify({ v: { original: RG }, exp }));

  test('expired orig:, renewed: and the other own records are swept once a day', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = setup();
    put(fake, 'orig:https://dl.example/old', T0 - 1);
    put(fake, 'renewed:task-old', T0 - 1);
    put(fake, 'magnetfiles:abc', T0 - 1);
    put(fake, 'hostsfail:torbox', T0 - 1);
    put(fake, 'orig:https://dl.example/fresh', T0 + 2 * DAY);
    fake.storage.map.set('orig:https://dl.example/corrupt', 'not json');
    put(fake, 'hosts:torbox', T0 - 1); // not ours to sweep: read through cached() as usual
    put(fake, 'rd:auth', T0 - 1);
    await onResolve(ctxOf(PLAIN), { providers: [] });
    assert.deepEqual([...fake.storage.map.keys()].filter((k) => k !== 'sweep:at').sort(),
      ['hosts:torbox', 'orig:https://dl.example/fresh', 'rd:auth']);
    assert.ok(fake.storage.map.has('sweep:at'));

    // within the day: no second sweep
    put(fake, 'orig:https://dl.example/later', T0 - 1);
    t.mock.timers.tick(SWEEP_EVERY_MS - 1);
    await onResolve(ctxOf(PLAIN), { providers: [] });
    assert.ok(fake.storage.map.has('orig:https://dl.example/later'));

    // a day later, onError sweeps as well
    t.mock.timers.tick(1);
    await onError({ task: taskOf(PLAIN), error: 'http request fail, code:403' }, { providers: [] });
    assert.ok(!fake.storage.map.has('orig:https://dl.example/later'));
    assert.ok(fake.storage.map.has('orig:https://dl.example/fresh'));
  });

  test('a storage write that throws during resolve still hands out the direct link', async () => {
    const fake = setup();
    fake.storage.set = async () => { throw new Error('disk full'); };
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [stub('torbox')] });
    assert.equal(ctx.res.files[0].req.url, 'https://dl.torbox.example/1/Some.File.mkv');
    assert.ok(fake.logs.some((l) => l.level === 'warn' && /cannot be renewed: disk full/.test(l.msg)));
    const mctx = ctxOf(MAGNET, { [LABEL]: 'cached-or-refuse' });
    await onResolve(mctx, { providers: [stub('torbox', { magnet: [{ name: 'a', size: 1, url: 'https://dl.example/a', headers: {} }] })] });
    assert.equal(mctx.res.files.length, 1);
  });

  test('storage that silently keeps no write allows no renewal at all', async () => {
    const fake = setup();
    const tb = stub('torbox');
    const url = 'https://dl.torbox.example/0/Some.File.mkv';
    put(fake, `orig:${url}`, Date.now() + DAY);
    fake.storage.set = async () => {};
    const task = taskOf(url);
    for (let i = 0; i < 5; i++) await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.setUrls.length + task.continued, 0);
    assert.equal(tb.calls.length, 0);
    assert.ok(fake.logs.some((l) => /does not keep the renewal count/.test(l.msg)));
  });

  test('a lost counter is backed by the count in memory: still no fourth renewal', async () => {
    const fake = setup();
    const tb = stub('torbox');
    const ctx = ctxOf(RG);
    await onResolve(ctx, { providers: [tb] });
    const task = taskOf(ctx.res.files[0].req.url);
    for (let i = 0; i < 3; i++) await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.continued, 3);
    fake.storage.map.delete(`renewed:${task.id}`);
    await onError({ task, error: 'http request fail, code:403' }, { providers: [tb] });
    assert.equal(task.continued, 3);
  });
});
