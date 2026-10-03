// The providers, in the default order of the `order` setting: the debrid services, then the Polish multihosters,
// then the premium hoster accounts.
import torbox from './torbox.js';
import alldebrid from './alldebrid.js';
import premiumize from './premiumize.js';
import realdebrid from './realdebrid.js';
import debridlink from './debridlink.js';
import rapideo from './rapideo.js';
import nopremium from './nopremium.js';
import twojlimit from './twojlimit.js';
import onefichier from './onefichier.js';
import rapidgator from './rapidgator.js';
import nitroflare from './nitroflare.js';

export const PROVIDERS = [
  torbox, alldebrid, premiumize, realdebrid, debridlink,
  rapideo, nopremium, twojlimit,
  onefichier, rapidgator, nitroflare,
];
