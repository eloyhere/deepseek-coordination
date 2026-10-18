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
import { createTestHost, insertGoal, insertPlan, insertSession, insertTurn } from './helpers.js'
import type { TestHostOptions } from './helpers.js'
import { resolveConfig } from '../src/host/config.js'
import { ChainEngine } from '../src/host/chain.js'
import { fileHandleFor, nodeHandleFor } from '../src/host/node-registry.js'
import type { ParsedFile } from '../src/host/parse-service.js'
import { ProfessionModule } from '../src/host/profession.js'
import {
  SelectionModule,
  abandonProfession,
  applyConfigPatch,
  rebuildProfession,
} from '../src/host/selection.js'
import {
  coordinationFileToolDefinitions,
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
import type { Locale } from '../src/shared/i18n.js'
import type { PermissionPresetOption, PermissionPresetPort } from '../src/host/module.js'
import {
  InvalidArgumentError,
  InvalidStateError,
  ProfessionLockedError,
} from '../src/shared/error.js'

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

type Fixture = ReturnType<typeof buildModules>

/** One catalog row as a DSH deployment may answer it: the label is optional. */
type PresetOptionFixture = Partial<PermissionPresetOption> & Pick<PermissionPresetOption, 'value'>

/**
 * A permission-preset double before `buildModules` completes it into a
 * `PermissionPresetPort`.
 *
 * The port declares a label on every row and a string from `current()`, but a
 * deployment may omit a row's `name` and have no current preset for a session.
 * The fixture keeps that honest, incomplete shape; `permissionPresetPort`
 * supplies only the mechanical defaults, never a fabricated label.
 */
interface PermissionPresetFixture {
  catalog(): { options: PresetOptionFixture[]; defaultPreset?: string }
  current?(session: unknown): string | undefined
  set?(session: unknown, name: string): void
  resolve?: PermissionPresetPort['resolve']
}

type BuildOptions = Omit<TestHostOptions, 'permissionPresets'> & {
  permissionPresets?: PermissionPresetFixture
}

function buildModules(options: BuildOptions = {}) {
  const fixture = createTestHost(hostOptions(options))
  const selection = new SelectionModule(fixture.host)
  const profession = new ProfessionModule(fixture.host)
  return {
    ...fixture,
    selection,
    profession,
    deps: { selection, profession },
  }
}

/** Complete only the mechanical parts of the partial preset fixture. */
function hostOptions(options: BuildOptions): TestHostOptions {
  const { permissionPresets, ...rest } = options
  return permissionPresets === undefined
    ? rest
    : { ...rest, permissionPresets: permissionPresetPort(permissionPresets) }
}

function permissionPresetPort(fixture: PermissionPresetFixture): PermissionPresetPort {
  return {
    catalog: () => {
      const catalog = fixture.catalog()
      return {
        // The port's declared option requires `name`, but the fixture models a
        // deployment that omits the label. Keep the row nameless at runtime —
        // the fallback label is the behaviour under test — and narrow only here,
        // at the fixture boundary.
        options: catalog.options as PermissionPresetOption[],
        ...(catalog.defaultPreset === undefined ? {} : { defaultPreset: catalog.defaultPreset }),
      }
    },
    // The port requires a string; an absent preset reads as the empty key.
    current: (session) => fixture.current?.(session) ?? '',
    set: (session, name) => {
      fixture.set?.(session, name)
    },
    ...(fixture.resolve === undefined ? {} : { resolve: fixture.resolve }),
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

/** A body-free parse fixture for the chain directory layer. */
function parsedFile(path: string, nodes: ParsedFile['nodes'] = []): ParsedFile {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    path,
    parserId: 'javascript',
    charset: 'utf-8',
    bomBytes: 0,
    truncated: false,
    tokens: 1,
    size: 1,
    cached: false,
    status: 'parsed',
    file: {
      kind: 'module',
      name,
      path,
      byteStart: 0,
      byteEnd: 1,
      lineStart: 1,
      lineEnd: 1,
      fingerprint: `sha256:${path}`,
      span: { start: 0, end: 1, line: 1, column: 1 },
    },
    nodes,
    references: [],
    diagnostics: [],
    structure: { headings: [], statements: [], divs: [], formulaReferences: [], frontMatter: {} },
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
 * Full config view and live patch (v24 §19)
 * ------------------------------------------------------------------------- */

test('configView() projects the full surface while the composer projection stays small', () => {
  const fixture = buildModules()
  try {
    insertSession(fixture.db, 'config-full')
    const state = fixture.selection.state('config-full')
    const view = fixture.selection.configView()

    // The full view carries every group the settings page renders.
    assert.deepEqual(Object.keys(view.values).sort(), [
      'bayesian',
      'cache',
      'chain',
      'clarifyTimeout',
      'compaction',
      'comprehension',
      'defaultLease',
      'defaults',
      'maxTurnPerSession',
      'orchestration',
      'parser',
      'plan',
      'profession',
      'scenes',
      'tools',
      'ui',
    ])
    assert.equal(view.values.parser.maxFileBytes, 1_048_576)
    assert.equal(view.values.chain.depth, 8)
    assert.equal(view.values.tools.maxResultBytes, 0)
    assert.deepEqual(view.values, view.defaults, 'a fresh config equals its schema defaults')

    // The legacy composer projection is unchanged: no parser/chain/tools keys.
    const legacy = state.config as unknown as Record<string, unknown>
    assert.equal('parser' in legacy, false)
    assert.equal('chain' in legacy, false)

    // Neither projection may leak the deployment path.
    for (const wire of [JSON.stringify(state), JSON.stringify(view)]) {
      assert.equal(wire.includes('databasePath'), false)
    }
  } finally {
    fixture.close()
  }
})

test('a config patch reaches the live selection projection', () => {
  const fixture = buildModules()
  try {
    insertSession(fixture.db, 'config-live')
    const before = fixture.selection.state('config-live')
    assert.equal(before.config?.showTooltip, true)
    assert.equal(before.config?.defaultScene, 'dialogue')

    applyConfigPatch(fixture.host.config, {
      'ui.showTooltip': false,
      'defaults.scene': 'research',
    })

    const after = fixture.selection.state('config-live')
    assert.equal(after.config?.showTooltip, false)
    assert.equal(after.config?.defaultScene, 'research')
    // A session without a stored selection follows the new default.
    assert.equal(fixture.selection.get('config-live').scene, 'research')
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Phase freezes (turn -> profession, plan -> validation, goal -> interaction)
 * ------------------------------------------------------------------------- */

test('state() freezes the matching dropdown per phase and lifts it automatically', () => {
  const fixture = buildModules()
  try {
    const handle = 'session-freeze'
    const session = insertSession(fixture.db, handle)
    const turn = insertTurn(fixture.db, session, { profession: 'execution', status: 'planning' })
    const plan = insertPlan(fixture.db, turn, { status: 'active' })
    const goal = insertGoal(fixture.db, session, turn, { status: 'set' })
    fixture.db.update('turn', { plan, goal }, 'identity = ?', turn)

    const frozen = fixture.selection.state(handle).frozen
    assert.equal(frozen?.profession?.phase, 'turn')
    assert.equal(frozen?.validation?.phase, 'plan')
    assert.equal(frozen?.validation?.status, 'active')
    assert.equal(frozen?.interaction?.phase, 'goal')
    assert.equal(frozen?.interaction?.status, 'set')
    assert.equal(frozen?.validation?.turn, 1)

    // A terminal plan lifts only the validation freeze.
    fixture.db.update('plan', { status: 'done' }, 'identity = ?', plan)
    const afterPlan = fixture.selection.state(handle).frozen
    assert.equal(afterPlan?.validation, undefined)
    assert.equal(afterPlan?.interaction?.phase, 'goal')
    assert.equal(afterPlan?.profession?.phase, 'turn')

    // Every newly created plan freezes again (the projection is re-derived).
    const nextPlan = insertPlan(fixture.db, turn, { status: 'draft' })
    fixture.db.update('turn', { plan: nextPlan }, 'identity = ?', turn)
    assert.equal(fixture.selection.state(handle).frozen?.validation?.phase, 'plan')

    // A `cleared` goal tombstone lifts the interaction freeze.
    const cleared = insertGoal(fixture.db, session, turn, { status: 'cleared' })
    fixture.db.update('turn', { goal: cleared }, 'identity = ?', turn)
    const afterGoal = fixture.selection.state(handle).frozen
    assert.equal(afterGoal?.interaction, undefined)
    assert.equal(afterGoal?.validation?.phase, 'plan')

    // Every newly set goal freezes interaction again.
    const reopened = insertGoal(fixture.db, session, turn, { status: 'set' })
    fixture.db.update('turn', { goal: reopened }, 'identity = ?', turn)
    assert.equal(fixture.selection.state(handle).frozen?.interaction?.phase, 'goal')

    // Closing the turn lifts everything and drops the lock.
    fixture.db.update('turn', { status: 'done' }, 'identity = ?', turn)
    const closed = fixture.selection.state(handle)
    assert.equal(closed.frozen, undefined)
    assert.equal(closed.locked, false)
  } finally {
    fixture.close()
  }
})

test('set() refuses a frozen validation/interaction and names the phase', () => {
  const fixture = buildModules()
  try {
    const handle = 'session-freeze-reject'
    const session = insertSession(fixture.db, handle)
    const turn = insertTurn(fixture.db, session, {
      profession: 'execution',
      status: 'planning',
      validation: 'medium',
      interaction: 'think',
    })
    const plan = insertPlan(fixture.db, turn, { status: 'scored' })
    const goal = insertGoal(fixture.db, session, turn, { status: 'updated' })
    fixture.db.update('turn', { plan, goal }, 'identity = ?', turn)

    assert.throws(
      () => fixture.selection.set(handle, { validation: 'high' }),
      (error: unknown) =>
        error instanceof InvalidStateError
        && error.code === 'INVALID_STATE'
        && error.details.phase === 'plan',
      'a running plan must freeze validation on the server',
    )
    assert.throws(
      () => fixture.selection.set(handle, { interaction: 'converge' }),
      (error: unknown) =>
        error instanceof InvalidStateError
        && error.code === 'INVALID_STATE'
        && error.details.phase === 'goal',
      'a set goal must freeze interaction on the server',
    )
    // Replaying the stored value is not an edit: it must never get stuck.
    assert.equal(fixture.selection.set(handle, { validation: 'medium' }).selection.validation, 'medium')

    // Ending the plan releases validation while the goal keeps interaction frozen.
    fixture.db.update('plan', { status: 'rebuilt' }, 'identity = ?', plan)
    assert.equal(fixture.selection.set(handle, { validation: 'high' }).selection.validation, 'high')
    assert.throws(() => fixture.selection.set(handle, { interaction: 'converge' }), InvalidStateError)

    // Clearing the goal releases interaction.
    const cleared = insertGoal(fixture.db, session, turn, { status: 'cleared' })
    fixture.db.update('turn', { goal: cleared }, 'identity = ?', turn)
    assert.equal(
      fixture.selection.set(handle, { interaction: 'converge' }).selection.interaction,
      'converge',
    )
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

test('a preset catalog that echoes its key as the name still shows the shipped label', () => {
  // DSH may return `{ value: 'read-only', name: 'read-only' }`. The dropdown must
  // render a human label and keep the key as the value: label is label, value is
  // value. A genuine DSH label still wins, and an unknown preset keeps its name.
  const fixture = buildModules({
    permissionPresets: {
      catalog: () => ({
        options: [
          { value: 'read-only', name: 'read-only' },
          { value: 'workspace-write' },
          { value: 'danger-full-access', name: 'danger-full-access' },
          { value: 'custom-tier', name: 'Custom tier' },
        ],
      }),
      current: () => undefined,
      set: () => undefined,
    },
  })
  try {
    const rows = fixture.selection.listPreset()
    assert.deepEqual(
      rows.map((row) => [row.value, row.name]),
      [
        ['read-only', '仅可查看'],
        ['workspace-write', '工作区内修改'],
        ['danger-full-access', '完全权限'],
        ['custom-tier', 'Custom tier'],
      ],
    )
  } finally {
    fixture.close()
  }
})

/* ------------------------------------------------------------------------- *
 * Chain directory layer and kind filter
 * ------------------------------------------------------------------------- */

test('chain index derives directory nodes and edges once per ancestor', () => {
  const chain = new ChainEngine()
  try {
    const file = fileHandleFor('pkg/src/a.ts')
    chain.index(parsedFile('pkg/src/a.ts'))

    // child -> directory `part_of` is the exact hierarchy, one level per hop.
    const ancestors = chain.dependenciesOf(file, { relation: 'part_of', depth: 2 })
    assert.deepEqual(
      ancestors.links.map((link) => ({
        path: link.path,
        kind: link.kind,
        relation: link.relation,
        direction: link.direction,
        depth: link.depth,
      })),
      [
        { path: 'pkg/src', kind: 'directory', relation: 'part_of', direction: 'forward', depth: 1 },
        { path: 'pkg', kind: 'directory', relation: 'part_of', direction: 'forward', depth: 2 },
      ],
    )
    const src = ancestors.links[0]?.handle as string
    const pkg = ancestors.links[1]?.handle as string
    assert.notEqual(src, pkg)
    assert.equal(chain.size, 3, 'file + pkg + pkg/src')
    assert.equal(chain.edgeCount, 4, 'two exact part_of + two derived contains')

    // The derived `contains` mirrors the same fact (directory -> child).
    assert.deepEqual(
      chain.dependenciesOf(src, { relation: 'contains' }).links.map((link) => link.path),
      ['pkg/src/a.ts'],
    )
    assert.deepEqual(
      chain.dependenciesOf(pkg, { relation: 'contains' }).links.map((link) => link.path),
      ['pkg/src'],
    )

    // A sibling reuses both directory vertices: only its own vertex and the
    // two file-level edges are new.
    chain.index(parsedFile('pkg/src/b.ts'))
    assert.equal(chain.size, 4)
    assert.equal(chain.edgeCount, 6)
    assert.deepEqual(
      chain.dependenciesOf(file, { relation: 'part_of', depth: 2 }).links.map((link) => link.handle),
      [src, pkg],
    )
    assert.deepEqual(
      chain.dependenciesOf(src, { relation: 'contains' }).links.map((link) => link.path).sort(),
      ['pkg/src/a.ts', 'pkg/src/b.ts'],
    )
  } finally {
    chain.dispose()
  }
})

test('chain refuses directory edges for ambiguous paths and case spellings', () => {
  for (const path of ['pkg/../src/a.ts', '//server/share/a.ts', 'C:/work/a.ts']) {
    const chain = new ChainEngine()
    try {
      chain.index(parsedFile(path))
      const file = fileHandleFor(path)
      assert.deepEqual(
        chain.dependenciesOf(file, { relation: 'part_of', depth: 2 }).links,
        [],
        `${path} must not claim an exact parent`,
      )
      assert.equal(chain.size, 1, `${path} creates only the file vertex`)
      assert.equal(chain.edgeCount, 0, `${path} creates no directory edge`)
    } finally {
      chain.dispose()
    }
  }

  // `Pkg` and `pkg` may be the same case-insensitive directory: the second
  // spelling proves no exact `part_of`, so it contributes no hierarchy.
  const chain = new ChainEngine()
  try {
    chain.index(parsedFile('pkg/src/a.ts'))
    chain.index(parsedFile('Pkg/src/b.ts'))
    const sibling = fileHandleFor('Pkg/src/b.ts')
    assert.deepEqual(chain.dependenciesOf(sibling, { relation: 'part_of' }).links, [])
    assert.equal(chain.size, 4, 'the two `pkg` directory vertices are not duplicated')
    assert.equal(chain.edgeCount, 4, 'no edge is guessed for the ambiguous sibling')
  } finally {
    chain.dispose()
  }
})

test('chain kind filter is trimmed, case-insensitive and filters instead of erroring', () => {
  const chain = new ChainEngine()
  try {
    const path = 'pkg/src/a.ts'
    const file = fileHandleFor(path)
    chain.index(
      parsedFile(path, [
        {
          kind: 'function',
          name: 'alpha',
          path,
          byteStart: 0,
          byteEnd: 1,
          lineStart: 1,
          lineEnd: 1,
          fingerprint: 'sha256:alpha',
          span: { start: 0, end: 1, line: 1, column: 1 },
        },
        {
          kind: 'class',
          name: 'Beta',
          path,
          byteStart: 2,
          byteEnd: 3,
          lineStart: 1,
          lineEnd: 1,
          fingerprint: 'sha256:beta',
          span: { start: 2, end: 3, line: 1, column: 1 },
        },
      ]),
    )

    // The filter gates traversal and links alike: only matching nodes survive.
    const dirs = chain.dependenciesOf(file, {
      relation: 'part_of',
      depth: 2,
      kind: '  DIRECTORY ',
    })
    assert.deepEqual(
      dirs.links.map((link) => [link.kind, link.path]),
      [['directory', 'pkg/src'], ['directory', 'pkg']],
    )
    const classes = chain.dependenciesOf(file, { relation: 'contains', kind: ' class ' })
    assert.deepEqual(classes.links.map((link) => [link.kind, link.name]), [['class', 'Beta']])

    // A kind that matches nothing is an empty list, never an error.
    const none = chain.dependenciesOf(file, { relation: 'contains', kind: 'theorem' })
    assert.deepEqual(none.links, [])
    assert.equal(none.truncated, false)

    // The filtered answer is cached separately from the unfiltered one.
    assert.deepEqual(
      chain.dependenciesOf(file, { relation: 'part_of', depth: 2 }).links.map((link) => link.path),
      ['pkg/src', 'pkg'],
    )
  } finally {
    chain.dispose()
  }
})

test('chain wires explicit TeX requires/meets only from a proven locator target', () => {
  const chain = new ChainEngine()
  try {
    const path = 'pkg/src/paper.tex'
    const theorem = nodeHandleFor(path, 'theorem', `document:${path}/theorem:1`)
    const requires = nodeHandleFor(path, 'condition', `document:${path}/condition:1`)
    const meets = nodeHandleFor(path, 'condition', `document:${path}/condition:2`)
    const unattached = nodeHandleFor(path, 'condition', `document:${path}/condition:3`)
    const unresolved = nodeHandleFor(path, 'condition', `document:${path}/condition:4`)
    const span = { start: 0, end: 1, line: 1, column: 1 }
    const condition = (
      locator: string,
      relation: 'requires' | 'meets' | undefined,
      appliesTo: string | undefined,
    ): ParsedFile['nodes'][number] => ({
      kind: 'condition',
      locator,
      path,
      source: 'command',
      span,
      domain: {
        kind: 'condition',
        locator,
        form: relation === 'meets' ? 'postcondition' : 'precondition',
        status: 'unknown',
        explicit: true,
        ...(relation === undefined ? {} : { relation }),
        ...(appliesTo === undefined ? {} : { appliesTo }),
      },
    })
    chain.index(
      parsedFile(path, [
        { kind: 'theorem', locator: `document:${path}/theorem:1`, name: 'Main', path, span },
        condition(`document:${path}/condition:1`, 'requires', `document:${path}/theorem:1`),
        condition(`document:${path}/condition:2`, 'meets', `document:${path}/theorem:1`),
        // Form-only markers never set `relation`: no edge may be invented.
        condition(`document:${path}/condition:3`, undefined, `document:${path}/theorem:1`),
        // An appliesTo locator with no surviving node stays unattached.
        condition(`document:${path}/condition:4`, 'requires', `document:${path}/theorem:99`),
      ]),
    )

    // `requires` points target → condition; `meets` points condition → target.
    assert.deepEqual(
      chain.dependenciesOf(theorem, { relation: 'requires' }).links.map((link) => link.handle),
      [requires],
    )
    assert.deepEqual(
      chain.dependenciesOf(meets, { relation: 'meets' }).links.map((link) => link.handle),
      [theorem],
    )
    assert.deepEqual(chain.dependenciesOf(unattached, { relation: 'requires' }).links, [])
    assert.deepEqual(chain.dependenciesOf(unresolved, { relation: 'requires' }).links, [])
  } finally {
    chain.dispose()
  }
})

test('coordination_chain exposes the kind parameter in both locales', () => {
  const fixture = buildModules()
  try {
    const expected: Array<[Locale, RegExp]> = [
      ['en-US', /kind/i],
      ['zh-CN', /种类/],
    ]
    for (const [locale, pattern] of expected) {
      const tool = toolOf(
        coordinationFileToolDefinitions(toolService(fixture), locale),
        'coordination_chain',
      )
      const properties = tool.parameters.properties as Record<string, Record<string, unknown>>
      assert.equal(properties.kind?.type, 'string', `${locale}: kind must be a string parameter`)
      assert.match(String(properties.kind?.description), pattern, `${locale}: kind description`)
    }
  } finally {
    fixture.close()
  }
})
