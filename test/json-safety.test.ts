/**
 * JSON losslessness at the tool boundary.
 *
 * DSH validates a tool's returned value by round-tripping it through JSON: a
 * key whose value is `undefined` is dropped by `JSON.stringify`, so the value
 * comes back unequal and the harness rejects the whole tool result with
 * "value is not lossless JSON". This actually happened live in v0.17.0: the
 * permission-preset catalog of the running host omitted `description` and the
 * sandbox port omitted `defaultMode`, and `coordination_selection` failed.
 *
 * These tests pin the projection rules so a foreign DSH port cannot reintroduce
 * the hole: absent optional fields are omitted, never carried as `undefined`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestHost, testConfig } from './helpers.js'
import { SelectionModule } from '../src/host/selection.js'
import { coordinationToolDefinitions } from '../src/host/tools.js'
import { AmpService, withAmpReceipts } from '../src/host/amp.js'
import { HandleGenerator, ManualClock } from '../src/host/handle.js'
import { jsonSafe } from '../src/shared/json-safe.js'

/** Deep equality against the value's own JSON round-trip. */
function lossless(value: unknown): boolean {
  return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
}

test('the selection state is JSON-lossless when the live ports omit optional fields', () => {
  const host = createTestHost({
    permissionPresets: {
      catalog: () => ({
        options: [
          // No description, and `resolve` returns no knob either.
          { value: 'read-only', name: 'read-only' },
          { value: 'full-access', name: 'Full access', description: 'everything' },
        ],
      }),
      current: () => 'read-only',
      set: () => undefined,
      resolve: () => ({}),
    },
    // A foreign port whose `defaultMode` is missing at runtime, despite the type.
    sandboxPolicy: {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: 'R:\\' }),
      overrideOf: () => undefined,
      get defaultMode(): string {
        return undefined as unknown as string
      },
    },
  })
  try {
    const selection = new SelectionModule(host.host)
    const state = selection.state('session-json')

    assert.equal(
      Object.hasOwn(state.presets[0], 'description'),
      false,
      'an absent description must be omitted, not stored as undefined',
    )
    assert.equal(
      Object.hasOwn(state, 'defaultMode'),
      false,
      'an absent defaultMode must be omitted, not stored as undefined',
    )
    // The decisive property: DSH's own acceptance check.
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
    assert.equal(lossless(state), true)
  } finally {
    host.close()
  }
})

test('a completely absent sandbox port still yields a lossless state', () => {
  const host = createTestHost()
  try {
    const selection = new SelectionModule(host.host)
    const state = selection.state('session-json-2')
    assert.equal(Object.hasOwn(state, 'defaultMode'), false)
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  } finally {
    host.close()
  }
})

test('jsonSafe detaches a lossy value into lossless JSON', () => {
  class Marker {
    constructor(public label: string) {}
  }
  const cycle: Record<string, unknown> = { name: "root" }
  cycle.self = cycle
  const input = {
    missing: undefined,
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    negativeZero: -0,
    big: 10n,
    fn: () => undefined,
    sparse: [1, , 3],
    map: new Map([["k", 1]]),
    set: new Set([1, 2]),
    when: new Date("2026-01-01T00:00:00.000Z"),
    instance: new Marker("boxed"),
    nested: { keep: 1, drop: undefined },
    cycle,
  }
  const { value, changed } = jsonSafe(input)
  assert.equal(changed, true)
  assert.equal(Object.hasOwn(value, "missing"), false)
  assert.equal(value.nan, null)
  assert.equal(value.infinity, null)
  assert.equal(value.negativeZero, 0)
  assert.equal(value.big, "10")
  assert.equal(Object.hasOwn(value, "fn"), false)
  assert.deepEqual(value.sparse, [1, null, 3])
  assert.deepEqual(value.map, { k: 1 })
  assert.deepEqual(value.set, [1, 2])
  assert.equal(value.when, "2026-01-01T00:00:00.000Z")
  assert.deepEqual(value.instance, { label: "boxed" })
  assert.deepEqual(value.nested, { keep: 1 })
  assert.equal(Object.hasOwn(value.cycle, "self"), false)
  // The decisive property.
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('the tool wrapper coerces a lossy value instead of failing the call', async () => {
  const host = createTestHost()
  try {
    const amp = new AmpService({
      db: host.db,
      config: testConfig(),
      handles: new HandleGenerator("test"),
      clock: new ManualClock(),
      capabilities: [],
    })
    let returned: unknown
    const registry = {
      register: (definition: { execute: (args: unknown, exec?: unknown) => unknown }) => {
        returned = definition
        return () => undefined
      },
    }
    const receipted = withAmpReceipts(registry as never, amp)
    receipted.register({
      name: "coordination_selection",
      description: "test",
      parameters: { type: "object" },
      output: { schema: { type: "object" }, render: () => [] },
      execute: () => ({ ok: true, missing: undefined, nan: Number.NaN }),
    } as never)
    const definition = returned as { execute: (args: unknown) => Promise<unknown> }
    const value = await definition.execute({})
    assert.deepEqual(value, { ok: true, nan: null })
    await amp.flush()
    const receipts = amp.receipts(5)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].outcome, "success")
  } finally {
    host.close()
  }
})



test('the declared selection schema covers every projected field', () => {
  const host = createTestHost()
  try {
    const selection = new SelectionModule(host.host)
    const service = {
      locale: 'en-US',
      state: (session: string) => selection.state(session),
      setSelection: (session: string, patch: never) => selection.set(session, patch),
      activeTurn: (session: string) => selection.activeTurn(session),
      getProfessionRecord: () => {
        throw new Error('not used')
      },
      turnByOrdinal: () => undefined,
    }
    const definitions = coordinationToolDefinitions(service as never, 'en-US')
    const definition = definitions.find((candidate) => candidate.name === 'coordination_selection')
    assert.ok(definition !== undefined)
    const schema = definition.output.schema as {
      properties: Record<string, { properties?: Record<string, unknown> }>
    }
    const state = selection.state('session-schema')
    for (const key of Object.keys(state)) {
      assert.ok(
        Object.hasOwn(schema.properties, key),
        `the value carries "${key}" but the declared schema does not declare it`,
      )
    }
    const configProperties = schema.properties.config?.properties ?? {}
    for (const key of Object.keys(selection.configuration())) {
      assert.ok(
        Object.hasOwn(configProperties, key),
        `the config projection carries "${key}" but the declared schema does not declare it`,
      )
    }
    // `frozen` only appears while a phase is open, but it must be declarable.
    assert.ok(Object.hasOwn(schema.properties, 'frozen'))
  } finally {
    host.close()
  }
})

