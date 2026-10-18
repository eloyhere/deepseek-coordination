/**
 * Body-free description of the project for the settings page.
 *
 * Three read-only sections consume this module: `关于 / About` renders the
 * metadata plus the dependency and tooling inventories, `参考文献 / References`
 * renders the citations, and `作者 / Author` renders the maintainer block. No
 * field here carries a file body, an AST, a token, a credential or any other
 * payload: the module is a plain metadata table, safe for the client bundle.
 *
 * # Version pinning
 *
 * The client bundle cannot read `package.json` at runtime, so `version` is a
 * hard-coded constant. `test/about.test.ts` reads the manifest synchronously and
 * fails loudly when this constant (or any dependency row) drifts from it.
 *
 * # Dependency rows
 *
 * Every package named in `dependencies`, `devDependencies`, `peerDependencies`
 * and `optionalDependencies` has exactly one row. Seven package names appear in
 * two sections (the DSH client/host packages and React are both development
 * installs and peer contracts); the row keeps the peer range, because that is
 * the compatibility promise shipped to the host, and records the wider scope
 * with `scope: 'peer'`. The parity test documents and enforces that rule.
 */
export interface AboutDependency {
  name: string
  version: string
  scope: 'runtime' | 'development' | 'peer'
  role: string
  reason: string
}

/**
 * One original paper the implementation is based on. `reason` is the audit
 * trail back to the module that applies it, so the list cannot quietly become a
 * bibliography of unrelated work.
 */
export interface AboutReference {
  id: string
  authors: string
  year: number
  title: string
  venue: string
  url?: string
  /** Backticked `src/...` path(s) proving this citation is not decoration. */
  reason: string
}

/** The maintainer block: plain contact data, rendered as read-only text/links. */
export interface AboutAuthor {
  name: string
  email: string
  github: string
  npm: string
}

/** Everything the About, References and Author sections render. */
export interface AboutInfo {
  name: string
  version: string
  license: string
  summary: string
  runtime: string
  author: AboutAuthor
  dependencies: readonly AboutDependency[]
  tooling: readonly AboutDependency[]
  references: readonly AboutReference[]
}

/** The project metadata; `version` and every dependency row are test-pinned. */
export const ABOUT: AboutInfo = {
  name: 'deepseek-coordination',
  version: '0.14.3',
  license: 'Apache-2.0',
  summary:
    'deepseek-coordination is a dual-face Cordis plugin for DeepSeek Harness: the host half records coordination state, registers model-facing tools and serves read-only HTTP routes, while the web half mounts the composer controls, workspace panel and settings page. The panel and parser layer is read-only: it projects body-free metadata and never edits, renames or deletes workspace files.',
  runtime: '>=22.13.0',
  author: {
    name: 'Eloy Kim',
    email: 'eloy.kim@outlook.com',
    github: 'https://github.com/eloyhere/deepseek-coordination',
    npm: 'https://www.npmjs.com/package/deepseek-coordination',
  },

  dependencies: [
    /* ---------------------------- runtime ---------------------------- */
    {
      name: '@deepseek-ai/schemastery',
      version: '^3.18.4',
      scope: 'runtime',
      role: 'Config schema',
      reason: 'Declares the host configuration schema, defaults and validation for the plugin config.',
    },
    {
      name: '@emotion/react',
      version: '^11.14.0',
      scope: 'runtime',
      role: 'Style engine',
      reason: 'Runtime required by MUI components to compose their styles in the browser bundle.',
    },
    {
      name: '@emotion/styled',
      version: '^11.14.1',
      scope: 'runtime',
      role: 'Styled engine',
      reason: 'Provides styled() for the MUI widgets used by the composer, panel and settings page.',
    },
    {
      name: '@mui/icons-material',
      version: '^9.5.0',
      scope: 'runtime',
      role: 'Icon set',
      reason: 'Tab, menu and status icons in the workspace panel and settings rows.',
    },
    {
      name: '@mui/material',
      version: '^9.5.0',
      scope: 'runtime',
      role: 'UI components',
      reason: 'Accordion, Table, List, TextField and the rest of the client widget surface.',
    },
    {
      name: 'dompurify',
      version: '^3.4.17',
      scope: 'runtime',
      role: 'HTML sanitizer',
      reason: 'Sanitizes the bounded Office preview HTML before the panel renders it.',
    },
    {
      name: 'fast-xml-parser',
      version: '^5.11.2',
      scope: 'runtime',
      role: 'XML parser',
      reason: 'Reads document, sheet and slide XML parts during bounded Office preview conversion.',
    },
    {
      name: 'fflate',
      version: '^0.8.3',
      scope: 'runtime',
      role: 'ZIP codec',
      reason: 'Unzips OOXML packages for preview and is bundled into the host entry.',
    },
    {
      name: 'katex',
      version: '^0.19.0',
      scope: 'runtime',
      role: 'Math renderer',
      reason: 'Renders TeX math in Markdown previews through rehype-katex (MathML output).',
    },
    {
      name: 'mammoth',
      version: '^1.13.0',
      scope: 'runtime',
      role: 'DOCX converter',
      reason: 'Converts a bounded word/document.xml into the preview HTML fragment.',
    },
    {
      name: 'prism-react-renderer',
      version: '^2.4.1',
      scope: 'runtime',
      role: 'Syntax highlighting',
      reason: 'Highlights fenced code blocks in the Markdown preview.',
    },
    {
      name: 'react-dom',
      version: '^18.2.0',
      scope: 'runtime',
      role: 'DOM renderer',
      reason: 'Renders the client widgets; React itself comes from the host module table.',
    },
    {
      name: 'react-markdown',
      version: '^10.1.0',
      scope: 'runtime',
      role: 'Markdown renderer',
      reason: 'Renders the bounded Markdown preview inside the workspace panel.',
    },
    {
      name: 'rehype-katex',
      version: '^7.0.1',
      scope: 'runtime',
      role: 'Math transform',
      reason: 'Turns remark-math nodes into KaTeX markup in the preview pipeline.',
    },
    {
      name: 'remark-gfm',
      version: '^4.0.1',
      scope: 'runtime',
      role: 'GFM syntax',
      reason: 'Adds tables, task lists and strikethrough to the Markdown preview.',
    },
    {
      name: 'remark-math',
      version: '^6.0.0',
      scope: 'runtime',
      role: 'Math syntax',
      reason: 'Parses inline and block math in the Markdown preview.',
    },

    /* -------------------------- development -------------------------- */
    {
      name: '@deepseek-ai/dsh-client-ui-conversation',
      version: '^0.2.1-rc.2',
      scope: 'development',
      role: 'Conversation UI types',
      reason: 'Development-time DSH conversation package for type compatibility; no runtime import ships.',
    },
    {
      name: '@types/dompurify',
      version: '^3.0.5',
      scope: 'development',
      role: 'Type definitions',
      reason: 'Types for the dompurify import in the preview sanitizer.',
    },
    {
      name: '@types/node',
      version: '^26.2.0',
      scope: 'development',
      role: 'Node types',
      reason: 'Types for node:* imports in the host half, the tests and the build config.',
    },
    {
      name: '@types/react',
      version: '~18.3.1',
      scope: 'development',
      role: 'React types',
      reason: 'Types for the React 18 client components.',
    },
    {
      name: 'tsdown',
      version: '^0.22.14',
      scope: 'development',
      role: 'Bundler',
      reason: 'Builds the host ESM entry and the wrapped client bundle from tsdown.config.ts.',
    },
    {
      name: 'typescript',
      version: '^5.6.0',
      scope: 'development',
      role: 'Typechecker',
      reason: 'Drives the typecheck scripts through tsc --noEmit.',
    },

    /* ------------------------------ peer ------------------------------ */
    {
      name: '@deepseek-ai/cordis',
      version: '^4.0.1',
      scope: 'peer',
      role: 'Plugin host',
      reason: 'Cordis context and service API; supplied by the DSH host process.',
    },
    {
      name: '@deepseek-ai/dsh-client-locale',
      version: '^0.1.0-rc.7 || >=0.2.1-rc.2',
      scope: 'peer',
      role: 'Host locale',
      reason: 'DSH locale service for the active UI language; supplied at runtime.',
    },
    {
      name: '@deepseek-ai/dsh-client-runtime',
      version: '^0.1.0-rc.7 || >=0.2.1-rc.2',
      scope: 'peer',
      role: 'Client runtime',
      reason: 'DSH web module loader and runtime APIs; provided by the host shell.',
    },
    {
      name: '@deepseek-ai/dsh-client-ui-settings',
      version: '^0.1.0-rc.7 || >=0.2.1-rc.2',
      scope: 'peer',
      role: 'Settings slot',
      reason: 'Host settings-page slot the coordination page is mounted into.',
    },
    {
      name: '@deepseek-ai/dsh-client-ui-slots',
      version: '^0.1.0-rc.7 || >=0.2.1-rc.2',
      scope: 'peer',
      role: 'Composer slots',
      reason: 'Composer slot registration for the five dropdown controls.',
    },
    {
      name: '@deepseek-ai/dsh-host-webserver',
      version: '^0.1.0-rc.7 || >=0.2.1-rc.2',
      scope: 'peer',
      role: 'HTTP routes',
      reason: 'Host web server used to register the /deepseek-coordination/* routes.',
    },
    {
      name: 'react',
      version: '^18.2.0',
      scope: 'peer',
      role: 'UI runtime',
      reason: 'React 18 is provided by the DSH web shell through the module table and is never bundled.',
    },
  ],

  tooling: [
    {
      name: 'tsdown',
      version: '^0.22.14',
      scope: 'development',
      role: 'Bundler',
      reason: 'tsdown.config.ts emits lib/index.mjs and wraps the client bundle for __ModuleLoader__.',
    },
    {
      name: 'typescript',
      version: '^5.6.0',
      scope: 'development',
      role: 'Typechecker',
      reason: 'npm run typecheck and test:tsc run tsc --noEmit over source and tests.',
    },
    {
      name: 'node',
      version: '>=22.13.0',
      scope: 'development',
      role: 'Runtime and test runner',
      reason: 'Node runs the host, node --test and scripts/check-pack.mjs; engines.node is the floor.',
    },
    {
      name: 'npm',
      version: 'unpinned',
      scope: 'development',
      role: 'Script runner',
      reason: 'Every build, test and prepack step is an npm script; no npm version is pinned in package.json.',
    },
  ],

  references: [
    {
      id: 'sharir-1981',
      authors: 'Micha Sharir',
      year: 1981,
      title: 'A Strong-Connectivity Algorithm and Its Applications in Data Flow Analysis',
      venue: 'Computers & Mathematics with Applications 7(1), 67-72',
      url: 'https://doi.org/10.1016/0898-1221(81)90008-0',
      reason: 'Strongly connected components for the cycle scan in `src/host/graph-view.ts`; the tree implements an iterative Kosaraju variant.',
    },
    {
      id: 'fruchterman-reingold-1991',
      authors: 'Thomas M. J. Fruchterman; Edward M. Reingold',
      year: 1991,
      title: 'Graph Drawing by Force-Directed Placement',
      venue: 'Software: Practice and Experience 21(11), 1129-1164',
      url: 'https://doi.org/10.1002/spe.4380211102',
      reason: 'Force-directed repulsion and spring relaxation in `layoutCanvasGraph` (`src/client/panel.ts`).',
    },
    {
      id: 'bayer-mccreight-1972',
      authors: 'Rudolf Bayer; Edward M. McCreight',
      year: 1972,
      title: 'Organization and Maintenance of Large Ordered Indices',
      venue: 'Acta Informatica 1(3), 173-189',
      url: 'https://doi.org/10.1007/BF00288683',
      reason: 'The B+ tree implementation in `src/shared/tree.ts`.',
    },
    {
      id: 'guibas-sedgewick-1978',
      authors: 'Leo J. Guibas; Robert Sedgewick',
      year: 1978,
      title: 'A Dichromatic Framework for Balanced Trees',
      venue: 'Proceedings of the 19th Annual Symposium on Foundations of Computer Science (FOCS), 8-21',
      url: 'https://doi.org/10.1109/SFCS.1978.3',
      reason: 'The red-black tree and set in `src/shared/redblack.ts`.',
    },
    {
      id: 'pugh-1990',
      authors: 'William Pugh',
      year: 1990,
      title: 'Skip Lists: A Probabilistic Alternative to Balanced Trees',
      venue: 'Communications of the ACM 33(6), 668-676',
      url: 'https://doi.org/10.1145/78973.78977',
      reason: 'Skip lists and skip sets in `src/shared/list.ts` and `src/shared/set.ts`.',
    },
    {
      id: 'cormen-leiserson-rivest-stein-2009',
      authors: 'Thomas H. Cormen; Charles E. Leiserson; Ronald L. Rivest; Clifford Stein',
      year: 2009,
      title: 'Introduction to Algorithms, 3rd edition',
      venue: 'MIT Press',
      reason: 'Baseline algorithm and complexity bounds used by `src/shared/graph.ts` and `src/shared/heap.ts`.',
    },
    {
      id: 'fielding-2000',
      authors: 'Roy Thomas Fielding',
      year: 2000,
      title: 'Architectural Styles and the Design of Network-based Software Architectures',
      venue: 'PhD dissertation, University of California, Irvine',
      url: 'https://www.ics.uci.edu/~fielding/pubs/dissertation/top.htm',
      reason: 'Read-only REST route design for the host HTTP surface in `src/index.ts`.',
    },
    {
      id: 'gim-et-al-2024',
      authors: 'In Gim; Guojun Chen; Seung-seob Lee; Nikhil Sarda; Anurag Khandelwal; Lin Zhong',
      year: 2024,
      title: 'Prompt Cache: Modular Attention Reuse for Low-Latency Inference',
      venue: 'Proceedings of MLSys 2024',
      url: 'https://arxiv.org/abs/2311.04934',
      reason: 'Stable-prefix decoration and cache hit-rate accounting in `src/host/cache.ts`.',
    },
    {
      id: 'liu-et-al-2024',
      authors: 'Nelson F. Liu; Kevin Lin; John Hewitt; Ashwin Paranjape; Michele Bevilacqua; Fabio Petroni; Percy Liang',
      year: 2024,
      title: 'Lost in the Middle: How Language Models Use Long Contexts',
      venue: 'Transactions of the Association for Computational Linguistics 12, 157-173',
      url: 'https://doi.org/10.1162/tacl_a_00638',
      reason: 'Context-pressure limits and compaction thresholds in `src/host/token.ts` and `src/host/compact.ts`.',
    },
  ],
}
