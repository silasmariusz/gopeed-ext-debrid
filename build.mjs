// Bundles src/index.js into dist/index.js: one ES2017 IIFE, the form Gopeed's goja engine runs.
import * as esbuild from 'esbuild';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

await esbuild.build({
  absWorkingDir: dirname(fileURLToPath(import.meta.url)),
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'iife',
  target: 'es2017',
  outfile: 'dist/index.js',
  legalComments: 'none',
});
