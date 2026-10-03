// Rapideo, through the REST API it shares with NoPremium and Twojlimit (polishrest.js). The base is the one the
// vendor's own QNAP addon uses; rapideo.net answered the same requests in the probe.
// Source: docs/notes/2026-10-02-hoster-apis.md, "Rapideo".
import { polishProvider } from './polishrest.js';

export default polishProvider({ id: 'rapideo', title: 'Rapideo', base: 'https://www.rapideo.pl' });
