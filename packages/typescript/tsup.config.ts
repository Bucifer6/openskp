import { defineConfig } from 'tsup';

export default defineConfig([
  // The published library: CommonJS and ES module builds, dependencies
  // left as imports for the consumer's own package manager or bundler.
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
  },
  // One self-contained ES module for the browser, dependencies included.
  //
  // The regular ES module build imports 'fflate', 'earcut' and
  // 'flatbuffers' by bare name. A page can point those at a CDN with an
  // import map, but an import map does not apply inside a Web Worker - and
  // a worker is where parsing a large model belongs, so the page stays
  // responsive. This file loads anywhere a module can, with no import map
  // and no bundler:
  //
  //   import { loadSkp } from 'https://cdn.jsdelivr.net/npm/openskp/dist/openskp.browser.mjs';
  {
    entry: { 'openskp.browser': 'src/index.ts' },
    format: ['esm'],
    platform: 'browser',
    noExternal: [/.*/],
    outExtension: () => ({ js: '.mjs' }),
  },
]);
