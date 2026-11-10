import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, registerRoutes } from '../lib/index.mjs'

const PREFERENCES = 'preferences.json'

/** Minimal Cordis-like context exposing only the services this plugin touches. */
function fakeContext({ agents, sessions }) {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
      get: (name) => tools.get(name),
      definitions: () => [...tools.values()],
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      section: () => () => {},
      context: () => () => {},
    },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    sessions,
    agents,
    on: () => () => {},
    effect: (factory) => {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get: () => undefined,
    provide: () => () => {},
    inject: () => () => {},
  }
  return { ctx, tools, disposers }
}

function config() {
  return {
    tenantId: 'test',
    rootId: 'root',
    storage: 'workspace',
    storeDirectory: '.deepseek-coordination',
    notifications: true,
    prompt: true,
    skills: true,
    commands: true,
    routes: true,
    contextOptimization: true,
    maxJournal: 100,
    maxReadChars: 200_000,
    maxWriteChars: 1_000_000,
  }
}

function writePreferences(directory, takeoverNotifications) {
  mkdirSync(join(directory, '.deepseek-coordination'), { recursive: true })
  writeFileSync(
    join(directory, '.deepseek-coordination', PREFERENCES),
    JSON.stringify({ takeoverNotifications }),
  )
}

function fakeExec(sessionId, workspace) {
  return {
    callId: 'call-1',
    name: 'coordination_notification',
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: sessionId, session: { header: { cwd: workspace } } },
    rootCallId: 'call-1',
  }
}

/** A web server that refuses duplicate paths, like the real one. */
function fakeServer(throwOnDispose = new Set()) {
  const routes = new Map()
  return {
    routes,
    register({ path }) {
      if (routes.has(path)) throw new Error(`duplicate route ${path}`)
      routes.set(path, true)
      return () => {
        if (throwOnDispose.has(path)) throw new Error(`cannot release ${path}`)
        routes.delete(path)
      }
    },
  }
}

function routeDependencies(failures) {
  return {
    host: { recordRouteFailure: (path, error) => failures.push({ path, message: String(error?.message ?? error) }) },
    notifications: { drain: () => [] },
    dialogs: { checkPreferences: () => {} },
    version: '0.24.2',
  }
}

test('a workspace takeover switch applies when only the session registry knows the workspace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'amp-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'amp-workspace-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // The machine-wide store says off; the workspace settings say on.
    mkdirSync(join(home, 'storages', 'deepseek-coordination'), { recursive: true })
    writeFileSync(
      join(home, 'storages', 'deepseek-coordination', PREFERENCES),
      JSON.stringify({ takeoverNotifications: false }),
    )
    writePreferences(workspace, true)
    const { ctx, tools, disposers } = fakeContext({
      agents: { get() { throw new Error('agent is not live in this process') } },
      sessions: { get: (id) => (id === 'session-1' ? { header: { cwd: workspace } } : undefined) },
    })
    await apply(ctx, config())
    try {
      const notification = tools.get('coordination_notification')
      assert.ok(notification, 'the client notification tool is registered')
      const value = await notification.execute(
        { surface: 'snackbar', message: 'workspace switch applies' },
        fakeExec('session-1', workspace),
      )
      assert.equal(value.ok, true, JSON.stringify(value))
    } finally {
      for (const dispose of disposers) dispose()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('a duplicate route is recorded instead of silently dropping the new handler', () => {
  const server = fakeServer()
  const failures = []
  const first = registerRoutes(server, routeDependencies(failures))
  assert.ok(server.routes.has('/deepseek-coordination/ping'))
  assert.equal(failures.length, 0)

  // A stale instance still owns every path: the new registration must not
  // throw, and each collision must be recorded for diagnostics.
  assert.doesNotThrow(() => registerRoutes(server, routeDependencies(failures)))
  assert.equal(failures.length, server.routes.size)
  assert.match(failures[0].message, /duplicate route/)

  first()
  assert.equal(server.routes.size, 0)
})

test('route disposal releases the remaining paths when one disposer throws', () => {
  const server = fakeServer(new Set(['/deepseek-coordination/ping']))
  const failures = []
  const dispose = registerRoutes(server, routeDependencies(failures))
  assert.ok(server.routes.size > 1)
  assert.doesNotThrow(() => dispose())
  // The throwing route cannot release itself; every other route must be gone.
  assert.equal(server.routes.size, 1)
  assert.ok(server.routes.has('/deepseek-coordination/ping'))
})
