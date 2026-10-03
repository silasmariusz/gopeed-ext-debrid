// Twojlimit, through the REST API it shares with Rapideo and NoPremium (polishrest.js). On this domain only the
// `account` call was probed; login, files/check and files/download are UNVERIFIED there (JD's own Twojlimit plugin
// still uses the legacy API). If the REST login fails with a real account, the service leaves v1 with that reason.
// Source: docs/notes/2026-10-02-hoster-apis.md, "Twojlimit".
import { polishProvider } from './polishrest.js';

export default polishProvider({ id: 'twojlimit', title: 'Twojlimit', base: 'https://www.twojlimit.pl' });
