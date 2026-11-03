/**
 * `coordination_selection` dispatch behaviour.
 *
 * The tool has three distinct answers and this file pins each of them with a
 * minimal fake service (no host, no database):
 *
 *  - a pure read keeps returning the full `SelectionState` (the historical
 *    shape, so an old caller that only reads still works);
 *  - a lawful patch answers with the save envelope `{ session, ok, locked,
 *    selection }`;
 *  - a refused patch — `ProfessionLockedError` or `InvalidStateError` — comes
 *    back as `{ ok: false, error: { code, message } }` instead of throwing, and
 *    leaves the stored selection untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  coordinationToolDefinitions,
  type CoordinationToolDefinition,
  type CoordinationToolService,
  type SelectionSaveValue,
} from '../src/host/tools.js'
import { InvalidStateError, ProfessionLockedError } from '../src/shared/error.js'
import type { Selection } from '../src/shared/entity.js'
import type { SelectionPatch, SelectionState } from '../src/shared/selection.js'

interface FakeSelectionService {
  readonly locale: string
  calls: Array<{ session: string; patch: SelectionPatch }>
  selection: Selection
  locked: boolean
  /** When set, the next `setSelection` throws it instead of writing. */
  failWith: unknown
  state(session: string): SelectionState
  setSelection(session: string, patch: SelectionPatch): SelectionState
  activeTurn(): undefined
  getProfessionRecord(): never
  turnByOrdinal(): undefined
}

function fakeService(): FakeSelectionService {
  const service: FakeSelectionService = {
    locale: 'en-US',
    calls: [],
    selection: {
      session: 'session-a',
      profession: 'execution',
      interaction: 'think',
      scene: 'engineering',
      validation: 'medium',
      command: 'none',
      locked: false,
      changed: 1,
    },
    locked: false,
    failWith: undefined,
    state(session: string): SelectionState {
      return {
        session,
        selection: { ...service.selection, session, locked: service.locked },
        locked: service.locked,
        presets: [],
        tooltip: true,
      }
    },
    setSelection(session: string, patch: SelectionPatch): SelectionState {
      service.calls.push({ session, patch })
      if (service.failWith !== undefined) throw service.failWith
      service.selection = { ...service.selection, ...patch }
      return service.state(session)
    },
    activeTurn: () => undefined,
    getProfessionRecord: () => {
      throw new Error('the selection tool must not read the profession record')
    },
    turnByOrdinal: () => undefined,
  }
  return service
}

function selectionToolOf(
  service: FakeSelectionService,
  locale: 'en-US' | 'zh-CN' = 'en-US',
): CoordinationToolDefinition {
  const definitions = coordinationToolDefinitions(service as unknown as CoordinationToolService, locale)
  const tool = definitions.find((candidate) => candidate.name === 'coordination_selection')
  assert.ok(tool !== undefined, 'coordination_selection is registered')
  return tool
}

const exec = { agent: { id: 'session-a' } }

test('a pure read still returns the whole SelectionState and writes nothing', async () => {
  const service = fakeService()
  const tool = selectionToolOf(service)

  const value = await tool.execute({}, exec) as SelectionState
  assert.equal(value.session, 'session-a')
  assert.equal(value.selection.scene, 'engineering')
  assert.equal(value.locked, false)
  assert.equal(Object.hasOwn(value, 'ok'), false)
  assert.deepEqual(service.calls, [])
})

test('a lawful patch answers with the save envelope and writes the selection', async () => {
  const service = fakeService()
  const tool = selectionToolOf(service)

  const value = await tool.execute(
    { scene: 'research', validation: 'high' },
    exec,
  ) as SelectionSaveValue
  assert.equal(value.session, 'session-a')
  assert.equal(value.ok, true)
  assert.equal(value.locked, false)
  assert.equal(value.selection.scene, 'research')
  assert.equal(value.selection.validation, 'high')
  assert.equal(value.error, undefined)
  assert.deepEqual(service.calls, [
    { session: 'session-a', patch: { scene: 'research', validation: 'high' } },
  ])
})

test('a frozen profession returns ok:false with PROFESSION_LOCKED instead of throwing', async () => {
  const service = fakeService()
  service.locked = true
  service.failWith = new ProfessionLockedError({
    turn: 1,
    current: 'execution',
    requested: 'decision',
  })
  const tool = selectionToolOf(service)

  const value = await tool.execute({ profession: 'decision' }, exec) as SelectionSaveValue
  assert.equal(value.session, 'session-a')
  assert.equal(value.ok, false)
  assert.equal(value.locked, true)
  assert.equal(value.selection.profession, 'execution')
  assert.equal(value.selection.locked, true)
  assert.equal(value.error?.code, 'PROFESSION_LOCKED')
  assert.match(value.error?.message ?? '', /locked/)
  // The failed patch never reached the store.
  assert.equal(service.selection.profession, 'execution')
})

test('a frozen plan/goal dimension returns INVALID_STATE as data', async () => {
  const service = fakeService()
  // A frozen dimension belongs to an active turn, so the session is locked.
  service.locked = true
  service.failWith = new InvalidStateError('interaction is frozen until the current goal is cleared')
  const tool = selectionToolOf(service)

  const value = await tool.execute({ interaction: 'converge' }, exec) as SelectionSaveValue
  assert.equal(value.ok, false)
  assert.equal(value.locked, true)
  assert.equal(value.selection.interaction, 'think')
  assert.equal(value.error?.code, 'INVALID_STATE')
})

test('an invalid argument maps to INVALID_ARGUMENT without throwing and keeps locked honest', async () => {
  const service = fakeService()
  const tool = selectionToolOf(service)

  const value = await tool.execute({ profession: 'not-a-profession' }, exec) as SelectionSaveValue
  assert.equal(value.ok, false)
  // The envelope mirrors the state: an argument error in an unlocked session
  // must not claim the profession is frozen.
  assert.equal(value.locked, false)
  assert.equal(value.selection.profession, 'execution')
  assert.equal(value.error?.code, 'INVALID_ARGUMENT')
  assert.deepEqual(service.calls, [])
})

test('the output schema is the oneOf of the summary, state and save envelopes', () => {
  const tool = selectionToolOf(fakeService())
  const schema = tool.output.schema as { oneOf?: Array<Record<string, unknown>>; type?: unknown }
  assert.equal(schema.type, undefined)
  assert.equal(schema.oneOf?.length, 3)
  const views = schema.oneOf
    ?.map((branch) => (branch.properties as Record<string, { enum?: unknown[] }> | undefined)?.view?.enum?.[0])
    .filter((value) => value !== undefined)
  assert.deepEqual(views, ['summary'])
})

test('the description states the unlocked editing and structured-refusal contract', () => {
  const en = selectionToolOf(fakeService(), 'en-US')
  assert.match(en.description, /freezes/)
  assert.match(en.description, /structured/)

  const zh = selectionToolOf(fakeService(), 'zh-CN')
  assert.match(zh.description, /冻结/)
  assert.match(zh.description, /结构化/)
})
