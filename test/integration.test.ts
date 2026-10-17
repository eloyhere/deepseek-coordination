/**
 * Host-side integration tests for the v24 follow-ups: the selection config
 * projection, the profession rebuild/abandon routes, the model-facing tools,
 * the config forcing rules and the locale-aware tool registration.
 *
 * Everything here composes real modules over the shared in-memory fixture from
 * `test/helpers.ts`; no Cordis context and no HTTP server is involved. The route
 * bodies (`rebuildProfession` / `abandonProfession`) are exported from
 * `src/host/selection.ts` for exactly this reason: they are the units the HTTP
 * handler and the tests share.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestHost, insertSession, insertTurn } from './helpers.js'
import { resolveConfig } from '../src/host/config.js'
import { ProfessionModule } from '../src/host/profession.js'
import {
  SelectionModule,
  abandonProfession,
  rebuildProfession,
} from '../src/host/selection.js'
import {
  coordinationToolDefinitions,
  registerCoordinationTools,
} from '../src/host/tools.js'
import type {
  CoordinationToolDefinition,
  CoordinationToolRegistry,
  CoordinationToolService,
  ProfessionLockToolValue,
  ProfessionToolValue,
} from '../src/host/tools.js'
import type { SelectionState } from '../src/shared/selection.js'
import {
  InvalidArgumentError,
  InvalidStateError,
  ProfessionLockedError,
} from '../src/shared/error.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Fixture = ReturnType<typeof buildModules>

function buildModules(options: Parameters<typeof createTestHost>[0] = {}) {
  const fixture = createTestHost(options)
  const selection = new SelectionModule(fixture.host)
  const profession = new ProfessionModule(fixture.host)
  return {
    ...fixture,
    selection,
    profession,
    deps: { selection, profession },
  }
}

/** The narrow service surface the tools call, composed from the real modules. */
function toolService(fixture: Fixture, locale = 'zh-CN'): CoordinationToolService {
  return {
    get locale(): string {
      return locale
    },
    state: (session) => fixture.selection.state(session),
    setSelection: (session, patch) => fixture.selection.set(session, patch),
    activeTurn: (session) => fixture.selection.activeTurn(session),
    getProfessionRecord: (turn) => fixture.profession.getProfessionRecord(turn),
    turnByOrdinal: (session, ordinal) => fixture.selection.turnByOrdinal(session, ordinal),
  }
}

function toolOf(definitions: readonly CoordinationToolDefinition[], name: string): CoordinationToolDefinition {
  const definition = definitions.find((entry) => entry.name === name)
  if (definition === undefined) throw new Error(`tool ${name} was not defined`)
  return definition
}

/** Minimal registry double: it records definitions and honours its disposers. */
class MemoryRegistry implements CoordinationToolRegistry {
  readonly definitions = new Map<string, CoordinationToolDefinition>()

  register(definition: CoordinationToolDefinition): () => void {
    this.definitions.set(definition.name, definition)
    return () => {
      if (this.definitions.get(definition.name) === definition) this.definitions.delete(definition.name)
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Selection config projection
 * ------------------------------------------------------------------------- */

test('state() projects the resolved config and keeps the old wire fields', () => {
  const fixture = buildModules({
    config: {
      databasePath: 'C:\\deployment\\coordination-secret.db',
      profession: {
        enabled: false,
        lock: false,
        default: 'execution',
        rebuildCanReselect: true,
        abandonCanReselect: true,
        audit: false,
        errorHint: false,
      },
      ui: {
        toolbar: false,
        showTooltip: false,
        takeover: true,
        refreshInterval: 7000,
        compact: false,
        locale: 'en-US',
      },
      cache: { enabled: false, ttl: 60000, fingerprintWindow: 50, effortWarning: true },
      comprehension: { stageTimeout: 30000, searchEnabled: false, maxEvidence: 8, highHistoryWindow: 50 },
      defaults: {
        profession: 'decision',
        interaction: 'converge',
        scene: 'research',
        validation: 'high',
        command: 'none',
      },
    },
  })
  try {
    const state = fixture.selection.state('config-session')

    // The pre-v24 fields stay intact, so an older client keeps rendering.
    assert.equal(state.session, 'config-session')
    assert.equal(state.locked, false)
    assert.deepEqual(state.presets, [])
    assert.equal(state.tooltip, false)

    assert.deepEqual(state.config, {
      defaultProfession: 'decision',
      defaultInteraction: 'converge',
      defaultScene: 'research',
      defaultValidation: 'high',
      showTooltip: false,
      takeover: true,
      workflow: false,
      locale: 'en-US',
      refreshInterval: 7000,
      cacheEnabled: false,
      searchEnabled: false,
      audit: false,
      errorHint: false,
      rebuildCanReselect: true,
      abandonCanReselect: true,
      compaction: {
        auto: true,
        soft: 0.7,
        hard: 0.88,
        reserve: 2048,
        recentTurns: 6,
        cooldown: 30000,
        maxPerSession: 20,
      },
    })

    // The projection is config-only: deployment paths and credentials never leak.
    const wire = JSON.stringify(state)
    assert.equal(wire.includes('coordination-secret.db'), false)
    assert.equal(wire.includes('databasePath'), false)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Profession rebuild / abandon
 * ------------------------------------------------------------------------- */

test('rebuildProfession creates a new locked task and moves the selection', () => {
  const fixture = buildModules()
  try {
    const handle = 'session-rebuild'
    const session = insertSession(fixture.db, handle)
    const before = fixture.selection.set(handle, { profession: 'execution' })
    assert.equal(before.locked, false)
    const oldTurn = insertTurn(fixture.db, session, { profession: 'execution', status: 'running' })

    const state = rebuildProfession(fixture.deps, handle, 'decision')

    assert.equal(state.locked, true)
    assert.equal(state.selection.profession, 'decision')
    assert.equal(state.turn?.profession, 'decision')
    assert.notEqual(state.turn?.identity, oldTurn)

    const newTurn = state.turn!.identity
    const oldRow = fixture.db.get<{ status: string }>('SELECT status FROM turn WHERE identity = ?', oldTurn)
    assert.equal(oldRow?.status, 'abandoned')
    const newRow = fixture.db.get<{ status: string; profession: string; locked: number; rebuild: number; ordinal: number }>(
      'SELECT status, profession, locked, rebuild, ordinal FROM turn WHERE identity = ?',
      newTurn,
    )
    assert.equal(newRow?.status, 'pending')
    assert.equal(newRow?.profession, 'decision')
    assert.equal(newRow?.locked, 1)
    assert.equal(newRow?.rebuild, 1)
    assert.equal(newRow?.ordinal, 2)

    const stored = fixture.db.get<{ profession: string }>(
      'SELECT profession FROM selection WHERE session = ?',
      handle,
    )
    assert.equal(stored?.profession, 'decision')

    // The governance trail names both the rebuild and the new task's lock.
    assert.deepEqual(fixture.host.trace.list(oldTurn).map((event) => event.event), ['rebuild'])
    assert.deepEqual(fixture.host.trace.list(newTurn).map((event) => event.event), ['lock'])
    assert.equal(fixture.host.trace.verify(oldTurn).ok, true)
    assert.equal(fixture.host.trace.verify(newTurn).ok, true)

    // The new task is locked too: the profession cannot be patched directly.
    assert.throws(
      () => fixture.selection.set(handle, { profession: 'outcome' }),
      (error: unknown) => error instanceof ProfessionLockedError && error.code === 'PROFESSION_LOCKED',
    )
    assert.equal(fixture.selection.state(handle).selection.profession, 'decision')
  } finally {
    fixture.close()
  }
})

test('abandonProfession closes the task and unlocks the next choice', () => {
  const fixture = buildModules()
  try {
    const handle = 'session-abandon'
    const session = insertSession(fixture.db, handle)
    fixture.selection.set(handle, { profession: 'outcome' })
    const turn = insertTurn(fixture.db, session, { profession: 'outcome', status: 'running' })

    const state = abandonProfession(fixture.deps, handle)

    assert.equal(state.locked, false)
    assert.equal(state.turn, undefined)
    assert.equal(state.selection.profession, 'outcome')

    const row = fixture.db.get<{ status: string }>('SELECT status FROM turn WHERE identity = ?', turn)
    assert.equal(row?.status, 'abandoned')
    assert.deepEqual(fixture.host.trace.list(turn).map((event) => event.event), ['abandon'])
    assert.equal(fixture.host.trace.verify(turn).ok, true)

    // Abandon does not create a replacement, so the selection is writable again.
    const next = fixture.selection.set(handle, { profession: 'decision' })
    assert.equal(next.locked, false)
    assert.equal(next.selection.profession, 'decision')
    assert.equal(fixture.selection.state(handle).locked, false)
  } finally {
    fixture.close()
  }
})

test('profession routes fail closed without an active turn or with a bad argument', () => {
  const fixture = buildModules()
  try {
    const handle = 'session-idle'
    insertSession(fixture.db, handle)

    for (const action of [
      () => rebuildProfession(fixture.deps, handle, 'decision'),
      () => abandonProfession(fixture.deps, handle),
    ]) {
      assert.throws(
        action,
        (error: unknown) =>
          error instanceof InvalidStateError &&
          error.code === 'INVALID_STATE' &&
          /no active turn/.test(error.message),
      )
    }

    assert.throws(
      () => rebuildProfession(fixture.deps, handle, 'wizard' as never),
      (error: unknown) => error instanceof InvalidArgumentError,
    )
    assert.throws(
      () => abandonProfession(fixture.deps, ''),
      (error: unknown) => error instanceof InvalidArgumentError,
    )
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Config hygiene
 * ------------------------------------------------------------------------- */

test('resolveConfig forces the lock/reselect switches and aliases profession.default', () => {
  const resolved = resolveConfig({
    profession: {
      enabled: false,
      lock: false,
      default: 'decision',
      rebuildCanReselect: false,
      abandonCanReselect: false,
      audit: true,
      errorHint: false,
    },
    defaults: {
      profession: 'outcome',
      interaction: 'think',
      scene: 'dialogue',
      validation: 'medium',
      command: 'none',
    },
  })

  assert.equal(resolved.profession.lock, true)
  assert.equal(resolved.profession.enabled, true)
  assert.equal(resolved.profession.rebuildCanReselect, true)
  assert.equal(resolved.profession.abandonCanReselect, true)
  // defaults.profession is authoritative; the documented alias mirrors it.
  assert.equal(resolved.defaults.profession, 'outcome')
  assert.equal(resolved.profession.default, 'outcome')
})

/* ------------------------------------------------------------------------- *
 * Tool definitions
 * ------------------------------------------------------------------------- */

test('tool definitions have the registry shape and render a text block', () => {
  const fixture = buildModules()
  try {
    const service = toolService(fixture)
    const definitions = coordinationToolDefinitions(service, 'zh-CN')
    assert.deepEqual(
      definitions.map((definition) => definition.name).sort(),
      ['coordination_profession', 'coordination_professionlock', 'coordination_selection'],
    )

    const handle = 'session-tool-shape'
    insertSession(fixture.db, handle)
    const state = fixture.selection.state(handle)
    const samples: Record<string, unknown> = {
      coordination_profession: { session: handle, ok: true, locked: false, selection: state.selection },
      coordination_professionlock: { locked: false },
      coordination_selection: state,
    }

    for (const definition of definitions) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 0, `${definition.name} needs a description`)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(typeof definition.parameters.properties, 'object')
      assert.equal(definition.output.schema.type, 'object')
      assert.equal(typeof definition.output.render, 'function')

      const blocks = definition.output.render({}, samples[definition.name])
      assert.equal(blocks.length, 1)
      assert.equal(blocks[0]?.type, 'text')
      assert.equal(typeof blocks[0]?.text, 'string')
      assert.ok((blocks[0]?.text ?? '').length > 0)
    }
  } finally {
    fixture.close()
  }
})

test('locale switch disposes and re-registers the tools with new copy', () => {
  const fixture = buildModules()
  try {
    const service = toolService(fixture)
    const registry = new MemoryRegistry()

    const disposeZh = registerCoordinationTools(registry, service, 'zh-CN')
    assert.equal(registry.definitions.size, 3)
    const zh = toolOf([...registry.definitions.values()], 'coordination_profession')
    assert.match(zh.description, /职能/)

    disposeZh()
    assert.equal(registry.definitions.size, 0)

    const disposeEn = registerCoordinationTools(registry, service, 'en-US')
    const en = toolOf([...registry.definitions.values()], 'coordination_profession')
    assert.notEqual(en.description, zh.description)
    assert.match(en.description, /profession/i)

    disposeEn()
    assert.equal(registry.definitions.size, 0)
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Tool behaviour
 * ------------------------------------------------------------------------- */

test('profession tool fails closed while locked and sets the selection once unlocked', async () => {
  const fixture = buildModules()
  try {
    const handle = 'session-profession-tool'
    const session = insertSession(fixture.db, handle)
    fixture.selection.set(handle, { profession: 'execution' })
    insertTurn(fixture.db, session, { profession: 'execution', status: 'running' })

    const service = toolService(fixture)
    const tool = toolOf(coordinationToolDefinitions(service, 'zh-CN'), 'coordination_profession')
    assert.equal(tool.name, 'coordination_profession')

    // The agent id is the DSH session id; no explicit `session` argument needed.
    const locked = (await tool.execute({ profession: 'decision' }, { agent: { id: handle } })) as ProfessionToolValue
    assert.equal(locked.ok, false)
    assert.equal(locked.locked, true)
    assert.equal(locked.error?.code, 'PROFESSION_LOCKED')
    assert.match(tool.output.render({}, locked)[0]!.text, /PROFESSION_LOCKED/)
    assert.equal(fixture.selection.state(handle).selection.profession, 'execution')

    const read = (await tool.execute({}, { agent: { id: handle } })) as ProfessionToolValue
    assert.equal(read.ok, true)
    assert.equal(read.session, handle)
    assert.equal(read.selection.profession, 'execution')
    assert.equal(read.record?.profession, 'execution')
    assert.equal(read.record?.locked, true)

    // Once the task is abandoned there is no lock, so the tool may set it.
    abandonProfession(fixture.deps, handle)
    const written = (await tool.execute({ profession: 'decision' }, { agent: { id: handle } })) as ProfessionToolValue
    assert.equal(written.ok, true)
    assert.equal(written.locked, false)
    assert.equal(written.selection.profession, 'decision')
    assert.equal(
      fixture.db.get<{ profession: string }>('SELECT profession FROM selection WHERE session = ?', handle)?.profession,
      'decision',
    )
  } finally {
    fixture.close()
  }
})

test('profession lock tool reports the active turn and resolves an ordinal', async () => {
  const fixture = buildModules()
  try {
    const handle = 'session-lock-tool'
    const session = insertSession(fixture.db, handle)
    insertTurn(fixture.db, session, { profession: 'outcome', status: 'running' })

    const tool = toolOf(
      coordinationToolDefinitions(toolService(fixture), 'en-US'),
      'coordination_professionlock',
    )

    const active = (await tool.execute({ session: handle }, {})) as ProfessionLockToolValue
    assert.deepEqual(active, { locked: true, profession: 'outcome' })

    const byOrdinal = (await tool.execute({ session: handle, turn: 1 }, {})) as ProfessionLockToolValue
    assert.deepEqual(byOrdinal, { locked: true, profession: 'outcome' })

    await assert.rejects(
      async () => {
        await tool.execute({ session: handle, turn: 9 }, {})
      },
      (error: unknown) => error instanceof InvalidArgumentError,
    )
  } finally {
    fixture.close()
  }
})

test('selection tool reads and writes the SelectionState', async () => {
  const fixture = buildModules()
  try {
    const handle = 'session-selection-tool'
    insertSession(fixture.db, handle)
    const tool = toolOf(
      coordinationToolDefinitions(toolService(fixture), 'zh-CN'),
      'coordination_selection',
    )

    const before = (await tool.execute({}, { agent: { id: handle } })) as SelectionState
    assert.equal(before.session, handle)
    assert.ok(before.config)
    assert.equal(before.selection.scene, 'dialogue')

    const after = (await tool.execute(
      { scene: 'engineering', validation: 'high' },
      { agent: { id: handle } },
    )) as SelectionState
    assert.equal(after.selection.scene, 'engineering')
    assert.equal(after.selection.validation, 'high')
    assert.equal(fixture.selection.get(handle).scene, 'engineering')
  } finally {
    fixture.close()
  }
})
