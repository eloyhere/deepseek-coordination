import { defineConfig } from 'tsdown'

// Must match package.json's name exactly: the client module system resolves the
// browser half by package name + `/client`, and __ModuleLoader__'s id is this string.
const PLUGIN_ID = 'deepseek-coordination'

/**
 * A dual-face plugin produces two artifacts:
 *  - lib/index.mjs : Host half (ESM, node) — Cordis plugin registering /deepseek-coordination/* routes.
 *  - lib/client.js : Browser half (CJS) — wrapped by banner/footer/intro into
 *                    window.__ModuleLoader__.load({ id, factory }) format,
 *                    loaded by dsh-client-modules at /plugins/<id>/client.js.
 */
export default defineConfig([
  {
    name: `${PLUGIN_ID}/host`,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: true,
    clean: false,
    deps: {
      // Host side: cordis and dsh-host-* come from the host process; never bundle them
      neverBundle: (id) =>
        id === '@deepseek-ai/cordis' ||
        id === '@deepseek-ai/dsh-host-webserver' ||
        id.startsWith('@deepseek-ai/dsh-'),
      // Office parsing is pure host code and must work from the packaged bundle
      // (lib/index.mjs) without a runtime node_modules lookup.
      alwaysBundle: (id) => id === 'fflate' || id === 'fast-xml-parser' || id === 'mammoth',
    },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: true,
    clean: false,
    define: {
      // MUI and emotion read process.env.NODE_ENV. The browser has no `process`,
      // and an unsubstituted read throws at module evaluation, which takes the
      // whole web boot down ("import failed: process is not defined").
      'process.env.NODE_ENV': '"production"',
    },
    deps: {
      // The module table only knows react and @deepseek-ai/dsh-client-*:
      //  - neverBundle excludes them (they resolve via module-table require())
      //  - alwaysBundle inlines every other dependency (a missing table row throws)
      neverBundle: (id) => id === 'react' || id.startsWith('@deepseek-ai/dsh-'),
      alwaysBundle: (id) => id !== 'react' && !id.startsWith('@deepseek-ai/dsh-'),
    },
    outputOptions: {
      // DSH's client module loader resolves registered ids only; relative chunk
      // imports break at runtime, and package.json ships only lib/client.js, so
      // the client bundle must stay a single file. Rolldown still wraps each
      // dynamic import in a lazy `__esmMin` initializer, so deferred module
      // bodies stay deferred without emitting a chunk.
      codeSplitting: false,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
