// The entry Gopeed runs (bundled to dist/index.js). manifest.json runs it for three events, each in a fresh engine:
// onResolve (resolve.js: which provider turns the link into a direct download), onStart and onError (renew.js: an
// expired direct link is renewed before the start or after a 403, 404 or 410).
import { onResolve } from './resolve.js';
import { onStart, onError } from './renew.js';

gopeed.events.onResolve((ctx) => onResolve(ctx));
gopeed.events.onStart((ctx) => onStart(ctx));
gopeed.events.onError((ctx) => onError(ctx));
