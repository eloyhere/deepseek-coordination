import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'deepseek-coordination'

/**
 * A dual-face plugin:
 *  - lib/index.mjs : Node host (ESM Cordis plugin).
 *  - lib/client.js : browser half in DSH's lazy-CJS factory envelope.
 */
export default defineConfig([
  {
    name: `${PLUGIN_ID}/provider-optimizations`,
    entry: { index: 'src/host/providers/index.ts' },
    outDir: 'scripts/context-compat',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: true,
    clean: false,
    outputOptions: { codeSplitting: false },
  },
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
      // The host runtime already owns every DSH package, Cordis and the AMP
      // runtime; bundling a second copy would split service identity.
      neverBundle: (id) =>
        id === '@deepseek-ai/cordis' ||
        id.startsWith('@deepseek-ai/') ||
        id === 'attention-manifest-protocol' ||
        id.startsWith('attention-manifest-protocol/') ||
        id.startsWith('semantic-typescript'),
    },
  },
  {
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    deps: {
      // The module table provides React only. Everything else (MUI, emotion)
      // is inlined into the single client bundle.
      neverBundle: (id) => id === 'react' || id === 'react-dom' || id.startsWith('@deepseek-ai/'),
      alwaysBundle: (id) => id !== 'react' && id !== 'react-dom' && !id.startsWith('@deepseek-ai/'),
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
