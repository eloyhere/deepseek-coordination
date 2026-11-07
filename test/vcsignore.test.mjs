import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function context() {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name) => tools.get(name),
      definitions: () => [...tools.values()],
    },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    sessions: { list: () => [] },
    agents: { get: () => undefined },
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: () => undefined,
    provide: () => () => {},
    inject: (_deps, callback) => callback(ctx),
  }
  return { ctx, tools, disposers }
}

function config(overrides = {}) {
  return {
    tenantId: 'test', rootId: 'root', notifications: false,
    prompt: false, skills: false, commands: false, routes: false,
    maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000,
    ...overrides,
  }
}

function execFor(root) {
  return {
    callId: 'call-1',
    name: 'amp',
    arguments: {},
    signal: new AbortController().signal,
    rootCallId: 'call-1',
    agent: { id: 'session-vcs', status: 'running', session: { header: { cwd: root } } },
  }
}

/** Run one plugin call against a fresh workspace so the store slot is created. */
async function inWorkspace(marker, run) {
  const directory = mkdtempSync(join(tmpdir(), 'amp-vcs-'))
  const workspace = join(directory, 'ws')
  mkdirSync(workspace)
  marker(workspace)
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config())
    const session = tools.get('attention_manifest_protocol_session')
    await session.execute({ verb: 'list' }, execFor(workspace))
    await session.execute({ verb: 'list' }, execFor(workspace))
    await run({ workspace, directory })
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
}

function read(path) {
  return readFileSync(path, 'utf8')
}

test('git repositories hide the AMP store and keep one rule', async () => {
  await inWorkspace((workspace) => mkdirSync(join(workspace, '.git')), async ({ workspace }) => {
    const ignore = read(join(workspace, '.gitignore'))
    assert.match(ignore, /# AMP runtime data written by deepseek-coordination/)
    assert.equal(ignore.split('\n').filter((line) => line.trim() === '.deepseek-coordination/').length, 1)
  })
})

test('a nested workspace is ignored relative to the git root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-vcs-'))
  const repo = join(directory, 'repo')
  const workspace = join(repo, 'packages', 'app')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(repo, '.git'))
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config())
    const session = tools.get('attention_manifest_protocol_session')
    await session.execute({ verb: 'list' }, execFor(workspace))
    assert.match(read(join(repo, '.gitignore')), /^packages\/app\/\.deepseek-coordination\/$/m)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('mercurial appends a glob rule when the file uses glob syntax', async () => {
  await inWorkspace((workspace) => {
    mkdirSync(join(workspace, '.hg'))
    writeFileSync(join(workspace, '.hgignore'), 'syntax: glob\n*.pyc\n', 'utf8')
  }, async ({ workspace }) => {
    const ignore = read(join(workspace, '.hgignore'))
    assert.match(ignore, /^\.deepseek-coordination\/\*\*$/m)
  })
})

test('mercurial appends a regexp rule when the file uses regexp syntax', async () => {
  await inWorkspace((workspace) => {
    mkdirSync(join(workspace, '.hg'))
    writeFileSync(join(workspace, '.hgignore'), 'syntax: regexp\n\\.pyc$\n', 'utf8')
  }, async ({ workspace }) => {
    assert.match(read(join(workspace, '.hgignore')), /^\^\\\.deepseek-coordination\/$/m)
  })
})

test('fossil checkouts hide the store through ignore-glob', async () => {
  await inWorkspace((workspace) => writeFileSync(join(workspace, '_FOSSIL_'), '', 'utf8'), async ({ workspace }) => {
    assert.match(read(join(workspace, '.fossil-settings', 'ignore-glob')), /^\.deepseek-coordination\/\*$/m)
  })
})

test('bazaar checkouts append to .bzrignore', async () => {
  await inWorkspace((workspace) => mkdirSync(join(workspace, '.bzr')), async ({ workspace }) => {
    assert.match(read(join(workspace, '.bzrignore')), /^\.deepseek-coordination$/m)
  })
})

test('a plain folder without version control is left untouched', async () => {
  await inWorkspace(() => {}, async ({ workspace }) => {
    assert.throws(() => read(join(workspace, '.gitignore')))
  })
})
