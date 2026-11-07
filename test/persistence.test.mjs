import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../lib/index.mjs'

function context() {
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
    agents: { get: () => undefined, list: () => [] },
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: () => undefined,
    provide: (name, value) => {
      services[name] = value
      return () => {}
    },
    inject: (_deps, callback) => callback(ctx),
  }
  return { ctx, tools, services, disposers }
}

function config(extra = {}) {
  return {
    tenantId: 'test',
    rootId: 'root',
    notifications: false,
    prompt: false,
    skills: false,
    commands: false,
    routes: false,
    maxJournal: 100,
    maxReadChars: 100_000,
    maxWriteChars: 100_000,
    ...extra,
  }
}

function execFor(root, callId = 'call-1') {
  return {
    callId,
    name: 'amp',
    arguments: {},
    signal: new AbortController().signal,
    rootCallId: callId,
    agent: { id: 'session-work', status: 'running', session: { header: { cwd: root } } },
  }
}

async function start(overrides = {}) {
  const { ctx, tools, services, disposers } = context()
  await apply(ctx, config(overrides))
  const amp = services.amp
  return {
    ctx,
    tools,
    amp,
    dispose: () => {
      for (const dispose of [...disposers].reverse()) dispose()
    },
  }
}

test('the AMP kernel store lives in the session workspace, not the home directory', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'amp-persist-ws-'))
  const host = await start()
  try {
    const plan = host.tools.get('attention_manifest_protocol_plan')
    const draft = await plan.execute({
      verb: 'propose_draft',
      arguments: { objective: 'persist this plan', tasks: [{ taskId: 'task:1', acceptance: 'it survives' }] },
    }, execFor(workspace))
    assert.equal(draft.value.ok, true, JSON.stringify(draft.value))
    const store = join(workspace, '.deepseek-coordination', 'amp.sqlite')
    assert.ok(existsSync(store), `expected ${store} to exist`)
    assert.equal(host.amp.storage().mode, 'workspace')
    assert.equal(host.amp.storage().defaultRoot, workspace)
    const root = host.amp.storage().roots.find((entry) => entry.storePath === store)
    assert.ok(root !== undefined, 'the open store is reported')
    assert.equal(root.open, true)
    const workspaceTool = host.tools.get('attention_manifest_protocol_workspace')
    const listing = await workspaceTool.execute({ verb: 'list', arguments: { path: '.' } }, execFor(workspace, 'call-2'))
    assert.equal(listing.value.ok, true)
    const paths = listing.value.value.entries.map((entry) => entry.path)
    assert.equal(paths.some((path) => path.startsWith('.deepseek-coordination')), false, 'the AMP data directory stays out of workspace listings')
  } finally {
    host.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('a restarted host restores the plan from the workspace store', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'amp-persist-reload-'))
  let planId
  const first = await start()
  try {
    const plan = first.tools.get('attention_manifest_protocol_plan')
    const draft = await plan.execute({
      verb: 'propose_draft',
      arguments: { objective: 'restore me after a restart', tasks: [{ taskId: 'task:1' }] },
    }, execFor(workspace))
    assert.equal(draft.value.ok, true, JSON.stringify(draft.value))
    planId = draft.value.value.plan.id
    assert.ok(typeof planId === 'string' && planId.length > 0)
  } finally {
    first.dispose()
  }

  const second = await start()
  try {
    const plan = second.tools.get('attention_manifest_protocol_plan')
    const restored = await plan.execute({ verb: 'get', arguments: { id: planId } }, execFor(workspace, 'call-2'))
    assert.equal(restored.value.ok, true, JSON.stringify(restored.value))
    assert.equal(restored.value.value.id, planId)
    assert.equal(restored.value.value.state, 'draft')
  } finally {
    second.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('host-side state (status lines) survives a restart', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'amp-persist-state-'))
  const first = await start()
  try {
    const session = first.tools.get('attention_manifest_protocol_session')
    const reported = await session.execute({
      verb: 'report_status',
      arguments: { status: 'reviewing the store' },
    }, execFor(workspace))
    assert.equal(reported.value.ok, true, JSON.stringify(reported.value))
    assert.ok(existsSync(join(workspace, '.deepseek-coordination', 'host-state.json')))
  } finally {
    first.dispose()
  }

  const second = await start()
  try {
    const session = second.tools.get('attention_manifest_protocol_session')
    const read = await session.execute({ verb: 'get', arguments: { id: 'session-work' } }, execFor(workspace, 'call-2'))
    assert.equal(read.value.ok, true)
    assert.equal(read.value.value.statusLine, 'reviewing the store')
  } finally {
    second.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('two workspace roots keep independent stores', async () => {
  const first = mkdtempSync(join(tmpdir(), 'amp-persist-a-'))
  const second = mkdtempSync(join(tmpdir(), 'amp-persist-b-'))
  const host = await start()
  try {
    const plan = host.tools.get('attention_manifest_protocol_plan')
    const draft = await plan.execute({
      verb: 'propose_draft',
      arguments: { objective: 'only in workspace A', tasks: [{ taskId: 'task:1' }] },
    }, execFor(first))
    assert.equal(draft.value.ok, true, JSON.stringify(draft.value))
    const planId = draft.value.value.plan.id
    const missing = await plan.execute({ verb: 'get', arguments: { id: planId } }, execFor(second, 'call-2'))
    assert.equal(missing.value.ok, false)
    assert.equal(missing.value.error.code, 'not_found')
    assert.ok(existsSync(join(first, '.deepseek-coordination', 'amp.sqlite')))
    assert.ok(existsSync(join(second, '.deepseek-coordination', 'amp.sqlite')))
  } finally {
    host.dispose()
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test('a workspace inherits the machine-wide takeover preferences on first use', async () => {
  const home = mkdtempSync(join(tmpdir(), 'amp-persist-prefs-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'amp-persist-prefs-ws-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  mkdirSync(join(home, 'storages', 'deepseek-coordination'), { recursive: true })
  writeFileSync(join(home, 'storages', 'deepseek-coordination', 'amp.sqlite'), '')
  writeFileSync(join(home, 'storages', 'deepseek-coordination', 'preferences.json'), JSON.stringify({
    takeoverFileRead: true,
    takeoverFileWrite: true,
    takeoverSearch: true,
    takeoverNotifications: false,
    autoRefresh: false,
    compactCatalog: true,
  }))
  const host = await start()
  try {
    const budget = host.tools.get('attention_manifest_protocol_budget')
    const remaining = await budget.execute({ verb: 'remaining', arguments: {} }, execFor(workspace))
    assert.equal(remaining.value.ok, true, JSON.stringify(remaining.value))
    const preferences = host.amp.preferencesFor(workspace).get()
    assert.equal(preferences.takeoverFileRead, true)
    assert.equal(preferences.takeoverFileWrite, true)
    assert.equal(preferences.takeoverSearch, true)
    assert.equal(preferences.autoRefresh, false)
    assert.equal(preferences.compactCatalog, true)
    assert.ok(existsSync(join(workspace, '.deepseek-coordination', 'preferences.json')))
  } finally {
    host.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('storage: user keeps the machine-wide $DSH_HOME layout', async () => {
  const home = mkdtempSync(join(tmpdir(), 'amp-persist-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'amp-persist-user-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const host = await start({ storage: 'user' })
  try {
    const budget = host.tools.get('attention_manifest_protocol_budget')
    const remaining = await budget.execute({ verb: 'remaining', arguments: {} }, execFor(workspace))
    assert.equal(remaining.value.ok, true, JSON.stringify(remaining.value))
    assert.ok(existsSync(join(home, 'storages', 'deepseek-coordination', 'amp.sqlite')))
    assert.equal(existsSync(join(workspace, '.deepseek-coordination', 'amp.sqlite')), false)
    assert.equal(host.amp.storage().mode, 'user')
  } finally {
    host.dispose()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('session lists show real requests and actions, retain diagnostics, and isolate sessions', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'amp-readable-session-'))
  const host = await start()
  const request = '重构 AMP 设置页面，使用 MUI 并修复标签切换卡顿'
  const s1 = { id: 'session-readable', header: { cwd: workspace }, seq: 3, deriveMessages: () => [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: request }] },
    { role: 'user', source: { kind: 'runtime', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context. secret diagnostic' }] },
    { role: 'user', source: { kind: 'skill', form: 'instructions' }, content: [{ type: 'text', text: '<skill_content>not the request</skill_content>' }] },
  ] }
  const s2 = { id: 'session-other', header: { cwd: workspace }, deriveMessages: () => [] }
  host.ctx.agents.get = (id) => ({ id, session: id === s1.id ? s1 : s2 })
  host.ctx.sessions.get = (id) => id === s1.id ? s1 : s2
  const emit = (session, type, data) => {
    host.amp.observeSessionEvent(session, { type, data })
    host.amp.sync.onSessionEvent(session, { type, data })
  }
  try {
    emit(s1, 'turn/start', { turn: 1 })
    emit(s2, 'turn/start', { turn: 1 })
    emit(s1, 'user/message', { source: { kind: 'user' }, turn: 1, content: [{ type: 'text', text: request }] })
    emit(s1, 'user/message', { source: { kind: 'runtime' }, turn: 1, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] })
    for (let i = 0; i < 24; i++) {
      emit(s1, 'tool/call', { turn: 1, callId: `readable-${i}`, name: 'read', arguments: JSON.stringify({ file_path: 'src/client/panel.ts', description: '检查输入框上方的 AMP 状态栏' }) })
      emit(s1, 'tool/result', { turn: 1, message: { toolCallId: `readable-${i}`, isError: false } })
    }
    emit(s2, 'tool/call', { turn: 1, callId: 'other-only', name: 'read', arguments: JSON.stringify({ file_path: 'private-other-session.txt' }) })
    emit(s1, 'todo/write', { turn: 1, todos: [{ content: '修复标签切换时重复挂载', status: 'in_progress' }] })
    const kernel = host.amp.kernel(workspace)
    for (const [id, kind, summary] of [
      ['focus-user', 'prompt', request],
      ['focus-system', 'prompt', '<system-reminder>private diagnostic</system-reminder>'],
      ['focus-workspace', 'workspace', `workspace: ${workspace}`],
    ]) kernel.store.save('attention', { id, version: 0, summary, pointer: { kind, id, version: '1' }, scope: { tenantId: 'test', principalId: s1.id, sessionId: s1.id, turnId: 'turn:session-readable:1' }, mounted: true, stale: false, createdAt: '2026-11-07T06:00:00Z', updatedAt: '2026-11-07T06:00:00Z' })
    const result = host.amp.snapshot(workspace, s1.id, true)
    const lists = result.lists
    assert.equal(result.kernel.counts.session, 1)
    assert.equal(result.kernel.counts.action, 24)
    assert.equal(lists.action.length, result.kernel.counts.action)
    assert.equal(lists.action_attempt.length, 24)
    assert.equal(lists.action[0].title, '检查输入框上方的 AMP 状态栏')
    assert.equal(lists.action[0].detail, 'src/client/panel.ts')
    assert.equal(lists.action[0].state, 'succeeded')
    assert.ok(lists.goal.some((row) => row.title === request))
    assert.ok(lists.mission.some((row) => row.title === request))
    assert.ok(lists.task.some((row) => row.title === '修复标签切换时重复挂载'))
    assert.ok(lists.plan.some((row) => row.title.includes(request)))
    const technical = lists.attention.find((row) => row.id === 'focus-system')
    assert.equal(technical.diagnostic, true)
    assert.equal(technical.raw.summary, '<system-reminder>private diagnostic</system-reminder>')
    assert.equal(lists.attention.find((row) => row.id === 'focus-workspace').title, '当前工作区')
    assert.equal(JSON.stringify(lists).includes('private-other-session.txt'), false)
    assert.equal(lists.turn[0].title, '第 1 轮对话')
    assert.equal(lists.turn[0].detail, request)
    assert.deepEqual(lists.profession, [])
  } finally {
    host.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('restored session history supplies readable labels without scanning raw events', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'amp-readable-restore-'))
  const host = await start()
  const session = { id: 'restored-view', header: { cwd: workspace }, seq: 4,
    snapshotEvents: () => { throw new Error('deprecated event scan must not be used') },
    deriveMessages: () => [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复状态栏高度' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'r1', name: 'read', arguments: '{"file_path":"src/client/panel.ts"}' }] },
      { role: 'user', source: { kind: 'runtime' }, content: [{ type: 'text', text: 'Current runtime context.' }] },
    ] }
  host.ctx.agents.get = () => ({ id: session.id, session })
  try {
    host.amp.sync.onSessionEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'r1', name: 'read', arguments: '{}' } })
    const lists = host.amp.sessionLists(session.id, workspace)
    assert.equal(lists.session[0].title, '修复状态栏高度')
    assert.equal(lists.action[0].title, '读取文件')
    assert.equal(lists.action[0].detail, 'src/client/panel.ts')
    assert.equal(lists.action_attempt[0].raw.actionId, lists.action[0].id)
  } finally {
    host.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('an explicit storePath pins every workspace to one store', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'amp-persist-shared-'))
  const workspace = mkdtempSync(join(tmpdir(), 'amp-persist-root-'))
  const storePath = join(directory, 'shared', 'amp.sqlite')
  const host = await start({ storePath })
  try {
    const plan = host.tools.get('attention_manifest_protocol_plan')
    const draft = await plan.execute({
      verb: 'propose_draft',
      arguments: { objective: 'one shared store', tasks: [{ taskId: 'task:1' }] },
    }, execFor(workspace))
    assert.equal(draft.value.ok, true, JSON.stringify(draft.value))
    assert.ok(existsSync(storePath))
    assert.equal(host.amp.storage().mode, 'explicit')
    assert.equal(existsSync(join(workspace, '.deepseek-coordination', 'amp.sqlite')), false)
  } finally {
    host.dispose()
    rmSync(directory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
