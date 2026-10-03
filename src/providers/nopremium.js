// NoPremium, through the REST API it shares with Rapideo and Twojlimit (polishrest.js). JDownloader uses the same
// REST path on this domain.
// Source: docs/notes/2026-10-02-hoster-apis.md, "NoPremium".
import { polishProvider } from './polishrest.js';

export default polishProvider({ id: 'nopremium', title: 'NoPremium', base: 'https://www.nopremium.pl' });
