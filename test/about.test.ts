/**
 * Data guard for the settings page's read-only page tail (About, References
 * and Author).
 *
 * Three invariants are easy to break silently and are pinned here:
 *
 *  - `ABOUT.version` and `ABOUT.license` are hard-coded in `src/shared/about.ts`
 *    (the client bundle cannot read `package.json`), so a manifest bump must
 *    fail this suite instead of shipping a stale About section;
 *  - `ABOUT.dependencies` must cover every package named in the four package.json
 *    dependency sections exactly once, with the version the manifest declares;
 *  - every citation must still name an existing `src/` module in its `reason`,
 *    so the References list cannot drift into an unrelated bibliography.
 *
 * The manifest is read with `node:fs` + `JSON.parse` rather than a JSON import:
 * an import assertion would need bundler support and would not run under the
 * plain `node --test` build used by this repository.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ABOUT } from '../src/shared/about.js'

const DEPENDENCY_SECTIONS = [
  ['dependencies', 'runtime'],
  ['devDependencies', 'development'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'runtime'],
] as const

type SectionName = (typeof DEPENDENCY_SECTIONS)[number][0]
type DependencyScope = 'runtime' | 'development' | 'peer'

interface PackageManifest {
  name: string
  version: string
  license?: string
  engines?: { node?: string }
  scripts?: Readonly<Record<string, string>>
  dependencies?: Readonly<Record<string, string>>
  devDependencies?: Readonly<Record<string, string>>
  peerDependencies?: Readonly<Record<string, string>>
  optionalDependencies?: Readonly<Record<string, string>>
}

interface Declaration {
  section: SectionName
  scope: DependencyScope
  version: string
}

/** Walk up until the manifest with the expected package name is found. */
function findRepositoryRoot(start: string): string | undefined {
  let current = start
  for (let depth = 0; depth < 12; depth += 1) {
    const manifestPath = join(current, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }
        if (parsed.name === 'deepseek-coordination') return current
      } catch {
        // Not a readable JSON manifest; keep walking up.
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = findRepositoryRoot(moduleDirectory) ?? findRepositoryRoot(process.cwd())

if (repositoryRoot === undefined) {
  throw new Error('test/about.test.ts cannot locate the deepseek-coordination repository root')
}

const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as PackageManifest

/** Every `name -> declarations` pair across the four dependency sections. */
function declarationsOf(source: PackageManifest): Map<string, Declaration[]> {
  const declarations = new Map<string, Declaration[]>()
  for (const [section, scope] of DEPENDENCY_SECTIONS) {
    for (const [name, version] of Object.entries(source[section] ?? {})) {
      const list = declarations.get(name) ?? []
      list.push({ section, scope, version })
      declarations.set(name, list)
    }
  }
  return declarations
}

/**
 * Scope shown for a package declared in more than one section.
 *
 * Runtime wins because it ships; the peer range is the compatibility promise
 * shown next; a development-only package is last.
 */
function pickRowScope(declarations: readonly Declaration[]): DependencyScope {
  if (declarations.some((entry) => entry.scope === 'runtime')) return 'runtime'
  if (declarations.some((entry) => entry.scope === 'peer')) return 'peer'
  return 'development'
}

/**
 * Version shown for a package declared in more than one section.
 *
 * Seven packages are both development installs and peer contracts; the row
 * keeps the peer range (the contract the host resolves), never a quiet rewrite
 * of one range into the other.
 */
function pickRowVersion(declarations: readonly Declaration[]): string {
  for (const scope of ['runtime', 'peer', 'development'] as const) {
    const match = declarations.find((entry) => entry.scope === scope)
    if (match !== undefined) return match.version
  }
  throw new Error('a dependency declaration must come from one of the four sections')
}

test('ABOUT pins the package version, license and Node runtime', () => {
  assert.equal(ABOUT.name, manifest.name)
  assert.equal(ABOUT.version, manifest.version)
  assert.equal(ABOUT.license, manifest.license)

  const engine = manifest.engines?.node
  assert.ok(engine !== undefined && engine.length > 0, 'package.json must declare engines.node')
  assert.ok(
    ABOUT.runtime.includes(engine),
    `ABOUT.runtime "${ABOUT.runtime}" must contain engines.node "${engine}"`,
  )
  assert.ok(ABOUT.summary.trim().length > 0, 'ABOUT.summary must not be empty')
})

test('every package.json dependency appears exactly once in ABOUT.dependencies', () => {
  const declarations = declarationsOf(manifest)
  const rows = new Map(ABOUT.dependencies.map((entry) => [entry.name, entry]))

  assert.equal(rows.size, ABOUT.dependencies.length, 'ABOUT.dependencies must not repeat a package name')
  assert.deepEqual(
    [...rows.keys()].sort(),
    [...declarations.keys()].sort(),
    'ABOUT.dependencies must cover exactly the four package.json dependency sections',
  )
  assert.ok(declarations.size > 0, 'package.json must declare dependencies')

  for (const [name, declared] of declarations) {
    const row = rows.get(name)
    assert.ok(row !== undefined, `${name} is missing from ABOUT.dependencies`)
    assert.equal(row.scope, pickRowScope(declared), `${name}: scope`)
    assert.equal(row.version, pickRowVersion(declared), `${name}: version`)
    assert.ok(
      declared.some((entry) => entry.version === row.version),
      `${name}: ${row.version} must be one of the versions package.json declares`,
    )
  }
})

test('every dependency and tooling entry states a role and a reason', () => {
  for (const [label, rows] of [
    ['dependencies', ABOUT.dependencies],
    ['tooling', ABOUT.tooling],
  ] as const) {
    assert.ok(rows.length > 0, `${label} must not be empty`)
    const names = new Set<string>()
    for (const row of rows) {
      assert.ok(row.name.trim().length > 0, `${label}: every row needs a name`)
      assert.ok(!names.has(row.name), `${label}: duplicate package name ${row.name}`)
      names.add(row.name)
      assert.ok(row.version.trim().length > 0, `${label}:${row.name} version`)
      assert.ok(row.role.trim().length > 0, `${label}:${row.name} role`)
      assert.ok(row.reason.trim().length > 0, `${label}:${row.name} reason`)
      assert.ok(
        (['runtime', 'development', 'peer'] as const).includes(row.scope),
        `${label}:${row.name} scope`,
      )
    }
  }

  // Tooling may only name a package that exists in devDependencies or a script.
  const scripts = Object.values(manifest.scripts ?? {}).join('\n')
  for (const tool of ABOUT.tooling) {
    const devVersion = manifest.devDependencies?.[tool.name]
    assert.ok(
      devVersion !== undefined || scripts.includes(tool.name),
      `tooling entry ${tool.name} must appear in package.json devDependencies or scripts`,
    )
    if (devVersion !== undefined) {
      assert.equal(tool.version, devVersion, `tooling entry ${tool.name} version`)
    }
    if (tool.name === 'node') {
      assert.equal(tool.version, manifest.engines?.node, 'tooling entry node version')
    }
  }
})

test('references are well-formed and each cites an implementing module', () => {
  assert.ok(ABOUT.references.length > 0, 'ABOUT.references must not be empty')
  const ids = new Set<string>()

  for (const reference of ABOUT.references) {
    assert.ok(reference.id.trim().length > 0, 'a reference needs an id')
    assert.ok(!ids.has(reference.id), `duplicate reference id ${reference.id}`)
    ids.add(reference.id)
    assert.ok(Number.isInteger(reference.year), `${reference.id}: year must be an integer`)
    assert.ok(
      reference.year >= 1900 && reference.year <= 2100,
      `${reference.id}: year ${reference.year} is outside 1900-2100`,
    )
    for (const field of ['authors', 'title', 'venue', 'reason'] as const) {
      assert.ok(reference[field].trim().length > 0, `${reference.id}: ${field} must not be empty`)
    }

    const url = reference.url
    if (url !== undefined) {
      assert.match(url, /^https:\/\//, `${reference.id}: url must start with https://`)
      assert.doesNotThrow(() => new URL(url), `${reference.id}: url must parse`)
    }

    // `reason` is the audit trail: it must name the module the citation grounds.
    const cited = [...reference.reason.matchAll(/`(src\/[^`]+)`/g)].map((match) => match[1])
    assert.ok(cited.length > 0, `${reference.id}: reason must name a src/ module`)
    for (const path of cited) {
      assert.ok(existsSync(join(repositoryRoot, path)), `${reference.id}: cites missing module ${path}`)
    }
  }
})

test('the author block carries the maintainer identity and links', () => {
  assert.equal(ABOUT.author.name, 'Eloy Kim')
  assert.match(ABOUT.author.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'author.email must be an email address')
  assert.ok(
    ABOUT.author.github.startsWith('https://github.com/eloyhere/deepseek-coordination'),
    'author.github must point at the repository',
  )
  assert.match(
    ABOUT.author.github,
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    'author.github must be a canonical repository URL',
  )
  assert.equal(
    ABOUT.author.npm,
    'https://www.npmjs.com/package/deepseek-coordination',
    'author.npm must point at the published package',
  )
})
