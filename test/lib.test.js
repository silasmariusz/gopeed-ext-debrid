import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakeGopeed } from './fake-gopeed.js';
import { requestJSON, ProviderError } from '../src/lib/http.js';
import { cached, remember, recall } from '../src/lib/cache.js';
import { parseMagnet } from '../src/lib/magnet.js';
import { hostOf, hostMatches } from '../src/lib/hosts.js';
import { settings, providerSettings, secretsOf, apiBase } from '../src/lib/settings.js';
import { cooldownLeft, startCooldown, COOLDOWN_MS, settingsHash } from '../src/lib/cooldown.js';
import { redact } from '../src/lib/redact.js';

const TB = 'https://api.torbox.app/v1/api';
const readJSON = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const manifest = readJSON('../manifest.json');

describe('http.js: requestJSON', () => {
  test('an HTML 503 becomes ProviderError("TorBox", "the service did not answer properly (HTTP 503)")', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => ({
      status: 503,
      headers: { 'content-type': 'text/html' },
      text: '<!doctype html><title>Just a moment...</title>',
    }));
    await assert.rejects(requestJSON('TorBox', 'GET', `${TB}/user/me`), (err) => {
      assert.ok(err instanceof ProviderError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'ProviderError');
      assert.equal(err.provider, 'TorBox');
      assert.equal(err.reason, 'the service did not answer properly (HTTP 503)');
      assert.equal(err.message, new ProviderError('TorBox', 'the service did not answer properly (HTTP 503)').message);
      assert.equal(err.message, 'TorBox: the service did not answer properly (HTTP 503)');
      assert.equal(err.status, 503);
      assert.equal(err.code, 'bad_response');
      return true;
    });
  });

  test('a 200 that is not JSON is a ProviderError too, never a parse error', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => ({ status: 200, text: '<html>maintenance</html>' }));
    await assert.rejects(requestJSON('TorBox', 'GET', `${TB}/user/me`), {
      name: 'ProviderError',
      message: 'TorBox: the service did not answer properly (HTTP 200)',
      status: 200,
    });
  });

  test('a server that never answers gives "did not answer within 30 s" (the default timeout)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => new Promise(() => {}));
    const pending = requestJSON('TorBox', 'GET', `${TB}/user/me`);
    t.mock.timers.tick(30000);
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /did not answer within 30 s/);
      assert.equal(err.message, 'TorBox: the service did not answer within 30 s');
      assert.equal(err.code, 'timeout');
      return true;
    });
  });

  test('timeoutMs sets the limit and the message', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => new Promise(() => {}));
    const pending = requestJSON('TorBox', 'GET', `${TB}/user/me`, { timeoutMs: 5000 });
    t.mock.timers.tick(5000);
    await assert.rejects(pending, { message: 'TorBox: the service did not answer within 5 s' });
  });

  test('the timer is cleared once the service answers, so no 30 s timer outlives a request', async (t) => {
    const set = t.mock.method(globalThis, 'setTimeout');
    const clear = t.mock.method(globalThis, 'clearTimeout');
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => ({ json: { ok: true } }));
    assert.deepEqual(await requestJSON('TorBox', 'GET', `${TB}/user/me`), { ok: true });
    assert.equal(set.mock.callCount(), 1);
    assert.equal(set.mock.calls[0].arguments[1], 30000);
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(clear.mock.calls[0].arguments[0], set.mock.calls[0].result);
  });

  test('query and form are encoded; null and undefined are skipped; arrays repeat the key', async () => {
    const fake = installFakeGopeed();
    fake.route('POST', 'https://api.alldebrid.com/', () => ({ json: { status: 'success' } }));
    const out = await requestJSON('AllDebrid', 'POST', 'https://api.alldebrid.com/v4/magnet/upload', {
      query: { agent: 'gopeed-ext-debrid', n: 2, skip: undefined, gone: null },
      form: {
        'magnets[]': ['magnet:?xt=urn:btih:abc&dn=a b', 'x'],
        link: 'https://rapidgator.net/file/1?a=b&c=d',
        none: null,
      },
    });
    assert.deepEqual(out, { status: 'success' });
    const [call] = fake.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.alldebrid.com/v4/magnet/upload?agent=gopeed-ext-debrid&n=2');
    assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(
      call.body,
      'magnets%5B%5D=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc%26dn%3Da%20b&magnets%5B%5D=x' +
        '&link=https%3A%2F%2Frapidgator.net%2Ffile%2F1%3Fa%3Db%26c%3Dd',
    );
    assert.deepEqual(call.form, {
      'magnets[]': ['magnet:?xt=urn:btih:abc&dn=a b', 'x'],
      link: 'https://rapidgator.net/file/1?a=b&c=d',
    });
  });

  test('query is appended to a URL that already has one', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => ({ json: { ok: 1 } }));
    await requestJSON('TorBox', 'GET', `${TB}/torrents/checkcached?format=list`, { query: { hash: 'ab cd' } });
    assert.equal(fake.calls[0].url, `${TB}/torrents/checkcached?format=list&hash=ab%20cd`);
  });

  test('json is sent as application/json', async () => {
    const fake = installFakeGopeed();
    fake.route('POST', TB, () => ({ json: { ok: 1 } }));
    await requestJSON('TorBox', 'POST', `${TB}/x`, { json: { a: 1, b: ['c'] } });
    assert.equal(fake.calls[0].headers['content-type'], 'application/json');
    assert.equal(fake.calls[0].body, '{"a":1,"b":["c"]}');
  });

  test('every request carries User-Agent gopeed-ext-debrid/<manifest version> and the caller headers', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => ({ json: {} }));
    await requestJSON('TorBox', 'GET', `${TB}/user/me`, { headers: { Authorization: 'Bearer k' } });
    assert.equal(fake.calls[0].headers['user-agent'], `gopeed-ext-debrid/${manifest.version}`);
    assert.equal(fake.calls[0].headers['user-agent'], 'gopeed-ext-debrid/0.1.0');
    assert.equal(fake.calls[0].headers.authorization, 'Bearer k');
    assert.equal(fake.calls[0].body, undefined);
  });

  test('a 2xx with an empty body (Real-Debrid answers 204) returns null', async () => {
    const fake = installFakeGopeed();
    fake.route('POST', 'https://api.real-debrid.com/', () => ({ status: 204 }));
    const out = await requestJSON('Real-Debrid', 'POST', 'https://api.real-debrid.com/rest/1.0/torrents/selectFiles/X', {
      form: { files: 'all' },
    });
    assert.equal(out, null);
  });

  test('a JSON error answer is a ProviderError with the status, the parsed body and a code taken from it', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', 'https://api.real-debrid.com/', () => ({ status: 401, json: { error: 'bad_token', error_code: 8 } }));
    await assert.rejects(requestJSON('Real-Debrid', 'GET', 'https://api.real-debrid.com/rest/1.0/user'), (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'bad_token');
      assert.deepEqual(err.body, { error: 'bad_token', error_code: 8 });
      assert.equal(err.message, 'Real-Debrid: the service answered HTTP 401: bad_token');
      return true;
    });
  });

  test('the error code also comes from an {error:{code,message}} body (AllDebrid shape)', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', 'https://api.alldebrid.com/', () => ({
      status: 400,
      json: { status: 'error', error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' } },
    }));
    await assert.rejects(requestJSON('AllDebrid', 'GET', 'https://api.alldebrid.com/v4/user'), {
      code: 'AUTH_BAD_APIKEY',
      message: 'AllDebrid: the service answered HTTP 400: The auth apikey is invalid',
    });
  });

  test('a network failure is a ProviderError that names no URL and no secret', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', 'https://www.premiumize.me/', () => {
      throw new Error('Get "https://www.premiumize.me/api/account/info?apikey=SECRET123": dial tcp: refused');
    });
    await assert.rejects(
      requestJSON('Premiumize', 'GET', 'https://www.premiumize.me/api/account/info', { query: { apikey: 'SECRET123' } }),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.message, 'Premiumize: the service could not be reached');
        assert.equal(err.code, 'network');
        assert.ok(!JSON.stringify({ ...err, message: err.message }).includes('SECRET123'));
        return true;
      },
    );
  });

  // Fix round 1, M1: a provider that echoes a credential must not leak it into the error.
  const KEY = 'k3y/S3CR3T+v';
  const KEY_ENC = encodeURIComponent(KEY); // k3y%2FS3CR3T%2Bv
  const noSecret = (err) => {
    assert.equal('secrets' in err, false, 'the error keeps no secrets list');
    const all = JSON.stringify({ ...err, message: err.message, stack: err.stack, reason: err.reason, body: err.body });
    assert.ok(!all.includes(KEY), `raw secret leaked: ${all}`);
    assert.ok(!all.includes(KEY_ENC), `encoded secret leaked: ${all}`);
    assert.ok(!all.includes('S3CR3T'), `part of the secret leaked: ${all}`);
  };

  test('M1: an error body that echoes the token gives a message without it', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', TB, () => ({ status: 401, json: { success: false, error: 'BAD_TOKEN', detail: `The token ${KEY} is not valid` } }));
    await assert.rejects(
      requestJSON('TorBox', 'GET', `${TB}/user/me`, { headers: { Authorization: `Bearer ${KEY}` }, secrets: [KEY] }),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.message, 'TorBox: the service answered HTTP 401: The token •••• is not valid');
        assert.equal(err.reason, 'the service answered HTTP 401: The token •••• is not valid');
        assert.equal(err.code, 'BAD_TOKEN');
        noSecret(err);
        return true;
      },
    );
  });

  test('M1: the same for the URL-encoded form of the token', async () => {
    const fake = installFakeGopeed();
    fake.route('GET', 'https://www.premiumize.me/', (req) => ({
      status: 400,
      json: { status: 'error', message: `bad request: apikey=${req.query.apikey && encodeURIComponent(req.query.apikey)}` },
    }));
    await assert.rejects(
      requestJSON('Premiumize', 'GET', 'https://www.premiumize.me/api/account/info', { query: { apikey: KEY }, secrets: [KEY] }),
      (err) => {
        assert.equal(err.message, 'Premiumize: the service answered HTTP 400: bad request: apikey=••••');
        noSecret(err);
        return true;
      },
    );
  });

  test('M1: err.body and err.code carry no secret; other fields stay as they were', async () => {
    const fake = installFakeGopeed();
    fake.route('POST', 'https://api.alldebrid.com/', () => ({
      status: 403,
      json: {
        status: 'error',
        error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' },
        echo: { apikey: KEY, encoded: `apikey=${KEY_ENC}`, list: ['x', KEY, 7, true, null], n: 42 },
      },
    }));
    fake.route('GET', 'https://api.real-debrid.com/', () => ({ status: 401, json: { error: KEY } }));
    await assert.rejects(
      requestJSON('AllDebrid', 'POST', 'https://api.alldebrid.com/v4/link/unlock', { form: { apikey: KEY }, secrets: [KEY] }),
      (err) => {
        assert.equal(err.code, 'AUTH_BAD_APIKEY');
        assert.deepEqual(err.body, {
          status: 'error',
          error: { code: 'AUTH_BAD_APIKEY', message: 'The auth apikey is invalid' },
          echo: { apikey: '••••', encoded: 'apikey=••••', list: ['x', '••••', 7, true, null], n: 42 },
        });
        noSecret(err);
        return true;
      },
    );
    await assert.rejects(requestJSON('Real-Debrid', 'GET', 'https://api.real-debrid.com/rest/1.0/user', { secrets: [KEY] }), (err) => {
      assert.equal(err.code, '••••');
      assert.equal(err.message, 'Real-Debrid: the service answered HTTP 401: ••••');
      noSecret(err);
      return true;
    });
  });

  test('M1: a secret that crosses the 200-character cap of the provider text is still hidden', async () => {
    const fake = installFakeGopeed();
    const detail = `${'x'.repeat(195)}${KEY} tail`;
    fake.route('GET', TB, () => ({ status: 401, json: { detail } }));
    await assert.rejects(requestJSON('TorBox', 'GET', `${TB}/user/me`, { secrets: [KEY] }), (err) => {
      assert.ok(err.message.includes('x'.repeat(195)));
      assert.ok(!err.message.includes('k3y'), err.message);
      noSecret(err);
      return true;
    });
  });

  test('M1: ProviderError redacts its message, code and body with extra.secrets, and keeps no secrets', () => {
    const err = new ProviderError('Rapidgator', `wrong password ${KEY}`, {
      status: 401,
      code: `login:${KEY}`,
      body: { response: null, details: `password=${KEY_ENC}`, deep: [[{ k: KEY }]] },
      secrets: [KEY, '', null],
    });
    assert.equal(err.message, 'Rapidgator: wrong password ••••');
    assert.equal(err.reason, 'wrong password ••••');
    assert.equal(err.code, 'login:••••');
    assert.equal(err.status, 401);
    assert.deepEqual(err.body, { response: null, details: 'password=••••', deep: [[{ k: '••••' }]] });
    noSecret(err);
  });

  test('ProviderError keeps provider, reason, status and code', () => {
    const err = new ProviderError('TorBox', 'the daily limit has been reached', { status: 429, code: 'limit' });
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ProviderError');
    assert.equal(err.message, 'TorBox: the daily limit has been reached');
    assert.equal(err.provider, 'TorBox');
    assert.equal(err.reason, 'the daily limit has been reached');
    assert.equal(err.status, 429);
    assert.equal(err.code, 'limit');
    assert.equal(new ProviderError('', 'plain').message, 'plain');
  });
});

describe('cache.js', () => {
  test('cached serves from storage until the TTL ends, then loads again', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    const fake = installFakeGopeed();
    let loads = 0;
    const loader = async () => { loads++; return ['rapidgator.net', `load-${loads}`]; };

    assert.deepEqual(await cached('hosts:torbox', 1000, loader), ['rapidgator.net', 'load-1']);
    assert.equal(typeof fake.storage.map.get('hosts:torbox'), 'string');
    t.mock.timers.tick(999);
    assert.deepEqual(await cached('hosts:torbox', 1000, loader), ['rapidgator.net', 'load-1']);
    assert.equal(loads, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await cached('hosts:torbox', 1000, loader), ['rapidgator.net', 'load-2']);
    assert.equal(loads, 2);
  });

  test('remember and recall keep JSON values until the TTL ends; an expired entry is removed', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 5_000 });
    const fake = installFakeGopeed();
    await remember('orig:https://dl/x', { original: 'https://rapidgator.net/file/1', provider: 'torbox' }, 100);
    assert.deepEqual(await recall('orig:https://dl/x'), { original: 'https://rapidgator.net/file/1', provider: 'torbox' });
    t.mock.timers.tick(100);
    assert.equal(await recall('orig:https://dl/x'), null);
    assert.equal(fake.storage.map.has('orig:https://dl/x'), false);
    assert.equal(await recall('never-set'), null);
  });

  test('a corrupt entry is a miss, and a loader that throws caches nothing', async () => {
    const fake = installFakeGopeed({ storage: { 'hosts:x': 'not json{' } });
    assert.equal(await recall('hosts:x'), null);
    await assert.rejects(cached('hosts:y', 1000, async () => { throw new Error('down'); }), /down/);
    assert.equal(fake.storage.map.has('hosts:y'), false);
    assert.deepEqual(await cached('hosts:x', 1000, async () => ['ok']), ['ok']);
  });

  test('a value that cannot be stored is still returned, and the failed write is logged', async () => {
    const fake = installFakeGopeed();
    fake.storage.set = async () => { throw new Error('disk full'); };
    assert.deepEqual(await cached('hosts:z', 1000, async () => ['ok']), ['ok']);
    assert.ok(fake.logs.some((l) => l.level === 'warn' && /hosts:z could not be stored: disk full/.test(l.msg)));
  });
});

describe('magnet.js: parseMagnet', () => {
  const HEX = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';

  test('a hex info-hash comes back lowercase, with the name and the trackers', () => {
    const m = parseMagnet(
      `magnet:?xt=urn:btih:${HEX.toUpperCase()}&dn=Ubuntu+24.04%20desktop` +
        '&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce&tr=https%3A%2F%2Ft2.example%2Fannounce' +
        '&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce',
    );
    assert.deepEqual(m, {
      hash: HEX,
      name: 'Ubuntu 24.04 desktop',
      trackers: ['udp://tracker.example:1337/announce', 'https://t2.example/announce'],
    });
  });

  test('a base32 info-hash becomes 40 lowercase hex (vectors from Python base64.b32encode)', () => {
    assert.equal(parseMagnet('magnet:?xt=urn:btih:YEX6DQDLXISUVHOJ6UM3GNNKPQJWPKEK').hash, HEX);
    assert.equal(
      parseMagnet('magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH').hash,
      '0123456789abcdef0123456789abcdef01234567',
    );
    assert.equal(parseMagnet('magnet:?xt=urn:btih:yex6dqdlxisuvhoj6um3gnnkpqjwpkek').hash, HEX);
  });

  test('the scheme, the keys and the urn are case-insensitive; no name means an empty name', () => {
    assert.deepEqual(parseMagnet(`MAGNET:?XT=URN:BTIH:${HEX}`), { hash: HEX, name: '', trackers: [] });
    assert.equal(parseMagnet(`magnet:?dn=a&xt.1=urn:btih:${HEX}`).hash, HEX);
  });

  test('anything without a valid v1 info-hash gives null', () => {
    assert.equal(parseMagnet('https://example.com/a.torrent'), null);
    assert.equal(parseMagnet('magnet:?xt=urn:btih:zz'), null);
    assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}00`), null);
    assert.equal(parseMagnet('magnet:?xt=urn:btmh:1220' + 'ab'.repeat(32)), null);
    assert.equal(parseMagnet(''), null);
    assert.equal(parseMagnet(undefined), null);
  });
});

describe('hosts.js', () => {
  test('hostOf gives the lowercase host without "www.", port or user', () => {
    assert.equal(hostOf('https://WWW.Rapidgator.net:443/file/abc?x=1#f'), 'rapidgator.net');
    assert.equal(hostOf('https://user:pw@dl.Example.com/x'), 'dl.example.com');
    assert.equal(hostOf('http://1fichier.com'), '1fichier.com');
    assert.equal(hostOf('magnet:?xt=urn:btih:abc'), '');
    assert.equal(hostOf('not a url'), '');
    assert.equal(hostOf(''), '');
    assert.equal(hostOf(undefined), '');
  });

  test('hostMatches is an exact or subdomain match', () => {
    assert.equal(hostMatches('dl.rapidgator.net', ['rapidgator.net']), true);
    assert.equal(hostMatches('rapidgator.net', ['rapidgator.net']), true);
    assert.equal(hostMatches('www.rapidgator.net', ['RapidGator.NET']), true);
    assert.equal(hostMatches('rg.to', ['rapidgator.net', 'rg.to']), true);
    assert.equal(hostMatches('evilrapidgator.net', ['rapidgator.net']), false);
    assert.equal(hostMatches('rapidgator.net.evil.com', ['rapidgator.net']), false);
    assert.equal(hostMatches('', ['rapidgator.net']), false);
    assert.equal(hostMatches('rapidgator.net', null), false);
    assert.equal(hostMatches('rapidgator.net', ['']), false);
  });
});

describe('settings.js', () => {
  test('settings() trims " key \\n"; numbers, booleans and null stay as typed', () => {
    installFakeGopeed({
      settings: { torbox_apikey: ' key \n', torbox_enabled: true, n: 3, empty: null, order: ' torbox, realdebrid ' },
    });
    assert.deepEqual(settings(), {
      torbox_apikey: 'key',
      torbox_enabled: true,
      n: 3,
      empty: null,
      order: 'torbox, realdebrid',
    });
  });

  test('settings() reads gopeed.settings on every call', () => {
    const fake = installFakeGopeed({ settings: { torbox_apikey: 'a' } });
    assert.equal(settings().torbox_apikey, 'a');
    fake.settings.torbox_apikey = 'b';
    assert.equal(settings().torbox_apikey, 'b');
  });

  test('providerSettings(id) gives the fields of that id, unprefixed and trimmed', () => {
    installFakeGopeed({
      settings: {
        rapidgator_enabled: true,
        rapidgator_login: ' me@example.com ',
        rapidgator_password: 'pw\t',
        rapideo_login: 'other',
        order: 'rapidgator',
      },
    });
    assert.deepEqual(providerSettings('rapidgator'), { enabled: true, login: 'me@example.com', password: 'pw' });
    assert.deepEqual(providerSettings('rapideo'), { login: 'other' });
    assert.deepEqual(providerSettings('torbox'), {});
  });

  test('secretsOf collects the values of the _token, _key, _apikey and _password settings', () => {
    installFakeGopeed({
      settings: {
        torbox_enabled: true,
        torbox_apikey: ' tb-key ',
        realdebrid_token: 'rd-token',
        rapidgator_login: 'me@example.com',
        rapidgator_password: 'rg-pass',
        nitroflare_user: 'nf@example.com',
        nitroflare_premium_key: 'nf-key',
        onefichier_apikey: '',
        premiumize_apikey: null,
        debridlink_apikey: 'rd-token',
        monkey: 'not a secret',
        order: 'torbox',
        n_key: 5,
      },
    });
    assert.deepEqual(secretsOf(settings()).sort(), ['nf-key', 'rd-token', 'rg-pass', 'tb-key']);
    assert.deepEqual(secretsOf(providerSettings('nitroflare')), ['nf-key']);
    assert.deepEqual(secretsOf(providerSettings('rapidgator')), ['rg-pass']);
    assert.deepEqual(secretsOf(providerSettings('torbox')), ['tb-key']);
    assert.deepEqual(secretsOf({ token: 't', key: 'k', apikey: 'a', password: 'p', login: 'l', user: 'u', enabled: true }).sort(),
      ['a', 'k', 'p', 't']);
    assert.deepEqual(secretsOf(undefined), []);
  });

  test('secretsOf also takes names ending in secret (rapidgator_2fa_secret), not in "secrets" or "secretary"', () => {
    installFakeGopeed({
      settings: {
        rapidgator_login: 'me@example.com',
        rapidgator_password: 'rg-pass',
        rapidgator_2fa_secret: 'FAKE2FASECRETBASE32',
        some_secrets: 'not one',
        secretary: 'not one either',
      },
    });
    assert.deepEqual(secretsOf(providerSettings('rapidgator')).sort(), ['FAKE2FASECRETBASE32', 'rg-pass']);
    assert.deepEqual(secretsOf(settings()).sort(), ['FAKE2FASECRETBASE32', 'rg-pass']);
    assert.deepEqual(secretsOf({ secret: 's', '2fa_secret': 'f', secrets: 'x', secretary: 'y' }).sort(), ['f', 's']);
  });

  test('a missing gopeed.settings gives an empty object', () => {
    installFakeGopeed();
    globalThis.gopeed.settings = undefined;
    assert.deepEqual(settings(), {});
  });

  test('apiBase gives the default, or <advanced_api_base>/<id> with the trailing slashes trimmed', () => {
    const real = 'https://api.torbox.app';
    const fake = installFakeGopeed();
    assert.equal(apiBase('torbox', real), real, 'no setting at all');
    for (const empty of ['', '   ', null, undefined, 42]) {
      fake.settings.advanced_api_base = empty;
      assert.equal(apiBase('torbox', real), real, `empty value ${JSON.stringify(empty)}`);
    }
    fake.settings.advanced_api_base = ' http://127.0.0.1:18990 ';
    assert.equal(apiBase('torbox', real), 'http://127.0.0.1:18990/torbox');
    fake.settings.advanced_api_base = 'http://127.0.0.1:18990///';
    assert.equal(apiBase('realdebrid', 'https://api.real-debrid.com'), 'http://127.0.0.1:18990/realdebrid');
    // It is read on every call, so a changed setting applies at once.
    fake.settings.advanced_api_base = '';
    assert.equal(apiBase('torbox', real), real);
    fake.settings.advanced_api_base = 'http://mock.test';
    assert.equal(apiBase('torbox', real), 'http://mock.test/torbox');
  });
});

describe('cooldown.js: settingsHash', () => {
  test('changes with any field or the API base, ignores the switch and the field order, never holds a value', () => {
    const base = settingsHash('alldebrid', { enabled: true, apikey: 'FAKE-KEY-1', login: 'u' }, '');
    assert.equal(settingsHash('alldebrid', { login: 'u', apikey: 'FAKE-KEY-1', enabled: false }, ''), base);
    assert.notEqual(settingsHash('alldebrid', { enabled: true, apikey: 'FAKE-KEY-2', login: 'u' }, ''), base);
    assert.notEqual(settingsHash('alldebrid', { enabled: true, apikey: 'FAKE-KEY-1', login: 'v' }, ''), base);
    assert.notEqual(settingsHash('alldebrid', { enabled: true, apikey: 'FAKE-KEY-1', login: 'u' }, 'http://mock'), base);
    assert.notEqual(settingsHash('torbox', { enabled: true, apikey: 'FAKE-KEY-1', login: 'u' }, ''), base);
    assert.ok(!base.includes('FAKE'));
  });
});

describe('cooldown.js', () => {
  const MIN = 60 * 1000;
  const T0 = Date.UTC(2026, 9, 2, 18, 0, 0);

  test('startCooldown pauses a credential for 10 minutes; the record holds a hash, never the credential', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = installFakeGopeed();
    assert.equal(COOLDOWN_MS, 10 * MIN);
    assert.equal(await cooldownLeft('torbox', 'SECRET-KEY-1'), null);
    await startCooldown('torbox', 'SECRET-KEY-1', 'invalid API key');
    const left = await cooldownLeft('torbox', 'SECRET-KEY-1');
    assert.deepEqual(left, { ms: 10 * MIN, minutes: 10, reason: 'invalid API key' });
    const raw = fake.storage.map.get('cooldown:torbox');
    assert.ok(raw);
    assert.ok(!raw.includes('SECRET-KEY-1'));
    t.mock.timers.tick(4 * MIN + 1);
    assert.equal((await cooldownLeft('torbox', 'SECRET-KEY-1')).minutes, 6);
    t.mock.timers.tick(6 * MIN);
    assert.equal(await cooldownLeft('torbox', 'SECRET-KEY-1'), null, 'over after 10 minutes');
  });

  test('another credential, or another provider, is not paused', async () => {
    installFakeGopeed();
    await startCooldown('torbox', 'SECRET-KEY-1', 'invalid API key');
    assert.equal(await cooldownLeft('torbox', 'SECRET-KEY-2'), null);
    assert.equal(await cooldownLeft('alldebrid', 'SECRET-KEY-1'), null);
    assert.ok(await cooldownLeft('torbox', 'SECRET-KEY-1'));
  });

  test('startCooldown takes a longer pause when asked (the 60 minutes of a Polish lock), and the record lasts as long', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const fake = installFakeGopeed();
    await startCooldown('rapideo', 'login\u0000pw', 'the login is locked', 60 * MIN);
    assert.deepEqual(await cooldownLeft('rapideo', 'login\u0000pw'), { ms: 60 * MIN, minutes: 60, reason: 'the login is locked' });
    t.mock.timers.tick(59 * MIN);
    assert.equal((await cooldownLeft('rapideo', 'login\u0000pw')).minutes, 1, 'still paused after 59 minutes');
    assert.ok(fake.storage.map.has('cooldown:rapideo'));
    t.mock.timers.tick(MIN);
    assert.equal(await cooldownLeft('rapideo', 'login\u0000pw'), null, 'over after 60 minutes');
  });

  test('a corrupt record is no pause', async () => {
    const fake = installFakeGopeed({ storage: { 'cooldown:torbox': '{not json' } });
    assert.equal(await cooldownLeft('torbox', 'k'), null);
    fake.storage.map.set('cooldown:torbox', JSON.stringify({ v: { h: 'x' }, exp: Date.now() + MIN }));
    assert.equal(await cooldownLeft('torbox', 'k'), null);
  });
});

describe('redact.js', () => {
  test("redact('x token=abc%2F1', ['abc/1']) hides the URL-encoded form, and the plain form too", () => {
    assert.equal(redact('x token=abc%2F1', ['abc/1']), 'x token=••••');
    assert.equal(redact('plain abc/1 and abc%2F1', ['abc/1']), 'plain •••• and ••••');
  });

  test('every secret is hidden, in lowercase percent and form (+) encodings as well', () => {
    assert.equal(redact('a=abc%2f1 b=my+pass c=my%20pass d=my pass', ['abc/1', 'my pass']), 'a=•••• b=•••• c=•••• d=••••');
    assert.equal(redact('k1 then k2', ['k1', 'k2']), '•••• then ••••');
  });

  test('L1: a secret posted in a form body is hidden in every common encoding', () => {
    const secret = 'p@ss w0rd!(x)*~/é';
    // Oracles: Node's URLSearchParams and encodeURI here; Go's url.QueryEscape and url.PathEscape were run separately.
    const forms = {
      raw: secret,
      component: encodeURIComponent(secret), // p%40ss%20w0rd!(x)*~%2F%C3%A9
      uri: encodeURI(secret), // p@ss%20w0rd!(x)*~/%C3%A9
      searchParams: new URLSearchParams({ p: secret }).toString().slice(2), // p%40ss+w0rd%21%28x%29*%7E%2F%C3%A9
      goQuery: 'p%40ss+w0rd%21%28x%29%2A~%2F%C3%A9',
      goPath: 'p@ss%20w0rd%21%28x%29%2A~%2F%C3%A9',
      mixedCase: 'p%40ss%20w0rd!(x)*~%2f%C3%a9',
    };
    for (const [name, form] of Object.entries(forms)) {
      assert.equal(redact(`<${form}>`, [secret]), '<••••>', `${name}: ${form}`);
    }
    assert.equal(redact('password=p%40ss+w0rd%21%28x%29*%7E%2F%C3%A9&user=me', [secret]), 'password=••••&user=me');
    assert.equal(redact('p@ss w0rd and p%40ss', [secret]), 'p@ss w0rd and p%40ss');
  });

  test('empty secrets are ignored, and the text is always a string', () => {
    assert.equal(redact('hello', ['', null, undefined]), 'hello');
    assert.equal(redact('hello', undefined), 'hello');
    assert.equal(redact(undefined, ['x']), '');
    assert.equal(redact(42, ['4']), '••••2');
  });
});

describe('manifest.json', () => {
  const byName = Object.fromEntries(manifest.settings.map((s) => [s.name, s]));
  const ORDER = 'torbox,alldebrid,premiumize,realdebrid,debridlink,rapideo,nopremium,twojlimit,onefichier,rapidgator,nitroflare';

  test('identity, version and scripts', () => {
    assert.equal(manifest.name, 'debrid');
    assert.equal(manifest.author, 'silasmariusz');
    assert.equal(manifest.title, 'Debrid & premium hosts');
    assert.equal(manifest.version, '0.1.0');
    assert.equal(manifest.version, readJSON('../package.json').version);
    assert.equal(manifest.homepage, 'https://github.com/silasmariusz/gopeed-ext-debrid');
    assert.deepEqual(manifest.repository, { url: 'https://github.com/silasmariusz/gopeed-ext-debrid' });
    assert.deepEqual(manifest.scripts, [
      { event: 'onResolve', match: { urls: ['*://*/*', 'magnet:*'], labels: ['rt16.debrid'] }, entry: 'dist/index.js' },
      { event: 'onStart', match: { urls: ['*://*/*'] }, entry: 'dist/index.js' },
      { event: 'onError', match: { urls: ['*://*/*'] }, entry: 'dist/index.js' },
    ]);
  });

  test('the settings: order, magnets_via_debrid, advanced_api_base, and one block per provider', () => {
    assert.equal(manifest.settings.length, Object.keys(byName).length, 'setting names are unique');
    for (const s of manifest.settings) {
      assert.ok(['string', 'number', 'boolean'].includes(s.type), `${s.name} has a known type`);
      assert.ok(s.title, `${s.name} has a title`);
    }
    assert.deepEqual(byName.order, { ...byName.order, type: 'string', value: ORDER });
    assert.deepEqual(byName.magnets_via_debrid, { ...byName.magnets_via_debrid, type: 'boolean', value: true });
    assert.deepEqual(byName.advanced_api_base, { ...byName.advanced_api_base, type: 'string', value: '' });

    const ids = ORDER.split(',');
    for (const id of ids) {
      assert.deepEqual(byName[`${id}_enabled`], { ...byName[`${id}_enabled`], type: 'boolean', value: false });
      const creds = manifest.settings.filter((s) => s.name.startsWith(`${id}_`) && s.name !== `${id}_enabled`);
      assert.ok(creds.length >= 1, `${id} has credential fields`);
    }
    const providerFields = manifest.settings.filter((s) => ids.some((id) => s.name.startsWith(`${id}_`)));
    assert.equal(providerFields.length + 3, manifest.settings.length, 'nothing outside the provider blocks but the 3 globals');
    for (const name of ['realdebrid_token', 'debridlink_apikey', 'torbox_apikey', 'alldebrid_apikey', 'premiumize_apikey',
      'rapideo_login', 'rapideo_password', 'nopremium_login', 'nopremium_password', 'twojlimit_login', 'twojlimit_password',
      'onefichier_apikey', 'rapidgator_login', 'rapidgator_password', 'nitroflare_user', 'nitroflare_premium_key']) {
      assert.equal(byName[name] && byName[name].type, 'string', `${name} is a string setting`);
    }
  });

  // The ruling of 2026-10-02 adds _secret (rapidgator_2fa_secret) to the suffixes the shim masks.
  test('every secret setting ends in _token, _key, _apikey, _password or _secret (the shim masks by suffix)', () => {
    const notSecret = /_(enabled|login|user)$/;
    for (const s of manifest.settings) {
      if (['order', 'magnets_via_debrid', 'advanced_api_base'].includes(s.name) || notSecret.test(s.name)) continue;
      assert.match(s.name, /_(token|key|apikey|password|secret)$/, `${s.name} is masked by the shim`);
    }
  });
});

describe('fake-gopeed.js', () => {
  test('MessageError is like goja: a message, but not an Error', () => {
    installFakeGopeed();
    const e = new MessageError('RT16_NOT_CACHED');
    assert.equal(e.message, 'RT16_NOT_CACHED');
    assert.equal(e instanceof Error, false);
  });

  test('storage stores strings and answers null for a missing key', async () => {
    const fake = installFakeGopeed();
    assert.equal(await gopeed.storage.get('k'), null);
    await gopeed.storage.set('k', 5);
    assert.equal(await gopeed.storage.get('k'), '5');
    assert.deepEqual(await gopeed.storage.keys(), ['k']);
    await gopeed.storage.remove('k');
    assert.equal(fake.storage.map.size, 0);
  });

  test('an unrouted request rejects and is recorded', async () => {
    const fake = installFakeGopeed();
    const saved = process.stderr.write;
    process.stderr.write = () => true;
    try {
      await assert.rejects(fetch('https://nowhere.example/x'), /no route for GET/);
    } finally {
      process.stderr.write = saved;
    }
    assert.equal(fake.unmatched.length, 1);
  });
});
