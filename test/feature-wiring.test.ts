/**
 * Feature-wiring tests for the v0.9 file layer (audit v24).
 *
 * These tests pin the *wiring*, not the parser: a file is parsed by the real
 * P0 parser, projected into a bounded `NodeCard`, indexed into the host-only
 * `Chain` engine, described by handle and read back through the one authorized
 * content path. They also pin the negative contract — no body in
 * parse/describe/chain values, no traversal, no binary read, explicit
 * truncation, bounded caches — and the shape of the four new tool definitions.
 *
 * Everything runs on plain Node with a temp workspace; no Cordis context, no
 * DSH host and no database are involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  ChainEngine,
  MAX_CHAIN_DEPTH,
  MAX_CHAIN_LINKS,
} from '../src/host/chain.js'
import type { ChainProjection } from '../src/host/chain.js'
import { NodeRegistry, fileHandleFor } from '../src/host/node-registry.js'
import type { NodeCard } from '../src/host/node-registry.js'
import {
  MAX_READ_TOKENS,
  ParseService,
} from '../src/host/parse-service.js'
import type { ParsedFile } from '../src/host/parse-service.js'
import {
  TOOL_RESULT_MARKER,
  coordinationFileToolDefinitions,
  coordinationToolDefinitions,
  registerCoordinationTools,
  resolveToolWorkspaceRoot,
  toolResultMaxBytes,
} from '../src/host/tools.js'
import type {
  CoordinationToolDefinition,
  CoordinationToolRegistry,
  CoordinationToolService,
  ParseToolValue,
} from '../src/host/tools.js'
import type { DescribeResult } from '../src/host/node-registry.js'
import { applyConfigPatch } from '../src/host/selection.js'
import type { CoordinationConfig } from '../src/host/config.js'
import { InvalidStateError } from '../src/shared/error.js'
import { estimateTokens } from '../src/host/token.js'
import { MAX_AST_DEPTH } from '../src/host/text/parser.js'
import { testConfig } from './helpers.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

class TempWorkspace {
  readonly root: string

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), 'coordination-wiring-'))
  }

  write(relative: string, content: string | Buffer): string {
    const absolute = join(this.root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
    return absolute
  }

  close(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

/** The composed host service is marked by the kernel fields; tests fake them. */
function toolService(
  workspaceRoot: string | undefined,
  locale: 'zh-CN' | 'en-US' = 'en-US',
  kernel = true,
): CoordinationToolService {
  return {
    locale,
    ...(kernel ? { db: {}, config: {} } : {}),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    state: () => {
      throw new Error('selection tools are not used by the file-layer tests')
    },
    setSelection: () => {
      throw new Error('selection tools are not used by the file-layer tests')
    },
    activeTurn: () => undefined,
    getProfessionRecord: () => {
      throw new Error('profession tools are not used by the file-layer tests')
    },
    turnByOrdinal: () => undefined,
  }
}

class MemoryRegistry implements CoordinationToolRegistry {
  readonly definitions = new Map<string, CoordinationToolDefinition>()

  register(definition: CoordinationToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name)
    }
  }

  get(name: string): CoordinationToolDefinition {
    const definition = this.definitions.get(name)
    if (definition === undefined) throw new Error(`tool ${name} was not registered`)
    return definition
  }
}

/** Index one parse into both projections, mirroring what the tool layer does. */
function indexInto(
  chain: ChainEngine,
  parsed: ParsedFile,
  registry: NodeRegistry,
): NodeCard[] {
  const cards = registry.register(parsed)
  if (parsed.path !== undefined) chain.index(parsed)
  return cards
}

/* ------------------------------------------------------------------------- *
 * Parser -> registry -> describe
 * ------------------------------------------------------------------------- */

test('parse -> registry -> describe projects a body-free NodeCard', () => {
  const workspace = new TempWorkspace()
  try {
    const bodyMarker = 'SECRET_BODY_MARKER_9f3c'
    workspace.write(
      'src/a.ts',
      [
        '/** Adds two numbers. */',
        'export function add(left: number, right: number): number {',
        `  return left + right + '${bodyMarker}'.length`,
        '}',
      ].join('\n'),
    )
    const service = new ParseService({ workspaceRoot: workspace.root })
    const parsed = service.parse({ path: 'src/a.ts' })
    assert.equal(parsed.path, 'src/a.ts')
    assert.equal(parsed.parserId, 'javascript')
    assert.equal(parsed.status, 'parsed')
    assert.equal(parsed.cached, false)
    assert.ok(parsed.file.fingerprint?.startsWith('sha256:'))
    assert.ok(parsed.nodes.length >= 1)
    // The parse result is metadata only: the body marker is in no field.
    assert.ok(!JSON.stringify(parsed).includes(bodyMarker))

    const registry = new NodeRegistry()
    const cards = registry.register(parsed)
    assert.ok(cards.length >= 2)
    const fileCard = cards[0]
    assert.equal(fileCard.identity, fileHandleFor('src/a.ts'))
    assert.equal(fileCard.kind, 'module')
    assert.equal(fileCard.name, 'a.ts')
    assert.equal(fileCard.path, 'src/a.ts')
    assert.equal(fileCard.byteStart, 0)
    assert.ok((fileCard.byteEnd ?? 0) > 0)
    assert.equal(fileCard.lineStart, 1)
    assert.ok((fileCard.lineEnd ?? 0) >= 4)
    assert.equal(registry.size, cards.length)

    const described = registry.describe(fileCard.identity, [
      'summary',
      'description',
      'usage',
      'purpose',
    ])
    assert.equal(described.handle, fileCard.identity)
    assert.equal(described.card.kind, 'module')
    assert.equal(typeof described.brief, 'string')
    assert.equal(described.fields.path, 'src/a.ts')
    assert.equal(described.fields.fingerprint, fileCard.fingerprint)
    assert.ok(!JSON.stringify(described).includes(bodyMarker))
    // Missing metadata is explicit, never invented.
    assert.ok(described.unverifiable.includes('purpose'))

    const symbol = cards.find((card) => card.kind === 'function')
    assert.ok(symbol !== undefined)
    assert.equal(symbol.name, 'add')
    assert.match(symbol.brief ?? '', /Adds two numbers/)
    assert.ok(!JSON.stringify(symbol).includes(bodyMarker))
    assert.ok((symbol.summary?.length ?? 0) <= 200)

    assert.throws(() => registry.describe('nmissing'), /was not found/)
    assert.throws(() => registry.describe(fileCard.identity, ['bogus']), /unknown describe field/)
  } finally {
    workspace.close()
  }
})

test('text parses are body-free, cacheless and have no chain identity', () => {
  const workspace = new TempWorkspace()
  try {
    const service = new ParseService({ workspaceRoot: workspace.root })
    const parsed = service.parse({
      text: 'export function inline(): number { return 1 }\n',
      parserId: 'javascript',
    })
    assert.equal(parsed.path, undefined)
    assert.equal(service.cacheStats().size, 0)
    const cards = new NodeRegistry().register(parsed)
    assert.ok(cards.length >= 2)
    const chain = new ChainEngine()
    assert.throws(() => chain.index(parsed), /file-backed parse/)
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Parse -> dependency chain
 * ------------------------------------------------------------------------- */

test('parse -> chain follows imports, orders by depth and reports cycles', () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/cycle-a.ts', "import './cycle-b'\nexport const a = 1\n")
    workspace.write('src/cycle-b.ts', "import './cycle-a'\nexport const b = 2\n")
    workspace.write('src/chain-1.ts', "import './chain-2'\nexport const one = 1\n")
    workspace.write('src/chain-2.ts', "import './chain-3'\nexport const two = 2\n")
    workspace.write('src/chain-3.ts', 'export const three = 3\n')

    const service = new ParseService({ workspaceRoot: workspace.root })
    const registry = new NodeRegistry()
    const chain = new ChainEngine()
    for (const path of [
      'src/cycle-a.ts',
      'src/cycle-b.ts',
      'src/chain-1.ts',
      'src/chain-2.ts',
      'src/chain-3.ts',
    ]) {
      indexInto(chain, service.parse({ path }), registry)
    }

    const a = fileHandleFor('src/cycle-a.ts')
    const b = fileHandleFor('src/cycle-b.ts')
    const direct = chain.dependenciesOf(a)
    assert.equal(direct.links.length, 1)
    assert.equal(direct.links[0]?.handle, b)
    assert.equal(direct.links[0]?.relation, 'depends')
    assert.equal(direct.links[0]?.status, 'satisfied')
    assert.equal(direct.links[0]?.depth, 1)
    assert.equal(direct.links[0]?.path, 'src/cycle-b.ts')
    assert.equal(direct.relation, 'depends')

    // A cycle is a legal result: reported as a path, never thrown or retried.
    const cycle = chain.cycleAt(a)
    assert.ok(Array.isArray(cycle.cycle))
    assert.ok((cycle.cycle ?? []).includes(a))
    assert.ok((cycle.cycle ?? []).includes(b))
    assert.equal(cycle.truncated, false)

    const reverse = chain.dependentsOf(b)
    assert.equal(reverse.links[0]?.handle, a)
    assert.equal(reverse.links[0]?.direction, 'reverse')

    // Topological evidence: depth 1 is the direct import, depth 2 its import.
    const one = fileHandleFor('src/chain-1.ts')
    const three = fileHandleFor('src/chain-3.ts')
    const deep = chain.dependenciesOf(one, { depth: 3 })
    assert.deepEqual(deep.links.map((link) => link.depth), [1, 2])
    assert.equal(deep.links[0]?.handle, fileHandleFor('src/chain-2.ts'))
    assert.equal(deep.links[1]?.handle, three)
    for (const link of deep.links) assert.equal(link.status, 'satisfied')
    assert.equal(deep.version, chain.graphVersion)

    const path = chain.path(one, three, { depth: 3 })
    assert.equal(path.found, true)
    assert.deepEqual(path.links.map((link) => link.handle), [
      fileHandleFor('src/chain-2.ts'),
      three,
    ])
    assert.equal(chain.path(three, one, { depth: 3 }).found, false)
  } finally {
    workspace.close()
  }
})

test('chain accepts a target parsed before or after its importer', () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/late-importer.ts', "import './late-target'\nexport const late = 1\n")
    workspace.write('src/late-target.ts', 'export const target = 1\n')
    const service = new ParseService({ workspaceRoot: workspace.root })
    const chain = new ChainEngine()
    const importerParsed = service.parse({ path: 'src/late-importer.ts' })
    chain.index(importerParsed)
    const unknown = chain.dependenciesOf(fileHandleFor('src/late-importer.ts'))
    assert.equal(unknown.links[0]?.status, 'unknown')
    // Parsing the target afterwards adopts the extensionless stub edge.
    chain.index(service.parse({ path: 'src/late-target.ts' }))
    const resolved = chain.dependenciesOf(fileHandleFor('src/late-importer.ts'))
    assert.equal(resolved.links[0]?.handle, fileHandleFor('src/late-target.ts'))
    assert.equal(resolved.links[0]?.status, 'satisfied')
  } finally {
    workspace.close()
  }
})

test('chain enforces depth, link and token budgets explicitly', () => {
  const workspace = new TempWorkspace()
  try {
    const files = 12
    for (let index = 0; index < files; index += 1) {
      const next = index + 1
      workspace.write(
        `src/chain/f${index}.ts`,
        next < files
          ? `import './f${next}'\nexport const v${index} = ${index}\n`
          : `export const v${index} = ${index}\n`,
      )
    }
    const service = new ParseService({ workspaceRoot: workspace.root })
    const chain = new ChainEngine({ cacheCapacity: 4 })
    for (let index = 0; index < files; index += 1) {
      chain.index(service.parse({ path: `src/chain/f${index}.ts` }))
    }
    const root = fileHandleFor('src/chain/f0.ts')

    const limited = chain.dependenciesOf(root, { depth: MAX_CHAIN_DEPTH, limit: 3 })
    assert.equal(limited.links.length, 3)
    assert.equal(limited.truncated, true)
    assert.ok(limited.counts.omitted >= 1)
    assert.ok(limited.depth <= MAX_CHAIN_DEPTH)

    const depthTwo = chain.dependenciesOf(root, { depth: 2 })
    assert.equal(depthTwo.links.length, 2)
    assert.ok(depthTwo.links.every((link) => link.depth <= 2))
    // The projection is capped by the 1,500-token budget as well.
    assert.ok(estimateTokens(JSON.stringify(limited)) < 4_000)

    assert.throws(() => chain.dependenciesOf(root, { depth: MAX_CHAIN_DEPTH + 1 }), /depth must be/)
    assert.throws(() => chain.dependenciesOf(root, { limit: MAX_CHAIN_LINKS + 1 }), /limit must be/)
    assert.throws(() => chain.path(root, 'nmissing'), /was not found/)
  } finally {
    workspace.close()
  }
})

test('chain exposes host-only relations (baseline, prerequisite, requires/meets) and unmet', () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write(
      'docs/spec.md',
      [
        '---',
        'form: article',
        'title: Wired Spec',
        '---',
        '',
        '::: require',
        'The spec requires a decision.',
        ':::',
        '',
        '## Detail',
        '',
        'Prose.',
      ].join('\n'),
    )
    workspace.write('docs/other.md', '# Other\n\nProse.\n')
    const service = new ParseService({ workspaceRoot: workspace.root })
    const registry = new NodeRegistry()
    const chain = new ChainEngine()
    const specParsed = service.parse({ path: 'docs/spec.md' })
    const cards = indexInto(chain, specParsed, registry)
    indexInto(chain, service.parse({ path: 'docs/other.md' }), registry)

    assert.equal(specParsed.document?.form, 'article')
    assert.equal(cards[0]?.kind, 'article')
    assert.equal(specParsed.structure.headings.length, 1)

    const spec = fileHandleFor('docs/spec.md')
    const other = fileHandleFor('docs/other.md')
    // The explicit `::: require` div becomes a necessary condition of the file.
    const requires = chain.unmet(spec)
    assert.ok(requires.links.some((link) => link.relation === 'requires' && link.status === 'unknown'))

    const baseline = chain.relate({ from: spec, to: other, relation: 'baseline' })
    assert.equal(baseline.status, 'satisfied')
    assert.equal(chain.baselineOf(spec).links[0]?.handle, other)

    const prerequisite = chain.relate({ from: spec, to: other, relation: 'prerequisite', status: 'unmet' })
    assert.equal(prerequisite.status, 'unmet')
    const prerequisites = chain.prerequisitesOf(spec)
    assert.equal(prerequisites.links[0]?.status, 'unmet')
    assert.ok(chain.unmet(spec).links.some((link) => link.relation === 'prerequisite' && link.status === 'unmet'))

    const evidence = registry.card(fileHandleFor('docs/spec.md'))
    assert.ok(evidence !== undefined)
    // satisfies is host-written only; an agent cannot assert it (no tool).
    const satisfies = chain.relate({
      from: spec,
      to: other,
      relation: 'satisfies',
      evidenceHandle: spec,
    })
    assert.equal(satisfies.status, 'satisfied')
    assert.equal(chain.satisfiedBy(spec).links[0]?.handle, other)
    assert.equal(chain.satisfiesOf(other).links[0]?.handle, spec)
    assert.throws(() => chain.relate({ from: spec, to: 'nmissing', relation: 'baseline' }), /was not found/)
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Read: the only content path
 * ------------------------------------------------------------------------- */

test('coordination_read bytes and lines agree, and traversal/binary are refused', () => {
  const workspace = new TempWorkspace()
  try {
    const content = 'alpha\nbeta\ngamma\n'
    workspace.write('docs/read.txt', content)
    const service = new ParseService({ workspaceRoot: workspace.root })

    const bytes = service.readContent({
      path: 'docs/read.txt',
      mode: 'bytes',
      start: 0,
      end: Buffer.byteLength('alpha\nbeta\n'),
    })
    const lines = service.readContent({ path: 'docs/read.txt', mode: 'lines', start: 1, end: 2 })
    assert.equal(bytes.content, 'alpha\nbeta\n')
    assert.equal(lines.content, bytes.content)
    assert.deepEqual(lines.byteRange, bytes.byteRange)
    assert.equal(bytes.truncated, false)
    assert.equal(lines.truncated, false)
    assert.deepEqual(lines.lineRange, { start: 1, end: 2 })

    const whole = service.readContent({ path: 'docs/read.txt', mode: 'lines', start: 1, end: 3 })
    assert.equal(whole.content, content)
    assert.equal(whole.hash, `sha256:${createHash('sha256').update(content).digest('hex')}`)
    assert.equal(whole.charset, 'ascii')

    const capped = service.readContent({
      path: 'docs/read.txt',
      mode: 'bytes',
      start: 0,
      end: 100,
      maxBytes: 5,
    })
    assert.equal(capped.content, 'alpha')
    assert.equal(capped.truncated, true)
    assert.equal(capped.nextStart, 5)

    assert.throws(
      () => service.readContent({ path: '../outside.txt', mode: 'lines', start: 1 }),
      /workspace-relative/,
    )
    assert.throws(
      () => service.readContent({ path: '/etc/passwd', mode: 'bytes', start: 0, end: 1 }),
      /workspace-relative/,
    )
    assert.throws(
      () => service.readContent({ path: 'C:\\Windows\\win.ini', mode: 'bytes', start: 0, end: 1 }),
      /workspace-relative/,
    )
    assert.throws(
      () => service.readContent({ path: 'docs/missing.txt', mode: 'bytes', start: 0, end: 1 }),
      /was not found/,
    )

    workspace.write('docs/binary.bin', Buffer.from([0x41, 0x00, 0x42]))
    assert.throws(
      () => service.readContent({ path: 'docs/binary.bin', mode: 'bytes', start: 0, end: 3 }),
      (error: unknown) => error instanceof InvalidStateError,
    )

    // A UTF-8 BOM is excluded from the returned range and content.
    workspace.write('docs/bom.txt', '\uFEFFhello\n')
    const bom = service.readContent({ path: 'docs/bom.txt', mode: 'lines', start: 1, end: 1 })
    assert.equal(bom.content, 'hello\n')
    assert.equal(bom.bom, true)
    assert.equal(bom.byteRange.start, 3)
    assert.throws(
      () => service.readContent({ path: 'docs/bom.txt', mode: 'bytes', start: 1, end: 4 }),
      /after the BOM/,
    )
  } finally {
    workspace.close()
  }
})

test('coordination_read enforces the per-call token budget', () => {
  const workspace = new TempWorkspace()
  try {
    const text = 'word '.repeat(24_000)
    assert.ok(estimateTokens(text) > MAX_READ_TOKENS)
    workspace.write('docs/long.txt', text)
    const service = new ParseService({ workspaceRoot: workspace.root })
    const read = service.readContent({ path: 'docs/long.txt', mode: 'bytes', start: 0, end: text.length })
    assert.equal(read.truncated, true)
    assert.ok(read.content.length < text.length)
    assert.ok(estimateTokens(read.content) <= MAX_READ_TOKENS)
    assert.ok((read.nextStart ?? 0) > 0)
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Tool definitions and end-to-end tool values
 * ------------------------------------------------------------------------- */

test('file tool definitions have the registry shape and the host registers all seven', async () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('docs/note.md', '# Title\n\nBody text.\n')
    workspace.write('src/leaf.ts', 'export const leaf = 1\n')
    const service = toolService(workspace.root)

    const definitions = coordinationFileToolDefinitions(service, 'en-US', {
      workspaceRoot: workspace.root,
    })
    assert.deepEqual(definitions.map((definition) => definition.name).sort(), [
      'coordination_chain',
      'coordination_describe',
      'coordination_parse',
      'coordination_read',
    ])
    for (const definition of definitions) {
      assert.ok(definition.description.length > 0, `${definition.name} needs a description`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(typeof definition.parameters.properties, 'object')
      assert.equal(definition.output.schema.type, 'object')
      const blocks = definition.output.render({}, { ok: true })
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0]?.type, 'text')
      assert.ok((blocks[0]?.text ?? '').length > 0)
    }
    // Locale changes the model-facing description without forking the surface.
    const zh = coordinationFileToolDefinitions({ ...service, locale: 'zh-CN' }, 'zh-CN', {
      workspaceRoot: workspace.root,
    })
    assert.notEqual(zh[0]?.description, definitions[0]?.description)

    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US', {
      workspaceRoot: workspace.root,
    })
    assert.equal(registry.definitions.size, 7)
    try {
      const parsed = (await registry.get('coordination_parse').execute({
        path: 'docs/note.md',
      })) as ParseToolValue
      assert.equal(parsed.path, 'docs/note.md')
      assert.equal(parsed.charset, 'ascii')
      assert.equal(parsed.truncated, false)
      assert.ok(parsed.cards.length >= 2)
      assert.equal(parsed.cards[0]?.name, 'note.md')
      assert.equal(parsed.references.length, 0)
      assert.equal(parsed.counts.nodes, parsed.cards.length)

      const handle = parsed.cards[0]?.identity as string
      const described = (await registry.get('coordination_describe').execute({
        handle,
        fields: ['summary', 'usage'],
      })) as DescribeResult
      assert.equal(described.card.identity, handle)
      assert.equal(described.fields.path, 'docs/note.md')
      assert.ok('usage' in described.requested)

      const chainValue = (await registry.get('coordination_chain').execute({
        handle,
        action: 'cycle',
      })) as ChainProjection
      assert.equal(chainValue.root, handle)
      assert.deepEqual(chainValue.links, [])
      assert.ok(!('nodes' in chainValue))
      assert.ok(!('graph' in chainValue))

      const text = (await registry.get('coordination_read').execute({
        path: 'docs/note.md',
        mode: 'lines',
        start: 1,
        end: 1,
      })) as { content: string }
      assert.equal(text.content, '# Title\n')
    } finally {
      dispose()
    }
    assert.equal(registry.definitions.size, 0)

    // A narrow (non-kernel) facade keeps exactly the three composer tools.
    const narrow = toolService(undefined, 'en-US', false)
    const narrowRegistry = new MemoryRegistry()
    const narrowDispose = registerCoordinationTools(narrowRegistry, narrow, 'en-US')
    assert.equal(narrowRegistry.definitions.size, 3)
    narrowDispose()

    // The host config's parser master switch removes the file tools.
    const disabledRegistry = new MemoryRegistry()
    const disabled = { ...service, config: { parser: { enabled: false } } }
    const disabledDispose = registerCoordinationTools(disabledRegistry, disabled, 'en-US', {
      workspaceRoot: workspace.root,
    })
    assert.equal(disabledRegistry.definitions.size, 3)
    disabledDispose()
  } finally {
    workspace.close()
  }
})

test('host config can only tighten the file-layer budgets', async () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/a.ts', "import './b'\nexport const a = 1\n")
    workspace.write('src/b.ts', "import './c'\nexport const b = 1\n")
    workspace.write('src/c.ts', 'export const c = 1\n')
    const service = {
      ...toolService(workspace.root),
      config: { parser: { enabled: true }, chain: { depth: 1, links: 1, tokenBudget: 100 } },
    }
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US', {
      workspaceRoot: workspace.root,
    })
    try {
      const parsed = (await registry.get('coordination_parse').execute({
        path: 'src/a.ts',
      })) as ParseToolValue
      await registry.get('coordination_parse').execute({ path: 'src/b.ts' })
      await registry.get('coordination_parse').execute({ path: 'src/c.ts' })
      const handle = parsed.cards[0]?.identity as string
      // The caller asks for depth 3 / limit 50; the host ceiling caps it at 1/1.
      const projection = (await registry.get('coordination_chain').execute({
        handle,
        action: 'dependencies',
        depth: 3,
        limit: 50,
      })) as ChainProjection
      assert.equal(projection.depth, 1)
      assert.equal(projection.links.length, 1)
      assert.equal(projection.truncated, true)
    } finally {
      dispose()
    }
  } finally {
    workspace.close()
  }
})

test('parse/describe/chain values never carry file bodies (read is the only content)', async () => {
  const workspace = new TempWorkspace()
  try {
    const marker = 'BODY_MARKER_7d1a'
    workspace.write(
      'src/wired.ts',
      `import './leaf'\n/** Wired symbol. */\nexport function wired(): string { return '${marker}' }\n`,
    )
    workspace.write('src/leaf.ts', `export const leaf = '${marker}'\n`)
    const service = toolService(workspace.root)
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US', {
      workspaceRoot: workspace.root,
    })
    try {
      const parsed = (await registry.get('coordination_parse').execute({
        path: 'src/wired.ts',
      })) as ParseToolValue
      assert.ok(parsed.cards.length >= 2)
      assert.ok(!JSON.stringify(parsed).includes(marker))
      assert.ok(!('content' in parsed))

      const handle = parsed.cards[0]?.identity as string
      const described = await registry.get('coordination_describe').execute({ handle })
      assert.ok(!JSON.stringify(described).includes(marker))
      assert.ok(!('content' in (described as object)))

      // The dependency edge exists, is body-free, and never serializes the graph.
      await registry.get('coordination_parse').execute({ path: 'src/leaf.ts' })
      const projection = (await registry.get('coordination_chain').execute({
        handle,
        action: 'dependencies',
        depth: 2,
      })) as ChainProjection
      assert.equal(projection.links.length, 1)
      assert.ok(!JSON.stringify(projection).includes(marker))
      assert.ok(!('edges' in projection))
      assert.ok(!('ast' in projection))

      const read = (await registry.get('coordination_read').execute({
        path: 'src/wired.ts',
        mode: 'lines',
        start: 3,
        end: 3,
      })) as { content: string }
      assert.ok(read.content.includes(marker))
    } finally {
      dispose()
    }
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Staleness and cache bounds
 * ------------------------------------------------------------------------- */

test('fingerprints drive staleness: a changed target marks baseline and depends stale', () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/importer.ts', "import './target'\nexport const importer = 1\n")
    workspace.write('src/target.ts', 'export const target = 1\n')
    const service = new ParseService({ workspaceRoot: workspace.root })
    const registry = new NodeRegistry()
    const chain = new ChainEngine()

    const importerParsed = service.parse({ path: 'src/importer.ts' })
    indexInto(chain, importerParsed, registry)
    const targetParsed = service.parse({ path: 'src/target.ts' })
    indexInto(chain, targetParsed, registry)

    const importer = fileHandleFor('src/importer.ts')
    const target = fileHandleFor('src/target.ts')
    const oldFingerprint = targetParsed.file.fingerprint
    assert.ok(oldFingerprint?.startsWith('sha256:'))

    const baseline = chain.relate({ from: importer, to: target, relation: 'baseline' })
    assert.equal(baseline.status, 'satisfied')
    assert.equal(baseline.baselineVersion, oldFingerprint)
    assert.equal(chain.baselineOf(importer).links[0]?.status, 'satisfied')
    assert.equal(chain.dependenciesOf(importer).links[0]?.status, 'satisfied')

    // Different size and content: the cache key must miss and the fingerprint
    // must change (position + fingerprint detects both edits and moves).
    workspace.write('src/target.ts', 'export const target = 22\nexport const extra = 3\n')
    const changed = service.parse({ path: 'src/target.ts' })
    assert.equal(changed.cached, false)
    assert.notEqual(changed.file.fingerprint, oldFingerprint)
    indexInto(chain, changed, registry)

    const staleBaseline = chain.baselineOf(importer).links[0]
    assert.equal(staleBaseline?.status, 'stale')
    assert.equal(staleBaseline?.baselineVersion, oldFingerprint)
    assert.equal(chain.dependenciesOf(importer).links[0]?.status, 'stale')
    assert.equal(registry.card(target)?.fingerprint, changed.file.fingerprint)

    // An unchanged re-parse is served from the cache with the same fingerprint.
    const cachedAgain = service.parse({ path: 'src/target.ts' })
    assert.equal(cachedAgain.cached, true)
    assert.equal(cachedAgain.file.fingerprint, changed.file.fingerprint)
  } finally {
    workspace.close()
  }
})

test('parse, registry and chain caches are capacity-bounded', () => {
  const workspace = new TempWorkspace()
  try {
    for (let index = 0; index < 4; index += 1) {
      workspace.write(`src/cache-${index}.ts`, `export const value${index} = ${index}\n`)
    }
    const service = new ParseService({ workspaceRoot: workspace.root, cacheCapacity: 2 })
    for (let index = 0; index < 4; index += 1) {
      assert.equal(service.parse({ path: `src/cache-${index}.ts` }).cached, false)
      assert.equal(service.parse({ path: `src/cache-${index}.ts` }).cached, true)
    }
    const stats = service.cacheStats()
    assert.equal(stats.capacity, 2)
    assert.ok(stats.size <= 2)
    assert.ok(stats.hits >= 4)
    assert.ok(stats.evictions >= 1)

    const registry = new NodeRegistry({ capacity: 2 })
    for (let index = 0; index < 4; index += 1) registry.register(service.parse({ path: `src/cache-${index}.ts` }))
    assert.equal(registry.capacity, 2)
    assert.equal(registry.size, 2)

    const chain = new ChainEngine({ cacheCapacity: 2 })
    for (let index = 0; index < 4; index += 1) chain.index(service.parse({ path: `src/cache-${index}.ts` }))
    const root = fileHandleFor('src/cache-0.ts')
    chain.dependenciesOf(root)
    chain.dependentsOf(root)
    const projection = chain.cycleAt(root)
    assert.equal(chain.cacheCapacity, 2)
    assert.ok(chain.cacheSize <= 2)
    assert.equal(projection.root, root)
    assert.ok(chain.size >= 1)
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Workspace root (limit 5)
 * ------------------------------------------------------------------------- */

test('workspace root comes from the service/host/sandbox policy, not cwd', async () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/rooted.ts', 'export const rooted = 1\n')
    const expected = resolve(workspace.root)
    const cwdRoot = resolve(process.cwd())
    assert.notEqual(expected, cwdRoot)

    // 1. An explicit service root wins.
    const service = { ...toolService(workspace.root), config: testConfig() }
    assert.equal(resolveToolWorkspaceRoot(service), expected)

    // 2. With no explicit root, the host sandbox policy is asked.
    const hostOnly: CoordinationToolService = {
      ...toolService(undefined),
      config: testConfig(),
      host: {
        sandboxPolicy: {
          resolve: () => ({ workspaceRoot: workspace.root, mode: 'workspace-write' }),
        },
      },
    }
    assert.equal(resolveToolWorkspaceRoot(hostOnly), expected)

    // 3. An explicit tool option outranks both.
    assert.equal(
      resolveToolWorkspaceRoot(hostOnly, { workspaceRoot: join(workspace.root, '..') }),
      resolve(join(workspace.root, '..')),
    )

    // 4. process.cwd() is the last resort only.
    const bare: CoordinationToolService = { ...toolService(undefined, 'en-US', false), host: {} }
    assert.equal(resolveToolWorkspaceRoot(bare), cwdRoot)

    // The tool reads from the service root without an explicit option.
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US')
    try {
      const parsed = (await registry.get('coordination_parse').execute({
        path: 'src/rooted.ts',
      })) as ParseToolValue
      assert.equal(parsed.path, 'src/rooted.ts')
      assert.equal(parsed.cards[0]?.path, 'src/rooted.ts')
      assert.equal(parsed.cards[0]?.name, 'rooted.ts')
    } finally {
      dispose()
    }
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * parser.maxAstDepth (limit 4)
 * ------------------------------------------------------------------------- */

test('parser.maxAstDepth reaches the parser and is capped to the hard maximum', async () => {
  const workspace = new TempWorkspace()
  try {
    const depth = 8
    const markup = [
      ...Array.from({ length: depth }, () => '::: deep'),
      'body',
      ...Array.from({ length: depth }, () => ':::'),
      '',
    ].join('\n')
    workspace.write('docs/deep.md', markup)

    const direct = new ParseService({ workspaceRoot: workspace.root, maxAstDepth: 3 })
    assert.equal(direct.astDepthLimit, 3)
    const parsed = direct.parse({ path: 'docs/deep.md' })
    assert.ok(
      parsed.diagnostics.some((diagnostic) => diagnostic.code === 'depth-limit'),
      JSON.stringify(parsed.diagnostics),
    )
    assert.equal(parsed.truncated, true)
    // A too-large config value can only lower the parser's hard cap.
    assert.equal(new ParseService({ workspaceRoot: workspace.root, maxAstDepth: 100_000 }).astDepthLimit, MAX_AST_DEPTH)

    const config = testConfig()
    config.parser.maxAstDepth = 3
    const service = { ...toolService(workspace.root), config }
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US')
    try {
      const value = (await registry.get('coordination_parse').execute({
        path: 'docs/deep.md',
      })) as ParseToolValue
      assert.ok(value.diagnostics.some((diagnostic) => diagnostic.code === 'depth-limit'))
      assert.equal(value.truncated, true)
    } finally {
      dispose()
    }
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Dependency-graph caps (limit 4)
 * ------------------------------------------------------------------------- */

test('dependency-graph caps fail closed in the parse summary', async () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/dep-a.ts', "import './dep-b'\nexport const a = 1\n")
    workspace.write('src/dep-b.ts', "import './dep-c'\nexport const b = 1\n")
    workspace.write('src/dep-c.ts', 'export const c = 1\n')

    const config = testConfig()
    config.parser.dependencyGraphMaxVertices = 2
    config.parser.dependencyGraphMaxEdges = 1
    const service = { ...toolService(workspace.root), config }
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US')
    try {
      await registry.get('coordination_parse').execute({ path: 'src/dep-a.ts' })
      await registry.get('coordination_parse').execute({ path: 'src/dep-b.ts' })
      const value = (await registry.get('coordination_parse').execute({
        path: 'src/dep-c.ts',
      })) as ParseToolValue
      assert.equal(value.dependencies.truncated, true)
      assert.ok(value.dependencies.vertices <= 2)
      assert.ok(value.dependencies.edges <= 1)
      assert.deepEqual(value.dependencies.limits, { maxVertices: 2, maxEdges: 1 })
      assert.ok(value.dependencies.diagnostics.some((diagnostic) => diagnostic.code === 'graph-limit'))
      // The summary is counts only: no edge list and no graph object.
      assert.ok(!('edgesList' in value.dependencies))
      assert.ok(!('graph' in value.dependencies))
    } finally {
      dispose()
    }

    // Huge options are clamped to the parser layer's hard caps; a normal parse
    // finishes untruncated and still exposes counts only.
    const direct = new ParseService({
      workspaceRoot: workspace.root,
      maxGraphVertices: 1_000_000_000,
      maxGraphEdges: 1_000_000_000,
    })
    assert.deepEqual(direct.dependencyGraphLimits, { maxVertices: 20_000, maxEdges: 100_000 })
    direct.parse({ path: 'src/dep-a.ts' })
    const summary = direct.dependencyGraph()
    assert.equal(summary.files, 1)
    assert.equal(summary.truncated, false)
    assert.ok(!('graph' in summary))
  } finally {
    workspace.close()
  }
})

/* ------------------------------------------------------------------------- *
 * tools.maxResultBytes (limit 4)
 * ------------------------------------------------------------------------- */

test('tools.maxResultBytes bounds every tool rendering as valid JSON', () => {
  const config = testConfig()
  config.tools.maxResultBytes = 512
  const service = { ...toolService('/workspace'), config }
  const definitions = [
    ...coordinationToolDefinitions(service),
    ...coordinationFileToolDefinitions(service, 'en-US', { workspaceRoot: '/workspace' }),
  ]
  assert.equal(definitions.length, 7)

  const value = {
    big: 'x'.repeat(2_000),
    nested: { list: Array.from({ length: 50 }, (_entry, index) => index) },
  }
  for (const definition of definitions) {
    const blocks = definition.output.render({}, value)
    assert.equal(blocks.length, 1, `${definition.name} must render one text block`)
    const text = blocks[0]?.text ?? ''
    assert.ok(
      Buffer.byteLength(text, 'utf8') <= 512,
      `${definition.name} exceeded tools.maxResultBytes`,
    )
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.equal(parsed.truncated, true, `${definition.name} lost its truncation marker`)
    assert.equal(parsed.marker, TOOL_RESULT_MARKER)
    assert.ok(Number(parsed.originalBytes) > Number(parsed.returnedBytes))
    assert.ok(String(parsed.preview ?? '').endsWith('…'))
  }

  // 0 keeps today's unbounded behaviour exactly.
  const unbounded = testConfig()
  unbounded.tools.maxResultBytes = 0
  const plain = { ...toolService('/workspace'), config: unbounded }
  assert.equal(toolResultMaxBytes(plain), 0)
  const plainText = coordinationToolDefinitions(plain)[0]?.output.render({}, value)[0]?.text
  assert.equal(plainText, JSON.stringify(value, null, 2))

  // Boundary: exactly the full byte length renders untouched; one byte less
  // truncates, and the replacement is still valid JSON within the cap.
  const smallValue = { alpha: 'beta'.repeat(20) }
  const full = JSON.stringify(smallValue, null, 2)
  const boundary = testConfig()
  boundary.tools.maxResultBytes = Buffer.byteLength(full, 'utf8')
  const boundaryService = { ...toolService('/workspace'), config: boundary }
  const exact = coordinationFileToolDefinitions(boundaryService, 'en-US', {})[0]
    ?.output.render({}, smallValue)[0]?.text
  assert.equal(exact, full)
  boundary.tools.maxResultBytes -= 1
  const over = coordinationFileToolDefinitions(boundaryService, 'en-US', {})[0]
    ?.output.render({}, smallValue)[0]?.text as string
  const overJson = JSON.parse(over) as Record<string, unknown>
  assert.equal(overJson.truncated, true)
  assert.ok(Buffer.byteLength(over, 'utf8') <= Buffer.byteLength(full, 'utf8') - 1)

  // A cap below the minimal marker still yields explicit valid JSON rather
  // than an empty or silently cut string (documented safe exception).
  const tiny = testConfig()
  tiny.tools.maxResultBytes = 1
  const tinyText = coordinationFileToolDefinitions(
    { ...toolService('/workspace'), config: tiny },
    'en-US',
    {},
  )[0]?.output.render({}, value)[0]?.text
  assert.equal(tinyText, '{"truncated":true}')
  assert.doesNotThrow(() => JSON.parse(tinyText as string))
})

/* ------------------------------------------------------------------------- *
 * Live config retune (limit 6)
 * ------------------------------------------------------------------------- */

test('a live /config patch retunes the file runtime without stranding handles', async () => {
  const workspace = new TempWorkspace()
  try {
    workspace.write('src/r-a.ts', "import './r-b'\nexport const a = 1\n")
    workspace.write('src/r-b.ts', "import './r-c'\nexport const b = 1\n")
    workspace.write('src/r-c.ts', 'export const c = 1\n')

    const config: CoordinationConfig = testConfig()
    const service = { ...toolService(workspace.root), config }
    const registry = new MemoryRegistry()
    const dispose = registerCoordinationTools(registry, service, 'en-US')
    try {
      const parsedA = (await registry.get('coordination_parse').execute({
        path: 'src/r-a.ts',
      })) as ParseToolValue
      await registry.get('coordination_parse').execute({ path: 'src/r-b.ts' })
      await registry.get('coordination_parse').execute({ path: 'src/r-c.ts' })
      const handle = parsedA.cards[0]?.identity as string

      const wide = (await registry.get('coordination_chain').execute({
        handle,
        action: 'dependencies',
        depth: 3,
        limit: 50,
      })) as ChainProjection
      assert.equal(wide.links.length, 2)
      assert.equal(wide.truncated, false)

      // A real POST /config patch (both keys are editable host rows).
      const narrowed = applyConfigPatch(config, { 'chain.links': 1, 'chain.depth': 1 })
      assert.ok(narrowed.applied.includes('chain.links'))
      const capped = (await registry.get('coordination_chain').execute({
        handle,
        action: 'dependencies',
        depth: 3,
        limit: 50,
      })) as ChainProjection
      assert.equal(capped.links.length, 1)
      assert.equal(capped.truncated, true)

      // The old handle still describes: retune must not discard the registry.
      const described = (await registry.get('coordination_describe').execute({ handle })) as DescribeResult
      assert.equal(described.card.identity, handle)
      assert.equal(described.fields.path, 'src/r-a.ts')

      // The parser cache capacity is retuned in place as well: two entries
      // means re-parsing a file touched three parses ago must miss.
      const cache = applyConfigPatch(config, { 'parser.cacheCapacity': 2 })
      assert.ok(cache.applied.includes('parser.cacheCapacity'))
      assert.equal(((await registry.get('coordination_parse').execute({ path: 'src/r-a.ts' })) as ParseToolValue).cached, false)
      await registry.get('coordination_parse').execute({ path: 'src/r-b.ts' })
      await registry.get('coordination_parse').execute({ path: 'src/r-c.ts' })
      const oldAgain = (await registry.get('coordination_parse').execute({ path: 'src/r-a.ts' })) as ParseToolValue
      assert.equal(oldAgain.cached, false)

      // Widening again takes effect on the next call, with the same handles.
      applyConfigPatch(config, { 'chain.links': 50, 'chain.depth': 8 })
      const wideAgain = (await registry.get('coordination_chain').execute({
        handle,
        action: 'dependencies',
        depth: 3,
        limit: 50,
      })) as ChainProjection
      assert.equal(wideAgain.links.length, 2)
    } finally {
      dispose()
    }
  } finally {
    workspace.close()
  }
})
