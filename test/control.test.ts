/**
 * Scoped control (AMP 0.5.0) and explicit knowledge marks.
 *
 * These tests pin the rules the agent tools, the HTTP routes and the panel all
 * depend on, against an in-memory coordination database and no DSH process:
 *
 *  - registry inheritance `global → workspace → session`, with a narrower scope
 *    overriding a wider one;
 *  - deletion markers, so removing an inherited entry cannot resurrect it;
 *  - CAS versions (`expectedVersion`) and `dryRun`, which must validate without
 *    writing;
 *  - interaction/scenario settings, including selector-vs-mix exclusivity and
 *    weighted-mix validation;
 *  - knowledge marks: explicit only, scoped, mirrored into the `knowledge`
 *    registry, and removable;
 *  - the route table's argument mapping and status codes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestHost } from './helpers.js'
import { ControlService } from '../src/host/control.js'
import { KnowledgeService } from '../src/host/knowledge.js'
import { handleControlRoute } from '../src/host/controlRoutes.js'
import { coordinationControlTools } from '../src/host/controlTools.js'
import { normaliseControlMix, type ControlRecordView } from '../src/shared/control.js'
import type { ManualClock } from '../src/host/handle.js'

const clock = { now: () => 1_700_000_000_000 }

function harness(): { control: ControlService; knowledge: KnowledgeService; close(): void } {
  const host = createTestHost()
  const control = new ControlService(host.db, clock)
  const knowledge = new KnowledgeService(host.db, clock, control)
  return {
    control,
    knowledge,
    close(): void {
      host.close()
    },
  }
}

const workspace = { workspace: 'C:\\ws', session: 'session-a' }

/* ------------------------------------------------------------------------- *
 * Registry
 * ------------------------------------------------------------------------- */

test('registry inheritance walks global to session and a narrower scope wins', () => {
  const h = harness()
  try {
    h.control.registry(
      { scope: 'global', registry: 'modules', action: 'register', id: 'module.search', value: { name: 'Search' } },
      workspace,
    )
    h.control.registry(
      { scope: 'workspace', registry: 'modules', action: 'update', id: 'module.search', value: { name: 'Search v2' } },
      workspace,
    )
    const global = h.control.getRecord('modules', 'module.search', 'global', workspace)
    const session = h.control.getRecord('modules', 'module.search', 'session', workspace)
    assert.equal(global?.value.name, 'Search')
    assert.equal(session?.value.name, 'Search v2')
    assert.equal(session?.source, 'workspace')
    assert.deepEqual(h.control.listRegistry('modules', 'session', workspace).map((entry) => entry.id), ['module.search'])
  } finally {
    h.close()
  }
})

test('removing an inherited entry leaves a tombstone instead of resurrecting the wider row', () => {
  const h = harness()
  try {
    h.control.registry(
      { scope: 'global', registry: 'skills', action: 'register', id: 'skill.a', value: { name: 'A' } },
      workspace,
    )
    assert.equal(h.control.getRecord('skills', 'skill.a', 'global', workspace)?.id, 'skill.a')
    h.control.registry({ scope: 'workspace', registry: 'skills', action: 'remove', id: 'skill.a' }, workspace)
    assert.equal(h.control.getRecord('skills', 'skill.a', 'workspace', workspace), undefined)
    // Global still holds it; only the narrower scope hides it.
    assert.equal(h.control.getRecord('skills', 'skill.a', 'global', workspace)?.id, 'skill.a')
  } finally {
    h.close()
  }
})

test('CAS versions reject a stale write and dryRun validates without writing', () => {
  const h = harness()
  try {
    const first = h.control.registry(
      { scope: 'global', registry: 'concepts', action: 'register', id: 'concept.x', value: { name: 'X' } },
      workspace,
    )
    assert.equal((first as { version: number }).version, 1)
    const preview = h.control.registry(
      {
        scope: 'global', registry: 'concepts', action: 'update', id: 'concept.x',
        value: { name: 'X2' }, expectedVersion: 1, dryRun: true,
      },
      workspace,
    )
    assert.equal((preview as { dryRun: boolean }).dryRun, true)
    assert.equal((preview as { version: number }).version, 2)
    assert.equal(h.control.getRecord('concepts', 'concept.x', 'global', workspace)?.value.name, 'X')
    assert.throws(
      () => h.control.registry(
        { scope: 'global', registry: 'concepts', action: 'update', id: 'concept.x', value: { name: 'X3' }, expectedVersion: 0 },
        workspace,
      ),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE',
    )
    h.control.registry(
      { scope: 'global', registry: 'concepts', action: 'update', id: 'concept.x', value: { name: 'X2' }, expectedVersion: 1 },
      workspace,
    )
    assert.equal(h.control.getRecord('concepts', 'concept.x', 'global', workspace)?.value.name, 'X2')
  } finally {
    h.close()
  }
})

test('registry values must be JSON objects and unknown ids are NOT_FOUND', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.control.registry(
        { scope: 'global', registry: 'modules', action: 'register', id: 'module.a', value: 'text' },
        workspace,
      ),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    )
    assert.equal(h.control.getRecord('modules', 'missing', 'global', workspace), undefined)
    assert.throws(
      () => h.control.registry({ scope: 'global', registry: 'modules', action: 'get', id: 'missing' }, workspace),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    )
  } finally {
    h.close()
  }
})

test('links are stored per registry and removed by unlink', () => {
  const h = harness()
  try {
    for (const id of ['module.a', 'module.b']) {
      h.control.registry(
        { scope: 'global', registry: 'modules', action: 'register', id, value: { name: id } },
        workspace,
      )
    }
    h.control.registry(
      { scope: 'global', registry: 'modules', action: 'link', id: 'module.a', targetId: 'module.b', relation: 'uses' },
      workspace,
    )
    assert.deepEqual(h.control.links('modules', 'module.a', 'global', workspace).map((link) => [link.targetId, link.relation]), [['module.b', 'uses']])
    h.control.registry(
      { scope: 'global', registry: 'modules', action: 'unlink', id: 'module.a', targetId: 'module.b', relation: 'uses' },
      workspace,
    )
    assert.deepEqual(h.control.links('modules', 'module.a', 'global', workspace), [])
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Settings
 * ------------------------------------------------------------------------- */

test('interaction and scenario settings inherit and reset restores the wider value', () => {
  const h = harness()
  try {
    h.control.setSetting({ scope: 'global', domain: 'interaction', action: 'set', selector: 'think' }, workspace)
    h.control.setSetting({ scope: 'workspace', domain: 'interaction', action: 'set', selector: 'converge' }, workspace)
    assert.equal(h.control.getSetting('interaction', 'workspace', workspace).value, 'converge')
    assert.equal(h.control.getSetting('interaction', 'session', workspace).value, 'converge')
    h.control.resetSetting({ scope: 'workspace', domain: 'interaction', action: 'reset' }, workspace)
    assert.equal(h.control.getSetting('interaction', 'session', workspace).value, 'think')
    assert.equal(h.control.getSetting('interaction', 'session', workspace).source, 'global')
  } finally {
    h.close()
  }
})

test('a setting accepts a selector or a mix, never both, and validates weights', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.control.setSetting(
        { scope: 'global', domain: 'scenario', action: 'set', selector: 'research', mix: { research: 1 } },
        workspace,
      ),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    )
    assert.throws(
      () => h.control.setSetting(
        { scope: 'global', domain: 'scenario', action: 'set', mix: { research: 0 } },
        workspace,
      ),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    )
    assert.equal(normaliseControlMix('scenario', { research: 0.7, engineering: 0.3 })?.['research'], 0.7)
    assert.equal(normaliseControlMix('scenario', { unknown: 1 }), undefined)
    const result = h.control.setSetting(
      { scope: 'global', domain: 'scenario', action: 'set', mix: { research: 0.7, engineering: 0.3 } },
      workspace,
    )
    assert.equal(result.changed, 1)
    const view = h.control.getSetting('scenario', 'global', workspace)
    assert.equal(view.mix?.['engineering'], 0.3)
    assert.equal(view.value, null)
  } finally {
    h.close()
  }
})

test('a session setting rejects applyTo and a stale expectedVersion', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.control.setSetting(
        { scope: 'session', domain: 'interaction', action: 'set', selector: 'think', applyTo: 'all' },
        workspace,
      ),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    )
    h.control.setSetting({ scope: 'global', domain: 'interaction', action: 'set', selector: 'think' }, workspace)
    assert.throws(
      () => h.control.setSetting(
        { scope: 'global', domain: 'interaction', action: 'set', selector: 'affect', expectedVersion: 99 },
        workspace,
      ),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_STATE',
    )
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Knowledge
 * ------------------------------------------------------------------------- */

test('marking a file makes it knowledge and mirrors the registry record', () => {
  const h = harness()
  try {
    const entry = h.knowledge.mark('docs/spec.md', { title: 'Spec', note: 'the contract', tags: ['spec', 'spec'] }, workspace)
    assert.equal(entry.path, 'docs/spec.md')
    assert.equal(entry.title, 'Spec')
    assert.deepEqual(entry.tags, ['spec'])
    assert.equal(h.knowledge.has('docs/spec.md', workspace), true)
    assert.deepEqual(h.knowledge.brief(workspace), ['docs/spec.md — Spec'])
    const record = h.control.getRecord('knowledge', 'docs/spec.md', 'workspace', workspace)
    assert.equal(record?.value.title, 'Spec')
    assert.equal(record?.value.kind, 'file')
  } finally {
    h.close()
  }
})

test('marking twice updates instead of duplicating and unmark removes both surfaces', () => {
  const h = harness()
  try {
    h.knowledge.mark('docs/spec.md', { title: 'Spec' }, workspace)
    h.knowledge.mark('docs/spec.md', { note: 'updated note' }, workspace)
    assert.equal(h.knowledge.list(workspace).length, 1)
    assert.equal(h.knowledge.list(workspace)[0]?.note, 'updated note')
    h.knowledge.unmark('docs/spec.md', workspace)
    assert.deepEqual(h.knowledge.list(workspace), [])
    assert.equal(h.control.getRecord('knowledge', 'docs/spec.md', 'workspace', workspace), undefined)
  } finally {
    h.close()
  }
})

test('session marks stay private to that session', () => {
  const h = harness()
  try {
    h.knowledge.mark('notes/private.md', { title: 'Private' }, { workspace: 'C:\\ws', session: 'session-a' }, 'session')
    assert.equal(h.knowledge.get('notes/private.md', { workspace: 'C:\\ws', session: 'session-a' })?.title, 'Private')
    assert.equal(h.knowledge.get('notes/private.md', { workspace: 'C:\\ws', session: 'session-b' }), undefined)
  } finally {
    h.close()
  }
})

test('tags must be an array of strings and an unknown path is NOT_FOUND', () => {
  const h = harness()
  try {
    assert.throws(
      () => h.knowledge.mark('docs/spec.md', { tags: 'spec' }, workspace),
      (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    )
    assert.throws(
      () => h.knowledge.unmark('docs/missing.md', workspace),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    )
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Routes
 * ------------------------------------------------------------------------- */

const routeRequest = (
  path: string,
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
): Parameters<typeof handleControlRoute>[0] => ({
  path,
  method,
  url: new URL(`http://host${path}${Object.keys(query).length === 0 ? '' : `?${new URLSearchParams(query).toString()}`}`),
  session: 'session-a',
  workspace: 'C:\\ws',
  ...(body === undefined ? {} : { body }),
})

test('the control routes map arguments and statuses onto the service', () => {
  const h = harness()
  try {
    const listEmpty = handleControlRoute(routeRequest('/control/registry', 'GET', { registry: 'modules' }), h)
    assert.equal(listEmpty?.status, 200)
    assert.deepEqual((listEmpty?.body as { value: { records: unknown[] } }).value.records, [])

    const registered = handleControlRoute(
      routeRequest('/control/registry', 'POST', {}, {
        scope: 'global', registry: 'modules', action: 'register', id: 'module.a', value: { name: 'A' },
      }),
      h,
    )
    assert.equal(registered?.status, 200)
    assert.equal((registered?.body as { value: { version: number } }).value.version, 1)

    const missing = handleControlRoute(
      routeRequest('/control/registry', 'POST', {}, {
        scope: 'global', registry: 'modules', action: 'get', id: 'module.missing',
      }),
      h,
    )
    assert.equal(missing?.status, 404)

    const conflict = handleControlRoute(
      routeRequest('/control/registry', 'POST', {}, {
        scope: 'global', registry: 'modules', action: 'update', id: 'module.a',
        value: { name: 'B' }, expectedVersion: 0,
      }),
      h,
    )
    assert.equal(conflict?.status, 409)

    const setting = handleControlRoute(
      routeRequest('/control/settings', 'POST', {}, {
        scope: 'global', domain: 'interaction', action: 'set', selector: 'think',
      }),
      h,
    )
    assert.equal(setting?.status, 200)
    const read = handleControlRoute(routeRequest('/control/settings', 'GET', { domain: 'interaction' }), h)
    assert.equal((read?.body as { value: { value: string } }).value.value, 'think')

    const unknown = handleControlRoute(routeRequest('/control/nothing', 'GET'), h)
    assert.equal(unknown, undefined)
  } finally {
    h.close()
  }
})

test('the knowledge routes list, mark and unmark with an indexed flag', () => {
  const h = harness()
  try {
    const marked = handleControlRoute(
      {
        ...routeRequest('/graph/knowledge', 'POST', {}, { path: 'docs/spec.md', title: 'Spec' }),
        isIndexed: (candidate: string) => candidate === 'docs/spec.md',
      },
      h,
    )
    assert.equal(marked?.status, 200)
    const listed = handleControlRoute(
      {
        ...routeRequest('/graph/knowledge', 'GET'),
        isIndexed: (candidate: string) => candidate === 'docs/spec.md',
      },
      h,
    )
    const entries = (listed?.body as { value: { entries: Array<{ path: string; indexed: boolean }> } }).value.entries
    assert.deepEqual(entries.map((entry) => [entry.path, entry.indexed]), [['docs/spec.md', true]])

    const removed = handleControlRoute(
      routeRequest('/graph/knowledge', 'POST', {}, { action: 'unmark', path: 'docs/spec.md' }),
      h,
    )
    assert.equal(removed?.status, 200)
    const after = handleControlRoute(
      { ...routeRequest('/graph/knowledge', 'GET'), isIndexed: () => false },
      h,
    )
    assert.deepEqual((after?.body as { value: { entries: unknown[] } }).value.entries, [])
  } finally {
    h.close()
  }
})

test('route failures stay typed: unknown scope, bad body and missing identity', () => {
  const h = harness()
  try {
    const badScope = handleControlRoute(routeRequest('/control/registry', 'GET', { scope: 'planet' }), h)
    assert.equal(badScope?.status, 400)
    const badBody = handleControlRoute(routeRequest('/control/registry', 'POST', {}, { action: 'list' }), h)
    assert.equal(badBody?.status, 400)
    const noWorkspace = handleControlRoute(
      { ...routeRequest('/control/registry', 'POST', {}, { scope: 'workspace', registry: 'modules', action: 'list' }), workspace: '' },
      h,
    )
    assert.equal(noWorkspace?.status, 400)
  } finally {
    h.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Agent tools
 * ------------------------------------------------------------------------- */

test('both agent tools call the same service methods as the routes', async () => {
  const h = harness()
  try {
    const service = {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      control: h.control,
      knowledge: h.knowledge,
    } as unknown as Parameters<typeof coordinationControlTools>[0]
    const tools = coordinationControlTools(service)
    const exec = { agent: { id: 'session-a' } }
    const byName = new Map(tools.map((tool) => [tool.name, tool]))

    const register = await byName.get('coordination_control')!.execute({
      scope: 'global', registry: 'modules', action: 'register', id: 'module.a', value: { name: 'A' },
    }, exec) as { version: number }
    assert.equal(register.version, 1, JSON.stringify(register))

    // `list` now returns an object envelope (`{ ok, action, scope, registry,
    // records }`) because DSH rejects a bare array as the tool value.
    const listed = await byName.get('coordination_control')!.execute({
      scope: 'global', registry: 'modules', action: 'list',
    }, exec) as { records: Array<{ id: string }> }
    assert.deepEqual(listed.records.map((record) => record.id), ['module.a'])

    const setting = await byName.get('coordination_control')!.execute({
      scope: 'global', domain: 'scenario', action: 'set', selector: 'research',
    }, exec) as { changed: number }
    assert.equal(setting.changed, 1)

    const marked = await byName.get('coordination_knowledge')!.execute({
      action: 'mark', path: 'docs/spec.md', title: 'Spec',
    }, exec) as { entry: { path: string; title: string } }
    assert.equal(marked.entry.title, 'Spec')
    assert.equal(h.knowledge.has('docs/spec.md', { workspace: process.cwd(), session: 'session-a' }), true)

    const read = await byName.get('coordination_knowledge')!.execute({ action: 'list' }, exec) as {
      entries: Array<{ path: string }>
    }
    assert.deepEqual(read.entries.map((entry) => entry.path), ['docs/spec.md'])

    // The tool returns the typed failure instead of throwing.
    const failed = await byName.get('coordination_control')!.execute({
      scope: 'global', registry: 'modules', action: 'get', id: 'missing',
    }, exec) as { error: { code: string } }
    assert.equal(failed.error.code, 'NOT_FOUND')
  } finally {
    h.close()
  }
})

test('the environment tool registers, reads, updates, toggles and removes one entry', async () => {
  const h = harness()
  try {
    const service = {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      control: h.control,
      knowledge: h.knowledge,
    } as unknown as Parameters<typeof coordinationControlTools>[0]
    const environment = coordinationControlTools(service)
      .find((candidate) => candidate.name === 'coordination_environment')
    assert.ok(environment !== undefined, 'coordination_environment is registered')
    const exec = { agent: { id: 'session-a' } }
    const identity = { workspace: process.cwd(), session: 'session-a' }
    const variables = { NODE_ENV: 'development', API_URL: 'http://localhost:3000' }

    const registered = await environment.execute({
      action: 'set',
      id: 'env.local',
      name: 'Local',
      description: 'Local development',
      variables,
    }, exec) as { ok: boolean; action: string; version: number; registry: string }
    assert.equal(registered.ok, true)
    assert.equal(registered.action, 'register')
    assert.equal(registered.registry, 'environments')
    assert.equal(registered.version, 1)

    const read = await environment.execute({ action: 'get', id: 'env.local' }, exec) as ControlRecordView
    assert.equal(read.value.name, 'Local')
    assert.deepEqual(read.value.variables, variables)
    assert.equal(read.enabled, true)

    // `set` on an existing id updates it and keeps the fields it did not send.
    const updated = await environment.execute({
      action: 'set',
      id: 'env.local',
      description: 'Updated',
    }, exec) as { action: string; version: number }
    assert.equal(updated.action, 'update')
    assert.equal(updated.version, 2)
    assert.equal(h.control.getRecord('environments', 'env.local', 'workspace', identity)?.value.name, 'Local')
    assert.deepEqual(h.control.getRecord('environments', 'env.local', 'workspace', identity)?.value.variables, variables)

    await environment.execute({ action: 'disable', id: 'env.local' }, exec)
    const disabled = await environment.execute({ action: 'list' }, exec) as { records: ControlRecordView[] }
    assert.deepEqual(disabled.records.map((record) => [record.id, record.enabled]), [['env.local', false]])

    await environment.execute({ action: 'enable', id: 'env.local' }, exec)
    const enabled = await environment.execute({ action: 'list' }, exec) as { records: ControlRecordView[] }
    assert.deepEqual(enabled.records.map((record) => [record.id, record.enabled]), [['env.local', true]])

    const removed = await environment.execute({ action: 'remove', id: 'env.local' }, exec) as {
      ok: boolean; changed: number
    }
    assert.equal(removed.ok, true)
    assert.equal(removed.changed, 1)
    const gone = await environment.execute({ action: 'get', id: 'env.local' }, exec) as { error: { code: string } }
    assert.equal(gone.error.code, 'NOT_FOUND')
    assert.equal(h.control.getRecord('environments', 'env.local', 'workspace', identity), undefined)
  } finally {
    h.close()
  }
})

test('the environment tool seeds env.local on the first list and refresh keeps edits', async () => {
  const h = harness()
  try {
    const service = {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      control: h.control,
      knowledge: h.knowledge,
    } as unknown as Parameters<typeof coordinationControlTools>[0]
    const environment = coordinationControlTools(service)
      .find((candidate) => candidate.name === 'coordination_environment')
    assert.ok(environment !== undefined, 'coordination_environment is registered')
    const exec = { agent: { id: 'session-a' } }

    const first = await environment.execute({ action: 'list' }, exec) as { records: ControlRecordView[] }
    assert.deepEqual(first.records.map((record) => record.id), ['env.local'])
    const variables = first.records[0]?.value.variables as Record<string, string>
    assert.equal(variables['project.root'], process.cwd())
    assert.equal(typeof variables.path, 'string')

    const second = await environment.execute({ action: 'list' }, exec) as { records: ControlRecordView[] }
    assert.equal(second.records.length, 1, 'a second list must not duplicate the seed')

    // Edit one discovered value, then refresh: the edit survives, drift follows.
    await environment.execute({
      action: 'set',
      id: 'env.local',
      variables: { ...variables, platform: 'edited-platform' },
    }, exec)
    const refreshed = await environment.execute({ action: 'refresh' }, exec) as {
      ok: boolean; kept: number; added: number; updated: number
    }
    assert.equal(refreshed.ok, true)
    assert.ok(refreshed.kept >= 1, 'the edited value counts as kept')
    const after = await environment.execute({ action: 'get', id: 'env.local' }, exec) as ControlRecordView
    assert.equal((after.value.variables as Record<string, string>).platform, 'edited-platform')
    assert.equal(typeof (after.value as { discovered?: unknown }).discovered, 'object')
  } finally {
    h.close()
  }
})

test('the environment tool returns typed failures for missing ids and unknown entries', async () => {
  const h = harness()
  try {
    const service = {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      control: h.control,
      knowledge: h.knowledge,
    } as unknown as Parameters<typeof coordinationControlTools>[0]
    const environment = coordinationControlTools(service)
      .find((candidate) => candidate.name === 'coordination_environment')
    assert.ok(environment !== undefined, 'coordination_environment is registered')
    const exec = { agent: { id: 'session-a' } }
    const identity = { workspace: process.cwd(), session: 'session-a' }

    const missingId = await environment.execute({ action: 'set', name: 'No id' }, exec) as {
      error: { code: string }
    }
    assert.equal(missingId.error.code, 'INVALID_ARGUMENT')

    for (const action of ['get', 'remove', 'enable', 'disable'] as const) {
      const missing = await environment.execute({ action, id: 'env.missing' }, exec) as {
        error: { code: string }
      }
      assert.equal(missing.error.code, 'NOT_FOUND', `${action} on an unknown id is NOT_FOUND`)
    }

    const badVariables = await environment.execute({
      action: 'set',
      id: 'env.bad',
      variables: { PORT: 3000 },
    }, exec) as { error: { code: string } }
    assert.equal(badVariables.error.code, 'INVALID_ARGUMENT')

    const badAction = await environment.execute({ action: 'register', id: 'env.bad' }, exec) as {
      error: { code: string }
    }
    assert.equal(badAction.error.code, 'INVALID_ARGUMENT')

    // Refused calls never leave a partial row behind.
    assert.equal(h.control.getRecord('environments', 'env.bad', 'workspace', identity), undefined)
  } finally {
    h.close()
  }
})

test('the control tool wraps list results in an object envelope', async () => {
  const h = harness()
  try {
    const service = {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      control: h.control,
      knowledge: h.knowledge,
    } as unknown as Parameters<typeof coordinationControlTools>[0]
    const tools = coordinationControlTools(service)
    const control = tools.find((tool) => tool.name === 'coordination_control')!
    const exec = { agent: { id: 'session-a' } }
    // Register one row so the listing is not trivially empty.
    await control.execute({
      scope: 'workspace', registry: 'tools', action: 'register', id: 'tool.search', value: { name: 'search' },
    }, exec)
    const listed = await control.execute({ scope: 'workspace', registry: 'tools', action: 'list' }, exec) as {
      ok?: boolean
      records?: Array<{ id: string }>
    }
    // A bare array is what DSH rejected with `"value" must be an object`.
    assert.equal(Array.isArray(listed), false)
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.records?.map((row) => row.id), ['tool.search'])
  } finally {
    h.close()
  }
})
test('the workspace adjust tool pins the scope and treats environments as a registry', async () => {
  const h = harness()
  try {
    const service = {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      control: h.control,
      knowledge: h.knowledge,
    } as unknown as Parameters<typeof coordinationControlTools>[0]
    const adjust = coordinationControlTools(service)
      .find((tool) => tool.name === 'coordination_workspace_adjust')!
    assert.ok(adjust, 'the workspace adjust tool is registered')
    const exec = { agent: { id: 'session-a' } }

    // `scope: 'global'` is ignored on purpose: this tool can only write the workspace.
    await adjust.execute({
      registry: 'environments',
      action: 'register',
      id: 'env.local',
      value: { name: 'Local', variables: { MODE: 'dev' } },
      scope: 'global',
    }, exec)
    const record = h.control.getRecord('environments', 'env.local', 'workspace', {
      workspace: process.cwd(), session: 'session-a',
    })
    assert.equal(record?.scope, 'workspace')
    const variables = record?.value.variables as Record<string, string> | undefined
    assert.equal(variables?.MODE, 'dev')
    assert.equal(h.control.getRecord('environments', 'env.local', 'global', {
      workspace: process.cwd(), session: 'session-a',
    }), undefined)

    const listed = await adjust.execute({ registry: 'environments', action: 'list' }, exec) as {
      ok: boolean
      records: Array<{ id: string; enabled: boolean }>
    }
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.records.map((row) => row.id), ['env.local'])

    // enable/disable are registry actions here too.
    await adjust.execute({ registry: 'environments', action: 'disable', id: 'env.local' }, exec)
    const disabled = h.control.getRecord('environments', 'env.local', 'workspace', {
      workspace: process.cwd(), session: 'session-a',
    })
    assert.equal(disabled?.enabled, false)

    await adjust.execute({ registry: 'environments', action: 'remove', id: 'env.local' }, exec)
    const after = await adjust.execute({ registry: 'environments', action: 'list' }, exec) as { records: unknown[] }
    assert.deepEqual(after.records, [])
  } finally {
    h.close()
  }
})
/** Keep the unused-import lint honest: the clock fixture type is shared. */
export type _ClockFixture = ManualClock
