import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

// Node >=24 strips these modules' type-only imports; no bundled build is needed.
import { createProjectFileProvider, parseProjectSearchArguments } from '../src/host/search.ts'

const binding = { tenantId: 'test', principalId: 'test', sessionId: 'search-test' }

async function snapshots(root, args) {
  const host = {
    protocol: {
      agent: {
        createSessionFileDiscoveryProvider: (read) => ({
          source: 'session_files',
          search: (_query, session) => read(session),
        }),
      },
    },
  }
  const request = parseProjectSearchArguments({ query: 'needle', scope: 'files', ...args })
  return createProjectFileProvider(host, request, root).search(request.options, binding)
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'amp-search-glob-'))
  try {
    for (const file of [
      'root.ts', 'src/view.tsx', 'src/nested/app.js', 'src/run.mjs',
      'src/readme.md', 'src/generated/skip.ts', 'src/view.test.tsx',
      'src/literal{ts}.ts', 'src/regex+(name).ts',
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), 'needle\n')
    }
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function paths(files) {
  return files.map((file) => file.path).sort()
}

test('search normalizes string include/exclude and preserves array and empty-array forms', () => {
  const single = parseProjectSearchArguments({ query: 'needle', include: '**/*.ts', exclude: '**/generated/**' })
  assert.deepEqual(single.include, ['**/*.ts'])
  assert.deepEqual(single.exclude, ['**/generated/**'])
  const multiple = parseProjectSearchArguments({ query: 'needle', include: ['**/*.ts', '**/*.tsx'], exclude: [] })
  assert.deepEqual(multiple.include, ['**/*.ts', '**/*.tsx'])
  assert.deepEqual(multiple.exclude, [])
  const omitted = parseProjectSearchArguments({ query: 'needle' })
  assert.equal(omitted.include, undefined)
  assert.equal(omitted.exclude, undefined)
})

test('search rejects invalid glob values with a useful parameter-specific error', () => {
  for (const name of ['include', 'exclude']) {
    for (const value of ['', '  ', null, 42, {}, ['**/*.ts', 42], ['']]) {
      assert.throws(
        () => parseProjectSearchArguments({ query: 'needle', [name]: value }),
        new RegExp(`${name} must be a non-empty string or an array of non-empty strings`),
      )
    }
  }
})

test('brace includes match all requested extensions at the root and nested paths', async () => {
  await fixture(async (root) => {
    const args = { include: '**/*.{ts,tsx,js,mjs}', exclude: ['**/generated/**', '**/*.test.{ts,tsx}'] }
    const expected = ['root.ts', 'src/literal{ts}.ts', 'src/nested/app.js', 'src/regex+(name).ts', 'src/run.mjs', 'src/view.tsx'].sort()
    assert.deepEqual(paths(await snapshots(root, args)), expected)
    assert.deepEqual(paths(await snapshots(root, { ...args, include: [args.include] })), expected)
    const content = await snapshots(root, { ...args, scope: 'content' })
    assert.deepEqual(paths(content), expected)
    assert.ok(content.every((file) => file.content === 'needle\n'))
  })
})

test('string and array brace excludes both remove matching files', async () => {
  await fixture(async (root) => {
    const args = { include: '**/*.{ts,tsx,js,mjs}', exclude: '**/*.{js,mjs}' }
    const expected = ['root.ts', 'src/generated/skip.ts', 'src/literal{ts}.ts', 'src/regex+(name).ts', 'src/view.test.tsx', 'src/view.tsx'].sort()
    assert.deepEqual(paths(await snapshots(root, args)), expected)
    assert.deepEqual(paths(await snapshots(root, { ...args, exclude: [args.exclude] })), expected)
  })
})

test('glob alternatives support nesting and multiple groups without treating regex metacharacters as syntax', async () => {
  await fixture(async (root) => {
    assert.deepEqual(paths(await snapshots(root, { include: '{root,src/view}.{ts,tsx}' })), ['root.ts', 'src/view.tsx'])
    assert.deepEqual(paths(await snapshots(root, { include: '**/*.{ts,{tsx,js}}', exclude: ['**/generated/**', '**/*.test.tsx'] })),
      ['root.ts', 'src/literal{ts}.ts', 'src/nested/app.js', 'src/regex+(name).ts', 'src/view.tsx'])
    assert.deepEqual(paths(await snapshots(root, { include: 'src/literal{ts}.ts' })), ['src/literal{ts}.ts'])
    assert.deepEqual(paths(await snapshots(root, { include: 'src/regex+(name).ts' })), ['src/regex+(name).ts'])
    assert.deepEqual(paths(await snapshots(root, { include: 'src/r?n.mjs' })), ['src/run.mjs'])
    assert.deepEqual(paths(await snapshots(root, { path: 'src/view.tsx', include: '**/*.{ts,tsx}' })), ['src/view.tsx'])
  })
})
