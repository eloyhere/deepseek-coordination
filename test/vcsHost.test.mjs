/** The host must keep AMP's store directory out of the workspace's VCS. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.mjs'

function harness(repo) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) { tools.set(definition.name, definition); return () => {} },
      get(name) { return tools.get(name) },
      definitions() { return [...tools.values()] },
    },
    systemPrompt: { getSectionOrder: () => 0, getContextOrder: () => 0, section: () => () => {}, context: () => () => {} },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    agents: { get: () => undefined },
    sessions: { list: () => [] },
    on: () => () => {},
    effect(effect) { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
    get: () => undefined,
    provide: () => () => {},
    inject: () => () => {},
  }
  return { ctx, tools, disposers, repo }
}

function execFor(repo, callId = 'call-1') {
  return {
    callId,
    name: 'attention_manifest_protocol_session',
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'session-vcs', session: { header: { cwd: repo } } },
    rootCallId: callId,
  }
}

test('the host ignores .deepseek-coordination in a git repository', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-vcs-host-'))
  const repo = join(directory, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
  const { ctx, tools, disposers } = harness(repo)
  try {
    await apply(ctx, {
      tenantId: 'test',
      rootId: 'root',
      notifications: false,
      prompt: false,
      skills: false,
      commands: false,
      routes: false,
      maxJournal: 100,
      maxReadChars: 200000,
      maxWriteChars: 1000000,
    })
    const session = tools.get('attention_manifest_protocol_session')
    assert.equal((await session.execute({ verb: 'get', arguments: {} }, execFor(repo))).value.ok, true)
    const first = readFileSync(join(repo, '.gitignore'), 'utf8')
    assert.match(first, /^\.deepseek-coordination\/$/m)
    assert.equal(first.match(/\.deepseek-coordination\//g).length, 1)

    assert.equal((await session.execute({ verb: 'get', arguments: {} }, execFor(repo, 'call-2'))).value.ok, true)
    const second = readFileSync(join(repo, '.gitignore'), 'utf8')
    assert.equal(second, first)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
