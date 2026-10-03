// The five debrid providers and the registry, against fixtures copied in shape from each service's API docs.
//
// Every provider gets the same checks: the auth it sends, the response mapping, null for a link it does not claim,
// the cache check of magnets (and that a probe leaves nothing behind), the errors a user sees, and the 24 h host
// list cache. The credentials are obvious fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeGopeed } from './fake-gopeed.js';
import { ProviderError } from '../src/lib/http.js';
import { providerSettings } from '../src/lib/settings.js';
import { PROVIDERS } from '../src/providers/index.js';
import torbox from '../src/providers/torbox.js';
import realdebrid from '../src/providers/realdebrid.js';
import debridlink from '../src/providers/debridlink.js';
import alldebrid from '../src/providers/alldebrid.js';
import premiumize from '../src/providers/premiumize.js';

const TB = 'https://api.torbox.app';
const RD = 'https://api.real-debrid.com';
const DL = 'https://debrid-link.com';
const AD = 'https://api.alldebrid.com';
const PM = 'https://www.premiumize.me';

const KEYS = {
  torbox: 'FAKE-TORBOX-KEY-0001',
  alldebrid: 'FAKE-ALLDEBRID-KEY-0001',
  premiumize: 'FAKE-PREMIUMIZE-KEY-0001',
  realdebrid: 'FAKE-RD-TOKEN-0001',
  debridlink: 'FAKE-DEBRIDLINK-KEY-0001',
};
const CRED = { torbox: 'apikey', alldebrid: 'apikey', premiumize: 'apikey', realdebrid: 'token', debridlink: 'apikey' };

const RG = 'https://rapidgator.net/file/abc123/Some.File.mkv.html';
const FICHIER = 'https://1fichier.com/?abc123def456';
const OTHER = 'https://example.com/files/plain.bin';
const CACHED = 'c0ffee1234567890abcdef1234567890abcdef12';
const UNCACHED = 'dead00beef1234567890abcdef1234567890abcd';
const magnet = (hash, name = 'Cached.Show.S01') =>
  `magnet:?xt=urn:btih:${hash}&dn=${name}&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce`;
const MASK = '••••';
const T0 = Date.UTC(2026, 9, 2, 18, 0, 0);
const MIN = 60 * 1000;

const fx = (id, name) => JSON.parse(readFileSync(new URL(`./fixtures/${id}/${name}.json`, import.meta.url), 'utf8'));
const ok = (json) => () => ({ status: 200, json });
const status = (code, json) => () => ({ status: code, json });

function setup(id, extra = {}) {
  return installFakeGopeed({
    settings: { [`${id}_enabled`]: true, [`${id}_${CRED[id]}`]: KEYS[id], ...extra },
  });
}

// Runs a promise whose code sleeps on (mocked) setTimeout: it lets the pending microtasks run, then moves the clock.
async function drive(t, promise, step = 500, limit = 2000) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < limit && !settled; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(step);
  }
  return promise;
}

function noSecret(value, secret) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(secret), `"${secret}" leaked into: ${text}`);
  assert.ok(!text.includes(encodeURIComponent(secret)), `"${secret}" leaked (encoded) into: ${text}`);
}

async function rejectsWith(promise, code, pattern, secret) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ProviderError, `not a ProviderError: ${err && err.stack}`);
    assert.equal(err.code, code, `code of "${err.message}"`);
    assert.match(err.message, pattern);
    if (secret) noSecret({ message: err.message, reason: err.reason, body: err.body, code: err.code, stack: err.stack }, secret);
    return true;
  });
}

const HOSTS = {
  torbox: { url: `${TB}/v1/api/webdl/hosters`, body: fx('torbox', 'hosters'), claims: [RG, 'https://rg.to/file/xyz'], refuses: ['https://clicknupload.com/abc'] },
  realdebrid: { url: `${RD}/rest/1.0/hosts/domains`, body: fx('realdebrid', 'hosts-domains'), claims: [RG, 'https://www.rg.to/file/x'], refuses: [] },
  debridlink: { url: `${DL}/api/v2/downloader/hosts`, body: fx('debridlink', 'hosts'), claims: [RG, FICHIER], refuses: ['https://uploaded.net/file/x'] },
  // AllDebrid's own list is per account (v4.1 user/hosts), so this call is the one host list that sends the key.
  alldebrid: { url: `${AD}/v4.1/user/hosts`, body: fx('alldebrid', 'user-hosts'), claims: [RG, 'https://alterupload.com/x'], refuses: ['https://uploaded.net/file/x', 'https://adf.ly/x'], auth: true },
  premiumize: { url: `${PM}/api/services/list`, body: fx('premiumize', 'services-list'), claims: [FICHIER, 'https://alterupload.com/x', 'https://turbo.to/x'], refuses: [RG] },
};
const MODULES = { torbox, realdebrid, debridlink, alldebrid, premiumize };
const EMPTY_LIST = { torbox: { data: [] }, realdebrid: [], debridlink: { success: true, value: [] }, alldebrid: { status: 'success', data: { hosts: {} } }, premiumize: { status: 'success', directdl: [] } };
// The first call of unrestrict() after the claim, for the tests that need any provider to fail the same way.
const FIRST_CALL = {
  torbox: { url: `${TB}/v1/api/webdl/createwebdownload`, link: RG },
  realdebrid: { url: `${RD}/rest/1.0/unrestrict/link`, link: RG },
  debridlink: { url: `${DL}/api/v2/downloader/add`, link: RG },
  alldebrid: { url: `${AD}/v4/link/unlock`, link: RG },
  premiumize: { url: `${PM}/api/transfer/directdl`, link: FICHIER },
};

describe('registry and shape', () => {
  const DEBRID = PROVIDERS.slice(0, 5);

  // The registry continues with the multihosters and the hosters (Task 4, providers-hosters.test.js).
  test('PROVIDERS starts with the debrid five, in the default order of the manifest order setting', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const order = manifest.settings.find((s) => s.name === 'order').value.split(',');
    assert.deepEqual(DEBRID.map((p) => p.id), ['torbox', 'alldebrid', 'premiumize', 'realdebrid', 'debridlink']);
    assert.deepEqual(DEBRID.map((p) => p.id), order.slice(0, 5));
    assert.deepEqual(DEBRID, [torbox, alldebrid, premiumize, realdebrid, debridlink]);
  });

  test('each module has the provider shape, kind debrid, its host root as base and its link lifetime', () => {
    const base = { torbox: TB, realdebrid: RD, debridlink: DL, alldebrid: AD, premiumize: PM };
    const title = { torbox: 'TorBox', realdebrid: 'Real-Debrid', debridlink: 'Debrid-Link', alldebrid: 'AllDebrid', premiumize: 'Premiumize' };
    for (const p of DEBRID) {
      assert.equal(p.kind, 'debrid', p.id);
      assert.equal(p.title, title[p.id]);
      assert.equal(p.base, base[p.id]);
      assert.equal(p.linkTTLms, p.id === 'torbox' ? 60 * MIN : 180 * MIN, p.id);
      for (const fn of ['enabled', 'hosts', 'unrestrict', 'cachedMagnet']) assert.equal(typeof p[fn], 'function', `${p.id}.${fn}`);
    }
  });

  test('enabled() needs the switch and the key; Real-Debrid needs only the switch (device login)', () => {
    for (const p of DEBRID) {
      const cred = CRED[p.id];
      assert.equal(p.enabled({ enabled: false, [cred]: 'x' }), false, p.id);
      assert.equal(p.enabled({ enabled: true, [cred]: 'x' }), true, p.id);
      assert.equal(p.enabled({ enabled: true, [cred]: '' }), p.id === 'realdebrid', p.id);
      assert.equal(p.enabled({ enabled: true, [cred]: null }), p.id === 'realdebrid', p.id);
    }
  });

  test('advanced_api_base sends the requests to <base>/<provider id>/<the API path>', async () => {
    const fake = setup('torbox', { advanced_api_base: 'http://127.0.0.1:18990/' });
    fake.route('GET', 'http://127.0.0.1:18990/torbox/v1/api/webdl/hosters', ok(fx('torbox', 'hosters')));
    assert.ok((await torbox.hosts(providerSettings('torbox'))).includes('rapidgator.net'));
    assert.equal(fake.calls.length, 1);
  });
});

for (const id of Object.keys(HOSTS)) {
  const p = MODULES[id];
  const h = HOSTS[id];
  describe(`${id}: host list and claiming`, () => {
    test(`hosts() is cached for 24 h under hosts:${id}: two calls make one request, and it sends no credential`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = setup(id);
      fake.route('GET', h.url, ok(h.body));
      const first = await p.hosts(providerSettings(id));
      const second = await p.hosts(providerSettings(id));
      assert.deepEqual(first, second);
      assert.ok(first.includes(new URL(h.claims[0]).hostname.replace(/^www\./, '')));
      assert.equal(fake.callsTo(h.url).length, 1);
      const stored = JSON.parse(fake.storage.map.get(`hosts:${id}`));
      assert.equal(stored.exp - T0, 24 * 60 * MIN);
      if (h.auth) assert.equal(fake.calls[0].headers.authorization, `Bearer ${KEYS[id]}`);
      else assert.equal(fake.calls[0].headers.authorization, undefined);
      noSecret({ url: fake.calls[0].url, body: fake.calls[0].body }, KEYS[id]);
      t.mock.timers.tick(24 * 60 * MIN);
      await p.hosts(providerSettings(id));
      assert.equal(fake.callsTo(h.url).length, 2, 'loaded again after 24 h');
    });

    test('unrestrict gives null for a link outside hosts(), and for a magnet, without asking the API', async () => {
      const fake = setup(id);
      fake.route('GET', h.url, ok(h.body));
      for (const url of [OTHER, magnet(CACHED), 'not a url', ...h.refuses]) {
        assert.equal(await p.unrestrict(providerSettings(id), url), null, url);
      }
      assert.deepEqual(fake.calls.map((c) => c.url.split('?')[0]), [h.url]);
    });

    test('cachedMagnet gives null for something that is not a magnet with a v1 info-hash, without a request', async () => {
      const fake = setup(id);
      assert.equal(await p.cachedMagnet(providerSettings(id), RG), null);
      assert.equal(await p.cachedMagnet(providerSettings(id), 'magnet:?dn=no-hash'), null);
      assert.equal(fake.calls.length, 0);
    });

    test('an empty host list is not kept for 24 h: the next call asks again', async () => {
      const fake = setup(id);
      fake.route('GET', h.url, ok(EMPTY_LIST[id]));
      assert.deepEqual(await p.hosts(providerSettings(id)), []);
      assert.deepEqual(await p.hosts(providerSettings(id)), []);
      assert.equal(fake.callsTo(h.url).length, 2);
      assert.equal(fake.storage.map.has(`hosts:${id}`), false);
    });

    test('a 401 with a body the provider does not know is still a refused key, and it pauses the provider', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const call = FIRST_CALL[id];
      const fake = setup(id);
      fake.route('GET', h.url, ok(h.body));
      fake.route('POST', call.url, status(401, { message: 'nope' }));
      await rejectsWith(p.unrestrict(providerSettings(id), call.link), 'auth_invalid', /^[\w-]+: invalid (API key|private API token)/, KEYS[id]);
      await rejectsWith(p.unrestrict(providerSettings(id), call.link), 'cooldown', /10 more minutes/);
      assert.equal(fake.callsTo(call.url).length, 1);
    });

    test('a failing host list hides the key too (the secrets go to the public calls as well)', async () => {
      const fake = setup(id);
      fake.route('GET', h.url, status(500, { error: `oops ${KEYS[id]}`, detail: `key ${KEYS[id]}`, message: KEYS[id] }));
      await assert.rejects(p.hosts(providerSettings(id)), (err) => {
        assert.ok(err instanceof ProviderError);
        noSecret({ message: err.message, reason: err.reason, body: err.body, code: err.code, stack: err.stack }, KEYS[id]);
        return true;
      });
    });

    test('an error answer the provider does not know is shown as it is, with the key hidden and the title in front', async () => {
      const call = FIRST_CALL[id];
      const fake = setup(id);
      fake.route('GET', h.url, ok(h.body));
      fake.route('POST', call.url, status(400, { error: `odd ${KEYS[id]}`, detail: `odd ${KEYS[id]}`, message: `odd ${KEYS[id]}` }));
      await assert.rejects(p.unrestrict(providerSettings(id), call.link), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.match(err.message, /^[\w-]+: .*HTTP 400.*odd/);
        noSecret({ message: err.message, reason: err.reason, body: err.body, code: err.code, stack: err.stack }, KEYS[id]);
        return true;
      });
    });

    test('an HTML 403 (a block page of Cloudflare or a WAF) is not a refused key: no pause, and the message says why', async () => {
      const call = FIRST_CALL[id];
      const fake = setup(id);
      fake.route('GET', h.url, ok(h.body));
      fake.route('POST', call.url, () => ({ status: 403, text: '<html><title>Attention Required! | Cloudflare</title></html>' }));
      await rejectsWith(p.unrestrict(providerSettings(id), call.link), 'ip_not_allowed',
        /^[\w-]+: blocked by the service's protection \(HTTP 403\); a VPN or datacenter address is often refused$/, KEYS[id]);
      assert.equal(fake.storage.map.has(`cooldown:${id}`), false);
      await assert.rejects(p.unrestrict(providerSettings(id), call.link), (err) => err.code === 'ip_not_allowed', 'asked again, not paused');
    });

    test('an HTML 503 or a 500 is service_down and a 429 is rate_limited; none of them pauses the provider', async () => {
      const call = FIRST_CALL[id];
      for (const [answer, code, pattern] of [
        [() => ({ status: 503, text: '<html>Service Unavailable</html>' }), 'service_down', /^[\w-]+: .*(down|unavailable).*503/],
        [status(500, { error: 'boom' }), 'service_down', /500/],
        [status(429, { error: 'too_many_requests', error_code: 34 }), 'rate_limited', /too many requests/],
      ]) {
        const fake = setup(id);
        fake.route('GET', h.url, ok(h.body));
        fake.route('POST', call.url, answer);
        await assert.rejects(p.unrestrict(providerSettings(id), call.link), (err) => {
          assert.ok(err instanceof ProviderError);
          assert.equal(err.code, code, err.message);
          assert.match(err.message, pattern);
          return true;
        });
        assert.equal(fake.storage.map.has(`cooldown:${id}`), false, 'a server error is not a refused key');
      }
    });
  });
}

describe('TorBox', () => {
  const KEY = KEYS.torbox;
  const tb = (path) => `${TB}/v1/api${path}`;

  function torboxWeb(fake, mylist) {
    fake.route('GET', HOSTS.torbox.url, ok(HOSTS.torbox.body));
    fake.route('POST', tb('/webdl/createwebdownload'), ok(fx('torbox', 'createwebdownload')));
    fake.route('GET', tb('/webdl/mylist'), mylist);
    fake.route('GET', tb('/webdl/requestdl'), ok(fx('torbox', 'requestdl')));
  }

  test('unrestrict: createwebdownload, mylist until the file is there, then requestdl; Bearer header, token only in requestdl', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = setup('torbox');
    let n = 0;
    torboxWeb(fake, () => ({ json: fx('torbox', ++n === 1 ? 'webdl-mylist-pending' : 'webdl-mylist-ready') }));
    const res = await drive(t, torbox.unrestrict(providerSettings('torbox'), RG));
    assert.deepEqual(res, {
      name: 'Some.File.mkv',
      size: 734003200,
      url: 'https://store-001.weur.tb-cdn.st/dld/00000000-fake-0000-0000-000000000001?token=fake-cdn-token',
      headers: {},
    });
    const [create] = fake.callsTo(tb('/webdl/createwebdownload'));
    assert.equal(create.headers.authorization, `Bearer ${KEY}`);
    assert.equal(create.form.link, RG);
    const lists = fake.callsTo(tb('/webdl/mylist'));
    assert.equal(lists.length, 2);
    assert.equal(lists[0].query.id, '4242');
    assert.equal(lists[0].query.bypass_cache, 'true');
    assert.equal(lists[0].headers.authorization, `Bearer ${KEY}`);
    const [dl] = fake.callsTo(tb('/webdl/requestdl'));
    assert.deepEqual({ token: dl.query.token, web_id: dl.query.web_id, file_id: dl.query.file_id }, { token: KEY, web_id: '4242', file_id: '0' });
    assert.equal(dl.query.redirect, undefined, 'never the permalink form, which embeds the key');
    noSecret(res, KEY);
    noSecret(fake.logs, KEY);
  });

  test('unrestrict: files that are listed while the progress is below 1 are not ready yet', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = setup('torbox');
    let n = 0;
    const early = fx('torbox', 'webdl-mylist-pending');
    early.data.files = fx('torbox', 'webdl-mylist-ready').data.files;
    torboxWeb(fake, () => ({ json: ++n === 1 ? early : fx('torbox', 'webdl-mylist-ready') }));
    await drive(t, torbox.unrestrict(providerSettings('torbox'), RG));
    assert.equal(fake.callsTo(tb('/webdl/mylist')).length, 2);
  });

  test('unrestrict: a web download that is not on TorBox within 60 s is not_ready, and polling stops', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = setup('torbox');
    torboxWeb(fake, ok(fx('torbox', 'webdl-mylist-pending')));
    await rejectsWith(drive(t, torbox.unrestrict(providerSettings('torbox'), RG)), 'not_ready', /^TorBox: .*not ready/);
    const lists = fake.callsTo(tb('/webdl/mylist')).length;
    assert.ok(lists >= 2 && lists <= 14, `mylist calls: ${lists}`);
    assert.equal(fake.callsTo(tb('/webdl/requestdl')).length, 0);
  });

  test('cachedMagnet: checkcached, createtorrent add_only_if_cached, mylist, then requestdl per file', async () => {
    const fake = setup('torbox');
    fake.route('GET', tb('/torrents/checkcached'), ok(fx('torbox', 'checkcached-hit')));
    fake.route('POST', tb('/torrents/createtorrent'), ok(fx('torbox', 'createtorrent')));
    fake.route('GET', tb('/torrents/mylist'), ok(fx('torbox', 'torrent-mylist')));
    fake.route('GET', tb('/torrents/requestdl'), (req) => ({
      json: { ...fx('torbox', 'requestdl'), data: `https://store-001.weur.tb-cdn.st/dld/fake-${req.query.file_id}` },
    }));
    const files = await torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED.toUpperCase()));
    assert.deepEqual(files, [
      { name: 'E01.mkv', size: 700000000, url: 'https://store-001.weur.tb-cdn.st/dld/fake-0', headers: {} },
      { name: 'E02.mkv', size: 600000000, url: 'https://store-001.weur.tb-cdn.st/dld/fake-1', headers: {} },
    ]);
    const [check] = fake.callsTo(tb('/torrents/checkcached'));
    assert.deepEqual({ hash: check.query.hash, format: check.query.format, list_files: check.query.list_files }, { hash: CACHED, format: 'list', list_files: 'true' });
    assert.equal(check.headers.authorization, `Bearer ${KEY}`);
    const [create] = fake.callsTo(tb('/torrents/createtorrent'));
    assert.equal(create.form.magnet, magnet(CACHED.toUpperCase()));
    assert.equal(create.form.add_only_if_cached, 'true');
    assert.equal(create.form.allow_zip, 'false', 'one link per file, never a zip');
    assert.equal(create.form.seed, '3', 'TorBox does not seed it');
    assert.equal(create.headers.authorization, `Bearer ${KEY}`);
    assert.equal(fake.callsTo(tb('/torrents/mylist'))[0].query.id, '777');
    const dls = fake.callsTo(tb('/torrents/requestdl'));
    assert.deepEqual(dls.map((c) => [c.query.torrent_id, c.query.file_id, c.query.token === KEY, c.query.redirect]), [
      ['777', '0', true, undefined],
      ['777', '1', true, undefined],
    ]);
    noSecret(files, KEY);
  });

  describe('after createtorrent', () => {
    const ctl = tb('/torrents/controltorrent');
    function added(mylist, extra) {
      const fake = setup('torbox');
      fake.route('GET', tb('/torrents/checkcached'), ok(fx('torbox', 'checkcached-hit')));
      fake.route('POST', tb('/torrents/createtorrent'), ok(fx('torbox', 'createtorrent')));
      fake.route('GET', tb('/torrents/mylist'), mylist);
      fake.route('POST', ctl, ok({ success: true, error: null, detail: 'ok', data: null }));
      fake.route('GET', tb('/torrents/requestdl'), (req) => extra
        ? extra(req) : ({ json: { ...fx('torbox', 'requestdl'), data: `https://store-001.weur.tb-cdn.st/dld/fake-${req.query.file_id}` } }));
      return fake;
    }
    const noFiles = () => { const b = fx('torbox', 'torrent-mylist'); b.data.files = []; return b; };

    test('an empty file list is polled for up to 10 s, and the files that then appear are used (never "not cached")', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
      let n = 0;
      const fake = added(() => ({ json: ++n < 3 ? noFiles() : fx('torbox', 'torrent-mylist') }));
      const files = await drive(t, torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED)));
      assert.deepEqual(files.map((f) => f.name), ['E01.mkv', 'E02.mkv']);
      assert.equal(fake.callsTo(tb('/torrents/mylist')).length, 3);
      assert.equal(fake.callsTo(ctl).length, 0, 'a usable torrent stays');
    });

    test('files that never appear: not_ready after 10 s, and the torrent is deleted (controltorrent, operation delete)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
      const fake = added(() => ({ json: noFiles() }));
      let at = null;
      fake.route('POST', ctl, (req) => { at = Date.now() - T0; assert.deepEqual(req.json, { operation: 'delete', torrent_id: 777 }); assert.equal(req.headers.authorization, `Bearer ${KEY}`); return { json: { success: true } }; });
      await rejectsWith(drive(t, torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED))), 'not_ready', /^TorBox: .*lists no files/);
      assert.ok(at >= 10000 && at <= 13000, `deleted after ${at} ms`);
      const polls = fake.callsTo(tb('/torrents/mylist')).length;
      assert.ok(polls >= 3 && polls <= 8, `mylist calls: ${polls}`);
    });

    test('an error after the add deletes the torrent, then shows the error', async () => {
      const fake = added(ok(fx('torbox', 'torrent-mylist')), () => ({ status: 503, text: '<html>down</html>' }));
      await rejectsWith(torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED)), 'service_down', /^TorBox: /);
      assert.equal(fake.callsTo(ctl).length, 1);
    });

    test('a key refused after the add sends no delete (the pause forbids another call)', async () => {
      const fake = added(status(401, fx('torbox', 'error-bad-token')));
      await rejectsWith(torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED)), 'auth_invalid', /invalid API key/);
      assert.equal(fake.callsTo(ctl).length, 0);
    });

    test('a download link that holds the API key is refused, never returned (it would become a task URL)', async () => {
      const bad = (req) => ({ json: { ...fx('torbox', 'requestdl'), data: `https://store-001.weur.tb-cdn.st/dld/x?apikey=${encodeURIComponent(KEY)}` } });
      const fake = added(ok(fx('torbox', 'torrent-mylist')), bad);
      await rejectsWith(torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED)), 'bad_response', /^TorBox: the service returned a link that holds the API key$/, KEY);
      assert.equal(fake.callsTo(ctl).length, 1);
      const f2 = setup('torbox');
      torboxWeb(f2, ok(fx('torbox', 'webdl-mylist-ready')));
      f2.route('GET', tb('/webdl/requestdl'), () => ({ json: { ...fx('torbox', 'requestdl'), data: `https://cdn.example/${KEY}/file` } }));
      await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), 'bad_response', /holds the API key/, KEY);
    });
  });

  test('cachedMagnet: an uncached magnet gives null, and nothing is added', async () => {
    const fake = setup('torbox');
    fake.route('GET', tb('/torrents/checkcached'), ok(fx('torbox', 'checkcached-miss')));
    fake.route('POST', tb('/torrents/createtorrent'), ok(fx('torbox', 'createtorrent')));
    assert.equal(await torbox.cachedMagnet(providerSettings('torbox'), magnet(UNCACHED)), null);
    assert.deepEqual(fake.calls.map((c) => c.method + ' ' + c.url.split('?')[0]), [`GET ${tb('/torrents/checkcached')}`]);
  });

  test('errors: invalid token, expired plan and limit reached name their cause; an echoed key is hidden', async () => {
    const fake = setup('torbox');
    fake.route('GET', tb('/torrents/checkcached'), status(401, { ...fx('torbox', 'error-bad-token'), detail: `Token ${KEY} is not valid` }));
    await rejectsWith(torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED)), 'auth_invalid', /^TorBox: invalid API key/, KEY);

    for (const [fixture, httpStatus, code, pattern] of [
      ['error-plan-restricted', 403, 'account_expired', /^TorBox: .*expired/],
      ['error-plan-restricted', 200, 'account_expired', /^TorBox: .*expired/],
      ['error-monthly-limit', 429, 'limit_reached', /^TorBox: limit reached/],
      ['error-monthly-limit', 200, 'limit_reached', /^TorBox: limit reached/],
      ['error-unsupported-site', 200, 'not_supported', /^TorBox: .*not supported/],
    ]) {
      const f = setup('torbox');
      f.route('GET', HOSTS.torbox.url, ok(HOSTS.torbox.body));
      f.route('POST', tb('/webdl/createwebdownload'), status(httpStatus, fx('torbox', fixture)));
      await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), code, pattern, KEY);
    }
  });
});

describe('Real-Debrid', () => {
  const TOKEN = KEYS.realdebrid;
  const rest = (path) => `${RD}/rest/1.0${path}`;
  const oauth = (path) => `${RD}/oauth/v2${path}`;
  const DEVICE_MSG = (n) =>
    `Real-Debrid: open https://real-debrid.com/device and enter FAKE1234, then add the link again (the code is valid for ${n} minutes)`;

  function unrestrictRoute(fake) {
    fake.route('POST', rest('/unrestrict/link'), (req) => {
      const base = fx('realdebrid', 'unrestrict-link');
      const m = /FAKELINK000(\d)/.exec(req.form.link);
      if (!m) return { json: base };
      const name = `E0${m[1]}.mkv`;
      return { json: { ...base, filename: name, filesize: m[1] === '1' ? 700000000 : 600000000, link: req.form.link, download: `https://fake-dl.real-debrid.com/d/${m[1]}/${name}` } };
    });
  }

  test('unrestrict with the private token: Bearer token, POST /unrestrict/link, no OAuth call', async () => {
    const fake = setup('realdebrid');
    fake.route('GET', HOSTS.realdebrid.url, ok(HOSTS.realdebrid.body));
    unrestrictRoute(fake);
    const res = await realdebrid.unrestrict(providerSettings('realdebrid'), RG);
    assert.deepEqual(res, { name: 'Some.File.mkv', size: 734003200, url: 'https://fake-dl.real-debrid.com/d/RDLINK0001/Some.File.mkv', headers: {} });
    const [call] = fake.callsTo(rest('/unrestrict/link'));
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(call.form, { link: RG });
    assert.equal(fake.callsTo(oauth('')).length, 0);
    noSecret(res, TOKEN);
  });

  test('a refused private token pauses the provider for 10 minutes, and says it is the token', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = setup('realdebrid');
    fake.route('GET', HOSTS.realdebrid.url, ok(HOSTS.realdebrid.body));
    fake.route('POST', rest('/unrestrict/link'), status(401, fx('realdebrid', 'error-bad-token')));
    await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'auth_invalid', /^Real-Debrid: invalid private API token/);
    const sent = fake.calls.length;
    await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'cooldown', /^Real-Debrid: invalid private API token.*10 more minutes/);
    await rejectsWith(realdebrid.cachedMagnet(providerSettings('realdebrid'), magnet(CACHED)), 'cooldown', /10 more minutes/);
    assert.equal(fake.calls.length, sent, 'nothing is sent during the pause');
    assert.equal(fake.callsTo(oauth('')).length, 0, 'a private token is never refreshed');
    fake.settings.realdebrid_token = 'FAKE-RD-TOKEN-0002';
    await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'auth_invalid', /invalid private API token/);
  });

  test('advanced_api_base reaches the OAuth and the REST paths: <base>/realdebrid/oauth/v2/... and /rest/1.0/...', async () => {
    const fake = installFakeGopeed({ settings: { realdebrid_enabled: true, realdebrid_token: null, advanced_api_base: 'http://127.0.0.1:18990' } });
    fake.route('GET', 'http://127.0.0.1:18990/realdebrid/rest/1.0/hosts/domains', ok(HOSTS.realdebrid.body));
    fake.route('GET', 'http://127.0.0.1:18990/realdebrid/oauth/v2/device/code', ok(fx('realdebrid', 'device-code')));
    await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'login_required', /enter FAKE1234/);
    assert.equal(fake.calls.length, 2);
  });

  test('cachedMagnet: addMagnet, selectFiles all, info says downloaded, then every link is unrestricted; nothing deleted', async () => {
    const fake = setup('realdebrid');
    fake.route('POST', rest('/torrents/addMagnet'), status(201, fx('realdebrid', 'addmagnet')));
    let selected = false;
    fake.route('GET', rest('/torrents/info/RDTORRENT01'), () => ({ json: fx('realdebrid', selected ? 'info-downloaded' : 'info-waiting') }));
    fake.route('POST', rest('/torrents/selectFiles/RDTORRENT01'), () => { selected = true; return { status: 204 }; });
    fake.route('DELETE', rest('/torrents/delete/'), () => ({ status: 204 }));
    unrestrictRoute(fake);
    const files = await realdebrid.cachedMagnet(providerSettings('realdebrid'), magnet(CACHED));
    assert.deepEqual(files, [
      { name: 'E01.mkv', size: 700000000, url: 'https://fake-dl.real-debrid.com/d/1/E01.mkv', headers: {} },
      { name: 'E02.mkv', size: 600000000, url: 'https://fake-dl.real-debrid.com/d/2/E02.mkv', headers: {} },
    ]);
    const [add] = fake.callsTo(rest('/torrents/addMagnet'));
    assert.equal(add.form.magnet, magnet(CACHED));
    assert.equal(add.headers.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(fake.callsTo(rest('/torrents/selectFiles/RDTORRENT01'))[0].form, { files: 'all' });
    assert.deepEqual(fake.callsTo(rest('/unrestrict/link')).map((c) => c.form.link), [
      'https://real-debrid.com/d/FAKELINK0001',
      'https://real-debrid.com/d/FAKELINK0002',
    ]);
    assert.equal(fake.callsTo(rest('/torrents/delete/')).length, 0);
  });

  test('cachedMagnet: not downloaded within the 10 s probe means DELETE /torrents/delete/{id} and null', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = setup('realdebrid');
    fake.route('POST', rest('/torrents/addMagnet'), status(201, fx('realdebrid', 'addmagnet')));
    let selected = false;
    fake.route('GET', rest('/torrents/info/RDTORRENT01'), () => ({ json: fx('realdebrid', selected ? 'info-queued' : 'info-waiting') }));
    fake.route('POST', rest('/torrents/selectFiles/RDTORRENT01'), () => { selected = true; return { status: 204 }; });
    let deletedAt = null;
    fake.route('DELETE', rest('/torrents/delete/RDTORRENT01'), (req) => {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      deletedAt = Date.now();
      return { status: 204 };
    });
    assert.equal(await drive(t, realdebrid.cachedMagnet(providerSettings('realdebrid'), magnet(UNCACHED))), null);
    assert.ok(deletedAt !== null, 'the torrent was deleted');
    assert.ok(deletedAt - T0 >= 10000 && deletedAt - T0 <= 13000, `deleted after ${deletedAt - T0} ms`);
    const infos = fake.callsTo(rest('/torrents/info/')).length;
    assert.ok(infos >= 2 && infos <= 8, `info calls: ${infos}`);
    assert.equal(fake.callsTo(rest('/unrestrict/link')).length, 0);
  });

  test('cachedMagnet: an error after addMagnet still deletes the torrent, then shows the error', async () => {
    const fake = setup('realdebrid');
    fake.route('POST', rest('/torrents/addMagnet'), status(201, fx('realdebrid', 'addmagnet')));
    fake.route('GET', rest('/torrents/info/RDTORRENT01'), status(503, { error: 'service_unavailable', error_code: 25 }));
    fake.route('DELETE', rest('/torrents/delete/RDTORRENT01'), () => ({ status: 204 }));
    await rejectsWith(realdebrid.cachedMagnet(providerSettings('realdebrid'), magnet(CACHED)), 'service_down', /^Real-Debrid: /);
    assert.equal(fake.callsTo(rest('/torrents/delete/RDTORRENT01')).length, 1);
  });

  test('cachedMagnet: a torrent that went wrong on the service (magnet_error) is deleted at once, then null', async () => {
    const fake = setup('realdebrid');
    fake.route('POST', rest('/torrents/addMagnet'), status(201, fx('realdebrid', 'addmagnet')));
    fake.route('GET', rest('/torrents/info/RDTORRENT01'), ok({ ...fx('realdebrid', 'info-waiting'), status: 'magnet_error' }));
    fake.route('DELETE', rest('/torrents/delete/RDTORRENT01'), () => ({ status: 204 }));
    assert.equal(await realdebrid.cachedMagnet(providerSettings('realdebrid'), magnet(UNCACHED)), null);
    assert.equal(fake.callsTo(rest('/torrents/delete/RDTORRENT01')).length, 1);
    assert.equal(fake.callsTo(rest('/torrents/selectFiles/')).length, 0);
  });

  test('errors: bad token, expired premium, traffic exhausted and unsupported host name their cause (error_code decides)', async () => {
    for (const [fixture, httpStatus, code, pattern] of [
      ['error-bad-token', 401, 'auth_invalid', /^Real-Debrid: invalid private API token/],
      ['error-free-users', 503, 'account_expired', /^Real-Debrid: .*(expired|premium)/],
      ['error-permission-denied', 403, 'account_expired', /^Real-Debrid: .*(locked|premium)/],
      ['error-traffic-exhausted', 503, 'limit_reached', /^Real-Debrid: limit reached/],
      ['error-unsupported', 503, 'not_supported', /^Real-Debrid: .*not supported/],
    ]) {
      const fake = setup('realdebrid');
      fake.route('GET', HOSTS.realdebrid.url, ok(HOSTS.realdebrid.body));
      fake.route('POST', rest('/unrestrict/link'), status(httpStatus, { ...fx('realdebrid', fixture), echo: TOKEN }));
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), code, pattern, TOKEN);
    }
  });

  describe('device login (no private token)', () => {
    function deviceSetup(storage = {}) {
      const fake = installFakeGopeed({ settings: { realdebrid_enabled: true, realdebrid_token: null }, storage });
      fake.route('GET', HOSTS.realdebrid.url, ok(HOSTS.realdebrid.body));
      fake.route('GET', oauth('/device/code'), ok(fx('realdebrid', 'device-code')));
      fake.route('GET', oauth('/device/credentials'), ok(fx('realdebrid', 'device-credentials')));
      fake.route('POST', oauth('/token'), ok(fx('realdebrid', 'token')));
      unrestrictRoute(fake);
      return fake;
    }
    const stored = (fake, key) => {
      const raw = fake.storage.map.get(key);
      return raw === undefined ? undefined : JSON.parse(raw).v;
    };

    test('the first resolve gets a device code, stores it and shows it; nothing else is asked', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup();
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'login_required', /^Real-Debrid: open /);
      const [code] = fake.callsTo(oauth('/device/code'));
      assert.deepEqual(code.query, { client_id: 'X245A4XAIBGVM', new_credentials: 'yes' });
      const dev = stored(fake, 'rd:device');
      assert.equal(dev.device_code, 'FAKE-RD-DEVICE-CODE-0001');
      assert.equal(dev.expires_at, T0 + 1800 * 1000);
      assert.equal(fake.callsTo(rest('/unrestrict/link')).length, 0);
    });

    test('the first message is the ruling text with the code and the minutes', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      deviceSetup();
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), (err) => {
        assert.equal(err.message, DEVICE_MSG(30));
        noSecret(err.message, 'FAKE-RD-DEVICE-CODE-0001');
        return true;
      });
    });

    test('the next resolve asks /device/credentials once, gets the token, stores rd:auth and unrestricts', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup();
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG));
      t.mock.timers.tick(2 * MIN);
      const res = await realdebrid.unrestrict(providerSettings('realdebrid'), RG);
      assert.equal(res.url, 'https://fake-dl.real-debrid.com/d/RDLINK0001/Some.File.mkv');
      const creds = fake.callsTo(oauth('/device/credentials'));
      assert.equal(creds.length, 1);
      assert.deepEqual(creds[0].query, { client_id: 'X245A4XAIBGVM', code: 'FAKE-RD-DEVICE-CODE-0001' });
      const [tok] = fake.callsTo(oauth('/token'));
      assert.deepEqual(tok.form, {
        client_id: 'FAKE-RD-USER-CLIENT-0001',
        client_secret: 'FAKE-RD-CLIENT-SECRET-0001',
        code: 'FAKE-RD-DEVICE-CODE-0001',
        grant_type: 'http://oauth.net/grant_type/device/1.0',
      });
      assert.equal(fake.callsTo(rest('/unrestrict/link'))[0].headers.authorization, 'Bearer FAKE-RD-ACCESS-0001');
      assert.deepEqual(stored(fake, 'rd:auth'), {
        access_token: 'FAKE-RD-ACCESS-0001',
        refresh_token: 'FAKE-RD-REFRESH-0001',
        client_id: 'FAKE-RD-USER-CLIENT-0001',
        client_secret: 'FAKE-RD-CLIENT-SECRET-0001',
        expires_at: T0 + 2 * MIN + 3600 * 1000,
      });
      assert.equal(stored(fake, 'rd:device'), undefined);
      // Later resolves use the stored token: no more OAuth calls.
      await realdebrid.unrestrict(providerSettings('realdebrid'), RG);
      assert.equal(fake.callsTo(oauth('')).length, 3);
      assert.equal(fake.callsTo(rest('/unrestrict/link'))[1].headers.authorization, 'Bearer FAKE-RD-ACCESS-0001');
    });

    test('before the user enters the code, the next resolve asks once and shows the same code again', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup();
      fake.route('GET', oauth('/device/credentials'), status(403, fx('realdebrid', 'device-credentials-pending')));
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG));
      t.mock.timers.tick(5 * MIN);
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), { message: DEVICE_MSG(25), code: 'login_required' });
      assert.equal(fake.callsTo(oauth('/device/credentials')).length, 1);
      assert.equal(fake.callsTo(oauth('/token')).length, 0);
      assert.equal(fake.callsTo(oauth('/device/code')).length, 1);
      assert.equal(fake.storage.map.has('cooldown:realdebrid'), false, 'waiting for the user is not a failed login');
    });

    test('an expired device code starts a new one', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup();
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG));
      t.mock.timers.tick(31 * MIN);
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), { message: DEVICE_MSG(30) });
      assert.equal(fake.callsTo(oauth('/device/code')).length, 2);
      assert.equal(fake.callsTo(oauth('/device/credentials')).length, 0);
    });

    const AUTH = {
      access_token: 'FAKE-RD-ACCESS-0001',
      refresh_token: 'FAKE-RD-REFRESH-0001',
      client_id: 'FAKE-RD-USER-CLIENT-0001',
      client_secret: 'FAKE-RD-CLIENT-SECRET-0001',
    };
    const seeded = (expiresAt) => ({ 'rd:auth': JSON.stringify({ v: { ...AUTH, expires_at: expiresAt }, exp: T0 + 365 * 24 * 60 * MIN }) });

    test('an expired access token is refreshed first (device grant, code = refresh token)', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup(seeded(T0 - 1000));
      fake.route('POST', oauth('/token'), ok(fx('realdebrid', 'token-refreshed')));
      await realdebrid.unrestrict(providerSettings('realdebrid'), RG);
      const [tok] = fake.callsTo(oauth('/token'));
      assert.deepEqual(tok.form, {
        client_id: 'FAKE-RD-USER-CLIENT-0001',
        client_secret: 'FAKE-RD-CLIENT-SECRET-0001',
        code: 'FAKE-RD-REFRESH-0001',
        grant_type: 'http://oauth.net/grant_type/device/1.0',
      });
      assert.equal(fake.callsTo(rest('/unrestrict/link'))[0].headers.authorization, 'Bearer FAKE-RD-ACCESS-0002');
      assert.equal(stored(fake, 'rd:auth').access_token, 'FAKE-RD-ACCESS-0002');
    });

    test('a 401 on a valid-looking token refreshes once and repeats the call once', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup(seeded(T0 + 30 * MIN));
      fake.route('POST', oauth('/token'), ok(fx('realdebrid', 'token-refreshed')));
      const base = fx('realdebrid', 'unrestrict-link');
      fake.route('POST', rest('/unrestrict/link'), (req) =>
        req.headers.authorization === 'Bearer FAKE-RD-ACCESS-0001' ? { status: 401, json: fx('realdebrid', 'error-bad-token') } : { json: base });
      const res = await realdebrid.unrestrict(providerSettings('realdebrid'), RG);
      assert.equal(res.url, base.download);
      assert.equal(fake.callsTo(oauth('/token')).length, 1);
      assert.deepEqual(fake.callsTo(rest('/unrestrict/link')).map((c) => c.headers.authorization), ['Bearer FAKE-RD-ACCESS-0001', 'Bearer FAKE-RD-ACCESS-0002']);
      assert.equal(fake.storage.map.has('cooldown:realdebrid'), false, 'a token that was only expired is not a refused login');
    });

    test('a 401 on the refreshed token as well drops the login and pauses', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup(seeded(T0 + 30 * MIN));
      fake.route('POST', oauth('/token'), ok(fx('realdebrid', 'token-refreshed')));
      fake.route('POST', rest('/unrestrict/link'), status(401, fx('realdebrid', 'error-bad-token')));
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'auth_invalid', /^Real-Debrid: the login expired or was revoked/);
      assert.equal(fake.callsTo(rest('/unrestrict/link')).length, 2, 'repeated once, not more');
      assert.equal(fake.callsTo(oauth('/token')).length, 1);
      assert.equal(stored(fake, 'rd:auth'), undefined);
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'cooldown', /10 more minutes/);
    });

    test('a login refused in the middle of a magnet probe sends nothing more: no clean-up call, no new device code', async (t) => {
      for (const refreshAnswer of [status(400, { error: 'invalid_grant', error_code: 8 }), ok(fx('realdebrid', 'token-refreshed'))]) {
        t.mock.timers.enable({ apis: ['Date'], now: T0 });
        const fake = deviceSetup(seeded(T0 + 30 * MIN));
        fake.route('POST', rest('/torrents/addMagnet'), status(201, fx('realdebrid', 'addmagnet')));
        fake.route('GET', rest('/torrents/info/RDTORRENT01'), status(401, fx('realdebrid', 'error-bad-token')));
        fake.route('POST', oauth('/token'), refreshAnswer);
        fake.route('DELETE', rest('/torrents/delete/RDTORRENT01'), () => ({ status: 204 }));
        await rejectsWith(realdebrid.cachedMagnet(providerSettings('realdebrid'), magnet(CACHED)), 'auth_invalid', /^Real-Debrid: the login expired or was revoked/);
        assert.equal(fake.callsTo(rest('/torrents/delete/')).length, 0, 'no DELETE with a refused login');
        assert.equal(fake.callsTo(oauth('/device/code')).length, 0, 'no silent new device login');
        assert.equal(fake.storage.map.has('rd:device'), false);
        assert.equal(stored(fake, 'rd:auth'), undefined);
        assert.ok(fake.storage.map.has('cooldown:realdebrid'));
        t.mock.timers.reset();
      }
    });

    test('an HTML 403 on a device login keeps the stored login and starts no pause', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup(seeded(T0 + 30 * MIN));
      fake.route('POST', rest('/unrestrict/link'), () => ({ status: 403, text: '<html>Access denied</html>' }));
      fake.route('POST', oauth('/token'), ok(fx('realdebrid', 'token-refreshed')));
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'ip_not_allowed', /^Real-Debrid: blocked by the service's protection/);
      assert.deepEqual(stored(fake, 'rd:auth').refresh_token, 'FAKE-RD-REFRESH-0001');
      assert.equal(fake.storage.map.has('cooldown:realdebrid'), false);
      assert.equal(fake.callsTo(oauth('/token')).length, 0, 'not refreshed either');
    });

    test('a /token exchange that refuses the device code drops it and says how to get a new one; the next resolve shows a fresh code', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup();
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG));
      fake.route('POST', oauth('/token'), status(400, { error: 'invalid_grant FAKE-RD-DEVICE-CODE-0001', error_code: 9 }));
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.code, 'login_required');
        assert.equal(err.message, 'Real-Debrid: the device login was not accepted; add the link again to get a new code');
        noSecret({ message: err.message, body: err.body, code: err.code, stack: err.stack }, 'FAKE-RD-DEVICE-CODE-0001');
        noSecret({ message: err.message, body: err.body }, 'FAKE-RD-CLIENT-SECRET-0001');
        return true;
      });
      assert.equal(stored(fake, 'rd:device'), undefined);
      assert.equal(stored(fake, 'rd:auth'), undefined);
      assert.equal(fake.storage.map.has('cooldown:realdebrid'), false, 'not a refused key');
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), { message: DEVICE_MSG(30) });
      assert.equal(fake.callsTo(oauth('/device/code')).length, 2);
      assert.equal(fake.callsTo(oauth('/device/credentials')).length, 1, 'the spent code is not asked about again');
      assert.equal(fake.callsTo(oauth('/token')).length, 1);
    });

    test('an error of /device/credentials that echoes the device code hides it', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup();
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG));
      fake.route('GET', oauth('/device/credentials'), status(500, { error: 'oops FAKE-RD-DEVICE-CODE-0001' }));
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 500, 'a server error is not "still waiting"');
        noSecret({ message: err.message, body: err.body, code: err.code }, 'FAKE-RD-DEVICE-CODE-0001');
        return true;
      });
    });

    test('a stored device code whose own expiry has passed is not asked about', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const old = { device_code: 'FAKE-RD-OLD-DEVICE', user_code: 'OLDCODE1', expires_at: T0 - 1000 };
      const fake = deviceSetup({ 'rd:device': JSON.stringify({ v: old, exp: T0 + MIN }) });
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), { message: DEVICE_MSG(30) });
      assert.equal(fake.callsTo(oauth('/device/credentials')).length, 0);
      assert.equal(fake.callsTo(oauth('/device/code')).length, 1);
    });

    test('a refused refresh is shown once: the login is dropped, then a 10-minute pause, then a new device code', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup(seeded(T0 - 1000));
      fake.route('POST', oauth('/token'), status(400, { error: 'invalid_grant FAKE-RD-REFRESH-0001', error_code: 8 }));
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'auth_invalid', /^Real-Debrid: .*login/, 'FAKE-RD-REFRESH-0001');
      assert.equal(stored(fake, 'rd:auth'), undefined);
      const before = fake.calls.length;
      await rejectsWith(realdebrid.unrestrict(providerSettings('realdebrid'), RG), 'cooldown', /10 more minutes/);
      assert.equal(fake.calls.length, before, 'no request during the pause');
      t.mock.timers.tick(10 * MIN);
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), { message: DEVICE_MSG(30) });
      assert.equal(fake.callsTo(oauth('/token')).length, 1, 'the refresh was not tried again');
    });

    test('the login-derived secrets (access and refresh token, client secret) are hidden in an error that echoes them', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = deviceSetup(seeded(T0 + 30 * MIN));
      const echo = `${AUTH.access_token} ${AUTH.refresh_token} ${AUTH.client_secret} ${encodeURIComponent(AUTH.client_secret)}`;
      fake.route('POST', rest('/unrestrict/link'), status(503, { error: `unavailable ${echo}`, error_code: 19, echo: [AUTH.refresh_token, { deep: AUTH.client_secret }] }));
      await assert.rejects(realdebrid.unrestrict(providerSettings('realdebrid'), RG), (err) => {
        assert.equal(err.code, 'service_down');
        for (const secret of [AUTH.access_token, AUTH.refresh_token, AUTH.client_secret]) {
          noSecret({ message: err.message, reason: err.reason, body: err.body, code: err.code, stack: err.stack }, secret);
        }
        return true;
      });
      noSecret(fake.logs, AUTH.access_token);
    });

    test('a filled-in private token skips the device flow even when a device login is stored', async () => {
      const fake = deviceSetup(seeded(T0 + 30 * MIN));
      fake.settings.realdebrid_token = TOKEN;
      await realdebrid.unrestrict(providerSettings('realdebrid'), RG);
      assert.equal(fake.callsTo(rest('/unrestrict/link'))[0].headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(fake.callsTo(oauth('')).length, 0);
    });
  });
});

describe('Debrid-Link', () => {
  const KEY = KEYS.debridlink;
  const api = (path) => `${DL}/api/v2${path}`;

  test('the host list asks for hosts only (no stream sites) and leaves out hosts that are offline', async () => {
    const fake = setup('debridlink');
    fake.route('GET', HOSTS.debridlink.url, ok(HOSTS.debridlink.body));
    const hosts = await debridlink.hosts(providerSettings('debridlink'));
    assert.equal(fake.calls[0].query.types, 'host');
    assert.ok(hosts.includes('rg.to') && hosts.includes('alterupload.com'));
    assert.ok(!hosts.includes('uploaded.net'));
  });

  test('unrestrict: POST /downloader/add with url and the Bearer key, mapped to the downloadUrl', async () => {
    const fake = setup('debridlink');
    fake.route('GET', HOSTS.debridlink.url, ok(HOSTS.debridlink.body));
    fake.route('POST', api('/downloader/add'), ok(fx('debridlink', 'downloader-add')));
    const res = await debridlink.unrestrict(providerSettings('debridlink'), RG);
    assert.deepEqual(res, { name: 'Some.File.mkv', size: 734003200, url: 'https://dl6.debrid.link/dl/fake/Some.File.mkv', headers: {} });
    const [add] = fake.callsTo(api('/downloader/add'));
    assert.equal(add.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(add.form, { url: RG });
    noSecret(res, KEY);
  });

  test('cachedMagnet: seedbox/add with the bare info-hash (only a cached hash is accepted) gives the files', async () => {
    const fake = setup('debridlink');
    fake.route('POST', api('/seedbox/add'), ok(fx('debridlink', 'seedbox-add-cached')));
    const files = await debridlink.cachedMagnet(providerSettings('debridlink'), magnet(CACHED.toUpperCase()));
    assert.deepEqual(files, [
      { name: 'E01.mkv', size: 700000000, url: 'https://seed20.debrid.link/dl/fake/E01.mkv', headers: {} },
      { name: 'E02.mkv', size: 600000000, url: 'https://seed20.debrid.link/dl/fake/E02.mkv', headers: {} },
    ]);
    const [add] = fake.callsTo(api('/seedbox/add'));
    assert.deepEqual(add.form, { url: CACHED });
    assert.equal(add.headers.authorization, `Bearer ${KEY}`);
  });

  test('cachedMagnet: a torrent with many files comes back as one zip entry, so its files are read from seedbox/list', async () => {
    const fake = setup('debridlink');
    fake.route('POST', api('/seedbox/add'), ok(fx('debridlink', 'seedbox-add-zip')));
    fake.route('GET', api('/seedbox/list'), ok(fx('debridlink', 'seedbox-list')));
    const files = await debridlink.cachedMagnet(providerSettings('debridlink'), magnet(CACHED));
    assert.deepEqual(files.map((f) => f.name), ['E01.mkv', 'E02.mkv']);
    const [list] = fake.callsTo(api('/seedbox/list'));
    assert.equal(list.query.ids, '2115ca3cf4356d24510');
    assert.equal(list.headers.authorization, `Bearer ${KEY}`);
    assert.equal(fake.callsTo(api('/seedbox/')).filter((c) => c.method === 'DELETE').length, 0);
  });

  test('cachedMagnet: a key refused after the add sends no remove (the pause forbids another call)', async () => {
    const fake = setup('debridlink');
    fake.route('POST', api('/seedbox/add'), ok(fx('debridlink', 'seedbox-add-zip')));
    fake.route('GET', api('/seedbox/list'), status(401, fx('debridlink', 'error-badToken')));
    fake.route('DELETE', api('/seedbox/'), ok(fx('debridlink', 'seedbox-remove')));
    await rejectsWith(debridlink.cachedMagnet(providerSettings('debridlink'), magnet(CACHED)), 'auth_invalid', /invalid API key/);
    assert.equal(fake.callsTo(api('/seedbox/')).filter((c) => c.method === 'DELETE').length, 0);
  });

  test('cachedMagnet: a file that is not complete is left out', async () => {
    const fake = setup('debridlink');
    const body = fx('debridlink', 'seedbox-add-cached');
    body.value.files[1].downloadPercent = 40;
    fake.route('POST', api('/seedbox/add'), ok(body));
    const files = await debridlink.cachedMagnet(providerSettings('debridlink'), magnet(CACHED));
    assert.deepEqual(files.map((f) => f.name), ['E01.mkv']);
  });

  test('cachedMagnet: a refused hash gives null; an added torrent that is not complete is removed, then null', async () => {
    const fake = setup('debridlink');
    fake.route('POST', api('/seedbox/add'), status(400, fx('debridlink', 'error-notAddTorrent')));
    assert.equal(await debridlink.cachedMagnet(providerSettings('debridlink'), magnet(UNCACHED)), null);

    const f2 = setup('debridlink');
    f2.route('POST', api('/seedbox/add'), ok(fx('debridlink', 'seedbox-add-partial')));
    f2.route('DELETE', api('/seedbox/2115ca3cf4356d24510/remove'), ok(fx('debridlink', 'seedbox-remove')));
    assert.equal(await debridlink.cachedMagnet(providerSettings('debridlink'), magnet(UNCACHED)), null);
    const [rm] = f2.callsTo(api('/seedbox/2115ca3cf4356d24510/remove'));
    assert.equal(rm.method, 'DELETE');
    assert.equal(rm.headers.authorization, `Bearer ${KEY}`);
  });

  test('errors: bad token, not premium and daily limit name their cause; an echoed key is hidden', async () => {
    for (const [fixture, httpStatus, code, pattern] of [
      ['error-badToken', 401, 'auth_invalid', /^Debrid-Link: invalid API key/],
      ['error-notFreeHost', 400, 'account_expired', /^Debrid-Link: .*(expired|premium)/],
      ['error-maxData', 200, 'limit_reached', /^Debrid-Link: limit reached/],
    ]) {
      const fake = setup('debridlink');
      fake.route('GET', HOSTS.debridlink.url, ok(HOSTS.debridlink.body));
      fake.route('POST', api('/downloader/add'), status(httpStatus, { ...fx('debridlink', fixture), error_description: `key ${KEY} refused` }));
      await rejectsWith(debridlink.unrestrict(providerSettings('debridlink'), RG), code, pattern, KEY);
    }
  });
});

describe('AllDebrid', () => {
  const KEY = KEYS.alldebrid;
  const v4 = (path) => `${AD}/v4${path}`;

  function adSetup() {
    const fake = setup('alldebrid');
    fake.route('GET', HOSTS.alldebrid.url, ok(HOSTS.alldebrid.body));
    return fake;
  }

  test('unrestrict: POST /v4/link/unlock with link and the Bearer key, and no agent parameter', async () => {
    const fake = adSetup();
    fake.route('POST', v4('/link/unlock'), ok(fx('alldebrid', 'link-unlock')));
    const res = await alldebrid.unrestrict(providerSettings('alldebrid'), RG);
    assert.deepEqual(res, { name: 'Some.File.mkv', size: 734003200, url: 'https://ombfyx.debrid.it/dl/abcdefgh12/Some.File.mkv', headers: {} });
    const [unlock] = fake.callsTo(v4('/link/unlock'));
    assert.equal(unlock.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(unlock.form, { link: RG });
    for (const c of fake.calls) {
      assert.equal(c.query.agent, undefined);
      assert.equal(c.query.apikey, undefined);
    }
    noSecret(res, KEY);
  });

  test('unrestrict: a delayed link is polled with POST /v4/link/delayed every 5 s until it is ready', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = adSetup();
    fake.route('POST', v4('/link/unlock'), ok(fx('alldebrid', 'link-unlock-delayed')));
    const times = [];
    fake.route('POST', v4('/link/delayed'), (req) => {
      assert.deepEqual(req.form, { id: '2457' });
      times.push(Date.now() - T0);
      return { json: fx('alldebrid', times.length < 3 ? 'link-delayed-processing' : 'link-delayed-ready') };
    });
    const res = await drive(t, alldebrid.unrestrict(providerSettings('alldebrid'), RG));
    assert.equal(res.url, 'https://ombfyx.debrid.it/dl/abcdefgh12/Some.File.mkv');
    assert.equal(res.name, 'Some.File.mkv');
    assert.equal(times.length, 3);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 5000, `poll gap ${times[i] - times[i - 1]} ms`);
  });

  test('unrestrict: a delayed link that is not ready within 60 s is not_ready', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
    const fake = adSetup();
    fake.route('POST', v4('/link/unlock'), ok(fx('alldebrid', 'link-unlock-delayed')));
    fake.route('POST', v4('/link/delayed'), ok(fx('alldebrid', 'link-delayed-processing')));
    await rejectsWith(drive(t, alldebrid.unrestrict(providerSettings('alldebrid'), RG)), 'not_ready', /^AllDebrid: .*not ready/);
    const polls = fake.callsTo(v4('/link/delayed')).length;
    assert.ok(polls >= 10 && polls <= 13, `delayed polls: ${polls}`);
  });

  test('cachedMagnet: magnet/upload says ready, magnet/files lists the tree, each file link is unlocked', async () => {
    const fake = adSetup();
    fake.route('POST', v4('/magnet/upload'), ok(fx('alldebrid', 'magnet-upload-ready')));
    fake.route('POST', v4('/magnet/files'), ok(fx('alldebrid', 'magnet-files')));
    fake.route('POST', v4('/link/unlock'), (req) => {
      const n = req.form.link.slice(-1);
      const name = `E0${n}.mkv`;
      return { json: { status: 'success', data: { ...fx('alldebrid', 'link-unlock').data, link: `https://ombfyx.debrid.it/dl/f${n}/${name}`, filename: name, filesize: n === '1' ? 700000000 : 600000000 } } };
    });
    const files = await alldebrid.cachedMagnet(providerSettings('alldebrid'), magnet(CACHED));
    assert.deepEqual(files, [
      { name: 'E01.mkv', size: 700000000, url: 'https://ombfyx.debrid.it/dl/f1/E01.mkv', headers: {} },
      { name: 'E02.mkv', size: 600000000, url: 'https://ombfyx.debrid.it/dl/f2/E02.mkv', headers: {} },
    ]);
    const [up] = fake.callsTo(v4('/magnet/upload'));
    assert.deepEqual(up.form, { 'magnets[]': magnet(CACHED) });
    assert.equal(up.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(fake.callsTo(v4('/magnet/files'))[0].form, { 'id[]': '123456' });
    assert.deepEqual(fake.callsTo(v4('/link/unlock')).map((c) => c.form.link), ['https://alldebrid.com/f/FAKEFILE01', 'https://alldebrid.com/f/FAKEFILE02']);
    assert.equal(fake.callsTo(v4('/magnet/delete')).length, 0);
  });

  test('cachedMagnet: a magnet that is not ready is deleted with /v4/magnet/delete, then null', async () => {
    const fake = adSetup();
    fake.route('POST', v4('/magnet/upload'), ok(fx('alldebrid', 'magnet-upload-notready')));
    fake.route('POST', v4('/magnet/delete'), ok(fx('alldebrid', 'magnet-delete')));
    assert.equal(await alldebrid.cachedMagnet(providerSettings('alldebrid'), magnet(UNCACHED)), null);
    const [del] = fake.callsTo(v4('/magnet/delete'));
    assert.deepEqual(del.form, { id: '123456' });
    assert.equal(del.headers.authorization, `Bearer ${KEY}`);
    assert.equal(fake.callsTo(v4('/magnet/files')).length, 0);
  });

  test('cachedMagnet: an error after the upload deletes the magnet again, then shows the error', async () => {
    const fake = adSetup();
    fake.route('POST', v4('/magnet/upload'), ok(fx('alldebrid', 'magnet-upload-ready')));
    fake.route('POST', v4('/magnet/files'), status(503, { status: 'error', error: { code: 'LINK_HOST_UNAVAILABLE', message: 'try later' } }));
    fake.route('POST', v4('/magnet/delete'), ok(fx('alldebrid', 'magnet-delete')));
    await rejectsWith(alldebrid.cachedMagnet(providerSettings('alldebrid'), magnet(CACHED)), 'service_down', /^AllDebrid: /);
    assert.equal(fake.callsTo(v4('/magnet/delete')).length, 1);
  });

  test('cachedMagnet: an error on the magnet itself (inside the upload answer) names its cause, and nothing is deleted', async () => {
    for (const [errCode, code, pattern] of [
      ['MAGNET_MUST_BE_PREMIUM', 'account_expired', /^AllDebrid: .*(expired|premium)/],
      ['MAGNET_INVALID_URI', 'MAGNET_INVALID_URI', /^AllDebrid: The magnet is invalid/],
    ]) {
      const fake = adSetup();
      const body = fx('alldebrid', 'magnet-upload-ready');
      body.data.magnets[0] = { magnet: 'x', error: { code: errCode, message: 'The magnet is invalid' } };
      fake.route('POST', v4('/magnet/upload'), ok(body));
      await rejectsWith(alldebrid.cachedMagnet(providerSettings('alldebrid'), magnet(CACHED)), code, pattern);
      assert.equal(fake.callsTo(v4('/magnet/delete')).length, 0);
    }
  });

  test('cachedMagnet: a key refused after the upload sends no delete (the pause forbids another call)', async () => {
    const fake = adSetup();
    fake.route('POST', v4('/magnet/upload'), ok(fx('alldebrid', 'magnet-upload-ready')));
    fake.route('POST', v4('/magnet/files'), ok(fx('alldebrid', 'error-bad-apikey')));
    fake.route('POST', v4('/magnet/delete'), ok(fx('alldebrid', 'magnet-delete')));
    await rejectsWith(alldebrid.cachedMagnet(providerSettings('alldebrid'), magnet(CACHED)), 'auth_invalid', /invalid API key/);
    assert.equal(fake.callsTo(v4('/magnet/delete')).length, 0);
  });

  test('errors: bad key (HTTP 401 or 200), not premium and host limit name their cause; an echoed key is hidden', async () => {
    for (const [fixture, httpStatus, code, pattern] of [
      ['error-bad-apikey', 401, 'auth_invalid', /^AllDebrid: invalid API key/],
      ['error-bad-apikey', 200, 'auth_invalid', /^AllDebrid: invalid API key/],
      ['error-must-be-premium', 200, 'account_expired', /^AllDebrid: .*(expired|premium)/],
      ['error-host-limit', 200, 'limit_reached', /^AllDebrid: limit reached/],
    ]) {
      const fake = adSetup();
      const body = fx('alldebrid', fixture);
      fake.route('POST', v4('/link/unlock'), status(httpStatus, { ...body, error: { ...body.error, message: `${body.error.message} (${KEY})` } }));
      await rejectsWith(alldebrid.unrestrict(providerSettings('alldebrid'), RG), code, pattern, KEY);
    }
  });
});

describe('Premiumize', () => {
  const KEY = KEYS.premiumize;
  const api = (path) => `${PM}/api${path}`;

  test('hosts() is the directdl services and their aliases; a service only in cache or queue is not claimed', async () => {
    const fake = setup('premiumize');
    fake.route('GET', HOSTS.premiumize.url, ok(HOSTS.premiumize.body));
    const hosts = await premiumize.hosts(providerSettings('premiumize'));
    for (const d of ['1fichier.com', 'alterupload.com', 'cjoint.net', 'turbo.to', 'mediafire.com']) assert.ok(hosts.includes(d), d);
    assert.ok(!hosts.includes('rapidgator.net') && !hosts.includes('rg.to'));
  });

  test('unrestrict: POST /api/transfer/directdl with src and the Bearer key; the key is never in a query or a form', async () => {
    const fake = setup('premiumize');
    fake.route('GET', HOSTS.premiumize.url, ok(HOSTS.premiumize.body));
    fake.route('POST', api('/transfer/directdl'), ok(fx('premiumize', 'directdl-link')));
    const res = await premiumize.unrestrict(providerSettings('premiumize'), FICHIER);
    assert.deepEqual(res, { name: 'Some.File.mkv', size: 734003200, url: 'https://fake01.energycdn.com/dl/fake/Some.File.mkv', headers: {} });
    const [dl] = fake.callsTo(api('/transfer/directdl'));
    assert.equal(dl.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(dl.form, { src: FICHIER });
    for (const c of fake.calls) noSecret({ url: c.url, body: c.body }, KEY);
  });

  test('cachedMagnet: POST /api/cache/check with the hash, then directdl of the magnet gives every file', async () => {
    const fake = setup('premiumize');
    fake.route('POST', api('/cache/check'), ok(fx('premiumize', 'cache-check-hit')));
    fake.route('POST', api('/transfer/directdl'), ok(fx('premiumize', 'directdl-magnet')));
    const files = await premiumize.cachedMagnet(providerSettings('premiumize'), magnet(CACHED.toUpperCase()));
    assert.deepEqual(files, [
      { name: 'E01.mkv', size: 700000000, url: 'https://fake01.energycdn.com/dl/fake/E01.mkv', headers: {} },
      { name: 'E02.mkv', size: 600000000, url: 'https://fake01.energycdn.com/dl/fake/E02.mkv', headers: {} },
    ]);
    const [check] = fake.callsTo(api('/cache/check'));
    assert.deepEqual(check.form, { 'items[]': CACHED });
    assert.equal(check.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(fake.callsTo(api('/transfer/directdl'))[0].form, { src: magnet(CACHED.toUpperCase()) });
  });

  test('cachedMagnet: a cache miss gives null and asks for nothing else', async () => {
    const fake = setup('premiumize');
    fake.route('POST', api('/cache/check'), ok(fx('premiumize', 'cache-check-miss')));
    assert.equal(await premiumize.cachedMagnet(providerSettings('premiumize'), magnet(UNCACHED)), null);
    assert.equal(fake.calls.length, 1);
  });

  test('errors come as HTTP 200 envelopes: invalid key, not premium and limit reached name their cause', async () => {
    for (const [fixture, code, pattern] of [
      ['error-auth', 'auth_invalid', /^Premiumize: invalid API key/],
      ['error-permission-denied', 'account_expired', /^Premiumize: .*(expired|premium)/],
      ['error-limit', 'limit_reached', /^Premiumize: limit reached/],
    ]) {
      const fake = setup('premiumize');
      fake.route('GET', HOSTS.premiumize.url, ok(HOSTS.premiumize.body));
      fake.route('POST', api('/transfer/directdl'), ok({ ...fx('premiumize', fixture), message: `apikey=${KEY} refused` }));
      await rejectsWith(premiumize.unrestrict(providerSettings('premiumize'), FICHIER), code, pattern, KEY);
    }
  });
});

describe('Premiumize: an error answer without a code', () => {
  test('"Not logged in." is a refused key (auth_invalid, and it pauses the provider)', async () => {
    const fake = setup('premiumize');
    fake.route('GET', HOSTS.premiumize.url, ok(HOSTS.premiumize.body));
    fake.route('POST', `${PM}/api/transfer/directdl`, ok({ status: 'error', message: 'Not logged in.' }));
    await rejectsWith(premiumize.unrestrict(providerSettings('premiumize'), FICHIER), 'auth_invalid', /^Premiumize: invalid API key/);
    await rejectsWith(premiumize.unrestrict(providerSettings('premiumize'), FICHIER), 'cooldown', /10 more minutes/);
  });

  test('an unknown error shows the provider text, with the title in front', async () => {
    const fake = setup('premiumize');
    fake.route('GET', HOSTS.premiumize.url, ok(HOSTS.premiumize.body));
    fake.route('POST', `${PM}/api/transfer/directdl`, ok({ status: 'error', message: 'Something odd happened.', code: 'weird_thing' }));
    await rejectsWith(premiumize.unrestrict(providerSettings('premiumize'), FICHIER), 'weird_thing', /^Premiumize: Something odd happened\.$/);
  });
});

describe('login cooldown (10 minutes after a refused credential)', () => {
  const tb = (path) => `${TB}/v1/api${path}`;

  function tbSetup() {
    const fake = setup('torbox');
    fake.route('GET', HOSTS.torbox.url, ok(HOSTS.torbox.body));
    fake.route('POST', tb('/webdl/createwebdownload'), status(401, fx('torbox', 'error-bad-token')));
    return fake;
  }

  test('a refused key pauses the provider for 10 minutes and says so; nothing is sent meanwhile', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = tbSetup();
    await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), 'auth_invalid', /invalid API key/);
    const sent = fake.calls.length;
    await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), 'cooldown', /^TorBox: invalid API key.*10 more minutes/);
    await rejectsWith(torbox.cachedMagnet(providerSettings('torbox'), magnet(CACHED)), 'cooldown', /10 more minutes/);
    t.mock.timers.tick(4 * MIN);
    await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), 'cooldown', /6 more minutes/);
    assert.equal(fake.calls.length, sent, 'no request during the pause');
    const raw = fake.storage.map.get('cooldown:torbox');
    assert.ok(raw, 'kept under cooldown:torbox');
    noSecret(raw, KEYS.torbox);
    t.mock.timers.tick(6 * MIN);
    await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), 'auth_invalid', /invalid API key/);
    assert.equal(fake.callsTo(tb('/webdl/createwebdownload')).length, 2, 'asked again after 10 minutes, once');
  });

  test('a changed key ends the pause at once', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = tbSetup();
    await assert.rejects(torbox.unrestrict(providerSettings('torbox'), RG));
    fake.settings.torbox_apikey = 'FAKE-TORBOX-KEY-0002';
    await rejectsWith(torbox.unrestrict(providerSettings('torbox'), RG), 'auth_invalid', /invalid API key/);
    assert.equal(fake.callsTo(tb('/webdl/createwebdownload')).length, 2);
    assert.equal(fake.callsTo(tb('/webdl/createwebdownload'))[1].headers.authorization, 'Bearer FAKE-TORBOX-KEY-0002');
  });

  test('a refused key in an HTTP 200 envelope pauses too; a not-premium answer does not', async () => {
    const fake = setup('alldebrid');
    fake.route('GET', HOSTS.alldebrid.url, ok(HOSTS.alldebrid.body));
    fake.route('POST', `${AD}/v4/link/unlock`, ok(fx('alldebrid', 'error-must-be-premium')));
    await rejectsWith(alldebrid.unrestrict(providerSettings('alldebrid'), RG), 'account_expired', /premium/);
    await rejectsWith(alldebrid.unrestrict(providerSettings('alldebrid'), RG), 'account_expired', /premium/);
    fake.route('POST', `${AD}/v4/link/unlock`, ok(fx('alldebrid', 'error-bad-apikey')));
    await rejectsWith(alldebrid.unrestrict(providerSettings('alldebrid'), RG), 'auth_invalid', /invalid API key/);
    await rejectsWith(alldebrid.unrestrict(providerSettings('alldebrid'), RG), 'cooldown', /10 more minutes/);
    assert.equal(fake.callsTo(`${AD}/v4/link/unlock`).length, 3);
  });

  test('AllDebrid sends its key for the host list, so a refused key there pauses it and hosts() respects the pause', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = setup('alldebrid');
    fake.route('GET', HOSTS.alldebrid.url, status(401, fx('alldebrid', 'error-bad-apikey')));
    await rejectsWith(alldebrid.hosts(providerSettings('alldebrid')), 'auth_invalid', /^AllDebrid: invalid API key/);
    await rejectsWith(alldebrid.hosts(providerSettings('alldebrid')), 'cooldown', /10 more minutes/);
    await rejectsWith(alldebrid.unrestrict(providerSettings('alldebrid'), RG), 'cooldown', /10 more minutes/);
    assert.equal(fake.calls.length, 1, 'one request, then the pause');
  });

  test('the host list is not paused, so claiming keeps working', async () => {
    const fake = tbSetup();
    await assert.rejects(torbox.unrestrict(providerSettings('torbox'), RG));
    fake.storage.map.delete('hosts:torbox');
    assert.equal(await torbox.unrestrict(providerSettings('torbox'), OTHER), null);
    assert.equal(fake.callsTo(HOSTS.torbox.url).length, 2);
  });
});
