/**
 * Local environment discovery: the seed behind a non-empty
 * `coordination_environment list`.
 *
 * The tests pin the contract the tool and the prompt depend on:
 *
 *  - only curated, secret-free values are collected (no API keys/tokens);
 *  - executable resolution follows PATH + PATHEXT and records real files only;
 *  - two discoveries on the same machine produce identical key order;
 *  - seeding is idempotent and never overwrites an edited record;
 *  - `refresh` keeps user-edited values, updates drift and adds new keys.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENVIRONMENT_ID,
  discoverEnvironment,
  findOnPath,
  isSensitiveName,
  mergeDiscovered,
  seedEnvironment,
} from '../src/host/environment.js'

function discovery(overrides: {
  files?: readonly string[]
  env?: Record<string, string>
  platform?: NodeJS.Platform
  workspaceRoot?: string
} = {}) {
  const files = new Set(overrides.files ?? [])
  return discoverEnvironment({
    workspaceRoot: overrides.workspaceRoot,
    env: overrides.env ?? {},
    platform: overrides.platform ?? 'win32',
    arch: 'x64',
    isFile: (path) => files.has(path),
    now: () => 1_700_000_000_000,
  })
}

test('discovery records curated tool paths and project metadata only', () => {
  const found = discovery({
    workspaceRoot: 'C:\\work\\demo',
    files: ['C:\\bin\\git.EXE', 'C:\\bin\\node.EXE', 'C:\\bin\\npm.CMD'],
    env: {
      PATH: 'C:\\bin;C:\\tools',
      PATHEXT: '.EXE;.CMD',
      USERPROFILE: 'C:\\Users\\demo',
      TEMP: 'C:\\Temp',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      LANG: 'zh_CN.UTF-8',
      OPENAI_API_KEY: 'sk-should-never-appear',
      GITHUB_TOKEN: 'ghp-should-never-appear',
    },
  })
  assert.deepEqual(Object.keys(found.variables), [
    'project.root',
    'tool.git',
    'tool.node',
    'tool.npm',
    'path',
    'pathext',
    'home',
    'temp',
    'shell',
    'lang',
    'platform',
    'arch',
  ])
  assert.equal(found.variables['tool.git'], 'C:\\bin\\git.EXE')
  assert.equal(found.variables.home, 'C:\\Users\\demo')
  assert.equal(found.variables.platform, 'win32')
  assert.equal(found.variables.arch, 'x64')
  assert.ok(!JSON.stringify(found).includes('sk-should-never-appear'))
  assert.ok(!JSON.stringify(found).includes('ghp-should-never-appear'))
  assert.deepEqual(found.discovered, found.variables)
  assert.equal(found.refreshedAt, '2023-11-14T22:13:20.000Z')
})

test('discovery is deterministic and clips long values', () => {
  const longPath = Array.from({ length: 1_200 }, (_, index) => `C:\\dir${index}`).join(';')
  const first = discovery({ env: { PATH: longPath } })
  const second = discovery({ env: { PATH: longPath } })
  assert.deepEqual(first.variables, second.variables)
  assert.ok(first.variables.path.length <= 4_000)
  assert.ok(first.variables.path.endsWith('…'))
})

test('executable resolution honours PATH order and PATHEXT', () => {
  assert.equal(findOnPath('git', {
    env: { PATH: 'C:\\first;C:\\second', PATHEXT: '.EXE' },
    platform: 'win32',
    isFile: (path) => path === 'C:\\second\\git.EXE' || path === 'C:\\first\\git.EXE',
  }), 'C:\\first\\git.EXE')
  assert.equal(findOnPath('node', {
    env: { PATH: '/usr/local/bin:/usr/bin' },
    platform: 'linux',
    isFile: (path) => path === '/usr/bin/node',
  }), '/usr/bin/node')
  assert.equal(findOnPath('missing', {
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    isFile: () => false,
  }), undefined)
})

test('credential-shaped names are refused', () => {
  for (const name of ['OPENAI_API_KEY', 'github_token', 'AWS_SECRET', 'DB_PASSWORD', 'api-key']) {
    assert.equal(isSensitiveName(name), true, name)
  }
  for (const name of ['path', 'home', 'tool.node', 'project.root', 'keyboard']) {
    assert.equal(isSensitiveName(name), false, name)
  }
})

test('refresh updates drift, keeps edits and adds new keys', () => {
  const merged = mergeDiscovered(
    { 'tool.git': 'D:\\custom\\git.exe', 'tool.node': 'C:\\old\\node.exe', 'custom.key': 'mine' },
    { 'tool.git': 'C:\\git.exe', 'tool.node': 'C:\\old\\node.exe' },
    { 'tool.git': 'C:\\git.exe', 'tool.node': 'C:\\new\\node.exe', 'tool.pnpm': 'C:\\pnpm.cmd' },
  )
  assert.equal(merged.variables['tool.git'], 'D:\\custom\\git.exe', 'a user edit outlives refresh')
  assert.equal(merged.variables['tool.node'], 'C:\\new\\node.exe', 'unchanged drift follows the discovery')
  assert.equal(merged.variables['tool.pnpm'], 'C:\\pnpm.cmd')
  assert.equal(merged.variables['custom.key'], 'mine')
  assert.deepEqual({ added: merged.added, updated: merged.updated, kept: merged.kept }, { added: 1, updated: 1, kept: 1 })
})

test('the seed writes once and never overwrites', () => {
  const records: Array<Record<string, unknown>> = []
  const control = {
    listRegistry: () => records,
    registry: (request: unknown) => {
      const row = request as { id: string; value: Record<string, unknown> }
      records.push({ id: row.id, value: row.value })
      return { ok: true, version: records.length }
    },
  }
  const root = process.cwd()
  assert.equal(seedEnvironment(control, root, { env: { PATH: '' }, isFile: () => false }), true)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.id, ENVIRONMENT_ID)
  assert.equal((records[0]?.value as { variables: Record<string, string> }).variables['project.root'], root)

  assert.equal(seedEnvironment(control, root, { env: { PATH: '' }, isFile: () => false }), false)
  assert.equal(records.length, 1, 'a second seed is a no-op')
})
