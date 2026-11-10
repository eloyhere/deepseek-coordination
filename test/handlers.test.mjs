import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function context(overrides = {}) {
  const tools = new Map()
  const disposers = []
  const services = {}
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
      get: (name) => services[name],
      provide: (name, value) => {
        services[name] = value
        return () => {}
      },
      inject: (_deps, callback) => callback(ctx),
    }
  Object.assign(ctx, overrides)
  return { ctx, tools, disposers, services }
}

function config(storePath) {
  return {
    tenantId: 'test', rootId: 'root', storePath, notifications: false,
    prompt: false, skills: false, commands: false, routes: false,
    takeoverSearch: true,
    maxJournal: 100, maxReadChars: 100_000, maxWriteChars: 100_000,
  }
}

function execFor(root, callId = 'call-1', sessionId = 'session-work') {
  return {
    callId,
    name: 'amp',
    arguments: {},
    signal: new AbortController().signal,
    rootCallId: callId,
    agent: { id: sessionId, status: 'running', session: { header: { cwd: root } } },
  }
}

test('the existing AMP discover tool searches project file names and content via AMP ranking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-discover-search-'))
  const project = join(directory, 'project')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(join(project, 'node_modules', 'excluded'), { recursive: true })
  writeFileSync(join(project, 'src', 'unique-file-name.ts'), 'export const needlePhrase = "find-me-content"\n')
  writeFileSync(join(project, 'node_modules', 'excluded', 'dep.ts'), 'find-me-content')
  const { ctx, tools, disposers, services } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const discover = tools.get('attention_manifest_protocol_discover')
    const exec = execFor(project)
    const disabled = await discover.execute({ action: 'search', query: 'needlePhrase', scope: 'content' }, exec)
    assert.equal(disabled.ok, false)
    assert.equal(disabled.error.code, 'disabled')
    services.amp.preferencesFor(project).update({ takeoverSearch: true })
    assert.equal(services.amp.preferencesFor(project).get().takeoverSearch, true)
    assert.equal(services.amp.rootOfAgent(exec.agent), project)

    const content = await discover.execute({ action: 'search', query: 'find-me-content', scope: 'content' }, exec)
    assert.equal(content.authorization, 'not_granted', JSON.stringify(content))
    assert.equal(content.sources.includes('session_files'), true)
    const contentResults = content.tree.children.flatMap((source) => source.children.flatMap((group) => group.children))
    assert.ok(contentResults.some((item) => item.kind === 'content' && item.target.path === 'src/unique-file-name.ts'), JSON.stringify(content))
    assert.equal(contentResults.some((item) => item.target.path?.includes('node_modules')), false)

    const files = await discover.execute({ action: 'search', query: 'unique-file-name', scope: 'files', include: ['**/*.ts'] }, execFor(project, 'call-2'))
    const fileResults = files.tree.children.flatMap((source) => source.children.flatMap((group) => group.children))
    assert.ok(fileResults.some((item) => item.kind === 'file' && item.name === 'src/unique-file-name.ts'))
    assert.equal(fileResults.some((item) => item.kind === 'content'), false)

    const stringGlobs = await discover.execute({ action: 'search', query: 'find-me-content', scope: 'content', include: '**/*.{ts,tsx,js,mjs}', exclude: '**/*.test.{ts,js}' }, execFor(project, 'call-string-globs'))
    assert.equal(stringGlobs.authorization, 'not_granted', JSON.stringify(stringGlobs))
    const stringResults = stringGlobs.tree.children.flatMap((source) => source.children.flatMap((group) => group.children))
    assert.ok(stringResults.some((item) => item.kind === 'content' && item.target.path === 'src/unique-file-name.ts'), JSON.stringify(stringGlobs))

    const arrayQuery = await discover.execute({ action: 'search', query: ['find-me-content', 'needlePhrase'], scope: 'content' }, execFor(project, 'call-array-query'))
    const arrayResults = arrayQuery.tree?.children.flatMap((source) => source.children.flatMap((group) => group.children)) ?? []
    assert.ok(arrayResults.some((item) => item.target.path === 'src/unique-file-name.ts'), JSON.stringify(arrayQuery))

    const regexQuery = await discover.execute({ action: 'search', query: ['find-me-(content|phrase)'], regex: true, scope: 'content' }, execFor(project, 'call-regex-query'))
    const regexResults = regexQuery.tree?.children.flatMap((source) => source.children.flatMap((group) => group.children)) ?? []
    assert.ok(regexResults.some((item) => item.target.path === 'src/unique-file-name.ts'), JSON.stringify(regexQuery))

    const badRegex = await discover.execute({ action: 'search', query: ['('], regex: true, scope: 'content' }, execFor(project, 'call-bad-regex'))
    assert.equal(badRegex.ok, false)
    assert.equal(badRegex.error.code, 'invalid_search')
    assert.match(badRegex.error.message, /invalid regular expression/)

    const catalogArray = await discover.execute({ action: 'catalog', query: ['goal', 'plan'] }, exec)
    assert.ok(catalogArray.modules.some((module) => module.module === 'goal'))
    assert.ok(catalogArray.modules.some((module) => module.module === 'plan'))
    const catalogRegex = await discover.execute({ action: 'catalog', query: '^pla', regex: true }, exec)
    assert.ok(catalogRegex.modules.some((module) => module.module === 'plan'))
    const badCatalogRegex = await discover.execute({ action: 'catalog', query: ['['], regex: true }, exec)
    assert.equal(badCatalogRegex.ok, false)
    assert.equal(badCatalogRegex.error.code, 'invalid_query')

    const escaped = await discover.execute({ action: 'search', query: 'needlePhrase', path: '..' }, execFor(project, 'call-3'))
    assert.equal(escaped.ok, false)
    assert.equal(escaped.error.code, 'invalid_search')
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('workspace read/write stays inside the session root and CAS-guards writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-workspace-'))
  const workspace = join(directory, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'a.txt'), 'alpha\nbeta\n')
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const workspaceTool = tools.get('attention_manifest_protocol_workspace')
    const read = await workspaceTool.execute({ verb: 'read', arguments: { path: 'a.txt' } }, execFor(workspace))
    assert.equal(read.value.ok, true)
    assert.equal(read.value.value.phase, 'outline')
    assert.equal(read.value.value.content, undefined)
    assert.ok(Array.isArray(read.value.value.nodes))
    assert.ok(read.value.value.nodes.some((node) => node.name === 'alpha'), JSON.stringify(read.value.value.nodes))
    assert.ok(read.value.value.project.entries.some(entry => entry.path === 'a.txt'))
    const revision = read.value.value.revision
    const contentRead = await workspaceTool.execute({ verb: 'read', arguments: { path: 'a.txt' } }, execFor(workspace))
    assert.equal(contentRead.value.value.content, 'alpha\nbeta\n')
    assert.equal(contentRead.value.value.phase, undefined)
    const otherSession = await workspaceTool.execute({ verb: 'read', arguments: { path: 'a.txt' } }, execFor(workspace, 'call-session-2', 'session-2'))
    assert.equal(otherSession.value.value.phase, 'outline')
    writeFileSync(join(workspace, 'a.txt'), 'gamma\ndelta\n')
    const changed = await workspaceTool.execute({ verb: 'read', arguments: { path: 'a.txt' } }, execFor(workspace, 'call-changed'))
    assert.equal(changed.value.value.phase, 'outline')
    const changedContent = await workspaceTool.execute({ verb: 'read', arguments: { path: 'a.txt' } }, execFor(workspace, 'call-changed-content'))
    assert.equal(changedContent.value.value.content, 'gamma\ndelta\n')
    const changedRevision = changed.value.value.revision
    const conflict = await workspaceTool.execute({
      verb: 'write',
      arguments: { path: 'a.txt', content: 'changed', expectedRevision: 'sha256:nope' },
    }, execFor(workspace, 'call-2'))
    assert.equal(conflict.value.ok, false)
    assert.equal(conflict.value.error.code, 'version_conflict')
    const written = await workspaceTool.execute({
      verb: 'write',
      arguments: { path: 'a.txt', content: 'changed\n', expectedRevision: changedRevision },
    }, execFor(workspace, 'call-3'))
    assert.equal(written.value.ok, true)
    assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'changed\n')
    const escape = await workspaceTool.execute({ verb: 'read', arguments: { path: '../outside.txt' } }, execFor(workspace, 'call-4'))
    assert.equal(escape.value.ok, false)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('attention_manifest_protocol_replace edits workspace files through AMP 0.7.9', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-replace-'))
  const workspace = join(directory, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'a.txt'), 'alpha\nbeta\n')
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const replace = tools.get('attention_manifest_protocol_replace')
    assert.ok(replace !== undefined)
    const literal = await replace.execute({ path: 'a.txt', mode: 'string', text: 'alpha', replacement: 'gamma' }, execFor(workspace))
    assert.equal(literal.ok, true, JSON.stringify(literal))
    assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'gamma\nbeta\n')
    const regex = await replace.execute({ path: 'a.txt', mode: 'regex', pattern: '^beta$', flags: 'm', replacement: 'delta' }, execFor(workspace, 'call-2'))
    assert.equal(regex.ok, true, JSON.stringify(regex))
    assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'gamma\ndelta\n')
    const all = await replace.execute({ path: 'a.txt', mode: 'string', text: 'a', replacement: 'A', all: true }, execFor(workspace, 'call-3'))
    assert.equal(all.ok, true, JSON.stringify(all))
    assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'gAmmA\ndeltA\n')
    const missing = await replace.execute({ path: 'missing.txt', mode: 'string', text: 'x', replacement: 'y' }, execFor(workspace, 'call-4'))
    assert.equal(missing.ok, false)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('project metadata follows outline-first navigation and environment uses CAS', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-project-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3' }))
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const project = tools.get('attention_manifest_protocol_project')
    const outline = await project.execute({ verb: 'metadata', arguments: {} }, execFor(directory))
    assert.equal(outline.value.value.phase, 'project_outline')
    assert.ok(Array.isArray(outline.value.value.project.entries))
    const metadata = await project.execute({ verb: 'metadata', arguments: {} }, execFor(directory, 'metadata-details'))
    assert.equal(metadata.value.value.name, 'demo')
    const otherSessionOutline = await project.execute({ verb: 'metadata', arguments: {} }, execFor(directory, 'other-session', 'session-other'))
    assert.equal(otherSessionOutline.value.value.phase, 'project_outline')
    const first = await project.execute({
      verb: 'configure_environment',
      arguments: { patch: { variables: { NODE_ENV: 'test' } } },
    }, execFor(directory, 'call-2'))
    assert.equal(first.value.ok, true)
    assert.equal(first.value.value.version, 1)
    const stale = await project.execute({
      verb: 'configure_environment',
      arguments: { expectedVersion: 0, patch: { variables: { A: 'b' } } },
    }, execFor(directory, 'call-3'))
    assert.equal(stale.value.ok, false)
    const environment = await project.execute({ verb: 'environment', arguments: {} }, execFor(directory, 'call-4'))
    assert.equal(environment.value.value.environment.variables.NODE_ENV, 'test')
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('plan.propose_draft creates a draft plan through the AMP kernel', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-plan-'))
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const plan = tools.get('attention_manifest_protocol_plan')
    const draft = await plan.execute({
      verb: 'propose_draft',
      arguments: {
        objective: 'ship the integration',
        tasks: [{ taskId: 'task:1', acceptance: 'plugin loads' }],
      },
    }, execFor(directory))
    assert.equal(draft.value.ok, true, JSON.stringify(draft.value))
    assert.equal(draft.value.value.plan.state, 'draft')
    assert.equal(draft.value.value.draft, true)
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reading a project directory returns its outline instead of failing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-dir-outline-'))
  const workspace = join(directory, 'ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# Demo\n')
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  const { ctx, tools, disposers } = context()
  try {
    await apply(ctx, config(join(directory, 'amp.sqlite')))
    const workspaceTool = tools.get('attention_manifest_protocol_workspace')
    const root = await workspaceTool.execute({ verb: 'read', arguments: { path: '.' } }, execFor(workspace))
    assert.equal(root.value.ok, true)
    assert.equal(root.value.value.phase, 'project_outline')
    assert.ok(root.value.value.entries.some((entry) => entry.path === 'README.md'), JSON.stringify(root.value.value.entries))
    assert.ok(root.value.value.project.entries.some((entry) => entry.path === 'README.md'))
    const sub = await workspaceTool.execute({ verb: 'outline', arguments: { path: 'src' } }, execFor(workspace, 'call-sub'))
    assert.equal(sub.value.value.phase, 'project_outline')
    assert.ok(sub.value.value.entries.some((entry) => entry.path.endsWith('a.ts')), JSON.stringify(sub.value.value.entries))
    const file = await workspaceTool.execute({ verb: 'read', arguments: { path: 'src/a.ts' } }, execFor(workspace, 'call-file'))
    assert.equal(file.value.value.phase, 'outline')
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})


