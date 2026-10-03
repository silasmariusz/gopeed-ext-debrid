// The Polish multihosters (Rapideo, NoPremium, Twojlimit: one REST API) and the premium hoster accounts (1fichier,
// Rapidgator, Nitroflare), plus the registry and the pure-JS TOTP for Rapidgator's two-factor login.
//
// Fixtures follow the shapes in docs/notes/2026-10-02-hoster-apis.md. Credentials and tokens are obvious fakes, and a
// message marked "fake fixture text" is not a service's real wording.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeGopeed } from './fake-gopeed.js';
import { ProviderError } from '../src/lib/http.js';
import { providerSettings } from '../src/lib/settings.js';
import { cooldownLeft } from '../src/lib/cooldown.js';
import { sha1Hex, hmacSha1, base32Decode, totp } from '../src/lib/totp.js';
import { PROVIDERS } from '../src/providers/index.js';
import rapideo from '../src/providers/rapideo.js';
import nopremium from '../src/providers/nopremium.js';
import twojlimit from '../src/providers/twojlimit.js';
import onefichier from '../src/providers/onefichier.js';
import rapidgator from '../src/providers/rapidgator.js';
import nitroflare from '../src/providers/nitroflare.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 2, 18, 0, 0);
const MASK = '••••';

const RG_LINK = 'https://rapidgator.net/file/abc123/Some.File.mkv.html';
const FICHIER_LINK = 'https://1fichier.com/?abc123def456';
const NF_LINK = 'https://nitroflare.com/view/ABC123XYZ/Some.File.rar';
const OTHER = 'https://example.com/files/plain.bin';
const MAGNET = 'magnet:?xt=urn:btih:c0ffee1234567890abcdef1234567890abcdef12&dn=Fake';

const fx = (id, name) => JSON.parse(readFileSync(new URL(`./fixtures/${id}/${name}.json`, import.meta.url), 'utf8'));
const ok = (json) => () => ({ status: 200, json });
const status = (code, json) => () => ({ status: code, json });
// Answers in turn, the last one again once the list is used up.
const seq = (...answers) => {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)]();
};

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

async function rejectsWith(promise, code, pattern, secrets = []) {
  let caught;
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ProviderError, `not a ProviderError: ${err && err.stack}`);
    assert.equal(err.code, code, `code of "${err.message}"`);
    assert.match(err.message, pattern);
    for (const s of secrets) noSecret({ message: err.message, reason: err.reason, body: err.body, code: err.code, stack: err.stack }, s);
    caught = err;
    return true;
  });
  return caught;
}

// ---------------------------------------------------------------------------------------------------------------
// TOTP

describe('totp.js (RFC 6238, HMAC-SHA1, pure JS)', () => {
  test('SHA-1 matches the FIPS 180 vectors', () => {
    const bytes = (s) => Array.from(Buffer.from(s, 'utf8'));
    assert.equal(sha1Hex(bytes('')), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
    assert.equal(sha1Hex(bytes('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(sha1Hex(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '84983e441c3bd26ebaae4aa1f95129e5e54670f1');
    assert.equal(sha1Hex(bytes('a'.repeat(1000))), '291e9a6c66994949b57ba5e650361e98fc36b1ba');
  });

  test('HMAC-SHA1 matches RFC 2202, with a short and a longer-than-block key', () => {
    const hex = (arr) => Buffer.from(arr).toString('hex');
    const bytes = (s) => Array.from(Buffer.from(s, 'utf8'));
    assert.equal(hex(hmacSha1(new Array(20).fill(0x0b), bytes('Hi There'))), 'b617318655057264e28bc0b6fb378c8ef146be00');
    assert.equal(hex(hmacSha1(bytes('Jefe'), bytes('what do ya want for nothing?'))), 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
    assert.equal(hex(hmacSha1(new Array(80).fill(0xaa), bytes('Test Using Larger Than Block-Size Key - Hash Key First'))),
      'aa4ae5e15272d00e95705637ce8a3b55ed402112');
  });

  test('base32 decodes the RFC secret, lower case, spaces and padding; anything else is null', () => {
    const rfc = Array.from(Buffer.from('12345678901234567890', 'ascii'));
    assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), rfc);
    assert.deepEqual(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), rfc);
    assert.deepEqual(base32Decode('JBSWY3DPEHPK3PXP===='), Array.from(Buffer.from('48656c6c6f21deadbeef', 'hex')));
    assert.equal(base32Decode('GEZ1'), null, 'the digit 1 is not base32');
    assert.equal(base32Decode(''), null);
    assert.equal(base32Decode('  '), null);
  });

  test('the RFC 6238 SHA-1 vectors, 8 digits and their last 6 digits', () => {
    const key = Array.from(Buffer.from('12345678901234567890', 'ascii'));
    const vectors = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
      // Beyond the RFC: counters of 2^32 and more fill the high word of the 8-byte counter (values from Python hmac).
      [128849018939, '39108930'],
      [257698037760, '11166590'],
    ];
    for (const [seconds, code] of vectors) {
      assert.equal(totp(key, seconds * 1000, { digits: 8 }), code, `T=${seconds}`);
      assert.equal(totp(key, seconds * 1000), code.slice(2), `T=${seconds}, 6 digits`);
    }
  });

  test('the code changes every 30 s (values from Python hmac)', () => {
    const key = base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    assert.equal(totp(key, T0), '412191');
    assert.equal(totp(key, T0 + 29999), '412191');
    assert.equal(totp(key, T0 + 30000), '970177');
    assert.equal(totp(base32Decode('JBSWY3DPEHPK3PXP'), T0), '728107');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Registry, shape and manifest

const NEW = { rapideo, nopremium, twojlimit, onefichier, rapidgator, nitroflare };
const NEW_IDS = ['rapideo', 'nopremium', 'twojlimit', 'onefichier', 'rapidgator', 'nitroflare'];

describe('registry, shape and manifest', () => {
  test('PROVIDERS is debrid first (Task 3 order), then rapideo, nopremium, twojlimit, onefichier, rapidgator, nitroflare', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const order = manifest.settings.find((s) => s.name === 'order').value.split(',');
    const ids = ['torbox', 'alldebrid', 'premiumize', 'realdebrid', 'debridlink', ...NEW_IDS];
    assert.deepEqual(PROVIDERS.map((p) => p.id), ids);
    assert.deepEqual(order, ids);
    assert.deepEqual(PROVIDERS.slice(5), NEW_IDS.map((id) => NEW[id]));
  });

  test('each new module has the provider shape, its kind, its host root as base and its link lifetime', () => {
    const expect = {
      rapideo: ['Rapideo', 'multihoster', 'https://www.rapideo.pl', 3 * HOUR],
      nopremium: ['NoPremium', 'multihoster', 'https://www.nopremium.pl', 3 * HOUR],
      twojlimit: ['Twojlimit', 'multihoster', 'https://www.twojlimit.pl', 3 * HOUR],
      onefichier: ['1fichier', 'hoster', 'https://api.1fichier.com', 5 * MIN],
      rapidgator: ['Rapidgator', 'hoster', 'https://rapidgator.net', 3 * HOUR],
      nitroflare: ['Nitroflare', 'hoster', 'https://nitroflare.com', 3 * HOUR],
    };
    for (const id of NEW_IDS) {
      const p = NEW[id];
      const [title, kind, base, ttl] = expect[id];
      assert.equal(p.id, id);
      assert.equal(p.title, title, id);
      assert.equal(p.kind, kind, id);
      assert.equal(p.base, base, id);
      assert.equal(p.linkTTLms, ttl, id);
      for (const fn of ['enabled', 'hosts', 'unrestrict', 'cachedMagnet']) assert.equal(typeof p[fn], 'function', `${id}.${fn}`);
    }
  });

  test('enabled() needs the switch and every credential; the 2FA secret is optional', () => {
    const creds = {
      rapideo: { login: 'l', password: 'p' },
      nopremium: { login: 'l', password: 'p' },
      twojlimit: { login: 'l', password: 'p' },
      onefichier: { apikey: 'k' },
      rapidgator: { login: 'l', password: 'p' },
      nitroflare: { user: 'u', premium_key: 'k' },
    };
    for (const id of NEW_IDS) {
      const p = NEW[id];
      assert.equal(p.enabled({ enabled: true, ...creds[id] }), true, id);
      assert.equal(p.enabled({ enabled: false, ...creds[id] }), false, id);
      for (const name of Object.keys(creds[id])) {
        assert.equal(p.enabled({ enabled: true, ...creds[id], [name]: '' }), false, `${id} without ${name}`);
      }
    }
  });

  test('cachedMagnet is null for all six, and sends nothing', async () => {
    const fake = installFakeGopeed();
    for (const id of NEW_IDS) assert.equal(await NEW[id].cachedMagnet({ enabled: true }, MAGNET), null, id);
    assert.equal(fake.calls.length, 0);
  });

  test('the manifest has every credential setting the note names, the 2FA secret, and the switches', () => {
    const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    const byName = Object.fromEntries(manifest.settings.map((s) => [s.name, s]));
    const fields = ['rapideo_login', 'rapideo_password', 'nopremium_login', 'nopremium_password', 'twojlimit_login', 'twojlimit_password',
      'onefichier_apikey', 'rapidgator_login', 'rapidgator_password', 'rapidgator_2fa_secret', 'nitroflare_user', 'nitroflare_premium_key'];
    for (const f of fields) assert.equal(byName[f] && byName[f].type, 'string', f);
    for (const id of NEW_IDS) {
      assert.equal(byName[`${id}_enabled`].type, 'boolean', id);
      assert.equal(byName[`${id}_enabled`].value, false, id);
    }
    assert.equal(byName.rapidgator_2fa_secret.description, 'optional: the base32 secret of your Rapidgator two-factor app');
    const names = manifest.settings.map((s) => s.name);
    assert.equal(names.indexOf('rapidgator_2fa_secret'), names.indexOf('rapidgator_password') + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Polish REST API, for each of the three services

const POLISH = {
  rapideo: { title: 'Rapideo', base: 'https://www.rapideo.pl', claims: 'https://filefactory.com/file/x' },
  nopremium: { title: 'NoPremium', base: 'https://www.nopremium.pl', claims: 'https://turbobit.net/x.html' },
  twojlimit: { title: 'Twojlimit', base: 'https://www.twojlimit.pl', claims: 'https://katfile.com/x' },
};
const PL_LOGIN = 'fake.polish.login';
const PL_PASS = 'FAKE-POLISH-PASSWORD-0001';
const TOKEN1 = 'FAKE-POLISH-AUTHTOKEN-0001';
const TOKEN2 = 'FAKE-POLISH-AUTHTOKEN-0002';

for (const id of Object.keys(POLISH)) {
  const { title, base, claims } = POLISH[id];
  const p = NEW[id];
  const REST = `${base}/api/rest`;

  function setupPL(extra = {}) {
    const fake = installFakeGopeed({
      settings: { [`${id}_enabled`]: true, [`${id}_login`]: PL_LOGIN, [`${id}_password`]: PL_PASS, ...extra },
    });
    fake.route('GET', `${base}/clipboard.php`, ok(fx(id, 'clipboard')));
    return fake;
  }
  function happy(fake) {
    fake.route('POST', `${REST}/login`, ok(fx('rapideo', 'login')));
    fake.route('POST', `${REST}/files/check`, ok(fx('rapideo', 'files-check')));
    fake.route('POST', `${REST}/files/download`, ok(fx('rapideo', 'files-download')));
  }
  const s = () => providerSettings(id);
  const restCalls = (fake) => fake.calls.filter((c) => c.url.startsWith(REST));

  describe(`${title} (Polish REST API)`, () => {
    test('hosts() reads clipboard.php?json=3 with no credential, keeps every entry with a domain (sdownload ignored), 24 h', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = setupPL();
      const list = await p.hosts(s());
      for (const d of ['rapidgator.net', 'rg.to', '1fichier.com', 'alterupload.com', 'nitroflare.com']) assert.ok(list.includes(d), d);
      assert.ok(list.includes(new URL(claims).hostname), 'its own extra entry');
      assert.ok(!list.includes(''), 'the blank torrent domain is dropped');
      assert.equal(fake.calls.length, 1);
      const [c] = fake.calls;
      assert.equal(c.method, 'GET');
      assert.equal(c.url, `${base}/clipboard.php?json=3`);
      assert.equal(c.headers.authorization, undefined);
      noSecret(c, PL_PASS);
      await p.hosts(s());
      assert.equal(fake.calls.length, 1, 'cached');
      t.mock.timers.tick(24 * HOUR);
      await p.hosts(s());
      assert.equal(fake.calls.length, 2, 'loaded again after 24 h');
    });

    test('unrestrict: login, files/check, files/download (device gopeed-ext-debrid, mode qnap), mapped to the file', async () => {
      const fake = setupPL();
      happy(fake);
      const got = await p.unrestrict(s(), RG_LINK);
      assert.deepEqual(got, { name: 'Some.File.Full.Name.mkv', size: 734003200, url: 'https://dl.example.invalid/fake/Some.File.Full.Name.mkv', headers: {} });
      const calls = restCalls(fake);
      assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${REST}/login`, `POST ${REST}/files/check`, `POST ${REST}/files/download`]);
      assert.deepEqual(calls[0].json, { login: PL_LOGIN, password: PL_PASS, device: 'gopeed-ext-debrid', version: 1 });
      assert.deepEqual(calls[1].json, { authtoken: TOKEN1, url: RG_LINK, device: 'gopeed-ext-debrid', version: 1 });
      assert.deepEqual(calls[2].json, { authtoken: TOKEN1, hash: 'fakehash0001', mode: 'qnap', device: 'gopeed-ext-debrid', version: 1 });
      for (const c of calls) {
        assert.equal(c.headers['content-type'], 'application/json');
        assert.ok(!c.url.includes('?'), 'nothing in the query string');
        assert.notEqual(c.json.device, 'qnap');
      }
    });

    test('the authtoken is kept under session:<id> and reused: two unrestricts make one login', async () => {
      const fake = setupPL();
      happy(fake);
      await p.unrestrict(s(), RG_LINK);
      await p.unrestrict(s(), FICHIER_LINK);
      assert.equal(fake.callsTo(`${REST}/login`).length, 1);
      assert.equal(fake.callsTo(`${REST}/files/check`).length, 2);
      const stored = fake.storage.map.get(`session:${id}`);
      assert.ok(stored && stored.includes(TOKEN1));
      noSecret(stored, PL_PASS);
    });

    test('a stored token of another login is not used', async () => {
      const fake = setupPL();
      happy(fake);
      await p.unrestrict(s(), RG_LINK);
      fake.settings[`${id}_login`] = 'another.fake.login';
      await p.unrestrict(s(), RG_LINK);
      assert.equal(fake.callsTo(`${REST}/login`).length, 2);
      assert.equal(fake.callsTo(`${REST}/login`)[1].json.login, 'another.fake.login');
    });

    test('error 1 (bad token) drops the token, logs in once and repeats the call once, with no pause', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/login`, seq(ok(fx('rapideo', 'login')), ok(fx('rapideo', 'login-second'))));
      await p.unrestrict(s(), RG_LINK);
      // The stored token goes stale: the next check answers error 1 once (as HTTP 401 here, the status is not documented).
      fake.route('POST', `${REST}/files/check`, seq(status(401, fx('rapideo', 'error-authtoken')), ok(fx('rapideo', 'files-check'))));
      const got = await p.unrestrict(s(), RG_LINK);
      assert.equal(got.url, 'https://dl.example.invalid/fake/Some.File.Full.Name.mkv');
      assert.equal(fake.callsTo(`${REST}/login`).length, 2);
      const checks = fake.callsTo(`${REST}/files/check`);
      assert.deepEqual(checks.map((c) => c.json.authtoken), [TOKEN1, TOKEN1, TOKEN2]);
      assert.equal(fake.callsTo(`${REST}/files/download`).at(-1).json.authtoken, TOKEN2);
      assert.equal(await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`), null);
      assert.ok(fake.storage.map.get(`session:${id}`).includes(TOKEN2));
    });

    test('error 1 again right after a new login: the token is dropped and the provider pauses, no second login', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/files/check`, ok(fx('rapideo', 'error-authtoken')));
      await fake.storage.set(`session:${id}`, JSON.stringify({ v: { login: PL_LOGIN, token: 'FAKE-POLISH-OLD-TOKEN' }, exp: Date.now() + HOUR }));
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'auth_invalid', new RegExp(`^${title}: the service refused a new session$`),
        [PL_PASS, TOKEN1, 'FAKE-POLISH-OLD-TOKEN']);
      assert.equal(fake.callsTo(`${REST}/login`).length, 1, 'one login after the stored token was refused');
      assert.deepEqual(fake.callsTo(`${REST}/files/check`).map((c) => c.json.authtoken), ['FAKE-POLISH-OLD-TOKEN', TOKEN1]);
      assert.equal(fake.storage.map.has(`session:${id}`), false);
      assert.ok(await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`));
    });

    test('one unrestrict logs in at most once: a re-login token refused again at files/download pauses', async () => {
      const fake = setupPL();
      happy(fake);
      await fake.storage.set(`session:${id}`, JSON.stringify({ v: { login: PL_LOGIN, token: 'FAKE-POLISH-OLD-TOKEN' }, exp: Date.now() + HOUR }));
      fake.route('POST', `${REST}/files/check`, seq(ok(fx('rapideo', 'error-authtoken')), ok(fx('rapideo', 'files-check'))));
      fake.route('POST', `${REST}/files/download`, ok(fx('rapideo', 'error-authtoken')));
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'auth_invalid', new RegExp(`^${title}: the service refused a new session$`), [PL_PASS, TOKEN1]);
      assert.equal(fake.callsTo(`${REST}/login`).length, 1);
      assert.equal(fake.callsTo(`${REST}/files/download`).length, 1);
      assert.ok(await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`));
    });

    test('concurrent unrestricts share one login', async () => {
      const fake = setupPL();
      happy(fake);
      const got = await Promise.all([p.unrestrict(s(), RG_LINK), p.unrestrict(s(), FICHIER_LINK), p.unrestrict(s(), RG_LINK)]);
      assert.equal(got.length, 3);
      assert.equal(fake.callsTo(`${REST}/login`).length, 1);
      assert.deepEqual(fake.callsTo(`${REST}/files/check`).map((c) => c.json.authtoken), [TOKEN1, TOKEN1, TOKEN1]);
    });

    test('an unknown error number at login pauses for 10 minutes with the service\'s text, and is not retried', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/login`, ok({ error: 9, message: 'Account blocked (fake fixture text)' }));
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'auth_invalid', new RegExp(`^${title}: Account blocked \\(fake fixture text\\)$`), [PL_PASS]);
      assert.equal((await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`)).minutes, 10);
      const before = fake.calls.length;
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'cooldown', /Account blocked/);
      assert.equal(fake.calls.length, before);
    });

    test('a 5xx at login is no refusal, whatever its body: no pause', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/login`, status(503, { error: 9, message: 'Maintenance (fake fixture text)' }));
      await assert.rejects(p.unrestrict(s(), RG_LINK), (e) => e.code !== 'auth_invalid' && e.code !== 'cooldown');
      assert.equal(await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`), null);
    });

    test('a token refused right after its first login is not followed by another login', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/files/check`, ok(fx('rapideo', 'error-authtoken')));
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'auth_invalid', new RegExp(`^${title}: `), [PL_PASS, TOKEN1]);
      assert.equal(fake.callsTo(`${REST}/login`).length, 1);
      assert.equal(fake.callsTo(`${REST}/files/check`).length, 1);
    });

    test(`a wrong password (error 3) gives "${title}: wrong login or password" and the 10-minute pause`, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/login`, ok(fx('rapideo', 'error-login')));
      const err = await rejectsWith(p.unrestrict(s(), RG_LINK), 'auth_invalid', new RegExp(`^${title}: wrong login or password$`), [PL_PASS]);
      assert.equal(err.reason, 'wrong login or password');
      assert.equal((await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`)).minutes, 10);
      const before = fake.calls.length;
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'cooldown', /wrong login or password, not retrying for 10 more minutes/);
      assert.equal(fake.calls.length, before, 'nothing sent during the pause');
      fake.settings[`${id}_password`] = 'FAKE-POLISH-PASSWORD-0002';
      fake.route('POST', `${REST}/login`, ok(fx('rapideo', 'login')));
      assert.ok(await p.unrestrict(s(), RG_LINK), 'a changed password ends the pause');
    });

    test('a locked login (error 4) pauses for the 60 minutes the API names', async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: T0 });
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/login`, ok(fx('rapideo', 'error-locked')));
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'auth_invalid', new RegExp(`^${title}: .*locked for 60 minutes`), [PL_PASS]);
      assert.equal((await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`)).minutes, 60);
      t.mock.timers.tick(59 * MIN);
      const before = fake.calls.length;
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'cooldown', /not retrying for 1 more minute /);
      assert.equal(fake.calls.length, before);
      t.mock.timers.tick(MIN);
      assert.equal(await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`), null);
    });

    test('out of transfer: the per-file message is shown with the title, and nothing pauses', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/files/check`, ok(fx('rapideo', 'error-file-transfer')));
      const err = await rejectsWith(p.unrestrict(s(), RG_LINK), '2', new RegExp(`^${title}: Not enough transfer left`), [PL_PASS, TOKEN1]);
      assert.equal(err.reason, 'Not enough transfer left for this file (fake fixture text)');
      assert.equal(await cooldownLeft(id, `${PL_LOGIN}\u0000${PL_PASS}`), null);
      assert.equal(fake.callsTo(`${REST}/files/download`).length, 0);
    });

    test('per-file error 15 (host not supported) is not_supported, so the next provider is asked', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/files/check`, ok(fx('rapideo', 'error-file-unsupported')));
      await rejectsWith(p.unrestrict(s(), RG_LINK), 'not_supported', new RegExp(`^${title}: this host is not supported$`));
    });

    test('a link of another hoster gives null, with no REST call; so does a magnet', async () => {
      const fake = setupPL();
      happy(fake);
      assert.equal(await p.unrestrict(s(), OTHER), null);
      assert.equal(await p.unrestrict(s(), MAGNET), null);
      assert.equal(restCalls(fake).length, 0);
    });

    test('the password and the authtoken never reach an error, even when the service echoes them', async () => {
      const fake = setupPL();
      happy(fake);
      fake.route('POST', `${REST}/files/download`, status(400, { error: 77, message: `bad request for ${TOKEN1} and ${PL_PASS}` }));
      const err = await rejectsWith(p.unrestrict(s(), RG_LINK), '77', /bad request for/, [PL_PASS, TOKEN1]);
      assert.ok(err.message.includes(MASK));
    });

    test('advanced_api_base sends the REST calls and the host list to <base>/<id>/...', async () => {
      const fake = setupPL({ advanced_api_base: 'http://127.0.0.1:18990/' });
      const MOCK = `http://127.0.0.1:18990/${id}`;
      fake.route('GET', `${MOCK}/clipboard.php`, ok(fx(id, 'clipboard')));
      fake.route('POST', `${MOCK}/api/rest/login`, ok(fx('rapideo', 'login')));
      fake.route('POST', `${MOCK}/api/rest/files/check`, ok(fx('rapideo', 'files-check')));
      fake.route('POST', `${MOCK}/api/rest/files/download`, ok(fx('rapideo', 'files-download')));
      assert.ok(await p.unrestrict(s(), RG_LINK));
      assert.ok(fake.calls.every((c) => c.url.startsWith(MOCK)), fake.calls.map((c) => c.url).join(' '));
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 1fichier

describe('1fichier', () => {
  const API = 'https://api.1fichier.com/v1';
  const KEY = 'FAKE-1FICHIER-KEY-0001';
  function setup1F() {
    return installFakeGopeed({ settings: { onefichier_enabled: true, onefichier_apikey: KEY } });
  }
  const s = () => providerSettings('onefichier');

  test('hosts() is 1fichier\'s own domains, with no network call', async () => {
    const fake = setup1F();
    const list = await onefichier.hosts(s());
    for (const d of ['1fichier.com', 'alterupload.com', 'cjoint.net', 'desfichiers.com', 'dfichiers.com', 'dl4free.com', 'megadl.fr',
      'mesfichiers.org', 'piecejointe.net', 'pjointe.com', 'tenvoi.com']) assert.ok(list.includes(d), d);
    assert.equal(fake.calls.length, 0);
  });

  test('unrestrict: get_token.cgi with the Bearer key, then file/info.cgi once for the name and size', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, ok(fx('onefichier', 'get-token')));
    fake.route('POST', `${API}/file/info.cgi`, ok(fx('onefichier', 'file-info')));
    const got = await onefichier.unrestrict(s(), FICHIER_LINK);
    assert.deepEqual(got, { name: 'Some.File.mkv', size: 524288000, url: 'https://a-1.1fichier.com/fake-token-url/Some.File.mkv', headers: {} });
    assert.equal(fake.calls.length, 2);
    for (const c of fake.calls) {
      assert.equal(c.headers.authorization, `Bearer ${KEY}`);
      assert.deepEqual(c.json, { url: FICHIER_LINK });
    }
  });

  test('the https://<id>.1fichier.com/ form is claimed too', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, ok(fx('onefichier', 'get-token')));
    fake.route('POST', `${API}/file/info.cgi`, ok(fx('onefichier', 'file-info')));
    assert.ok(await onefichier.unrestrict(s(), 'https://abc123def456.1fichier.com/'));
  });

  test('a failing file/info.cgi is not fatal: the link comes without name and size, and nothing pauses', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, ok(fx('onefichier', 'get-token')));
    fake.route('POST', `${API}/file/info.cgi`, status(401, fx('onefichier', 'error-401')));
    const got = await onefichier.unrestrict(s(), FICHIER_LINK);
    assert.deepEqual(got, { name: '', size: 0, url: 'https://a-1.1fichier.com/fake-token-url/Some.File.mkv', headers: {} });
    assert.equal(fake.callsTo(`${API}/file/info.cgi`).length, 1);
    assert.equal(await cooldownLeft('onefichier', KEY), null);
  });

  test('a wrong key (HTTP 401) gives "1fichier: invalid API key" and pauses; the next call sends nothing', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, status(401, fx('onefichier', 'error-401')));
    await rejectsWith(onefichier.unrestrict(s(), FICHIER_LINK), 'auth_invalid', /^1fichier: invalid API key$/, [KEY]);
    assert.equal(fake.calls.length, 1, 'no file/info.cgi after a failure');
    await rejectsWith(onefichier.unrestrict(s(), FICHIER_LINK), 'cooldown', /^1fichier: invalid API key, not retrying/);
    assert.equal(fake.calls.length, 1);
  });

  test('HTTP 403 pauses too (repeated 403s ban the IP), and names the non-premium account', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, status(403, { status: 'KO', message: 'Forbidden (fake fixture text)' }));
    await rejectsWith(onefichier.unrestrict(s(), FICHIER_LINK), 'auth_invalid', /^1fichier: .*HTTP 403.*not premium/, [KEY]);
    assert.ok(await cooldownLeft('onefichier', KEY));
  });

  test('a 403 that is not JSON (a block page) is ip_not_allowed with the common wording, and no pause', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, () => ({ status: 403, text: '<html><title>Attention Required</title></html>' }));
    await rejectsWith(onefichier.unrestrict(s(), FICHIER_LINK), 'ip_not_allowed',
      /^1fichier: blocked by the service's protection \(HTTP 403\); a VPN or datacenter address is often refused$/, [KEY]);
    assert.equal(await cooldownLeft('onefichier', KEY), null);
    assert.equal(fake.calls.length, 1);
  });

  test('HTTP 404 and 410 are a dead link, with no pause', async () => {
    for (const code of [404, 410]) {
      const fake = setup1F();
      fake.route('POST', `${API}/download/get_token.cgi`, status(code, { status: 'KO', message: 'Resource not found #469' }));
      await rejectsWith(onefichier.unrestrict(s(), FICHIER_LINK), 'dead_link', /^1fichier: the link is dead/);
      assert.equal(await cooldownLeft('onefichier', KEY), null);
      assert.equal(fake.calls.length, 1);
    }
  });

  test('a KO answer (here the traffic limit) shows 1fichier\'s message with the title', async () => {
    const fake = setup1F();
    fake.route('POST', `${API}/download/get_token.cgi`, ok(fx('onefichier', 'error-ko-traffic')));
    await rejectsWith(onefichier.unrestrict(s(), FICHIER_LINK), 'error', /^1fichier: Traffic limit reached \(fake fixture text\)$/, [KEY]);
    assert.equal(fake.calls.length, 1);
  });

  test('a link of another hoster gives null, with no call', async () => {
    const fake = setup1F();
    assert.equal(await onefichier.unrestrict(s(), RG_LINK), null);
    assert.equal(fake.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Rapidgator

describe('Rapidgator', () => {
  const API = 'https://rapidgator.net/api/v2';
  const LOGIN = 'fake.user@example.invalid';
  const PASS = 'FAKE-RG-PASSWORD-0001';
  const SECRET = 'jbsw y3dp ehpk 3pxp'; // a well-known demo secret, written the way an app groups it
  const RGT1 = 'FAKE-RG-TOKEN-0001';
  const RGT2 = 'FAKE-RG-TOKEN-0002';
  const CRED = `${LOGIN}\u0000${PASS}\u0000`;
  function setupRG(extra = {}) {
    return installFakeGopeed({ settings: { rapidgator_enabled: true, rapidgator_login: LOGIN, rapidgator_password: PASS, ...extra } });
  }
  function happy(fake) {
    fake.route('POST', `${API}/user/login`, seq(ok(fx('rapidgator', 'login')), ok(fx('rapidgator', 'login-second'))));
    fake.route('POST', `${API}/file/download`, ok(fx('rapidgator', 'file-download')));
  }
  const s = () => providerSettings('rapidgator');

  test('hosts() is rapidgator.net, rapidgator.asia and rg.to, with no network call', async () => {
    const fake = setupRG();
    assert.deepEqual((await rapidgator.hosts(s())).sort(), ['rapidgator.asia', 'rapidgator.net', 'rg.to']);
    assert.equal(fake.calls.length, 0);
  });

  test('unrestrict: user/login (password in a POST form, no code without a secret), then file/download', async () => {
    const fake = setupRG();
    happy(fake);
    const got = await rapidgator.unrestrict(s(), RG_LINK);
    assert.deepEqual(got, { name: 'Some.File.mkv', size: 0, url: 'http://pr3.rapidgator.net//?r=download/index&session_id=FAKESESSION0001', headers: {} });
    assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.url}`), [`POST ${API}/user/login`, `POST ${API}/file/download`]);
    assert.deepEqual(fake.calls[0].form, { login: LOGIN, password: PASS });
    assert.deepEqual(fake.calls[1].form, { token: RGT1, file_id: 'abc123' });
    for (const c of fake.calls) noSecret(c.url, PASS);
  });

  test('with a 2FA secret the login sends the current TOTP code', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = setupRG({ rapidgator_2fa_secret: SECRET });
    happy(fake);
    await rapidgator.unrestrict(s(), 'https://rg.to/file/abc123');
    assert.deepEqual(fake.calls[0].form, { login: LOGIN, password: PASS, code: '728107' });
  });

  test('a 2FA secret that is not base32 fails before any request', async () => {
    const fake = setupRG({ rapidgator_2fa_secret: 'not-base32!' });
    happy(fake);
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'auth_invalid', /^Rapidgator: the 2FA secret is not a base32 secret/, ['not-base32!']);
    assert.equal(fake.calls.length, 0);
  });

  test('the token is kept under session:rapidgator and reused: two unrestricts make one login', async () => {
    const fake = setupRG();
    happy(fake);
    await rapidgator.unrestrict(s(), RG_LINK);
    await rapidgator.unrestrict(s(), 'https://rapidgator.net/file/def456');
    assert.equal(fake.callsTo(`${API}/user/login`).length, 1);
    assert.deepEqual(fake.callsTo(`${API}/file/download`).map((c) => c.form.token), [RGT1, RGT1]);
    const stored = fake.storage.map.get('session:rapidgator');
    assert.ok(stored.includes(RGT1));
    noSecret(stored, PASS);
  });

  test('a 401 on file/download logs in once more and repeats once, with no pause', async () => {
    const fake = setupRG();
    happy(fake);
    await rapidgator.unrestrict(s(), RG_LINK);
    fake.route('POST', `${API}/file/download`, seq(ok(fx('rapidgator', 'error-session')), ok(fx('rapidgator', 'file-download'))));
    assert.ok(await rapidgator.unrestrict(s(), RG_LINK));
    assert.equal(fake.callsTo(`${API}/user/login`).length, 2);
    assert.deepEqual(fake.callsTo(`${API}/file/download`).map((c) => c.form.token), [RGT1, RGT1, RGT2]);
    assert.equal(await cooldownLeft('rapidgator', CRED), null);
  });

  test('an HTTP 401 on file/download counts the same', async () => {
    const fake = setupRG();
    happy(fake);
    fake.route('POST', `${API}/file/download`, seq(status(401, fx('rapidgator', 'error-session')), ok(fx('rapidgator', 'file-download'))));
    // Stored token first, so the 401 is on a reused session.
    await gopeed.storage.set('session:rapidgator', JSON.stringify({ v: { login: LOGIN, token: 'FAKE-RG-OLD-TOKEN' }, exp: Date.now() + HOUR }));
    assert.ok(await rapidgator.unrestrict(s(), RG_LINK));
    assert.equal(fake.callsTo(`${API}/user/login`).length, 1);
  });

  test('a 401 again with the new token drops the session and pauses: no third login', async () => {
    const fake = setupRG();
    happy(fake);
    fake.route('POST', `${API}/file/download`, ok(fx('rapidgator', 'error-session')));
    await gopeed.storage.set('session:rapidgator', JSON.stringify({ v: { login: LOGIN, token: 'FAKE-RG-OLD-TOKEN' }, exp: Date.now() + HOUR }));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'auth_invalid', /^Rapidgator: /, [PASS, RGT1, 'FAKE-RG-OLD-TOKEN']);
    assert.equal(fake.callsTo(`${API}/user/login`).length, 1);
    assert.equal(fake.storage.map.has('session:rapidgator'), false);
    assert.ok(await cooldownLeft('rapidgator', CRED));
  });

  test('a wrong password gives "Rapidgator: wrong login or password" and pauses; no retry, no second login', async () => {
    for (const answer of [ok(fx('rapidgator', 'error-login')), status(401, fx('rapidgator', 'error-login'))]) {
      const fake = setupRG();
      happy(fake);
      fake.route('POST', `${API}/user/login`, answer);
      await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'auth_invalid', /^Rapidgator: wrong login or password$/, [PASS]);
      assert.equal(fake.calls.length, 1);
      await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'cooldown', /^Rapidgator: wrong login or password, not retrying/);
      assert.equal(fake.calls.length, 1);
      assert.equal(fake.storage.map.has('session:rapidgator'), false);
    }
  });

  test('a second login in the same 30 s window waits for the next window and sends the next code', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
    const fake = setupRG({ rapidgator_2fa_secret: SECRET });
    const sentAt = [];
    // An account that is not premium keeps no token, so every link logs in again.
    fake.route('POST', `${API}/user/login`, () => { sentAt.push(Date.now()); return { status: 200, json: fx('rapidgator', 'login-not-premium') }; });
    await assert.rejects(drive(t, rapidgator.unrestrict(s(), RG_LINK)), (e) => e.code === 'account_expired');
    t.mock.timers.tick(5000);
    const started = Date.now();
    await assert.rejects(drive(t, rapidgator.unrestrict(s(), RG_LINK)), (e) => e.code === 'account_expired');
    assert.deepEqual(fake.callsTo(`${API}/user/login`).map((c) => c.form.code), ['728107', '172011']);
    assert.equal(sentAt[0], T0);
    assert.ok(sentAt[1] >= T0 + 30000, 'sent in the next window');
    assert.ok(sentAt[1] - started < 30000, 'waited less than one window');
    // The window after that needs no wait.
    t.mock.timers.tick(30000);
    const third = Date.now();
    await assert.rejects(drive(t, rapidgator.unrestrict(s(), RG_LINK)), (e) => e.code === 'account_expired');
    assert.equal(sentAt[2], third);
    assert.equal(fake.callsTo(`${API}/user/login`)[2].form.code, '752484');
  });

  test('concurrent unrestricts share one login (and one 2FA code)', async () => {
    const fake = setupRG({ rapidgator_2fa_secret: SECRET });
    happy(fake);
    const got = await Promise.all([rapidgator.unrestrict(s(), RG_LINK), rapidgator.unrestrict(s(), 'https://rg.to/file/def456'), rapidgator.unrestrict(s(), RG_LINK)]);
    assert.equal(got.length, 3);
    assert.equal(fake.callsTo(`${API}/user/login`).length, 1);
    assert.deepEqual(fake.callsTo(`${API}/file/download`).map((c) => c.form.token), [RGT1, RGT1, RGT1]);
  });

  test('a login refusal that is not a 401 pauses too, with Rapidgator\'s text; no second login', async () => {
    const fake = setupRG();
    happy(fake);
    fake.route('POST', `${API}/user/login`, ok({ response: null, status: 403, details: 'Error: Too many login attempts (fake fixture text)' }));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'auth_invalid', /^Rapidgator: Too many login attempts \(fake fixture text\)$/, [PASS]);
    assert.ok(await cooldownLeft('rapidgator', CRED));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'cooldown', /Too many login attempts/);
    assert.equal(fake.calls.length, 1);
  });

  test('a 5xx or a block page at login is no refusal: no pause', async () => {
    for (const answer of [status(503, { response: null, status: 503, details: 'Error: Maintenance' }), () => ({ status: 403, text: '<html>blocked</html>' })]) {
      const fake = setupRG();
      fake.route('POST', `${API}/user/login`, answer);
      await assert.rejects(rapidgator.unrestrict(s(), RG_LINK), (e) => e.code !== 'auth_invalid' && e.code !== 'cooldown');
      assert.equal(await cooldownLeft('rapidgator', CRED), null);
    }
  });

  test('a refused 2FA code names the secret and the clock, and pauses', async () => {
    const fake = setupRG({ rapidgator_2fa_secret: SECRET });
    fake.route('POST', `${API}/user/login`, ok(fx('rapidgator', 'error-2fa')));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'auth_invalid', /^Rapidgator: the 2FA code was refused .*clock/, [PASS, SECRET, 'JBSWY3DPEHPK3PXP']);
    assert.ok(await cooldownLeft('rapidgator', `${LOGIN}\u0000${PASS}\u0000${SECRET}`));
    assert.equal(fake.calls.length, 1);
  });

  test('no traffic left on the account is limit_reached and names the traffic; the token is not kept', async () => {
    const fake = setupRG();
    fake.route('POST', `${API}/user/login`, ok(fx('rapidgator', 'login-no-traffic')));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'limit_reached', /^Rapidgator: limit reached \(no traffic left on the account\)$/, ['FAKE-RG-TOKEN-0003']);
    assert.equal(fake.callsTo(`${API}/file/download`).length, 0);
    assert.equal(fake.storage.map.has('session:rapidgator'), false);
    assert.equal(await cooldownLeft('rapidgator', CRED), null);
  });

  test('an account that is not premium is account_expired', async () => {
    const fake = setupRG();
    fake.route('POST', `${API}/user/login`, ok(fx('rapidgator', 'login-not-premium')));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'account_expired', /^Rapidgator: the account has expired or is not premium$/);
    assert.equal(fake.callsTo(`${API}/file/download`).length, 0);
  });

  test('"File not found" is a dead link; another status shows Rapidgator\'s details', async () => {
    const fake = setupRG();
    happy(fake);
    fake.route('POST', `${API}/file/download`, ok(fx('rapidgator', 'error-not-found')));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), 'dead_link', /^Rapidgator: the link is dead/);
    fake.route('POST', `${API}/file/download`, ok({ response: null, status: 403, details: `Error: You have reached the daily limit (fake fixture text) ${RGT1}` }));
    await rejectsWith(rapidgator.unrestrict(s(), RG_LINK), '403', /^Rapidgator: You have reached the daily limit \(fake fixture text\) ••••$/, [RGT1]);
    assert.equal(fake.callsTo(`${API}/user/login`).length, 1);
  });

  test('a link of another hoster, or a Rapidgator link that is not a file, gives null with no call', async () => {
    const fake = setupRG();
    happy(fake);
    assert.equal(await rapidgator.unrestrict(s(), OTHER), null);
    assert.equal(await rapidgator.unrestrict(s(), 'https://rapidgator.net/folder/12345/Some.Folder.html'), null);
    assert.equal(fake.calls.length, 0);
  });

  test('a stored token of another login is not used', async () => {
    const fake = setupRG();
    happy(fake);
    await gopeed.storage.set('session:rapidgator', JSON.stringify({ v: { login: 'someone.else@example.invalid', token: 'FAKE-RG-OTHER' }, exp: Date.now() + HOUR }));
    await rapidgator.unrestrict(s(), RG_LINK);
    assert.equal(fake.callsTo(`${API}/user/login`).length, 1);
    assert.equal(fake.callsTo(`${API}/file/download`)[0].form.token, RGT1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Nitroflare

describe('Nitroflare', () => {
  const API = 'https://nitroflare.com/api/v2';
  const USER = 'fake.nf.user@example.invalid';
  const KEY = 'FAKE-NF-PREMIUM-KEY-0001';
  const CAPTCHA = 'Nitroflare: log in on nitroflare.com once in a browser to clear the captcha, then add the link again';
  function setupNF() {
    return installFakeGopeed({ settings: { nitroflare_enabled: true, nitroflare_user: USER, nitroflare_premium_key: KEY } });
  }
  function happy(fake) {
    fake.route('GET', `${API}/getKeyInfo`, ok(fx('nitroflare', 'key-info')));
    fake.route('GET', `${API}/getDownloadLink`, ok(fx('nitroflare', 'download-link')));
  }
  const s = () => providerSettings('nitroflare');

  test('hosts() is nitroflare.com and nitro.download, with no network call', async () => {
    const fake = setupNF();
    assert.deepEqual((await nitroflare.hosts(s())).sort(), ['nitro.download', 'nitroflare.com']);
    assert.equal(fake.calls.length, 0);
  });

  test('unrestrict: getKeyInfo, then getDownloadLink with file, user and premiumKey; size given as a string', async () => {
    const fake = setupNF();
    happy(fake);
    const got = await nitroflare.unrestrict(s(), NF_LINK);
    assert.deepEqual(got, { name: 'Some.File.rar', size: 314572800, url: 'https://s12.nitroflare.example.invalid/d/fake/Some.File.rar', headers: {} });
    assert.deepEqual(fake.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`), [`GET ${API}/getKeyInfo`, `GET ${API}/getDownloadLink`]);
    assert.deepEqual(fake.calls[0].query, { user: USER, premiumKey: KEY });
    assert.deepEqual(fake.calls[1].query, { file: 'ABC123XYZ', user: USER, premiumKey: KEY });
  });

  test('a nitro.download link is claimed', async () => {
    const fake = setupNF();
    happy(fake);
    assert.ok(await nitroflare.unrestrict(s(), 'https://nitro.download/view/ABC123XYZ/Some.File.rar'));
    assert.equal(fake.calls[1].query.file, 'ABC123XYZ');
  });

  test('a refused key gives "Nitroflare: wrong user or premium key" and pauses; the key never reaches the error', async () => {
    const fake = setupNF();
    happy(fake);
    fake.route('GET', `${API}/getKeyInfo`, ok({ ...fx('nitroflare', 'error-wrong-key'), message: `Wrong login ${KEY}` }));
    await rejectsWith(nitroflare.unrestrict(s(), NF_LINK), 'auth_invalid', /^Nitroflare: wrong user or premium key$/, [KEY]);
    assert.equal(fake.calls.length, 1);
    await rejectsWith(nitroflare.unrestrict(s(), NF_LINK), 'cooldown', /^Nitroflare: wrong user or premium key, not retrying/);
    assert.equal(fake.calls.length, 1);
    assert.ok(await cooldownLeft('nitroflare', `${USER}\u0000${KEY}`));
  });

  test('the captcha (code 12) asks the user to log in once in a browser, on either call, with no pause', async () => {
    for (const where of ['getKeyInfo', 'getDownloadLink']) {
      const fake = setupNF();
      happy(fake);
      fake.route('GET', `${API}/${where}`, ok(fx('nitroflare', 'error-captcha')));
      const err = await rejectsWith(nitroflare.unrestrict(s(), NF_LINK), 'login_required', /captcha/, [KEY]);
      assert.equal(err.message, CAPTCHA, where);
      assert.equal(await cooldownLeft('nitroflare', `${USER}\u0000${KEY}`), null);
    }
  });

  test('no traffic left is limit_reached naming the traffic; an inactive key is account_expired', async () => {
    let fake = setupNF();
    happy(fake);
    fake.route('GET', `${API}/getKeyInfo`, ok(fx('nitroflare', 'key-info-no-traffic')));
    await rejectsWith(nitroflare.unrestrict(s(), NF_LINK), 'limit_reached', /^Nitroflare: limit reached \(no traffic left on the account\)$/);
    assert.equal(fake.calls.length, 1);
    fake = setupNF();
    happy(fake);
    fake.route('GET', `${API}/getKeyInfo`, ok(fx('nitroflare', 'key-info-expired')));
    await rejectsWith(nitroflare.unrestrict(s(), NF_LINK), 'account_expired', /^Nitroflare: the account has expired or is not premium$/);
  });

  test('another error of getDownloadLink shows Nitroflare\'s message, with the key hidden', async () => {
    const fake = setupNF();
    happy(fake);
    fake.route('GET', `${API}/getDownloadLink`, ok({ ...fx('nitroflare', 'error-file'), message: `File not found (fake fixture text) for premiumKey=${KEY}` }));
    const err = await rejectsWith(nitroflare.unrestrict(s(), NF_LINK), '4', /^Nitroflare: File not found \(fake fixture text\)/, [KEY]);
    assert.ok(err.message.includes(MASK));
    assert.equal(await cooldownLeft('nitroflare', `${USER}\u0000${KEY}`), null);
  });

  test('a link of another hoster, or a Nitroflare link without /view/, gives null with no call', async () => {
    const fake = setupNF();
    happy(fake);
    assert.equal(await nitroflare.unrestrict(s(), OTHER), null);
    assert.equal(await nitroflare.unrestrict(s(), 'https://nitroflare.com/folder/123/abc'), null);
    assert.equal(fake.calls.length, 0);
  });
});
