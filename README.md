# gopeed-ext-debrid

A [Gopeed](https://github.com/GopeedLab/gopeed) extension for people who pay for a debrid service, a Polish
multihoster or a premium hoster account. You add a hoster link, or a magnet the service already has cached, and the
extension asks your account for a direct HTTPS link. Gopeed then downloads from that link.

Version 0.1.0 has eleven providers: five debrid services (TorBox, AllDebrid, Premiumize, Real-Debrid and
Debrid-Link), three Polish multihosters (Rapideo, NoPremium and Twojlimit) and three premium hoster accounts
(1fichier, Rapidgator and Nitroflare). Gopeed calls the extension on three events. `onResolve` turns a link into a
direct download, and `onStart` and `onError` renew a direct link that has expired.

The providers were tested against recorded answers and a mock server that answers every provider's endpoints, inside
a real Gopeed. They have not been tested against live accounts yet, so a service may answer in a way the mock does
not. The open questions are listed below under "Not verified yet".

## Install

The extension needs a Gopeed whose extension engine has `task.meta.req.setUrl`, which upstream added after
2.0.0-beta.3 (GopeedLab/gopeed#1538). On an older Gopeed, links still resolve, but an expired link cannot be renewed.

- From the store: the repository has the GitHub topic `gopeed-extension`, which the Gopeed Extension Store lists
  extensions from. Open **Extensions**, search for "debrid" and press **Install**.
- By URL: open **Extensions**, paste `https://github.com/silasmariusz/gopeed-ext-debrid` into **Install URL** and
  confirm.
- On a QNAP NAS, the Rtorrent 16 Gopeed add-on carries this extension from its build 2.0.0-10. At every start it
  compares the bundled version with the installed one and installs the bundled copy when they differ, keeping your
  settings. There you only fill in the settings.

Then open the extension's settings on the **Extensions** page, switch on the services you have an account for and
paste their keys or logins. Every service starts switched off.

## How a link is handled

- The enabled services are asked in the order of the `order` setting. Unknown ids in it are ignored, and
  the ids it leaves out follow in the default order. A service takes a link when the link's host is in its host
  list. A link that no service takes is left alone, and Gopeed downloads it as usual.
- The host lists are kept for 24 hours. When they have to be loaded, all services load theirs at the same time and
  get 10 seconds, so a link waits 10 seconds at most. A service whose list fails to load, or loads empty, takes no
  link for the next 10 minutes, or until its settings change. A premium hoster account (1fichier, Rapidgator,
  Nitroflare) still takes links to its own site in that time, because it needs no list for them.
- When a service fails with a refused key or login (or the pause that follows one), Real-Debrid's device code, a
  dead link or a file password, that error is shown at once and no other service is asked. Any other failure, such
  as "host not supported", a used-up limit, a file that is not ready, a refused address, an expired account or a
  service that is down, passes the link to the next service that takes it. When none succeeds, you see every reason.
- Only `magnet:` links count as magnets; a `.torrent` URL is an ordinary link. Magnets reach the extension through the
  manifest's `*://*/*` pattern; Gopeed's matcher never matches the `magnet:*` entry, which is kept as harmless. The debrid services are asked in
  order whether they have the torrent cached, and the first one that has it gives one download per file, under the
  torrent's name (the magnet's `dn`, or else its info hash). A refused key or the device code is shown; any other
  error counts as "not cached". When nothing is cached, a request with the label `rt16.debrid=cached-or-refuse`
  fails with `RT16_NOT_CACHED` (the Rtorrent16 package then gives the magnet to rtorrent). Without that label,
  Gopeed's own BitTorrent engine takes the magnet. With `magnets_via_debrid` off, no service is asked about
  magnets.
- Every direct link the extension hands out is remembered for 7 days with the link it came from.
  - Before a task starts, a link older than half of its service's link lifetime is fetched again.
  - When a download fails with HTTP 403, 404 or 410, the link is fetched again with the current settings and
    order, and the task continues, up to 3 times per task.
  - A file of a magnet is renewed by asking for the magnet again and taking the file with the same name and size.
    When no file matches, the link is not renewed and the error stands. The magnet's new file list is kept for 5
    minutes, so the other files of the same pack reuse it.
  - If the storage cannot keep these records, the link is still handed out; it just cannot be renewed. A task whose
    renewal count cannot be stored gets no renewal.
- The records of finished tasks are removed once a day, when they have expired.
- Every error you see goes through the same masking as the provider errors, so no key, token or password from the
  settings appears in it. The log line for each handled link names the service and, for a hoster link, its host;
  it never holds a URL.

## Services

Each service has a switch and its credentials:

| Service | Kind | Settings |
|---|---|---|
| TorBox | debrid | `torbox_enabled`, `torbox_apikey` |
| AllDebrid | debrid | `alldebrid_enabled`, `alldebrid_apikey` |
| Premiumize | debrid | `premiumize_enabled`, `premiumize_apikey` |
| Real-Debrid | debrid | `realdebrid_enabled`, `realdebrid_token` |
| Debrid-Link | debrid | `debridlink_enabled`, `debridlink_apikey` |
| Rapideo | multihoster | `rapideo_enabled`, `rapideo_login`, `rapideo_password` |
| NoPremium | multihoster | `nopremium_enabled`, `nopremium_login`, `nopremium_password` |
| Twojlimit | multihoster | `twojlimit_enabled`, `twojlimit_login`, `twojlimit_password` |
| 1fichier | hoster | `onefichier_enabled`, `onefichier_apikey` |
| Rapidgator | hoster | `rapidgator_enabled`, `rapidgator_login`, `rapidgator_password`, `rapidgator_2fa_secret` (optional) |
| Nitroflare | hoster | `nitroflare_enabled`, `nitroflare_user`, `nitroflare_premium_key` |

Three more settings apply to all of them:

- `order` lists provider ids, separated by commas, in the order they are asked. The default is
  `torbox,alldebrid,premiumize,realdebrid,debridlink,rapideo,nopremium,twojlimit,onefichier,rapidgator,nitroflare`.
- `magnets_via_debrid` (on by default) lets magnets go to the debrid services.
- `advanced_api_base` is for testing only. It sends every provider's requests to this base URL. Leave it empty.

Real-Debrid has two ways to sign in. With `realdebrid_token` empty, the first link you add fails with a message such
as "open https://real-debrid.com/device and enter ABCD1234, then add the link again". Enter the code there, add the
link again, and the extension stores the login it gets. With `realdebrid_token` filled in, that private API token is
used as it is.

If your Rapidgator account has two-factor login on, put the base32 secret from your authenticator's setup screen in
`rapidgator_2fa_secret`, not a six-digit code. The extension computes the current code from it. The code depends on
the clock, so a device whose clock is wrong sends wrong codes, and Rapidgator counts each one as a failed login.
The extension never sends the same code twice: a second login within the same 30 seconds waits for the next code,
and links added at the same moment share one login.

Nitroflare sometimes asks for a captcha. The extension cannot show one, so it tells you to log in on nitroflare.com
once in a browser and then add the link again.

Every service starts switched off. The extension trims whitespace around a pasted key or password. Gopeed stores
extension settings in plain text and returns them from its API, so the names of secret settings end in `_token`,
`_key`, `_apikey`, `_password` or `_secret`, which lets a front end mask them.

Mega links are not supported. Mega encrypts files on the client with AES-CTR and keeps the key in the URL fragment.
Gopeed would save the ciphertext, and decrypting gigabytes in the extension engine is not workable. A Mega link that
none of your enabled services takes fails with a message that says so.

## Not verified yet

These come from the API research and were not confirmed against a live account:

- TorBox: the name of the operation that deletes a torrent (`delete`), and whether `createtorrent` accepts a urlencoded form
  body. If the delete name is wrong, a torrent that was not cached stays in the TorBox account.
- Rapideo, NoPremium and Twojlimit: what the `sdownload` field of the host list means. The extension does not filter
  on it, so every listed domain counts and the API's answer decides. Of Twojlimit's API only the `account` call was
  probed.
- Rapidgator: whether the `session_id` in a download URL is the login token.

## Development

You need Node 22 or newer and npm.

```sh
npm install
npm test        # node:test, against a fake of Gopeed's globals (test/fake-gopeed.js)
npm run build   # esbuild bundles src/index.js into dist/index.js, one ES2017 IIFE
```

Gopeed runs `dist/index.js` (the `entry` of every script in `manifest.json`), so the bundle is committed together
with the source. Rebuild it before you commit a change under `src/`.

The extension runs in Gopeed's goja engine. It can use `fetch`, `setTimeout`, `MessageError` and
`gopeed.{events,settings,storage,logger,info}`; Node's built-in modules are not available there.

### Layout

```
manifest.json      identity silasmariusz@debrid, the scripts (onResolve, onStart, onError) and the settings
build.mjs          the esbuild bundle
src/index.js       the entry: it registers the three hooks
src/resolve.js     onResolve: the order, the claim, magnets and the label, Mega, and the record of each direct link
src/renew.js       onStart and onError: the renewal of an expired direct link
src/lib/           the shared libraries below
src/providers/     one module per service, common.js with what they share, and index.js, the registry
test/              node:test suites, the fixtures (test/fixtures/<id>/) and the fake Gopeed
dist/index.js      the bundle Gopeed runs
```

### Shared libraries

- `http.js`
  - `requestJSON(provider, method, url, { headers, form, json, query, timeoutMs = 30000, secrets = [] })` returns the
    parsed JSON, or `null` for an empty 2xx answer (such as a 204). It encodes `query` and `form` itself: `null` and
    `undefined` values are skipped, and an array value repeats its key. Every request carries the header
    `User-Agent: gopeed-ext-debrid/<version>`.
  - Any failure, a parse error included, becomes a `ProviderError`. The message reads
    `<provider>: <reason>`, for example `TorBox: the service did not answer properly (HTTP 503)`. The error also
    carries `provider`, `reason`, `status`, `code` and, for a JSON error answer, `body`.
  - The codes are `timeout` ("the service did not answer within 30 s"), `network`, `bad_response` (the body is not
    JSON), and, for HTTP 400 or more with a JSON body, the error code from the body, or `http` when the body has none.
    No message contains the URL, because a query can hold an API key.
  - A provider may echo the credential it was sent, so pass the call's credentials as `secrets` (for example
    `secretsOf(providerSettings(id))`). `ProviderError` takes them as `extra.secrets` and hides them in its reason,
    its message, a string `code` and every string in `body` before it stores them. It keeps no copy of the secrets.
    A provider that throws its own `ProviderError` passes `{ secrets }` the same way.
- `cache.js`
  - `cached(key, ttlMs, loader)`, `remember(key, value, ttlMs)` and `recall(key)` keep JSON values in `gopeed.storage`
    with an expiry time.
  - A missing, corrupt or expired entry counts as a miss. A loader that throws stores nothing.
  - `sweep(prefixes, everyMs)` removes the expired or unreadable entries under the given key prefixes, at most once
    per `everyMs` (the time of the last run is kept under `sweep:at`).
- `magnet.js`
  - `parseMagnet(uri)` returns `{ hash, name, trackers }`, where `hash` is always 40 lowercase hex, whether the magnet
    gives it in hex or base32.
  - It returns `null` when the magnet has no valid v1 info-hash.
- `hosts.js`
  - `hostOf(url)` gives the lowercase host without `www.`.
  - `hostMatches(host, domains)` matches exactly or by subdomain, so `dl.rapidgator.net` matches `rapidgator.net` and
    `evilrapidgator.net` does not.
- `settings.js`
  - `settings()` returns the current settings with strings trimmed.
  - `providerSettings(id)` returns one provider's fields without their prefix: `torbox_apikey` becomes `apikey`.
  - `apiBase(id, defaultBase)` is where a provider sends its requests: `defaultBase`, or
    `<advanced_api_base>/<id>` when that setting is filled in, so one mock server can answer for every provider. It
    reads the setting on every call.
  - `secretsOf(fields)` lists the non-empty string values of the fields whose name is, or ends in, `token`, `key`,
    `apikey`, `password` or `secret`. It takes the output of either function, so `nitroflare_premium_key` and `premium_key`
    both count, and `rapidgator_login` does not.
- `cooldown.js`
  - After a provider refuses a credential, `startCooldown(id, credential, reason, ms)` pauses that provider for `ms`
    (10 minutes when it is left out), and `cooldownLeft(id, credential)` says how long is left (`null` when there is no pause). The record is
    kept under `cooldown:<id>`. It holds a hash of the credential, never the credential, so a changed setting ends
    the pause at once.
- `totp.js`
  - `totp(keyBytes, timeMs, { step = 30, digits = 6 })` is the RFC 6238 code, and `base32Decode(text)` turns an
    authenticator secret into bytes (any case, spaces and `=` padding allowed; `null` for anything else).
  - Both run on a plain-JS SHA-1 and HMAC-SHA1 (`sha1`, `sha1Hex`, `hmacSha1`), because goja has no WebCrypto.
- `redact.js`
  - `redact(text, secrets)` replaces each secret with `••••`, as written and in any percent-encoding. Each
    character may appear as itself or as its `%XX` bytes in either hex case, and a space also as `+`. That covers
    `encodeURIComponent`, `encodeURI`, form bodies (`URLSearchParams`, Go's `url.QueryEscape`) and Go's
    `url.PathEscape`.

### Providers

Each module in `src/providers/` exports one object and the registry exports them as `PROVIDERS`, in the default
order of the `order` setting:

```js
{ id, title, kind, base, linkTTLms, // kind is 'debrid', 'multihoster' or 'hoster'
  enabled(s),                   // s = providerSettings(id)
  async hosts(s),               // the domains this account handles, kept 24 h under hosts:<id>
  async unrestrict(s, url),     // { name, size, url, headers } for a link, or null when the host is not in hosts()
  async cachedMagnet(s, magnet) // [{ name, size, url, headers }] for a magnet the service has cached, or null
}
```

The multihosters and the hosters take no magnets, so their `cachedMagnet` always returns `null`. A hoster's
`hosts()` returns its own domains and makes no request.

- `base` is the host root. The version path (`/rest/1.0`, `/v4`, `/api/v2`) is part of each request.
- `linkTTLms` is the lifetime the extension assumes for a direct link: five minutes for 1fichier, one hour for
  TorBox, three hours for the others.
- A magnet probe leaves nothing behind:
  - TorBox and Premiumize check their cache first, and add nothing when the magnet is not cached.
  - Debrid-Link is sent only the info hash, which its API adds only when it has the torrent cached. An added torrent
    that is not complete is removed.
  - Real-Debrid adds the magnet, waits up to 10 s, and deletes it when it is not cached.
  - AllDebrid reads the `ready` flag of the upload and deletes a magnet that is not ready.
- Every failure is a `ProviderError` whose message names the cause, and whose `code` is one of `auth_invalid`,
  `cooldown`, `account_expired`, `limit_reached`, `not_supported`, `dead_link`, `service_down`, `rate_limited`,
  `not_ready`, `login_required` (Real-Debrid's device code), `ip_not_allowed` and `bad_password`. Any other
  code is the service's own. The list is at the top of `src/providers/common.js`.
- A refused key (`auth_invalid`) pauses that provider for 10 minutes. Later calls fail at once with a `cooldown`
  error and send nothing, until the pause ends or the setting changes. The pause lasts 60 minutes when a Polish
  multihoster answers that the login is locked for 60 minutes (its error 4).
- Rapideo, NoPremium and Twojlimit share one REST API, in `polishrest.js`. The three modules only set the domain.
  - The calls send `device: "gopeed-ext-debrid"`. The vendor addon's own device name, `qnap`, is not used.
  - `files/download` sends `mode: "qnap"`, because the API needs it to return the link.
  - The host list comes from the service's public `clipboard.php?json=3`. Every domain in it counts, and the API's
    answer decides; its "host not supported" error is `not_supported`.
- The services that sign in with a password (the Polish three and Rapidgator) keep their session token under
  `session:<id>`, for the login it belongs to, and reuse it. A refused token is replaced by one new login and the
  call is repeated once, so one link logs in at most once. Any refused login starts the 10-minute pause (60 minutes
  for the Polish lock) and is never retried by the extension itself.
- 1fichier uses `onefichier_apikey` as a Bearer key. Nitroflare checks the user and the premium key with `getKeyInfo`
  before it asks for a link, which also catches an expired account or a used-up quota.
- Keys and tokens, including the ones Real-Debrid, the Polish multihosters and Rapidgator hand out at login, are
  hidden in every error text.

## Licence

MIT. See [LICENSE](LICENSE).
